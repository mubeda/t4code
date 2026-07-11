use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::entries::{self, BrowseResult};
use super::paths::{canonical_existing_within, resolve_relative, safe_mutation_target};
use super::{EntryKind, WorkspaceError};

const READ_LIMIT_BYTES: usize = 1024 * 1024;
const DUPLICATE_LIMIT: usize = 1000;
const DEFAULT_MAX_CONCURRENT_OPERATIONS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub relative_path: String,
    pub contents: String,
    pub byte_length: usize,
    pub truncated: bool,
}

#[derive(Clone)]
pub struct WorkspaceService {
    permits: Arc<Semaphore>,
}

impl Default for WorkspaceService {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENT_OPERATIONS)
    }
}

impl WorkspaceService {
    pub fn new(max_concurrent_operations: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_concurrent_operations.max(1))),
        }
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit, WorkspaceError> {
        self.permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| WorkspaceError::Cancelled)
    }

    pub async fn read_file(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<ReadFileResult, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized_relative) = resolve_relative(root, relative_path)?;
        let (_, canonical_target) = canonical_existing_within(root, &target).await?;
        let path_for_error = canonical_target.clone();
        let (bytes, byte_length) = tokio::task::spawn_blocking(move || {
            let metadata = std::fs::metadata(&canonical_target)
                .map_err(|error| WorkspaceError::operation("stat", &canonical_target, error))?;
            if !metadata.is_file() {
                return Err(WorkspaceError::NotFile {
                    path: canonical_target,
                });
            }
            let byte_length = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
            let mut file = std::fs::File::open(&canonical_target)
                .map_err(|error| WorkspaceError::operation("open", &canonical_target, error))?;
            let mut bytes = Vec::with_capacity(byte_length.min(READ_LIMIT_BYTES));
            file.by_ref()
                .take(READ_LIMIT_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| WorkspaceError::operation("read", &canonical_target, error))?;
            Ok::<_, WorkspaceError>((bytes, byte_length))
        })
        .await
        .map_err(|error| {
            WorkspaceError::operation("read", path_for_error, std::io::Error::other(error))
        })??;
        if bytes.contains(&0) {
            return Err(WorkspaceError::BinaryFile { path: target });
        }
        Ok(ReadFileResult {
            relative_path: normalized_relative,
            contents: String::from_utf8_lossy(&bytes).into_owned(),
            byte_length,
            truncated: byte_length > READ_LIMIT_BYTES,
        })
    }

    pub async fn write_file(
        &self,
        root: &Path,
        relative_path: &str,
        contents: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", parent, error))?;
        }
        tokio::fs::write(&target, contents)
            .await
            .map_err(|error| WorkspaceError::operation("write-file", &target, error))?;
        Ok(normalized)
    }

    pub async fn create_entry(
        &self,
        root: &Path,
        relative_path: &str,
        kind: EntryKind,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized) = resolve_relative(root, relative_path)?;
        let target = safe_mutation_target(root, &target).await?;
        if tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?
        {
            return Err(WorkspaceError::AlreadyExists { path: target });
        }
        match kind {
            EntryKind::Directory => tokio::fs::create_dir_all(&target)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", &target, error))?,
            EntryKind::File => {
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(|error| {
                        WorkspaceError::operation("make-directory", parent, error)
                    })?;
                }
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .await
                    .map_err(|error| WorkspaceError::operation("write-file", &target, error))?;
            }
        }
        Ok(normalized)
    }

    pub async fn rename_entry(
        &self,
        root: &Path,
        from_relative_path: &str,
        to_relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (from, _) = resolve_relative(root, from_relative_path)?;
        if !tokio::fs::try_exists(&from)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &from, error))?
        {
            return Err(WorkspaceError::NotFound { path: from });
        }
        canonical_existing_within(root, &from).await?;
        let (to, normalized) = resolve_relative(root, to_relative_path)?;
        let to = safe_mutation_target(root, &to).await?;
        if tokio::fs::try_exists(&to)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &to, error))?
        {
            return Err(WorkspaceError::AlreadyExists { path: to });
        }
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| WorkspaceError::operation("make-directory", parent, error))?;
        }
        tokio::fs::rename(&from, &to)
            .await
            .map_err(|error| WorkspaceError::operation("rename", &from, error))?;
        Ok(normalized)
    }

    pub async fn delete_entry(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (target, normalized) = resolve_relative(root, relative_path)?;
        if !tokio::fs::try_exists(&target)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &target, error))?
        {
            return Err(WorkspaceError::NotFound { path: target });
        }
        let (_, canonical_target) = canonical_existing_within(root, &target).await?;
        let metadata = tokio::fs::metadata(&canonical_target)
            .await
            .map_err(|error| WorkspaceError::operation("stat", &canonical_target, error))?;
        if metadata.is_dir() {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|error| WorkspaceError::operation("remove", &target, error))?;
        } else {
            tokio::fs::remove_file(&target)
                .await
                .map_err(|error| WorkspaceError::operation("remove", &target, error))?;
        }
        Ok(normalized)
    }

    pub async fn duplicate_entry(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<String, WorkspaceError> {
        let _permit = self.permit().await?;
        let (source, normalized_source) = resolve_relative(root, relative_path)?;
        if !tokio::fs::try_exists(&source)
            .await
            .map_err(|error| WorkspaceError::operation("exists", &source, error))?
        {
            return Err(WorkspaceError::NotFound { path: source });
        }
        let (_, canonical_source) = canonical_existing_within(root, &source).await?;
        let metadata = tokio::fs::metadata(&canonical_source)
            .await
            .map_err(|error| WorkspaceError::operation("stat", &canonical_source, error))?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile {
                path: canonical_source,
            });
        }
        let source_path = Path::new(&normalized_source);
        let extension = source_path.extension().map(OsString::from);
        let stem = source_path
            .file_stem()
            .map_or_else(OsString::new, OsString::from);
        let parent = source_path.parent().unwrap_or(Path::new(""));
        for attempt in 1..=DUPLICATE_LIMIT {
            let suffix = if attempt == 1 {
                "copy".to_owned()
            } else {
                format!("copy {attempt}")
            };
            let mut name = stem.clone();
            name.push(format!(" {suffix}"));
            if let Some(extension) = &extension {
                name.push(".");
                name.push(extension);
            }
            let relative = parent.join(name);
            let (candidate, normalized) = resolve_relative(root, &relative.to_string_lossy())?;
            let candidate = safe_mutation_target(root, &candidate).await?;
            if !tokio::fs::try_exists(&candidate)
                .await
                .map_err(|error| WorkspaceError::operation("exists", &candidate, error))?
            {
                tokio::fs::copy(&canonical_source, &candidate)
                    .await
                    .map_err(|error| {
                        WorkspaceError::operation("copy-file", &canonical_source, error)
                    })?;
                return Ok(normalized);
            }
        }
        Err(WorkspaceError::AlreadyExists { path: source })
    }

    pub async fn browse(
        &self,
        partial_path: &str,
        cwd: Option<&Path>,
    ) -> Result<BrowseResult, WorkspaceError> {
        let _permit = self.permit().await?;
        entries::browse(partial_path, cwd).await
    }
}
