use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use thiserror::Error;
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use uuid::Uuid;

const SECRET_FILE_SUFFIX: &str = ".bin";
const MAX_SECRET_NAME_LEN: usize = 128;

#[derive(Debug, Error)]
pub enum SecretStoreError {
    #[error("failed to create secret store directory {path}")]
    Initialize {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to set restrictive permissions on secret store directory {path}")]
    SecureDirectory {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("secret name {name:?} is not a safe internal filename segment")]
    InvalidName { name: String },
    #[error("failed to read secret {name:?} from {path}")]
    Read {
        name: String,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to enumerate secret store directory {path}")]
    Enumerate {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to generate a temporary path for secret {name:?}")]
    TemporaryPath {
        name: String,
        #[source]
        source: getrandom::Error,
    },
    #[error("failed to {operation} secret {name:?} at {path}")]
    Persist {
        name: String,
        path: PathBuf,
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error(
        "failed to {operation} secret {name:?} at {path}; cleanup also failed: {cleanup_error}"
    )]
    PersistAndCleanup {
        name: String,
        path: PathBuf,
        operation: &'static str,
        #[source]
        source: io::Error,
        cleanup_error: io::Error,
    },
    #[error("secret {name:?} already exists at {path}")]
    AlreadyExists {
        name: String,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(
        "secret {name:?} already exists at {path}; failed to clean up {temporary_path}: {cleanup_error}"
    )]
    AlreadyExistsAndCleanup {
        name: String,
        path: PathBuf,
        temporary_path: PathBuf,
        #[source]
        source: io::Error,
        cleanup_error: io::Error,
    },
    #[error("failed to generate random bytes for secret {name:?}")]
    RandomGeneration {
        name: String,
        #[source]
        source: getrandom::Error,
    },
    #[error("secret {name:?} disappeared after a concurrent creator won the race")]
    ConcurrentRead { name: String, path: PathBuf },
}

impl SecretStoreError {
    #[must_use]
    pub const fn is_already_exists(&self) -> bool {
        matches!(
            self,
            Self::AlreadyExists { .. } | Self::AlreadyExistsAndCleanup { .. }
        )
    }
}

pub type Result<T> = std::result::Result<T, SecretStoreError>;

#[derive(Clone, Debug)]
pub struct SecretStore {
    root: PathBuf,
}

impl SecretStore {
    pub async fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .await
            .map_err(|source| SecretStoreError::Initialize {
                path: root.clone(),
                source,
            })?;

        secure_directory(&root)
            .await
            .map_err(|source| SecretStoreError::SecureDirectory {
                path: root.clone(),
                source,
            })?;

        Ok(Self { root })
    }

    pub async fn get(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let path = self.secret_path(name)?;
        if let Err(source) = secure_file(&path).await {
            if source.kind() == io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(SecretStoreError::Persist {
                name: name.to_owned(),
                path,
                operation: "secure existing",
                source,
            });
        }
        match fs::read(&path).await {
            Ok(value) => Ok(Some(value)),
            Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(SecretStoreError::Read {
                name: name.to_owned(),
                path,
                source,
            }),
        }
    }

    pub async fn create(&self, name: &str, value: &[u8]) -> Result<()> {
        let path = self.secret_path(name)?;
        let temporary_path = self.write_temporary(name, value).await?;

        // A hard link publishes the fully-synced inode with create-new
        // semantics, so racing readers cannot observe a partial secret.
        match fs::hard_link(&temporary_path, &path).await {
            Ok(()) => remove_published_temporary(name, &temporary_path).await,
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                Err(already_exists_error_after_cleanup(name, path, temporary_path, source).await)
            }
            Err(source) => {
                Err(
                    persist_error_after_cleanup(name, &temporary_path, "atomically create", source)
                        .await,
                )
            }
        }
    }

    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "provider secret rotation uses atomic replacement in Task 11"
        )
    )]
    pub async fn set(&self, name: &str, value: &[u8]) -> Result<()> {
        let path = self.secret_path(name)?;
        let temporary_path = self.write_temporary(name, value).await?;
        match fs::rename(&temporary_path, &path).await {
            Ok(()) => Ok(()),
            Err(source) if should_use_windows_replace(&source) => {
                replace_existing_secret(name, &temporary_path, &path).await
            }
            Err(source) => {
                Err(persist_error_after_cleanup(name, &temporary_path, "replace", source).await)
            }
        }
    }

    pub async fn get_or_create_random(&self, name: &str, bytes: usize) -> Result<Vec<u8>> {
        if let Some(existing) = self.get(name).await? {
            return Ok(existing);
        }

        let mut generated = vec![0_u8; bytes];
        getrandom::fill(&mut generated).map_err(|source| SecretStoreError::RandomGeneration {
            name: name.to_owned(),
            source,
        })?;

        match self.create(name, &generated).await {
            Ok(()) => Ok(generated),
            Err(error) if error.is_already_exists() => {
                self.get(name)
                    .await?
                    .ok_or_else(|| SecretStoreError::ConcurrentRead {
                        name: name.to_owned(),
                        path: self.root.join(secret_filename(name)),
                    })
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn prune_records_with_prefix<F>(
        &self,
        prefix: &str,
        should_remove: F,
    ) -> Result<usize>
    where
        F: Fn(&[u8]) -> bool,
    {
        validate_name(prefix)?;
        let required_prefix = format!("{prefix}-");
        let mut entries =
            fs::read_dir(&self.root)
                .await
                .map_err(|source| SecretStoreError::Enumerate {
                    path: self.root.clone(),
                    source,
                })?;
        let mut retained = 0_usize;
        while let Some(entry) =
            entries
                .next_entry()
                .await
                .map_err(|source| SecretStoreError::Enumerate {
                    path: self.root.clone(),
                    source,
                })?
        {
            let Some(filename) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(name) = filename.strip_suffix(SECRET_FILE_SUFFIX) else {
                continue;
            };
            if !name.starts_with(&required_prefix) || validate_name(name).is_err() {
                continue;
            }
            let path = entry.path();
            let value = match fs::read(&path).await {
                Ok(value) => value,
                Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
                Err(source) => {
                    return Err(SecretStoreError::Read {
                        name: name.to_owned(),
                        path,
                        source,
                    });
                }
            };
            if should_remove(&value) {
                match fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                    Err(source) => {
                        return Err(SecretStoreError::Persist {
                            name: name.to_owned(),
                            path,
                            operation: "remove expired",
                            source,
                        });
                    }
                }
            } else {
                retained = retained.saturating_add(1);
            }
        }
        Ok(retained)
    }

    fn secret_path(&self, name: &str) -> Result<PathBuf> {
        validate_name(name)?;
        Ok(self.root.join(secret_filename(name)))
    }

    fn temporary_path(&self, name: &str) -> Result<PathBuf> {
        let mut random_bytes = [0_u8; 16];
        getrandom::fill(&mut random_bytes).map_err(|source| SecretStoreError::TemporaryPath {
            name: name.to_owned(),
            source,
        })?;
        let id = Uuid::from_bytes(random_bytes);
        Ok(self
            .root
            .join(format!("{}.{id}.tmp", secret_filename(name))))
    }

    async fn write_temporary(&self, name: &str, value: &[u8]) -> Result<PathBuf> {
        let temporary_path = self.temporary_path(name)?;
        let options = secure_create_new_options();
        let mut file =
            options
                .open(&temporary_path)
                .await
                .map_err(|source| SecretStoreError::Persist {
                    name: name.to_owned(),
                    path: temporary_path.clone(),
                    operation: "create temporary file for",
                    source,
                })?;

        if let Err(source) = file.write_all(value).await {
            drop(file);
            return Err(persist_error_after_cleanup(name, &temporary_path, "write", source).await);
        }

        if let Err(source) = secure_file(&temporary_path).await {
            drop(file);
            return Err(persist_error_after_cleanup(name, &temporary_path, "secure", source).await);
        }

        if let Err(source) = file.sync_all().await {
            drop(file);
            return Err(persist_error_after_cleanup(name, &temporary_path, "sync", source).await);
        }
        drop(file);

        Ok(temporary_path)
    }
}

fn validate_name(name: &str) -> Result<()> {
    let valid_characters = name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if name.is_empty()
        || name.len() > MAX_SECRET_NAME_LEN
        || !valid_characters
        || is_windows_reserved_name(name)
    {
        return Err(SecretStoreError::InvalidName {
            name: name.to_owned(),
        });
    }

    Ok(())
}

fn should_use_windows_replace(error: &io::Error) -> bool {
    cfg!(windows)
        && matches!(
            error.kind(),
            io::ErrorKind::AlreadyExists | io::ErrorKind::PermissionDenied
        )
}

async fn replace_existing_secret(
    name: &str,
    temporary_path: &Path,
    target_path: &Path,
) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
        };

        let replacement = temporary_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let target = target_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let secret_name = name.to_owned();
        let path = target_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            // SAFETY: Both paths are valid NUL-terminated UTF-16 strings.
            if unsafe {
                ReplaceFileW(
                    target.as_ptr(),
                    replacement.as_ptr(),
                    std::ptr::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            } != 0
                || unsafe {
                    MoveFileExW(
                        replacement.as_ptr(),
                        target.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } != 0
            {
                Ok(())
            } else {
                Err(SecretStoreError::Persist {
                    name: secret_name,
                    path,
                    operation: "replace",
                    source: io::Error::last_os_error(),
                })
            }
        })
        .await
        .map_err(|error| SecretStoreError::Persist {
            name: name.to_owned(),
            path: target_path.to_path_buf(),
            operation: "replace",
            source: io::Error::other(error),
        })?
    }

    #[cfg(not(windows))]
    fs::rename(temporary_path, target_path)
        .await
        .map_err(|source| SecretStoreError::Persist {
            name: name.to_owned(),
            path: target_path.to_path_buf(),
            operation: "replace",
            source,
        })
}

