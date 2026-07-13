use std::{
    collections::BTreeSet,
    io,
    path::{Path, PathBuf},
};

use thiserror::Error;

const KNOWN_SHARED_DIRECTORIES: &[&str] = &[
    "sessions",
    "archived_sessions",
    "sqlite",
    "shell_snapshots",
    "worktrees",
    "skills",
    "plugins",
    "cache",
    "logs",
];
const PRIVATE_ENTRIES: &[&str] = &["auth.json", "models_cache.json"];
const SHADOW_LOCAL_ENTRIES: &[&str] = &["log", "memories", "tmp"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexHomeLayout {
    pub shared_home_path: PathBuf,
    pub effective_home_path: Option<PathBuf>,
    pub continuation_key: String,
    overlay: bool,
}

impl CodexHomeLayout {
    #[must_use]
    pub fn is_overlay(&self) -> bool {
        self.overlay
    }
}

#[derive(Debug, Error)]
pub enum CodexHomeLayoutError {
    #[error("Codex home path '{effective}' must be different from shared home '{shared}'")]
    PathConflict { shared: PathBuf, effective: PathBuf },
    #[error("Codex shadow entry '{path}' already exists and is not a symlink")]
    EntryConflict { path: PathBuf },
    #[error("Codex private auth entry '{path}' must be a real file, not a symlink")]
    PrivateAuthSymlink { path: PathBuf },
    #[error("Codex home filesystem operation '{operation}' failed for '{path}': {source}")]
    FileSystem {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[must_use]
pub fn resolve_codex_home_layout(
    home_path: Option<&str>,
    shadow_home_path: Option<&str>,
    user_home: &Path,
) -> CodexHomeLayout {
    let configured_home = home_path.map(str::trim).filter(|value| !value.is_empty());
    let shared_home_path = resolve_home_path(configured_home.unwrap_or("~/.codex"), user_home);
    let shadow_home_path = shadow_home_path
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let effective_home_path = shadow_home_path
        .map(|value| resolve_home_path(value, user_home))
        .or_else(|| configured_home.map(|_| shared_home_path.clone()));
    CodexHomeLayout {
        continuation_key: format!("codex:home:{}", shared_home_path.display()),
        shared_home_path,
        effective_home_path,
        overlay: shadow_home_path.is_some(),
    }
}

pub async fn materialize_codex_shadow_home(
    layout: &CodexHomeLayout,
) -> Result<(), CodexHomeLayoutError> {
    if !layout.is_overlay() {
        return Ok(());
    }
    let Some(effective_home) = layout.effective_home_path.as_ref() else {
        return Ok(());
    };
    if effective_home == &layout.shared_home_path {
        return Err(CodexHomeLayoutError::PathConflict {
            shared: layout.shared_home_path.clone(),
            effective: effective_home.clone(),
        });
    }

    create_dir_all(&layout.shared_home_path).await?;
    create_dir_all(effective_home).await?;
    for directory in KNOWN_SHARED_DIRECTORIES {
        create_dir_all(&layout.shared_home_path.join(directory)).await?;
    }

    let mut entries = KNOWN_SHARED_DIRECTORIES
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect::<BTreeSet<_>>();
    let mut directory = tokio::fs::read_dir(&layout.shared_home_path)
        .await
        .map_err(|source| fs_error("readDirectory", &layout.shared_home_path, source))?;
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|source| fs_error("readDirectory", &layout.shared_home_path, source))?
    {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if !PRIVATE_ENTRIES.contains(&entry_name.as_str())
            && !SHADOW_LOCAL_ENTRIES.contains(&entry_name.as_str())
        {
            entries.insert(entry_name);
        }
    }

    let auth_path = effective_home.join("auth.json");
    if is_symlink(&auth_path).await? {
        return Err(CodexHomeLayoutError::PrivateAuthSymlink { path: auth_path });
    }
    let model_cache_path = effective_home.join("models_cache.json");
    if is_symlink(&model_cache_path).await? {
        tokio::fs::remove_file(&model_cache_path)
            .await
            .map_err(|source| fs_error("remove", &model_cache_path, source))?;
    }

    for entry_name in entries {
        ensure_shared_link(
            &layout.shared_home_path.join(&entry_name),
            &effective_home.join(entry_name),
        )
        .await?;
    }
    Ok(())
}

fn resolve_home_path(value: &str, user_home: &Path) -> PathBuf {
    let path = if value == "~" {
        user_home.to_path_buf()
    } else if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        user_home.join(relative)
    } else {
        PathBuf::from(value)
    };
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

async fn create_dir_all(path: &Path) -> Result<(), CodexHomeLayoutError> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|source| fs_error("makeDirectory", path, source))
}

async fn is_symlink(path: &Path) -> Result<bool, CodexHomeLayoutError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(fs_error("readLink", path, source)),
    }
}

