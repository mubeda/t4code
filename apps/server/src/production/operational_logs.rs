use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncWriteExt,
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{persistence::StatePaths, terminal::TerminalManager};

#[derive(Clone, Copy, Debug)]
pub struct OperationalLogOptions {
    pub max_file_bytes: u64,
    pub retained_files: usize,
    pub queue_capacity: usize,
}

impl Default for OperationalLogOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: 4 * 1024 * 1024,
            retained_files: 3,
            queue_capacity: 256,
        }
    }
}

pub struct OperationalLogs {
    provider: ProviderOperationalLog,
    terminal: TerminalOperationalLog,
    terminal_cancellation: CancellationToken,
    terminal_worker: Mutex<Option<JoinHandle<()>>>,
}

impl OperationalLogs {
    pub async fn start(
        paths: &StatePaths,
        terminal_manager: &TerminalManager,
        options: OperationalLogOptions,
    ) -> Result<Self, String> {
        let provider =
            ProviderOperationalLog::start(paths.provider_event_log.clone(), options).await?;
        let terminal_path = paths.terminal_logs_dir.join("events.log");
        let terminal = match TerminalOperationalLog::start(terminal_path, options).await {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = provider.shutdown().await;
                return Err(error);
            }
        };
        let mut events = terminal_manager.subscribe_events();
        let terminal_cancellation = CancellationToken::new();
        let worker_cancellation = terminal_cancellation.clone();
        let worker_log = terminal.clone();
        let terminal_worker = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = worker_cancellation.cancelled() => {
                        while let Ok(event) = events.try_recv() {
                            let _ = worker_log.record(&event);
                        }
                        return;
                    }
                    result = events.recv() => match result {
                        Ok(event) => { let _ = worker_log.record(&event); }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "terminal operational log subscriber lagged");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
        Ok(Self {
            provider,
            terminal,
            terminal_cancellation,
            terminal_worker: Mutex::new(Some(terminal_worker)),
        })
    }

    #[must_use]
    pub fn provider(&self) -> ProviderOperationalLog {
        self.provider.clone()
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.terminal_cancellation.cancel();
        if let Some(worker) = self.terminal_worker.lock().await.take() {
            worker
                .await
                .map_err(|error| format!("terminal operational log task failed: {error}"))?;
        }
        let terminal_result = self.terminal.shutdown().await;
        let provider_result = self.provider.shutdown().await;
        terminal_result.and(provider_result)
    }
}

#[derive(Clone)]
pub struct ProviderOperationalLog {
    writer: BoundedNdjsonWriter,
}

impl ProviderOperationalLog {
    pub async fn start(path: PathBuf, options: OperationalLogOptions) -> Result<Self, String> {
        Ok(Self {
            writer: BoundedNdjsonWriter::start(path, options).await?,
        })
    }

    #[must_use]
    pub fn record(&self, event: &crate::production::provider_runtime::ProviderEvent) -> bool {
        let summary = ProviderEventSummary {
            timestamp: timestamp(),
            event_type: &event.event_type,
            thread_id: &event.thread_id,
            turn_id: event.turn_id.as_deref(),
            request_id: event.request_id.as_deref(),
            status: provider_status(&event.event_type),
        };
        serde_json::to_value(summary)
            .ok()
            .is_some_and(|record| self.writer.try_write(record))
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.writer.shutdown().await
    }
}

#[derive(Clone)]
pub struct TerminalOperationalLog {
    writer: BoundedNdjsonWriter,
}

impl TerminalOperationalLog {
    pub async fn start(path: PathBuf, options: OperationalLogOptions) -> Result<Self, String> {
        Ok(Self {
            writer: BoundedNdjsonWriter::start(path, options).await?,
        })
    }

