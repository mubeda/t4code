use std::{collections::HashMap, future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio_util::sync::CancellationToken;

use super::{
    PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput, TerminalAttachInput,
    TerminalEvent, TerminalMetadataEvent, TerminalOpenInput, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalStatus, TerminalSummary,
};
use crate::{
    diagnostics::{NativeProcessSampler, ProcessSampler, build_descendant_entries},
    process::{Platform, ShellCandidate, resolve_shell_candidates},
};

const DEFAULT_SUBPROCESS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_TERMINAL_LABEL_LENGTH: usize = 128;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SubprocessInspection {
    pub has_running_subprocess: bool,
    pub child_command_label: Option<String>,
    pub process_ids: Vec<u32>,
}

pub trait TerminalSubprocessInspector: std::fmt::Debug + Send + Sync {
    fn inspect(
        &self,
        terminal_pid: u32,
    ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>>;
}

#[derive(Debug, Default)]
struct NativeTerminalSubprocessInspector {
    sampler: NativeProcessSampler,
}

impl TerminalSubprocessInspector for NativeTerminalSubprocessInspector {
    fn inspect(
        &self,
        terminal_pid: u32,
    ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>> {
        Box::pin(async move {
            if terminal_pid == 0 {
                return Ok(SubprocessInspection::default());
            }

            let rows = self
                .sampler
                .sample()
                .await
                .map_err(|error| error.to_string())?;
            let descendants = build_descendant_entries(&rows, terminal_pid);
            let Some(first_child) = descendants.iter().find(|entry| entry.depth == 0) else {
                return Ok(SubprocessInspection::default());
            };

            let mut process_ids = Vec::with_capacity(descendants.len() + 1);
            process_ids.push(terminal_pid);
            process_ids.extend(descendants.iter().map(|entry| entry.pid));

            Ok(SubprocessInspection {
                has_running_subprocess: true,
                child_command_label: normalize_child_command_name(&first_child.command)
                    .map(|label| truncate_terminal_label(&label)),
                process_ids,
            })
        })
    }
}

#[derive(Clone, Debug)]
pub struct TerminalManagerOptions {
    pub history_line_limit: usize,
    pub event_capacity: usize,
    pub preferred_shell: Option<String>,
    pub subprocess_poll_interval: Duration,
    pub subprocess_inspector: Option<Arc<dyn TerminalSubprocessInspector>>,
}

impl Default for TerminalManagerOptions {
    fn default() -> Self {
        Self {
            history_line_limit: 5_000,
            event_capacity: 512,
            preferred_shell: None,
            subprocess_poll_interval: DEFAULT_SUBPROCESS_POLL_INTERVAL,
            subprocess_inspector: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal cwd does not exist: {0}")]
    CwdNotFound(String),
    #[error("terminal cwd is not a directory: {0}")]
    CwdNotDirectory(String),
    #[error("unknown terminal thread: {thread_id}, terminal: {terminal_id}")]
    NotFound {
        thread_id: String,
        terminal_id: String,
    },
    #[error("terminal is not running for thread: {thread_id}, terminal: {terminal_id}")]
    NotRunning {
        thread_id: String,
        terminal_id: String,
    },
    #[error("failed to spawn terminal; attempted {attempted:?}: {message}")]
    Spawn {
        attempted: Vec<String>,
        message: String,
    },
    #[error("terminal I/O failed: {0}")]
    Io(String),
}

#[derive(Debug)]
struct Session {
    thread_id: String,
    terminal_id: String,
    cwd: String,
    worktree_path: Option<String>,
    status: TerminalStatus,
    pid: Option<u32>,
    history: String,
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
    label: String,
    has_running_subprocess: bool,
    child_command_label: Option<String>,
    updated_at: String,
    sequence: u64,
    cols: u16,
    rows: u16,
    process: Option<Arc<dyn PtyProcess>>,
}

type SessionKey = (String, String);
type SharedSession = Arc<Mutex<Session>>;

impl Session {
    fn snapshot(&self) -> TerminalSessionSnapshot {
        TerminalSessionSnapshot {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            pid: self.pid,
            history: self.history.clone(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            label: self.display_label(),
            updated_at: self.updated_at.clone(),
            sequence: self.sequence,
        }
    }

    fn summary(&self) -> TerminalSummary {
        TerminalSummary {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            pid: self.pid,
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            has_running_subprocess: self.has_running_subprocess,
            label: self.display_label(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn display_label(&self) -> String {
        if self.has_running_subprocess
            && let Some(label) = self.child_command_label.as_deref()
        {
            let trimmed = label.trim();
            if !trimmed.is_empty() {
                return truncate_terminal_label(trimmed);
            }
        }
        truncate_terminal_label(&self.label)
    }

    fn advance(&mut self) -> u64 {
        self.sequence = self.sequence.saturating_add(1);
        self.updated_at = now_iso();
        self.sequence
    }
}

#[derive(Debug)]
struct Inner {
    backend: Arc<dyn PtyBackend>,
    options: TerminalManagerOptions,
    inspector: Arc<dyn TerminalSubprocessInspector>,
    lifecycle: Mutex<()>,
    sessions: RwLock<HashMap<SessionKey, SharedSession>>,
    events: broadcast::Sender<TerminalEvent>,
    metadata: broadcast::Sender<TerminalMetadataEvent>,
    cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions::default(),
        )
    }
}

impl TerminalManager {
    pub fn new(backend: Arc<dyn PtyBackend>, options: TerminalManagerOptions) -> Self {
        let (events, _) = broadcast::channel(options.event_capacity.max(16));
        let (metadata, _) = broadcast::channel(options.event_capacity.max(16));
        let inspector = options
            .subprocess_inspector
            .clone()
            .unwrap_or_else(|| Arc::new(NativeTerminalSubprocessInspector::default()));
        Self {
            inner: Arc::new(Inner {
                backend,
                options,
                inspector,
                lifecycle: Mutex::new(()),
                sessions: RwLock::new(HashMap::new()),
                events,
                metadata,
                cancellation: CancellationToken::new(),
            }),
        }
    }

    pub async fn open(
        &self,
        input: TerminalOpenInput,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.start(input, false).await
    }

    pub async fn restart(
        &self,
        input: TerminalRestartInput,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.close_sessions(&input.thread_id, Some(&input.terminal_id))
            .await;
        self.start(input, true).await
    }

    async fn start(
        &self,
        input: TerminalOpenInput,
        restarted: bool,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        validate_cwd(&input.cwd).await?;
        validate_dimensions(input.cols, input.rows)?;
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        if let Some(existing) = self.inner.sessions.read().await.get(&key).cloned() {
            let (process, snapshot, needs_resize) = {
                let session = existing.lock().await;
                (
                    session.process.clone(),
                    session.snapshot(),
                    session.cols != input.cols || session.rows != input.rows,
                )
            };
            if let Some(process) = process {
                if needs_resize {
                    process
                        .resize(input.cols, input.rows)
                        .map_err(TerminalError::Io)?;
                    let mut session = existing.lock().await;
                    session.cols = input.cols;
                    session.rows = input.rows;
                    session.updated_at = now_iso();
                }
                return Ok(snapshot);
            }
        }

        let candidates = resolve_shell_candidates(
            Platform::current(),
            self.inner.options.preferred_shell.as_deref(),
            &input.env,
        );
        let mut attempted = Vec::new();
        let mut last_error = "no shell candidates were available".to_string();
        let mut spawned = None;
        for candidate in candidates {
            attempted.push(format_shell_candidate(&candidate));
            let spawn = PtySpawnInput {
                shell: candidate.command,
                args: candidate.args,
                cwd: input.cwd.clone(),
                cols: input.cols,
                rows: input.rows,
                env: input.env.clone(),
            };
            match self.inner.backend.spawn(&spawn) {
                Ok(process) => {
                    spawned = Some(process);
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        let process = spawned.ok_or(TerminalError::Spawn {
            attempted,
            message: last_error,
        })?;
        let session = Arc::new(Mutex::new(Session {
            thread_id: input.thread_id.clone(),
            terminal_id: input.terminal_id.clone(),
            cwd: input.cwd.to_string_lossy().into_owned(),
            worktree_path: input
                .worktree_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            status: TerminalStatus::Running,
            pid: Some(process.pid()),
            history: String::new(),
            exit_code: None,
            exit_signal: None,
            label: terminal_label(&input.terminal_id),
            has_running_subprocess: false,
            child_command_label: None,
            updated_at: now_iso(),
            sequence: 1,
            cols: input.cols,
            rows: input.rows,
            process: Some(process.clone()),
        }));
        self.inner
            .sessions
            .write()
            .await
            .insert(key, session.clone());
        self.supervise(session.clone(), process);
        let snapshot = session.lock().await.snapshot();
        let event = if restarted {
            TerminalEvent::Restarted {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
                sequence: snapshot.sequence,
                snapshot: snapshot.clone(),
            }
        } else {
            TerminalEvent::Started {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
                sequence: snapshot.sequence,
                snapshot: snapshot.clone(),
            }
        };
        let _ = self.inner.events.send(event);
        let _ = self.inner.metadata.send(TerminalMetadataEvent::Upsert {
            terminal: session.lock().await.summary(),
        });
        Ok(snapshot)
    }

    fn supervise(&self, session: Arc<Mutex<Session>>, process: Arc<dyn PtyProcess>) {
        let inner = self.inner.clone();
        let mut output = process.subscribe_output();
        let output_session = session.clone();
        let output_cancel = inner.cancellation.child_token();
        let output_inner = inner.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = output_cancel.cancelled() => return,
                    result = output.recv() => match result {
                        Ok(data) => {
                            let event = {
                                let mut session = output_session.lock().await;
                                append_history(
                                    &mut session.history,
                                    &data,
                                    output_inner.options.history_line_limit,
                                );
                                let sequence = session.advance();
                                TerminalEvent::Output {
                                    thread_id: session.thread_id.clone(),
                                    terminal_id: session.terminal_id.clone(),
                                    sequence,
                                    data,
                                }
                            };
                            let _ = output_inner.events.send(event);
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });

        let mut exit = process.subscribe_exit();
        let exit_cancel = inner.cancellation.child_token();
        let exit_inner = inner.clone();
        let exit_session = session.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = exit_cancel.cancelled() => return,
                    result = exit.changed() => {
                        if result.is_err() {
                            return;
                        }
                        let Some(PtyExit { exit_code, signal }) = exit.borrow().clone() else {
                            continue;
                        };
                        let _lifecycle = exit_inner.lifecycle.lock().await;
                        let registered = {
                            let sessions = exit_inner.sessions.read().await;
                            let session = exit_session.lock().await;
                            sessions
                                .get(&(session.thread_id.clone(), session.terminal_id.clone()))
                                .is_some_and(|current| Arc::ptr_eq(current, &exit_session))
                        };
                        if !registered {
                            return;
                        }
                        let (event, summary) = {
                            let mut session = exit_session.lock().await;
                            session.status = TerminalStatus::Exited;
                            session.pid = None;
                            session.process = None;
                            session.exit_code = exit_code;
                            session.exit_signal = signal;
                            session.has_running_subprocess = false;
                            session.child_command_label = None;
                            let sequence = session.advance();
                            (
                                TerminalEvent::Exited {
                                    thread_id: session.thread_id.clone(),
                                    terminal_id: session.terminal_id.clone(),
                                    sequence,
                                    exit_code,
                                    exit_signal: signal,
                                },
                                session.summary(),
                            )
                        };
                        let _ = exit_inner.events.send(event);
                        let _ = exit_inner.metadata.send(TerminalMetadataEvent::Upsert {
                            terminal: summary,
                        });
                        return;
                    }
                }
            }
        });

        let activity_cancel = inner.cancellation.child_token();
        let activity_session = session;
        let activity_inner = inner.clone();
        let activity_pid = process.pid();
        tokio::spawn(async move {
            if activity_inner.options.subprocess_poll_interval.is_zero() {
                return;
            }
            loop {
                tokio::select! {
                    () = activity_cancel.cancelled() => return,
                    () = tokio::time::sleep(activity_inner.options.subprocess_poll_interval) => {}
                }

                let inspection = match activity_inner.inspector.inspect(activity_pid).await {
                    Ok(inspection) => inspection,
                    Err(error) => {
                        tracing::debug!(%error, pid = activity_pid, "failed to inspect terminal subprocess state");
                        continue;
                    }
                };

                let activity = {
                    let mut session = activity_session.lock().await;
                    if session.status != TerminalStatus::Running
                        || session.pid != Some(activity_pid)
                    {
                        return;
                    }
                    if session.has_running_subprocess == inspection.has_running_subprocess
                        && session.child_command_label == inspection.child_command_label
                    {
                        None
                    } else {
                        session.has_running_subprocess = inspection.has_running_subprocess;
                        session.child_command_label = inspection.child_command_label.clone();
                        let sequence = session.advance();
                        Some((
                            TerminalEvent::Activity {
                                thread_id: session.thread_id.clone(),
                                terminal_id: session.terminal_id.clone(),
                                sequence,
                                has_running_subprocess: session.has_running_subprocess,
                                label: session.display_label(),
                            },
                            session.summary(),
                        ))
                    }
                };

                if let Some((event, summary)) = activity {
                    let _ = activity_inner.events.send(event);
                    let _ = activity_inner
                        .metadata
                        .send(TerminalMetadataEvent::Upsert { terminal: summary });
                }
            }
        });
    }

    pub async fn attach(
        &self,
        input: TerminalAttachInput,
    ) -> Result<TerminalAttachment, TerminalError> {
        let events = self.inner.events.subscribe();
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let existing = {
            let sessions = self.inner.sessions.read().await;
            sessions.get(&key).cloned()
        };
        let mut session = match existing {
            Some(session) => session,
            None => {
                let cwd = input.cwd.clone().ok_or_else(|| TerminalError::NotFound {
                    thread_id: input.thread_id.clone(),
                    terminal_id: input.terminal_id.clone(),
                })?;
                self.open(TerminalOpenInput {
                    thread_id: input.thread_id.clone(),
                    terminal_id: input.terminal_id.clone(),
                    cwd,
                    worktree_path: input.worktree_path.clone(),
                    cols: input.cols.unwrap_or(120),
                    rows: input.rows.unwrap_or(30),
                    env: input.env.clone(),
                })
                .await?;
                self.inner
                    .sessions
                    .read()
                    .await
                    .get(&key)
                    .cloned()
                    .ok_or_else(|| TerminalError::NotFound {
                        thread_id: input.thread_id.clone(),
                        terminal_id: input.terminal_id.clone(),
                    })?
            }
        };
        tokio::task::yield_now().await;
        let (process, status, current_cols, current_rows) = {
            let session = session.lock().await;
            (
                session.process.clone(),
                session.status,
                session.cols,
                session.rows,
            )
        };
        if status != TerminalStatus::Running && input.restart_if_not_running {
            let cwd = input.cwd.ok_or_else(|| TerminalError::NotRunning {
                thread_id: input.thread_id.clone(),
                terminal_id: input.terminal_id.clone(),
            })?;
            self.restart(TerminalOpenInput {
                thread_id: input.thread_id.clone(),
                terminal_id: input.terminal_id.clone(),
                cwd,
                worktree_path: input.worktree_path,
                cols: input.cols.unwrap_or(current_cols),
                rows: input.rows.unwrap_or(current_rows),
                env: input.env,
            })
            .await?;
            session = self
                .require_session(&input.thread_id, &input.terminal_id)
                .await?;
        } else if let (Some(process), Some(cols), Some(rows)) = (process, input.cols, input.rows)
            && (cols != current_cols || rows != current_rows)
        {
            process.resize(cols, rows).map_err(TerminalError::Io)?;
            let mut session = session.lock().await;
            session.cols = cols;
            session.rows = rows;
            session.updated_at = now_iso();
        }
        let initial = session.lock().await.snapshot();
        Ok(TerminalAttachment {
            thread_id: input.thread_id,
            terminal_id: input.terminal_id,
            next_sequence: initial.sequence,
            initial,
            events,
        })
    }

    pub async fn write(
        &self,
        thread_id: &str,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), TerminalError> {
        let session = self.require_session(thread_id, terminal_id).await?;
        let (process, status) = {
            let session = session.lock().await;
            (session.process.clone(), session.status)
        };
        if status == TerminalStatus::Exited {
            return Ok(());
        }
        let process = process.ok_or_else(|| TerminalError::NotRunning {
            thread_id: thread_id.to_string(),
            terminal_id: terminal_id.to_string(),
        })?;
        process.write(data).map_err(TerminalError::Io)
    }

    pub async fn resize(
        &self,
        thread_id: &str,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        validate_dimensions(cols, rows)?;
        let Some(session) = self
            .inner
            .sessions
            .read()
            .await
            .get(&(thread_id.to_string(), terminal_id.to_string()))
            .cloned()
        else {
            return Ok(());
        };
        let process = session.lock().await.process.clone();
        let Some(process) = process else {
            return Ok(());
        };
        process.resize(cols, rows).map_err(TerminalError::Io)?;
        let mut session = session.lock().await;
        session.cols = cols;
        session.rows = rows;
        session.updated_at = now_iso();
        Ok(())
    }

    pub async fn clear(&self, thread_id: &str, terminal_id: &str) -> Result<(), TerminalError> {
        let session = self.require_session(thread_id, terminal_id).await?;
        let event = {
            let mut session = session.lock().await;
            session.history.clear();
            let sequence = session.advance();
            TerminalEvent::Cleared {
                thread_id: thread_id.to_string(),
                terminal_id: terminal_id.to_string(),
                sequence,
            }
        };
        let _ = self.inner.events.send(event);
        Ok(())
    }

    pub async fn close(&self, thread_id: &str, terminal_id: Option<&str>) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        self.close_sessions(thread_id, terminal_id).await;
    }

    async fn close_sessions(&self, thread_id: &str, terminal_id: Option<&str>) {
        let keys = {
            let sessions = self.inner.sessions.read().await;
            sessions
                .keys()
                .filter(|(candidate_thread, candidate_terminal)| {
                    candidate_thread == thread_id
                        && terminal_id.is_none_or(|value| candidate_terminal == value)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for key in keys {
            let Some(session) = self.inner.sessions.write().await.remove(&key) else {
                continue;
            };
            let (process, sequence) = {
                let mut session = session.lock().await;
                (session.process.take(), session.advance())
            };
            if let Some(process) = process
                && let Err(error) = process.kill()
            {
                tracing::debug!(%error, pid = process.pid(), "failed to kill terminal process");
            }
            let _ = self.inner.events.send(TerminalEvent::Closed {
                thread_id: key.0.clone(),
                terminal_id: key.1.clone(),
                sequence,
            });
            let _ = self.inner.metadata.send(TerminalMetadataEvent::Remove {
                thread_id: key.0,
                terminal_id: key.1,
            });
        }
    }

    pub async fn subscribe_metadata(&self) -> TerminalMetadataAttachment {
        let events = self.inner.metadata.subscribe();
        let sessions = self.inner.sessions.read().await;
        let mut initial = Vec::with_capacity(sessions.len());
        for session in sessions.values() {
            initial.push(session.lock().await.summary());
        }
        initial.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
                .then_with(|| left.terminal_id.cmp(&right.terminal_id))
        });
        TerminalMetadataAttachment { initial, events }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<TerminalEvent> {
        self.inner.events.subscribe()
    }

    pub async fn shutdown(&self) {
        let keys = self
            .inner
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for (thread_id, terminal_id) in keys {
            self.close(&thread_id, Some(&terminal_id)).await;
        }
        self.inner.cancellation.cancel();
    }

    async fn require_session(
        &self,
        thread_id: &str,
        terminal_id: &str,
    ) -> Result<SharedSession, TerminalError> {
        self.inner
            .sessions
            .read()
            .await
            .get(&(thread_id.to_string(), terminal_id.to_string()))
            .cloned()
            .ok_or_else(|| TerminalError::NotFound {
                thread_id: thread_id.to_string(),
                terminal_id: terminal_id.to_string(),
            })
    }
}

pub struct TerminalAttachment {
    pub initial: TerminalSessionSnapshot,
    thread_id: String,
    terminal_id: String,
    next_sequence: u64,
    events: broadcast::Receiver<TerminalEvent>,
}

impl TerminalAttachment {
    pub async fn recv(&mut self) -> Option<TerminalEvent> {
        loop {
            match self.events.recv().await {
                Ok(event)
                    if event.belongs_to(&self.thread_id, &self.terminal_id)
                        && event.sequence() > self.next_sequence =>
                {
                    self.next_sequence = event.sequence();
                    return Some(event);
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

pub struct TerminalMetadataAttachment {
    pub initial: Vec<TerminalSummary>,
    events: broadcast::Receiver<TerminalMetadataEvent>,
}

impl TerminalMetadataAttachment {
    pub async fn recv(&mut self) -> Option<TerminalMetadataEvent> {
        loop {
            match self.events.recv().await {
                Ok(event) => return Some(event),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

async fn validate_cwd(cwd: &Path) -> Result<(), TerminalError> {
    match tokio::fs::metadata(cwd).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(TerminalError::CwdNotDirectory(
            cwd.to_string_lossy().into_owned(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(
            TerminalError::CwdNotFound(cwd.to_string_lossy().into_owned()),
        ),
        Err(error) => Err(TerminalError::Io(error.to_string())),
    }
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if !(1..=1_000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(TerminalError::Io(format!(
            "invalid terminal size {cols}x{rows}"
        )));
    }
    Ok(())
}

fn append_history(history: &mut String, data: &str, line_limit: usize) {
    history.push_str(data);
    if line_limit == 0 {
        history.clear();
        return;
    }
    let line_count = history
        .as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count();
    if line_count <= line_limit {
        return;
    }
    let mut lines_to_remove = line_count - line_limit;
    let truncate_at = history
        .char_indices()
        .find_map(|(index, character)| {
            if character != '\n' {
                return None;
            }
            lines_to_remove -= 1;
            (lines_to_remove == 0).then_some(index + character.len_utf8())
        })
        .unwrap_or(0);
    history.drain(..truncate_at);
}

fn terminal_label(terminal_id: &str) -> String {
    terminal_id
        .strip_prefix("term-")
        .filter(|suffix| !suffix.is_empty())
        .map_or_else(
            || terminal_id.to_string(),
            |suffix| format!("Terminal {suffix}"),
        )
}

fn format_shell_candidate(candidate: &ShellCandidate) -> String {
    if candidate.args.is_empty() {
        candidate.command.clone()
    } else {
        format!("{} {}", candidate.command, candidate.args.join(" "))
    }
}

fn truncate_terminal_label(value: &str) -> String {
    let truncated = value
        .chars()
        .take(MAX_TERMINAL_LABEL_LENGTH)
        .collect::<String>();
    if truncated.is_empty() {
        value.to_string()
    } else {
        truncated
    }
}

fn normalize_child_command_name(raw: &str) -> Option<String> {
    let mut trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
    {
        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }
    let first_token = trimmed.split_whitespace().next()?.trim();
    if first_token.is_empty() {
        return None;
    }
    let base = first_token
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(first_token);
    let without_exe = if base.to_ascii_lowercase().ends_with(".exe") {
        &base[..base.len().saturating_sub(4)]
    } else {
        base
    };
    (!without_exe.is_empty()).then(|| without_exe.to_string())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}
