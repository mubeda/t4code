use std::path::PathBuf;

use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace root does not exist: {path}", path = .path.display())]
    RootNotFound { path: PathBuf },
    #[error("workspace root is not a directory: {path}", path = .path.display())]
    RootNotDirectory { path: PathBuf },
    #[error("workspace path must be relative to the project root: {relative_path}")]
    PathOutsideRoot { relative_path: String },
    #[error("workspace path resolves outside the project root: {resolved_path}", resolved_path = .resolved_path.display())]
    ResolvedPathOutsideRoot {
        root: PathBuf,
        resolved_path: PathBuf,
    },
    #[error("workspace path is not a file: {path}", path = .path.display())]
    NotFile { path: PathBuf },
    #[error("workspace file is binary: {path}", path = .path.display())]
    BinaryFile { path: PathBuf },
    #[error("workspace entry already exists: {path}", path = .path.display())]
    AlreadyExists { path: PathBuf },
    #[error("workspace entry was not found: {path}", path = .path.display())]
    NotFound { path: PathBuf },
    #[error("a current project is required to browse relative path: {partial_path}")]
    CurrentProjectRequired { partial_path: String },
    #[allow(dead_code)]
    #[error("Windows path is unsupported on this platform: {partial_path}")]
    WindowsPathUnsupported { partial_path: String },
    #[error("workspace operation '{operation}' failed at {path}: {source}", path = .path.display())]
    Operation {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("workspace operation was cancelled")]
    Cancelled,
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("unsupported Task 6 RPC method: {0}")]
    UnsupportedMethod(String),
}

impl WorkspaceError {
    pub fn operation(
        operation: &'static str,
        path: impl Into<PathBuf>,
        source: std::io::Error,
    ) -> Self {
        Self::Operation {
            operation,
            path: path.into(),
            source,
        }
    }

    pub fn wire_failure(&self) -> &'static str {
        match self {
            Self::PathOutsideRoot { .. } => "workspace_path_outside_root",
            Self::ResolvedPathOutsideRoot { .. } => "resolved_path_outside_root",
            Self::NotFile { .. } => "path_not_file",
            Self::BinaryFile { .. } => "binary_file",
            Self::AlreadyExists { .. } => "entry_already_exists",
            Self::NotFound { .. } | Self::RootNotFound { .. } => "path_not_found",
            _ => "operation_failed",
        }
    }

    pub fn to_project_wire(&self, tag: &str, cwd: &str, relative_path: &str) -> Value {
        let mut value = json!({
            "_tag": tag,
            "cwd": cwd,
            "relativePath": relative_path,
            "failure": self.wire_failure(),
            "message": self.to_string(),
        });
        let object = value.as_object_mut().expect("wire error is an object");
        match self {
            Self::ResolvedPathOutsideRoot {
                root,
                resolved_path,
            } => {
                object.insert(
                    "resolvedWorkspaceRoot".to_owned(),
                    json!(root.to_string_lossy()),
                );
                object.insert(
                    "resolvedPath".to_owned(),
                    json!(resolved_path.to_string_lossy()),
                );
            }
            Self::NotFile { path }
            | Self::BinaryFile { path }
            | Self::AlreadyExists { path }
            | Self::NotFound { path } => {
                object.insert("resolvedPath".to_owned(), json!(path.to_string_lossy()));
            }
            Self::Operation {
                operation, path, ..
            } => {
                object.insert("operation".to_owned(), json!(operation));
                object.insert("operationPath".to_owned(), json!(path.to_string_lossy()));
            }
            _ => {}
        }
        value
    }
}