    #[must_use]
    pub fn record(&self, event: &crate::terminal::TerminalEvent) -> bool {
        use crate::terminal::TerminalEvent;

        let timestamp = timestamp();
        let record = match event {
            TerminalEvent::Started {
                thread_id,
                terminal_id,
                sequence,
                snapshot,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "start",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "status": snapshot.status.as_str(),
                "pid": snapshot.pid,
            }),
            TerminalEvent::Restarted {
                thread_id,
                terminal_id,
                sequence,
                snapshot,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "restart",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "status": snapshot.status.as_str(),
                "pid": snapshot.pid,
            }),
            TerminalEvent::Output {
                thread_id,
                terminal_id,
                sequence,
                data,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "activity",
                "activityType": "output",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "byteCount": data.len(),
            }),
            TerminalEvent::Activity {
                thread_id,
                terminal_id,
                sequence,
                has_running_subprocess,
                ..
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "activity",
                "activityType": "subprocess",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "hasRunningSubprocess": has_running_subprocess,
            }),
            TerminalEvent::Exited {
                thread_id,
                terminal_id,
                sequence,
                exit_code,
                exit_signal,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "exit",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "status": "exited",
                "exitCode": exit_code,
                "exitSignal": exit_signal,
            }),
            TerminalEvent::Closed {
                thread_id,
                terminal_id,
                sequence,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "close",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "status": "closed",
            }),
            TerminalEvent::Error {
                thread_id,
                terminal_id,
                sequence,
                ..
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "error",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
                "status": "error",
            }),
            TerminalEvent::Cleared {
                thread_id,
                terminal_id,
                sequence,
            } => serde_json::json!({
                "timestamp": timestamp,
                "eventType": "clear",
                "threadId": thread_id,
                "terminalId": terminal_id,
                "sequence": sequence,
            }),
        };
        self.writer.try_write(record)
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.writer.shutdown().await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderEventSummary<'a> {
    timestamp: String,
    event_type: &'a str,
    thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a str>,
    status: &'static str,
}

fn provider_status(event_type: &str) -> &'static str {
    let suffix = event_type.rsplit('.').next().unwrap_or_default();
    match suffix {
        "started" | "running" => "running",
        "completed" | "resolved" => "completed",
        "failed" | "error" => "error",
        "cancelled" | "canceled" => "cancelled",
        "interrupted" => "interrupted",
        _ => "observed",
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

enum WriterMessage {
    Record(Value),
    Shutdown(oneshot::Sender<()>),
}

type WriterTask = JoinHandle<Result<(), String>>;

#[derive(Clone)]
pub struct BoundedNdjsonWriter {
    sender: mpsc::Sender<WriterMessage>,
    worker: Arc<Mutex<Option<WriterTask>>>,
}

impl BoundedNdjsonWriter {
    pub async fn start(path: PathBuf, options: OperationalLogOptions) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let (sender, receiver) = mpsc::channel(options.queue_capacity.max(1));
        let worker = tokio::spawn(run_writer(path, options, receiver));
        Ok(Self {
            sender,
            worker: Arc::new(Mutex::new(Some(worker))),
        })
    }

    #[must_use]
    pub fn try_write(&self, record: Value) -> bool {
        self.sender.try_send(WriterMessage::Record(record)).is_ok()
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        let mut worker = self.worker.lock().await;
        let Some(handle) = worker.take() else {
            return Ok(());
        };
        let (completed_tx, completed_rx) = oneshot::channel();
        let _ = self
            .sender
            .send(WriterMessage::Shutdown(completed_tx))
            .await;
        let _ = completed_rx.await;
        handle
            .await
            .map_err(|error| format!("operational log writer task failed: {error}"))?
    }
}

async fn run_writer(
    path: PathBuf,
    options: OperationalLogOptions,
    mut receiver: mpsc::Receiver<WriterMessage>,
) -> Result<(), String> {
    let retained_files = options.retained_files.max(1);
    let max_file_bytes = options.max_file_bytes.max(1);
    reconcile_existing_files(&path, retained_files, max_file_bytes)
        .await
        .map_err(io_message)?;
    let (mut file, mut file_bytes) = open_append(&path).await.map_err(io_message)?;

    while let Some(message) = receiver.recv().await {
        match message {
            WriterMessage::Record(record) => {
                let mut line = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
                line.push(b'\n');
                if line.len() as u64 > max_file_bytes {
                    continue;
                }
                if file_bytes > 0 && file_bytes + line.len() as u64 > max_file_bytes {
                    file.flush().await.map_err(io_message)?;
                    drop(file);
                    rotate(&path, retained_files).await.map_err(io_message)?;
                    (file, file_bytes) = open_append(&path).await.map_err(io_message)?;
                }
                file.write_all(&line).await.map_err(io_message)?;
                file.flush().await.map_err(io_message)?;
                file_bytes += line.len() as u64;
            }
            WriterMessage::Shutdown(completed) => {
                file.flush().await.map_err(io_message)?;
                let _ = completed.send(());
                return Ok(());
            }
        }
    }
    file.flush().await.map_err(io_message)
}

