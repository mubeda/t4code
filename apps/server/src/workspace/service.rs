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
        directory_mode: bool,
    ) -> Result<BrowseResult, WorkspaceError> {
        let _permit = self.permit().await?;
        if directory_mode {
            entries::browse_directory(partial_path, cwd).await
        } else {
            entries::browse(partial_path, cwd).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn service_covers_file_and_directory_lifecycle_edges() {
        let root = TempDir::new().unwrap();
        let service = WorkspaceService::new(0);

        assert_eq!(
            service
                .write_file(root.path(), "nested/file.txt", "hello")
                .await
                .unwrap(),
            "nested/file.txt"
        );
        let read = service
            .read_file(root.path(), "nested/file.txt")
            .await
            .unwrap();
        assert_eq!(read.contents, "hello");
        assert_eq!(read.byte_length, 5);
        assert!(!read.truncated);

        assert_eq!(
            service
                .create_entry(root.path(), "empty", EntryKind::Directory)
                .await
                .unwrap(),
            "empty"
        );
        assert_eq!(
            service
                .create_entry(root.path(), "new/file.rs", EntryKind::File)
                .await
                .unwrap(),
            "new/file.rs"
        );
        assert!(matches!(
            service
                .create_entry(root.path(), "new/file.rs", EntryKind::File)
                .await,
            Err(WorkspaceError::AlreadyExists { .. })
        ));
        assert!(matches!(
            service.read_file(root.path(), "empty").await,
            Err(WorkspaceError::NotFile { .. })
        ));

        assert_eq!(
            service
                .rename_entry(root.path(), "new/file.rs", "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file.rs"
        );
        assert!(matches!(
            service.rename_entry(root.path(), "missing", "unused").await,
            Err(WorkspaceError::NotFound { .. })
        ));
        service
            .write_file(root.path(), "occupied", "occupied")
            .await
            .unwrap();
        assert!(matches!(
            service
                .rename_entry(root.path(), "renamed/file.rs", "occupied")
                .await,
            Err(WorkspaceError::AlreadyExists { .. })
        ));

        assert_eq!(
            service
                .duplicate_entry(root.path(), "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file copy.rs"
        );
        assert_eq!(
            service
                .duplicate_entry(root.path(), "renamed/file.rs")
                .await
                .unwrap(),
            "renamed/file copy 2.rs"
        );
        assert!(matches!(
            service.duplicate_entry(root.path(), "empty").await,
            Err(WorkspaceError::NotFile { .. })
        ));
        assert!(matches!(
            service.duplicate_entry(root.path(), "missing").await,
            Err(WorkspaceError::NotFound { .. })
        ));

        std::fs::write(root.path().join("binary.dat"), b"binary\0payload").unwrap();
        assert!(matches!(
            service.read_file(root.path(), "binary.dat").await,
            Err(WorkspaceError::BinaryFile { .. })
        ));
        let browsed = service
            .browse("./r", Some(root.path()), false)
            .await
            .unwrap();
        assert!(!browsed.entries.is_empty());

        assert_eq!(
            service
                .delete_entry(root.path(), "renamed/file copy.rs")
                .await
                .unwrap(),
            "renamed/file copy.rs"
        );
        assert_eq!(
            service.delete_entry(root.path(), "empty").await.unwrap(),
            "empty"
        );
        assert!(matches!(
            service.delete_entry(root.path(), "missing").await,
            Err(WorkspaceError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn service_maps_concurrency_and_filesystem_failures_to_workspace_errors() {
        let root = TempDir::new().unwrap();
        let service = WorkspaceService::default();
        let blocker = root.path().join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();

        for result in [
            service
                .write_file(root.path(), "blocker/file.txt", "contents")
                .await,
            service
                .create_entry(root.path(), "blocker/directory", EntryKind::Directory)
                .await,
            service
                .create_entry(root.path(), "blocker/file.txt", EntryKind::File)
                .await,
            service
                .rename_entry(root.path(), "blocker", "blocker/renamed")
                .await,
        ] {
            assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
        }

        std::fs::create_dir(root.path().join("write-target")).unwrap();
        assert!(matches!(
            service
                .write_file(root.path(), "write-target", "contents")
                .await,
            Err(WorkspaceError::Operation { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            std::fs::write(root.path().join("source.txt"), "copy source").unwrap();
            let mut source_permissions = std::fs::metadata(root.path().join("source.txt"))
                .unwrap()
                .permissions();
            source_permissions.set_mode(0o000);
            std::fs::set_permissions(root.path().join("source.txt"), source_permissions).unwrap();
            let copy_result = service.duplicate_entry(root.path(), "source.txt").await;
            let mut source_permissions = std::fs::metadata(root.path().join("source.txt"))
                .unwrap()
                .permissions();
            source_permissions.set_mode(0o600);
            std::fs::set_permissions(root.path().join("source.txt"), source_permissions).unwrap();
            assert!(matches!(copy_result, Err(WorkspaceError::Operation { .. })));

            let unreadable = root.path().join("unreadable.txt");
            std::fs::write(&unreadable, "private").unwrap();
            let mut unreadable_permissions = std::fs::metadata(&unreadable).unwrap().permissions();
            unreadable_permissions.set_mode(0o000);
            std::fs::set_permissions(&unreadable, unreadable_permissions).unwrap();
            let read_result = service.read_file(root.path(), "unreadable.txt").await;
            let mut unreadable_permissions = std::fs::metadata(&unreadable).unwrap().permissions();
            unreadable_permissions.set_mode(0o600);
            std::fs::set_permissions(&unreadable, unreadable_permissions).unwrap();
            assert!(matches!(read_result, Err(WorkspaceError::Operation { .. })));

            let locked = root.path().join("locked");
            std::fs::create_dir(&locked).unwrap();
            let mut locked_permissions = std::fs::metadata(&locked).unwrap().permissions();
            locked_permissions.set_mode(0o500);
            std::fs::set_permissions(&locked, locked_permissions).unwrap();
            for result in [
                service
                    .create_entry(root.path(), "locked/directory", EntryKind::Directory)
                    .await,
                service
                    .create_entry(root.path(), "locked/file.txt", EntryKind::File)
                    .await,
            ] {
                assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
            }
            let mut locked_permissions = std::fs::metadata(&locked).unwrap().permissions();
            locked_permissions.set_mode(0o700);
            std::fs::set_permissions(&locked, locked_permissions).unwrap();

            for entry in ["rename-source", "delete-file"] {
                std::fs::write(root.path().join(entry), entry).unwrap();
            }
            std::fs::create_dir(root.path().join("delete-directory")).unwrap();
            let mut root_permissions = std::fs::metadata(root.path()).unwrap().permissions();
            root_permissions.set_mode(0o500);
            std::fs::set_permissions(root.path(), root_permissions).unwrap();
            for result in [
                service
                    .rename_entry(root.path(), "rename-source", "rename-target")
                    .await,
                service.delete_entry(root.path(), "delete-file").await,
                service.delete_entry(root.path(), "delete-directory").await,
            ] {
                assert!(matches!(result, Err(WorkspaceError::Operation { .. })));
            }
            let mut root_permissions = std::fs::metadata(root.path()).unwrap().permissions();
            root_permissions.set_mode(0o700);
            std::fs::set_permissions(root.path(), root_permissions).unwrap();
        }

        let closed = WorkspaceService::default();
        closed.permits.close();
        assert!(matches!(
            closed.browse(".", Some(root.path()), false).await,
            Err(WorkspaceError::Cancelled)
        ));
    }
}