fn is_windows_reserved_name(name: &str) -> bool {
    let uppercase = name.to_ascii_uppercase();
    if matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }

    if uppercase.len() != 4 {
        return false;
    }
    let (prefix, suffix) = uppercase.split_at(3);
    matches!(prefix, "COM" | "LPT") && matches!(suffix.as_bytes(), [b'1'..=b'9'])
}

fn secret_filename(name: &str) -> String {
    format!("{name}{SECRET_FILE_SUFFIX}")
}

fn secure_create_new_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
}

#[cfg(unix)]
async fn secure_directory(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await
}

#[cfg(unix)]
async fn secure_file(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(windows)]
async fn secure_directory(path: &Path) -> io::Result<()> {
    secure_windows_path(path, true).await
}

#[cfg(windows)]
async fn secure_file(path: &Path) -> io::Result<()> {
    secure_windows_path(path, false).await
}

#[cfg(windows)]
async fn secure_windows_path(path: &Path, inheritable: bool) -> io::Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || set_restrictive_windows_acl(&path, inheritable))
        .await
        .map_err(io::Error::other)?
}

#[cfg(windows)]
fn set_restrictive_windows_acl(path: &Path, inheritable: bool) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree},
        Security::{
            Authorization::{
                EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS,
                SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
                TRUSTEE_W,
            },
            DACL_SECURITY_INFORMATION, GetTokenInformation, PROTECTED_DACL_SECURITY_INFORMATION,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `token` is a valid out pointer and the pseudo process handle is valid.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let result = (|| {
        let mut required_bytes = 0_u32;
        // SAFETY: This sizing call intentionally supplies no destination buffer.
        unsafe {
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required_bytes);
        }
        if required_bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let word_bytes = std::mem::size_of::<usize>();
        let word_count = usize::try_from(required_bytes)
            .ok()
            .and_then(|bytes| bytes.checked_add(word_bytes - 1))
            .map(|bytes| bytes / word_bytes)
            .ok_or_else(|| io::Error::other("Windows token information is too large"))?;
        let mut token_buffer = vec![0_usize; word_count];
        // SAFETY: The aligned buffer has at least `required_bytes` writable bytes.
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                token_buffer.as_mut_ptr().cast::<c_void>(),
                required_bytes,
                &mut required_bytes,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: A successful TokenUser query initializes a TOKEN_USER at the buffer start.
        let user_sid = unsafe { (*(token_buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let inheritance = if inheritable {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            0
        };
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: user_sid.cast(),
            },
        };
        let mut acl = ptr::null_mut();
        // SAFETY: The entry and output ACL pointers are valid for the duration of the call.
        let acl_status = unsafe { SetEntriesInAclW(1, &entry, ptr::null(), &mut acl) };
        if acl_status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(acl_status.cast_signed()));
        }

        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: The path is NUL-terminated and `acl` is owned until LocalFree below.
        let set_status = unsafe {
            SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        };
        // SAFETY: SetEntriesInAclW allocated `acl` with LocalAlloc on success.
        unsafe {
            LocalFree(acl.cast());
        }
        if set_status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(set_status.cast_signed()))
        }
    })();

    // SAFETY: OpenProcessToken returned an owned real handle.
    unsafe {
        CloseHandle(token);
    }
    result
}