async fn reconcile_existing_files(
    path: &Path,
    retained_files: usize,
    max_file_bytes: u64,
) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let Some(base_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let mut entries = fs::read_dir(parent).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let generation = if name == base_name {
            Some(0)
        } else {
            name.strip_prefix(base_name)
                .and_then(|suffix| suffix.strip_prefix('.'))
                .and_then(|suffix| suffix.parse::<usize>().ok())
        };
        let Some(generation) = generation else {
            continue;
        };
        let metadata = entry.metadata().await?;
        if metadata.is_file() && (metadata.len() > max_file_bytes || generation >= retained_files) {
            fs::remove_file(entry.path()).await?;
        }
    }
    Ok(())
}

async fn open_append(path: &Path) -> io::Result<(File, u64)> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let length = file.metadata().await?.len();
    Ok((file, length))
}

async fn rotate(path: &Path, retained_files: usize) -> io::Result<()> {
    if retained_files == 1 {
        return remove_if_exists(path).await;
    }
    for index in (1..retained_files).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            rotated_path(path, index - 1)
        };
        let destination = rotated_path(path, index);
        remove_if_exists(&destination).await?;
        if fs::try_exists(&source).await? {
            fs::rename(source, destination).await?;
        }
    }
    Ok(())
}

async fn remove_if_exists(path: &Path) -> io::Result<()> {
    if fs::try_exists(path).await? {
        fs::remove_file(path).await?;
    }
    Ok(())
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), index))
}

