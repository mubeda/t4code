use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};

use thiserror::Error;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

pub(crate) const SERVER_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const SERVER_LOG_BACKUPS: usize = 3;
const TRUNCATION_MARKER: &[u8] = b"\n[truncated]\n";
static INITIALIZE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_LOG_WRITER: OnceLock<LogWriter> = OnceLock::new();
#[cfg(test)]
pub(crate) static TEST_INITIALIZE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone)]
struct LogWriter(Arc<Mutex<RotatingFile>>);

impl LogWriter {
    fn replace(&self, file: RotatingFile) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = file;
    }
}

struct LogWriterGuard<'a>(MutexGuard<'a, RotatingFile>);

struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    max_bytes: u64,
    backups: usize,
}

impl RotatingFile {
    fn open(path: PathBuf, max_bytes: u64, backups: usize) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes,
            max_bytes: max_bytes.max(1),
            backups,
        })
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.take();
        if self.backups > 0 {
            let oldest = backup_path(&self.path, self.backups);
            remove_if_exists(&oldest)?;
            for index in (2..=self.backups).rev() {
                let source = backup_path(&self.path, index - 1);
                if source.exists() {
                    std::fs::rename(source, backup_path(&self.path, index))?;
                }
            }
            if self.path.exists() {
                std::fs::rename(&self.path, backup_path(&self.path, 1))?;
            }
        } else {
            remove_if_exists(&self.path)?;
        }
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        self.bytes = 0;
        Ok(())
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

pub(crate) fn retained_server_log_paths(path: &Path) -> Vec<PathBuf> {
    (1..=SERVER_LOG_BACKUPS)
        .rev()
        .map(|index| backup_path(path, index))
        .chain(std::iter::once(path.to_path_buf()))
        .collect()
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogWriter {
    type Writer = LogWriterGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LogWriterGuard(
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }
}

impl Write for LogWriterGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let original_len = buffer.len();
        let max_bytes = usize::try_from(self.0.max_bytes).unwrap_or(usize::MAX);
        let bounded;
        let buffer = if buffer.len() > max_bytes {
            let marker_len = TRUNCATION_MARKER.len().min(max_bytes);
            let content_len = max_bytes.saturating_sub(marker_len);
            bounded = [&buffer[..content_len], &TRUNCATION_MARKER[..marker_len]].concat();
            bounded.as_slice()
        } else {
            buffer
        };
        if self.0.bytes > 0 && self.0.bytes.saturating_add(buffer.len() as u64) > self.0.max_bytes {
            self.0.rotate()?;
        }
        self.0
            .file
            .as_mut()
            .expect("rotating log file is always open")
            .write_all(buffer)?;
        self.0.bytes = self.0.bytes.saturating_add(buffer.len() as u64);
        Ok(original_len)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .file
            .as_mut()
            .expect("rotating log file is always open")
            .flush()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Init {
    Installed,
    AlreadyInstalled,
}

#[derive(Debug, Error)]
pub enum LoggingError {
    #[error("failed to create native log directory {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open native log file {path}")]
    OpenFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to install native tracing subscriber: {0}")]
    InstallSubscriber(String),
}

pub fn initialize(log_path: &Path) -> Result<Init, LoggingError> {
    let filter = EnvFilter::try_from_env("T4CODE_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("info"));
    initialize_with_filter(log_path, filter)
}

fn initialize_with_filter(log_path: &Path, filter: EnvFilter) -> Result<Init, LoggingError> {
    let _guard = INITIALIZE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = log_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|source| LoggingError::CreateDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    let file = RotatingFile::open(
        log_path.to_path_buf(),
        SERVER_LOG_MAX_BYTES,
        SERVER_LOG_BACKUPS,
    )
    .map_err(|source| LoggingError::OpenFile {
        path: log_path.to_path_buf(),
        source,
    })?;
    if let Some(file_writer) = ACTIVE_LOG_WRITER.get() {
        file_writer.replace(file);
        return Ok(Init::AlreadyInstalled);
    }
    let file_writer = LogWriter(Arc::new(Mutex::new(file)));
    let stderr = tracing_subscriber::fmt::layer()
        .with_ansi(std::io::stderr().is_terminal())
        .with_writer(std::io::stderr);
    let file = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file_writer.clone());

    tracing_subscriber::registry()
        .with(filter)
        .with(stderr)
        .with(file)
        .try_init()
        .map_err(|error| LoggingError::InstallSubscriber(error.to_string()))?;
    let _ = ACTIVE_LOG_WRITER.set(file_writer);
    Ok(Init::Installed)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use tempfile::TempDir;
    use tracing_subscriber::fmt::MakeWriter as _;

    use super::*;

    #[test]
    fn native_log_files_rotate_with_a_bounded_backup_count() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("server.log");
        let writer = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(log_path.clone(), 12, 2).expect("open rotating log"),
        )));

        for line in [
            b"first-line\n".as_slice(),
            b"second-line\n".as_slice(),
            b"third-line\n".as_slice(),
        ] {
            let mut guard = writer.make_writer();
            guard.write_all(line).expect("write rotating log");
            guard.flush().expect("flush rotating log");
        }

        assert_eq!(
            std::fs::read_to_string(&log_path).expect("current log"),
            "third-line\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&log_path, 1)).expect("first backup"),
            "second-line\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&log_path, 2)).expect("second backup"),
            "first-line\n"
        );
        assert!(!backup_path(&log_path, 3).exists());
    }

    #[test]
    fn a_single_oversized_log_record_is_truncated_to_the_file_limit() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("server.log");
        let writer = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(log_path.clone(), 32, 2).expect("open rotating log"),
        )));

        let mut guard = writer.make_writer();
        guard
            .write_all(&vec![b'x'; 4 * 1024])
            .expect("write oversized log record");
        guard.flush().expect("flush oversized log record");
        drop(guard);

        assert!(std::fs::metadata(log_path).expect("log metadata").len() <= 32);
    }

    #[test]
    fn native_events_are_written_and_repeated_initialization_is_safe() {
        let _guard = TEST_INITIALIZE_LOCK.blocking_lock();
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("nested/server.log");

        let initialization = initialize_with_filter(&log_path, EnvFilter::new("info"))
            .expect("subscriber initializes or replaces the active test writer");
        tracing::info!(target: "t4code_server_logging_test", "native logging is connected");
        let replacement_path = temp.path().join("replacement/server.log");
        assert_eq!(
            initialize_with_filter(&replacement_path, EnvFilter::new("info"))
                .expect("repeated initialization is safe"),
            Init::AlreadyInstalled
        );
        tracing::info!(target: "t4code_server_logging_test", "native logging moved");

        let contents = std::fs::read_to_string(&log_path).expect("server log is readable");
        let replacement =
            std::fs::read_to_string(replacement_path).expect("replacement log is readable");
        if initialization == Init::Installed {
            assert!(contents.contains("native logging is connected"));
            assert!(!contents.contains("native logging moved"));
            assert!(replacement.contains("native logging moved"));
        }
    }
}
