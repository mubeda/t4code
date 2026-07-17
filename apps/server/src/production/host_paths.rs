use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

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

pub async fn resolve_host_directory_identity(
    path: &Path,
    allow_missing: bool,
) -> Result<PathBuf, HostPathError> {
    let resolved = expand_home_path(path)?;
    match tokio::fs::metadata(&resolved).await {
        Ok(metadata) if !metadata.is_dir() => Err(HostPathError::NotDirectory(resolved)),
        Ok(_) => canonicalize_path(&resolved).await,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
            canonicalize_missing_path(&resolved).await
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(HostPathError::Missing(resolved))
        }
        Err(source) => Err(HostPathError::Io {
            path: resolved,
            source,
        }),
    }
}

fn expand_home_path(path: &Path) -> Result<PathBuf, HostPathError> {
    let value = path.to_string_lossy();
    let remainder = if value == "~" {
        Some("")
    } else if let Some(remainder) = value.strip_prefix("~/") {
        Some(remainder)
    } else {
        value.strip_prefix("~\\")
    };
    let Some(remainder) = remainder else {
        return Ok(path.to_path_buf());
    };
    let home = dirs::home_dir()
        .ok_or_else(|| HostPathError::HomeDirectoryUnavailable(path.to_path_buf()))?;
    let mut expanded = home;
    for component in remainder
        .split(['/', '\\'])
        .filter(|component| !component.is_empty())
    {
        expanded.push(component);
    }
    Ok(expanded)
}

async fn canonicalize_path(path: &Path) -> Result<PathBuf, HostPathError> {
    tokio::fs::canonicalize(path)
        .await
        .map(process_compatible_path)
        .map_err(|source| HostPathError::Io {
            path: path.to_path_buf(),
            source,
        })
}

async fn canonicalize_missing_path(path: &Path) -> Result<PathBuf, HostPathError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| HostPathError::Io {
                path: path.to_path_buf(),
                source,
            })?
            .join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut missing_components = Vec::<OsString>::new();
    loop {
        match tokio::fs::metadata(ancestor).await {
            Ok(metadata) if !metadata.is_dir() => {
                return Err(HostPathError::NotDirectory(ancestor.to_path_buf()));
            }
            Ok(_) => {
                let mut canonical = canonicalize_path(ancestor).await?;
                for component in missing_components.iter().rev() {
                    canonical.push(component);
                }
                return Ok(normalize_lexically(&canonical));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(component) = ancestor.file_name() else {
                    return Err(HostPathError::Missing(absolute));
                };
                missing_components.push(component.to_os_string());
                let Some(parent) = ancestor.parent() else {
                    return Err(HostPathError::Missing(absolute));
                };
                ancestor = parent;
            }
            Err(source) => {
                return Err(HostPathError::Io {
                    path: ancestor.to_path_buf(),
                    source,
                });
            }
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
        }
    }
    process_compatible_path(normalized)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_expansion_accepts_both_separators_without_expanding_named_users() {
        let home = dirs::home_dir().expect("home directory");

        assert_eq!(expand_home_path(Path::new("~")).expect("exact home"), home);
        assert_eq!(
            expand_home_path(Path::new("~/alpha/beta")).expect("slash home path"),
            home.join("alpha").join("beta")
        );
        assert_eq!(
            expand_home_path(Path::new(r"~\alpha\beta")).expect("backslash home path"),
            home.join("alpha").join("beta")
        );
        assert_eq!(
            expand_home_path(Path::new("~someone/project")).expect("named-user path"),
            PathBuf::from("~someone/project")
        );
    }
}