fn io_message(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use crate::{
        production::provider_runtime::ProviderEvent,
        terminal::{TerminalEvent, TerminalSessionSnapshot, TerminalStatus},
    };

    use super::{
        BoundedNdjsonWriter, OperationalLogOptions, ProviderOperationalLog, TerminalOperationalLog,
    };

    #[tokio::test]
    async fn terminal_output_records_never_persist_output_data() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("terminal-events.log");
        let log = TerminalOperationalLog::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 4096,
                retained_files: 1,
                queue_capacity: 4,
            },
        )
        .await
        .expect("terminal log starts");

        assert!(log.record(&TerminalEvent::Output {
            thread_id: "thread-1".to_owned(),
            terminal_id: "terminal-1".to_owned(),
            sequence: 7,
            data: "PRIVATE_TERMINAL_OUTPUT".to_owned(),
        }));
        log.shutdown().await.expect("terminal log shuts down");

        let contents = std::fs::read_to_string(path).expect("read terminal log");
        let record: Value = serde_json::from_str(contents.trim()).expect("terminal record");
        assert_eq!(record["eventType"], "activity");
        assert_eq!(record["activityType"], "output");
        assert_eq!(record["threadId"], "thread-1");
        assert_eq!(record["terminalId"], "terminal-1");
        assert_eq!(record["sequence"], 7);
        assert_eq!(record["byteCount"], 23);
        assert!(record["timestamp"].is_string());
        assert!(!contents.contains("PRIVATE_TERMINAL_OUTPUT"));
        assert!(record.get("data").is_none());
    }

    #[tokio::test]
    async fn terminal_start_records_omit_snapshot_content() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("terminal-events.log");
        let log = TerminalOperationalLog::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 4096,
                retained_files: 1,
                queue_capacity: 4,
            },
        )
        .await
        .expect("terminal log starts");
        let snapshot = TerminalSessionSnapshot {
            thread_id: "thread-1".to_owned(),
            terminal_id: "terminal-1".to_owned(),
            cwd: "PRIVATE_PATH".to_owned(),
            worktree_path: Some("PRIVATE_WORKTREE".to_owned()),
            status: TerminalStatus::Running,
            pid: Some(42),
            history: "PRIVATE_HISTORY".to_owned(),
            exit_code: None,
            exit_signal: None,
            label: "PRIVATE_LABEL".to_owned(),
            updated_at: "PRIVATE_TIMESTAMP".to_owned(),
            sequence: 1,
        };

        assert!(log.record(&TerminalEvent::Started {
            thread_id: "thread-1".to_owned(),
            terminal_id: "terminal-1".to_owned(),
            sequence: 1,
            snapshot,
        }));
        log.shutdown().await.expect("terminal log shuts down");

        let contents = std::fs::read_to_string(path).expect("read terminal log");
        let record: Value = serde_json::from_str(contents.trim()).expect("terminal record");
        assert_eq!(record["eventType"], "start");
        assert_eq!(record["status"], "running");
        assert_eq!(record["pid"], 42);
        for private_value in [
            "PRIVATE_PATH",
            "PRIVATE_WORKTREE",
            "PRIVATE_HISTORY",
            "PRIVATE_LABEL",
            "PRIVATE_TIMESTAMP",
        ] {
            assert!(!contents.contains(private_value));
        }
    }

    #[tokio::test]
    async fn provider_records_persist_only_bounded_diagnostic_summaries() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("provider-events.log");
        let log = ProviderOperationalLog::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 4096,
                retained_files: 1,
                queue_capacity: 4,
            },
        )
        .await
        .expect("provider log starts");

        assert!(log.record(&ProviderEvent {
            event_type: "turn.completed".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("request-1".to_owned()),
            payload: json!({
                "text": "PRIVATE_PROMPT",
                "arguments": { "token": "PRIVATE_CREDENTIAL" },
                "environment": { "SECRET": "PRIVATE_ENVIRONMENT" },
                "raw": "PRIVATE_PROVIDER_PAYLOAD"
            }),
        }));
        log.shutdown().await.expect("provider log shuts down");

        let contents = std::fs::read_to_string(path).expect("read provider log");
        let record: Value = serde_json::from_str(contents.trim()).expect("provider record");
        assert_eq!(record["eventType"], "turn.completed");
        assert_eq!(record["threadId"], "thread-1");
        assert_eq!(record["turnId"], "turn-1");
        assert_eq!(record["requestId"], "request-1");
        assert_eq!(record["status"], "completed");
        assert!(record["timestamp"].is_string());
        assert_eq!(record.as_object().expect("record object").len(), 6);
        for private_value in [
            "PRIVATE_PROMPT",
            "PRIVATE_CREDENTIAL",
            "PRIVATE_ENVIRONMENT",
            "PRIVATE_PROVIDER_PAYLOAD",
        ] {
            assert!(!contents.contains(private_value));
        }
    }

    #[tokio::test]
    async fn writer_rotates_ndjson_files_within_the_configured_bound() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("events.log");
        let options = OperationalLogOptions {
            max_file_bytes: 120,
            retained_files: 2,
            queue_capacity: 8,
        };
        let writer = BoundedNdjsonWriter::start(path.clone(), options)
            .await
            .expect("writer starts");

        for sequence in 0..8 {
            assert!(writer.try_write(json!({
                "eventType": "provider.event",
                "sequence": sequence,
                "padding": "xxxxxxxxxxxxxxxxxxxxxxxx"
            })));
        }
        writer.shutdown().await.expect("writer shuts down");

        let mut total_files = 0;
        for candidate in [path.clone(), PathBuf::from(format!("{}.1", path.display()))] {
            if candidate.exists() {
                total_files += 1;
                let metadata = std::fs::metadata(&candidate).expect("log metadata");
                assert!(
                    metadata.len() <= 120,
                    "{} exceeded bound",
                    candidate.display()
                );
                let contents = std::fs::read_to_string(candidate).expect("read log");
                for line in contents.lines() {
                    serde_json::from_str::<Value>(line).expect("valid NDJSON record");
                }
            }
        }
        assert_eq!(total_files, 2);
        assert!(!PathBuf::from(format!("{}.2", path.display())).exists());
    }

    #[tokio::test]
    async fn writer_replaces_an_existing_file_that_exceeds_the_size_limit() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("events.log");
        std::fs::write(&path, vec![b'x'; 256]).expect("oversized existing log");
        let writer = BoundedNdjsonWriter::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 100,
                retained_files: 2,
                queue_capacity: 2,
            },
        )
        .await
        .expect("writer starts");

        assert!(writer.try_write(json!({ "eventType": "replacement" })));
        writer.shutdown().await.expect("writer shuts down");

        assert!(std::fs::metadata(&path).expect("active log").len() <= 100);
        let rotated = PathBuf::from(format!("{}.1", path.display()));
        assert!(!rotated.exists() || std::fs::metadata(rotated).expect("rotated log").len() <= 100);
    }

    #[tokio::test]
    async fn shutdown_drains_records_already_accepted_by_the_writer() {
        let temp = TempDir::new().expect("temporary log directory");
        let path = temp.path().join("events.log");
        let writer = BoundedNdjsonWriter::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 1024,
                retained_files: 1,
                queue_capacity: 4,
            },
        )
        .await
        .expect("writer starts");

        assert!(writer.try_write(json!({ "eventType": "accepted" })));
        writer.shutdown().await.expect("writer shuts down");

        let contents = std::fs::read_to_string(path).expect("read log");
        assert!(contents.contains("accepted"));
    }
}