async fn persist_error_after_cleanup(
    name: &str,
    path: &Path,
    operation: &'static str,
    source: io::Error,
) -> SecretStoreError {
    match fs::remove_file(path).await {
        Ok(()) => SecretStoreError::Persist {
            name: name.to_owned(),
            path: path.to_path_buf(),
            operation,
            source,
        },
        Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => {
            SecretStoreError::Persist {
                name: name.to_owned(),
                path: path.to_path_buf(),
                operation,
                source,
            }
        }
        Err(cleanup_error) => SecretStoreError::PersistAndCleanup {
            name: name.to_owned(),
            path: path.to_path_buf(),
            operation,
            source,
            cleanup_error,
        },
    }
}

async fn already_exists_error_after_cleanup(
    name: &str,
    path: PathBuf,
    temporary_path: PathBuf,
    source: io::Error,
) -> SecretStoreError {
    match fs::remove_file(&temporary_path).await {
        Ok(()) => SecretStoreError::AlreadyExists {
            name: name.to_owned(),
            path,
            source,
        },
        Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => {
            SecretStoreError::AlreadyExists {
                name: name.to_owned(),
                path,
                source,
            }
        }
        Err(cleanup_error) => SecretStoreError::AlreadyExistsAndCleanup {
            name: name.to_owned(),
            path,
            temporary_path,
            source,
            cleanup_error,
        },
    }
}

