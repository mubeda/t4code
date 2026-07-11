use std::path::{Component, Path, PathBuf};

use super::WorkspaceError;

pub async fn normalize_root(
    root: &Path,
    create_if_missing: bool,
) -> Result<PathBuf, WorkspaceError> {
    if create_if_missing && !root.exists() {
        tokio::fs::create_dir_all(root)
            .await
            .map_err(|error| WorkspaceError::operation("make-directory", root, error))?;
    }
    let metadata = tokio::fs::metadata(root).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::RootNotFound {
                path: root.to_path_buf(),
            }
        } else {
            WorkspaceError::operation("stat", root, error)
        }
    })?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::RootNotDirectory {
            path: root.to_path_buf(),
        });
    }
    tokio::fs::canonicalize(root)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-workspace-root", root, error))
}

pub fn resolve_relative(root: &Path, relative: &str) -> Result<(PathBuf, String), WorkspaceError> {
    let trimmed = relative.trim();
    let path = Path::new(trimmed);
    let invalid_component = path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    });
    if trimmed.is_empty() || trimmed == "." || path.is_absolute() || invalid_component {
        return Err(WorkspaceError::PathOutsideRoot {
            relative_path: relative.to_owned(),
        });
    }
    let normalized = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<PathBuf>();
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceError::PathOutsideRoot {
            relative_path: relative.to_owned(),
        });
    }
    Ok((root.join(&normalized), to_posix(&normalized)))
}

pub async fn canonical_existing_within(
    root: &Path,
    target: &Path,
) -> Result<(PathBuf, PathBuf), WorkspaceError> {
    let canonical_root = normalize_root(root, false).await?;
    let canonical_target = tokio::fs::canonicalize(target)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-target", target, error))?;
    ensure_contained(&canonical_root, &canonical_target)?;
    Ok((canonical_root, canonical_target))
}

pub async fn safe_mutation_target(root: &Path, target: &Path) -> Result<PathBuf, WorkspaceError> {
    let canonical_root = normalize_root(root, false).await?;
    let mut existing = target.to_path_buf();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| WorkspaceError::PathOutsideRoot {
                relative_path: target.to_string_lossy().into_owned(),
            })?;
        suffix.push(name.to_os_string());
        existing = existing
            .parent()
            .ok_or_else(|| WorkspaceError::PathOutsideRoot {
                relative_path: target.to_string_lossy().into_owned(),
            })?
            .to_path_buf();
    }
    let mut canonical_target = tokio::fs::canonicalize(&existing)
        .await
        .map_err(|error| WorkspaceError::operation("realpath-target", &existing, error))?;
    ensure_contained(&canonical_root, &canonical_target)?;
    for component in suffix.iter().rev() {
        canonical_target.push(component);
    }
    Ok(canonical_target)
}

pub fn ensure_contained(root: &Path, target: &Path) -> Result<(), WorkspaceError> {
    if target == root || target.starts_with(root) {
        Ok(())
    } else {
        Err(WorkspaceError::ResolvedPathOutsideRoot {
            root: root.to_path_buf(),
            resolved_path: target.to_path_buf(),
        })
    }
}

pub fn to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
