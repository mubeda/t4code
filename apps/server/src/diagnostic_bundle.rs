use std::{
    fs::File,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

use thiserror::Error;
use time::OffsetDateTime;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    diagnostics::redact_sensitive_text,
    logging::{SERVER_LOG_MAX_BYTES, retained_server_log_paths},
};

const FRONTEND_LOG_MAX_BYTES: usize = 512 * 1024;
const SERVER_LOG_ENTRY: &str = "server.log";
const SERVER_TRACE_ENTRY: &str = "server.trace.ndjson";
const FRONTEND_LOG_ENTRY: &str = "frontend.log";
const EMPTY_SERVER_LOG: &str = "No retained server logs were found.\n";
const EMPTY_SERVER_TRACE: &str = "No retained server trace records were found.\n";
const EMPTY_FRONTEND_LOG: &str = "No frontend warnings or errors were captured.\n";

#[derive(Clone)]
pub struct DiagnosticBundleService {
    logs_dir: PathBuf,
}

pub struct DiagnosticBundle {
    pub filename: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum DiagnosticBundleError {
    #[error("failed to read a retained server log")]
    ReadServerLog(#[source] std::io::Error),
    #[error("failed to construct the diagnostic archive")]
    Zip(#[source] zip::result::ZipError),
    #[error("failed to write diagnostic archive contents")]
    Write(#[source] std::io::Error),
    #[error("diagnostic archive construction task failed")]
    Join(#[source] tokio::task::JoinError),
}

impl DiagnosticBundleService {
    #[must_use]
    pub fn new(logs_dir: impl AsRef<Path>) -> Self {
        Self {
            logs_dir: logs_dir.as_ref().to_path_buf(),
        }
    }

    pub async fn build(
        &self,
        frontend_log: String,
        generated_at: OffsetDateTime,
    ) -> Result<DiagnosticBundle, DiagnosticBundleError> {
        let logs_dir = self.logs_dir.clone();
        tokio::task::spawn_blocking(move || build_bundle(&logs_dir, &frontend_log, generated_at))
            .await
            .map_err(DiagnosticBundleError::Join)?
    }
}

fn build_bundle(
    logs_dir: &Path,
    frontend_log: &str,
    generated_at: OffsetDateTime,
) -> Result<DiagnosticBundle, DiagnosticBundleError> {
    let server_log = collect_server_logs(logs_dir)?;
    let server_trace = collect_retained_logs(
        &logs_dir.join(SERVER_TRACE_ENTRY),
        EMPTY_SERVER_TRACE,
    )?;
    let mut frontend_log = if frontend_log.trim().is_empty() {
        EMPTY_FRONTEND_LOG.to_owned()
    } else {
        redact_sensitive_text(&bounded_frontend_log(frontend_log))
    };
    if !frontend_log.ends_with('\n') {
        frontend_log.push('\n');
    }
    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    writer
        .start_file(SERVER_LOG_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(server_log.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    writer
        .start_file(SERVER_TRACE_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(server_trace.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    writer
        .start_file(FRONTEND_LOG_ENTRY, options)
        .map_err(DiagnosticBundleError::Zip)?;
    writer
        .write_all(frontend_log.as_bytes())
        .map_err(DiagnosticBundleError::Write)?;
    let bytes = writer
        .finish()
        .map_err(DiagnosticBundleError::Zip)?
        .into_inner();
    Ok(DiagnosticBundle {
        filename: format!(
            "t4code-diagnostics-{:04}{:02}{:02}T{:02}{:02}{:02}Z.zip",
            generated_at.year(),
            u8::from(generated_at.month()),
            generated_at.day(),
            generated_at.hour(),
            generated_at.minute(),
            generated_at.second(),
        ),
        bytes,
    })
}

fn collect_server_logs(logs_dir: &Path) -> Result<String, DiagnosticBundleError> {
    collect_retained_logs(&logs_dir.join(SERVER_LOG_ENTRY), EMPTY_SERVER_LOG)
}

fn collect_retained_logs(
    active_log: &Path,
    empty_message: &str,
) -> Result<String, DiagnosticBundleError> {
    let mut combined = String::new();
    for path in retained_server_log_paths(active_log) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(contents) = read_bounded_if_present(&path)? else {
            continue;
        };
        if contents.trim().is_empty() {
            continue;
        }
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&format!("===== {name} =====\n"));
        combined.push_str(&redact_sensitive_text(&contents));
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
    }
    if combined.is_empty() {
        Ok(empty_message.to_owned())
    } else {
        Ok(combined)
    }
}

fn read_bounded_if_present(path: &Path) -> Result<Option<String>, DiagnosticBundleError> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(DiagnosticBundleError::ReadServerLog(error)),
    };
    let limit = SERVER_LOG_MAX_BYTES.saturating_add(1);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(DiagnosticBundleError::ReadServerLog)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > SERVER_LOG_MAX_BYTES {
        bytes.truncate(usize::try_from(SERVER_LOG_MAX_BYTES).unwrap_or(usize::MAX));
        bytes.extend_from_slice(b"\n[truncated]\n");
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn bounded_frontend_log(input: &str) -> String {
    if input.len() <= FRONTEND_LOG_MAX_BYTES {
        return input.to_owned();
    }
    let mut output =
        String::from_utf8_lossy(&input.as_bytes()[..FRONTEND_LOG_MAX_BYTES]).into_owned();
    output.push_str("\n[truncated]\n");
    output
}