async fn remove_published_temporary(name: &str, temporary_path: &Path) -> Result<()> {
    fs::remove_file(temporary_path)
        .await
        .map_err(|source| SecretStoreError::Persist {
            name: name.to_owned(),
            path: temporary_path.to_path_buf(),
            operation: "remove published temporary link for",
            source,
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use tempfile::TempDir;
    use tokio::{sync::Barrier, task::JoinSet};

    async fn test_store() -> (TempDir, SecretStore) {
        let temp_dir = tempfile::tempdir().expect("create temporary test directory");
        let store = SecretStore::new(temp_dir.path().join("secrets"))
            .await
            .expect("create secret store");
        (temp_dir, store)
    }

    #[tokio::test]
    async fn missing_secret_returns_none() {
        let (_temp_dir, store) = test_store().await;

        assert_eq!(store.get("missing-secret").await.unwrap(), None);
    }

    #[tokio::test]
    async fn get_or_create_random_reuses_existing_value() {
        let (_temp_dir, store) = test_store().await;
        let existing = b"existing-value";
        store.create("session-signing-key", existing).await.unwrap();

        let value = store
            .get_or_create_random("session-signing-key", 32)
            .await
            .unwrap();

        assert_eq!(value, existing);
    }

    #[tokio::test]
    async fn concurrent_creators_return_the_same_persisted_value() {
        const CREATORS: usize = 16;

        let (_temp_dir, store) = test_store().await;
        let barrier = Arc::new(Barrier::new(CREATORS));
        let mut tasks = JoinSet::new();

        for _ in 0..CREATORS {
            let store = SecretStore::new(&store.root).await.unwrap();
            let barrier = Arc::clone(&barrier);
            tasks.spawn(async move {
                barrier.wait().await;
                store.get_or_create_random("session-signing-key", 32).await
            });
        }

        let mut winner = None;
        while let Some(result) = tasks.join_next().await {
            let value = result.expect("creator task completed").unwrap();
            assert_eq!(value.len(), 32);
            if let Some(winner) = &winner {
                assert_eq!(&value, winner);
            } else {
                winner = Some(value);
            }
        }

        assert_eq!(
            store.get("session-signing-key").await.unwrap(),
            winner.map(Some).unwrap()
        );
    }

    #[tokio::test]
    async fn create_classifies_existing_secret_distinctly() {
        let (_temp_dir, store) = test_store().await;
        store.create("only-once", b"first").await.unwrap();

        let error = store.create("only-once", b"second").await.unwrap_err();

        assert!(error.is_already_exists());
        assert!(matches!(error, SecretStoreError::AlreadyExists { .. }));
        assert_eq!(store.get("only-once").await.unwrap().unwrap(), b"first");
    }

    #[tokio::test]
    async fn set_atomically_replaces_an_existing_secret() {
        let (temp_dir, store) = test_store().await;
        store.create("replaceable", b"first").await.unwrap();

        store.set("replaceable", b"second").await.unwrap();

        assert_eq!(store.get("replaceable").await.unwrap().unwrap(), b"second");

        let replace_error = io::Error::new(io::ErrorKind::AlreadyExists, "fixture");
        #[cfg(windows)]
        assert!(should_use_windows_replace(&replace_error));
        #[cfg(not(windows))]
        assert!(!should_use_windows_replace(&replace_error));
        assert!(
            replace_existing_secret(
                "missing",
                &temp_dir.path().join("missing-temporary"),
                &temp_dir.path().join("missing-target"),
            )
            .await
            .is_err()
        );
        assert!(matches!(
            persist_error_after_cleanup(
                "missing",
                &temp_dir.path().join("missing-cleanup"),
                "fixture",
                io::Error::other("fixture"),
            )
            .await,
            SecretStoreError::Persist { .. }
        ));
        assert!(
            remove_published_temporary("missing", &temp_dir.path().join("missing-published"))
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn store_uses_restrictive_unix_permissions() {
        let (_temp_dir, store) = test_store().await;
        store.create("restricted", b"value").await.unwrap();

        let directory_mode = fs::metadata(&store.root)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(store.secret_path("restricted").unwrap())
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }

    #[tokio::test]
    async fn unsafe_names_are_rejected() {
        let (temp_dir, store) = test_store().await;

        for name in [
            "",
            ".",
            "..",
            "../outside",
            "nested/secret",
            r"nested\secret",
            "white space",
            "secret.bin",
            "NUL",
        ] {
            let error = store.create(name, b"value").await.unwrap_err();
            assert!(
                matches!(error, SecretStoreError::InvalidName { .. }),
                "unexpected error for {name:?}: {error}"
            );
        }

        let blocker = temp_dir.path().join("blocker");
        fs::write(&blocker, "not a directory").await.unwrap();
        assert!(matches!(
            SecretStore::new(blocker.join("secrets")).await,
            Err(SecretStoreError::Initialize { .. })
        ));

        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&store.root).await.unwrap().permissions();
            permissions.set_mode(0o500);
            fs::set_permissions(&store.root, permissions).await.unwrap();
            assert!(matches!(
                store.create("blocked", b"value").await,
                Err(SecretStoreError::Persist { .. })
            ));
            let mut permissions = fs::metadata(&store.root).await.unwrap().permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&store.root, permissions).await.unwrap();
        }
    }
}