async fn ensure_shared_link(target: &Path, link: &Path) -> Result<(), CodexHomeLayoutError> {
    match tokio::fs::symlink_metadata(link).await {
        Ok(metadata) if !metadata.file_type().is_symlink() => {
            #[cfg(windows)]
            if target.is_file() && metadata.is_file() && same_windows_file(target, link)? {
                return Ok(());
            }
            return Err(CodexHomeLayoutError::EntryConflict { path: link.into() });
        }
        Ok(_) => {
            let existing = tokio::fs::read_link(link)
                .await
                .map_err(|source| fs_error("readLink", link, source))?;
            let resolved = if existing.is_absolute() {
                existing
            } else {
                link.parent()
                    .unwrap_or_else(|| Path::new(""))
                    .join(existing)
            };
            if resolved == target {
                return Ok(());
            }
            tokio::fs::remove_file(link)
                .await
                .map_err(|source| fs_error("remove", link, source))?;
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(source) => return Err(fs_error("readLink", link, source)),
    }
    create_symlink(target, link).map_err(|source| fs_error("symlink", link, source))
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> io::Result<()> {
    if target.is_dir() {
        junction::create(target, link)
    } else {
        std::fs::hard_link(target, link)
    }
}

#[cfg(windows)]
fn same_windows_file(left: &Path, right: &Path) -> Result<bool, CodexHomeLayoutError> {
    use std::{fs::File, mem::MaybeUninit, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    fn identity(path: &Path) -> Result<(u32, u64), CodexHomeLayoutError> {
        let file = File::open(path).map_err(|source| fs_error("open", path, source))?;
        let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        // SAFETY: `information` points to writable storage of the exact structure expected by
        // `GetFileInformationByHandle`, and the file handle remains valid for the call.
        let succeeded = unsafe {
            GetFileInformationByHandle(file.as_raw_handle() as _, information.as_mut_ptr())
        };
        if succeeded == 0 {
            return Err(fs_error("readIdentity", path, io::Error::last_os_error()));
        }
        // SAFETY: Windows initialized the structure after returning a nonzero result.
        let information = unsafe { information.assume_init() };
        Ok((
            information.dwVolumeSerialNumber,
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        ))
    }

    Ok(identity(left)? == identity(right)?)
}

fn fs_error(operation: &'static str, path: &Path, source: io::Error) -> CodexHomeLayoutError {
    CodexHomeLayoutError::FileSystem {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_direct_and_overlay_homes() {
        let user_home = Path::new("C:/Users/tester");
        let direct = resolve_codex_home_layout(None, None, user_home);
        assert_eq!(direct.shared_home_path, user_home.join(".codex"));
        assert_eq!(direct.effective_home_path, None);

        let configured = resolve_codex_home_layout(Some("~/custom-codex"), None, user_home);
        assert_eq!(
            configured.effective_home_path,
            Some(user_home.join("custom-codex"))
        );
        assert!(!configured.is_overlay());

        let overlay =
            resolve_codex_home_layout(Some("~/shared-codex"), Some("~/private-codex"), user_home);
        assert_eq!(overlay.shared_home_path, user_home.join("shared-codex"));
        assert_eq!(
            overlay.effective_home_path,
            Some(user_home.join("private-codex"))
        );
        assert_eq!(
            overlay.continuation_key,
            format!("codex:home:{}", user_home.join("shared-codex").display())
        );
    }

    #[tokio::test]
    async fn rejects_identical_overlay_path() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let layout = resolve_codex_home_layout(
            Some(temporary.path().to_str().expect("utf8")),
            Some(temporary.path().to_str().expect("utf8")),
            temporary.path(),
        );
        assert!(matches!(
            materialize_codex_shadow_home(&layout).await,
            Err(CodexHomeLayoutError::PathConflict { .. })
        ));
    }

    #[tokio::test]
    async fn materializes_shared_entries_without_linking_private_files() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let shared = temporary.path().join("shared");
        let shadow = temporary.path().join("shadow");
        tokio::fs::create_dir_all(&shared)
            .await
            .expect("shared home");
        tokio::fs::write(shared.join("config.toml"), "model = 'test'")
            .await
            .expect("shared config");
        tokio::fs::write(shared.join("auth.json"), "shared-secret")
            .await
            .expect("shared auth");
        let layout = resolve_codex_home_layout(
            Some(shared.to_str().expect("utf8")),
            Some(shadow.to_str().expect("utf8")),
            temporary.path(),
        );

        materialize_codex_shadow_home(&layout)
            .await
            .expect("materialize overlay");

        #[cfg(unix)]
        assert!(
            tokio::fs::symlink_metadata(shadow.join("config.toml"))
                .await
                .expect("config metadata")
                .file_type()
                .is_symlink()
        );
        #[cfg(windows)]
        assert!(
            same_windows_file(&shared.join("config.toml"), &shadow.join("config.toml"))
                .expect("hard-link identity")
        );
        assert!(
            tokio::fs::symlink_metadata(shadow.join("sessions"))
                .await
                .expect("sessions metadata")
                .file_type()
                .is_symlink()
        );
        assert!(!shadow.join("auth.json").exists());
        materialize_codex_shadow_home(&layout)
            .await
            .expect("overlay is idempotent");
    }
}
