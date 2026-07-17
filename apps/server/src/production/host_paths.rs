use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum HostPathError {
    #[error("home directory is unavailable while resolving {0}")]
    HomeDirectoryUnavailable(PathBuf),
    #[error("host path does not exist: {0}")]
    Missing(PathBuf),
    #[error("host path is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("failed to access host path {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub async fn resolve_host_directory(
    path: &Path,
    create_if_missing: bool,
) -> Result<PathBuf, HostPathError> {
    let resolved = expand_home_path(path)?;
    match tokio::fs::metadata(&resolved).await {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(HostPathError::NotDirectory(resolved));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_if_missing => {
            tokio::fs::create_dir_all(&resolved)
                .await
                .map_err(|source| HostPathError::Io {
                    path: resolved.clone(),
                    source,
                })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(HostPathError::Missing(resolved));
        }
        Err(source) => {
            return Err(HostPathError::Io {
                path: resolved,
                source,
            });
        }
    }

    tokio::fs::canonicalize(&resolved)
        .await
        .map(process_compatible_path)
        .map_err(|source| HostPathError::Io {
            path: resolved,
            source,
        })
}

fn expand_home_path(path: &Path) -> Result<PathBuf, HostPathError> {
    let value = path.to_string_lossy();
    let remainder = if value == "~" {
        Some("")
    } else {
        value.strip_prefix("~/")
    };
    let Some(remainder) = remainder else {
        return Ok(path.to_path_buf());
    };
    let home = dirs::home_dir()
        .ok_or_else(|| HostPathError::HomeDirectoryUnavailable(path.to_path_buf()))?;
    let remainder = remainder.trim_start_matches(['/', '\\']);
    Ok(if remainder.is_empty() {
        home
    } else {
        home.join(remainder)
    })
}

#[must_use]
pub fn process_compatible_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let display = path.to_string_lossy();
        if let Some(stripped) = display.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = display.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}
