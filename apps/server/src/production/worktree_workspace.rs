use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use thiserror::Error;

use super::host_paths::{HostPathError, resolve_host_directory};

#[derive(Debug, Error)]
pub enum WorktreeWorkspaceValidationError {
    #[error("Workspace must be an absolute directory on this host.")]
    Relative(PathBuf),
    #[error("Workspace {0} does not exist.")]
    Missing(PathBuf),
    #[error("Workspace {0} is not a directory.")]
    NotDirectory(PathBuf),
    #[error("Workspace {path} is unavailable: {detail}")]
    Unavailable { path: PathBuf, detail: String },
}

impl WorktreeWorkspaceValidationError {
    fn path(&self) -> &Path {
        match self {
            Self::Relative(path) | Self::Missing(path) | Self::NotDirectory(path) => path,
            Self::Unavailable { path, .. } => path,
        }
    }

    fn failure(&self) -> &'static str {
        match self {
            Self::Relative(_) => "relative_path",
            Self::Missing(_) => "missing",
            Self::NotDirectory(_) => "not_directory",
            Self::Unavailable { .. } => "unavailable",
        }
    }

    pub fn to_wire(&self) -> Value {
        json!({
            "_tag": "WorktreeWorkspaceError",
            "path": self.path().to_string_lossy(),
            "failure": self.failure(),
            "message": self.to_string(),
        })
    }
}

pub async fn normalize_worktree_workspace(
    raw: &str,
) -> Result<String, WorktreeWorkspaceValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let expands_home = trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\");
    let requested = PathBuf::from(trimmed);
    if !expands_home && !requested.is_absolute() {
        return Err(WorktreeWorkspaceValidationError::Relative(requested));
    }
    resolve_host_directory(&requested, false)
        .await
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| match error {
            HostPathError::Missing(path) => WorktreeWorkspaceValidationError::Missing(path),
            HostPathError::NotDirectory(path) => {
                WorktreeWorkspaceValidationError::NotDirectory(path)
            }
            HostPathError::HomeDirectoryUnavailable(path) => {
                WorktreeWorkspaceValidationError::Unavailable {
                    path,
                    detail: "the server home directory is unavailable".to_owned(),
                }
            }
            HostPathError::Io { path, source } => WorktreeWorkspaceValidationError::Unavailable {
                path,
                detail: source.to_string(),
            },
        })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::normalize_worktree_workspace;

    #[tokio::test]
    async fn home_workspace_expands_to_a_native_absolute_directory() {
        let normalized = PathBuf::from(
            normalize_worktree_workspace("~")
                .await
                .expect("server home directory"),
        );
        assert!(normalized.is_absolute());
        assert!(normalized.is_dir());
        #[cfg(windows)]
        assert!(!normalized.to_string_lossy().starts_with(r"\\?\"));
    }
}
