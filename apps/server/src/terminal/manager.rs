use std::{collections::HashMap, future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio_util::sync::CancellationToken;

use super::{
    PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput, TerminalAttachInput,
    TerminalEvent, TerminalMetadataEvent, TerminalOpenInput, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalStatus, TerminalSummary, history::TerminalHistory,
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
    history: TerminalHistory,
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
            history: self.history.snapshot(),
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

        let spawn_candidates = if let Some(command) = input.command.as_ref() {
            vec![(
                PtySpawnInput {
                    executable: command.executable.clone(),
                    args: command.args.clone(),
                    cwd: input.cwd.clone(),
                    cols: input.cols,
                    rows: input.rows,
                    env: input.env.clone(),
                },
                format!("{} {:?}", command.executable, command.args),
            )]
        } else {
            resolve_shell_candidates(
                Platform::current(),
                self.inner.options.preferred_shell.as_deref(),
                &input.env,
            )
            .into_iter()
            .map(|candidate| {
                let attempted = format_shell_candidate(&candidate);
                (
                    PtySpawnInput {
                        executable: candidate.command,
                        args: candidate.args,
                        cwd: input.cwd.clone(),
                        cols: input.cols,
                        rows: input.rows,
                        env: input.env.clone(),
                    },
                    attempted,
                )
            })
            .collect::<Vec<_>>()
        };

        let mut attempted = Vec::new();
        let mut last_error = "no terminal launch candidates were available".to_owned();
        let mut spawned = None;
        for (spawn, attempted_label) in spawn_candidates {
            attempted.push(attempted_label);
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
        let history = TerminalHistory::new(self.inner.options.history_line_limit);
        debug_assert_eq!(
            history.line_limit(),
            self.inner.options.history_line_limit,
            "session history must retain the manager's configured line limit"
        );
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
            history,
            exit_code: None,
            exit_signal: None,
            label: input
                .command
                .as_ref()
                .and_then(|command| command.label.clone())
                .unwrap_or_else(|| terminal_label(&input.terminal_id)),
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
                                session.history.push(&data);
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

                let _lifecycle = activity_inner.lifecycle.lock().await;
                let registered = {
                    let sessions = activity_inner.sessions.read().await;
                    let session = activity_session.lock().await;
                    sessions
                        .get(&(session.thread_id.clone(), session.terminal_id.clone()))
                        .is_some_and(|current| Arc::ptr_eq(current, &activity_session))
                };
                if !registered {
                    return;
                }
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
                    command: input.command.clone(),
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
                command: input.command,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct HistoryTestPty {
        pid: u32,
        output: broadcast::Sender<String>,
        exit: tokio::sync::watch::Sender<Option<PtyExit>>,
    }

    impl HistoryTestPty {
        fn new(pid: u32) -> Self {
            let (output, _) = broadcast::channel(16);
            let (exit, _) = tokio::sync::watch::channel(None);
            Self { pid, output, exit }
        }

        fn emit(&self, data: &str) {
            self.output.send(data.to_owned()).expect("output receiver");
        }
    }

    impl PtyProcess for HistoryTestPty {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn write(&self, _data: &str) -> Result<(), String> {
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self) -> Result<(), String> {
            Ok(())
        }

        fn subscribe_output(&self) -> broadcast::Receiver<String> {
            self.output.subscribe()
        }

        fn subscribe_exit(&self) -> tokio::sync::watch::Receiver<Option<PtyExit>> {
            self.exit.subscribe()
        }
    }

    #[derive(Debug, Default)]
    struct HistoryTestBackend {
        processes: std::sync::Mutex<Vec<Arc<HistoryTestPty>>>,
        spawns: std::sync::Mutex<Vec<PtySpawnInput>>,
        fail_spawns: bool,
    }

    impl HistoryTestBackend {
        fn latest(&self) -> Arc<HistoryTestPty> {
            self.processes
                .lock()
                .expect("processes lock")
                .last()
                .cloned()
                .expect("spawned process")
        }

        fn spawns(&self) -> Vec<PtySpawnInput> {
            self.spawns.lock().expect("spawns lock").clone()
        }
    }

    impl PtyBackend for HistoryTestBackend {
        fn spawn(&self, input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
            self.spawns.lock().expect("spawns lock").push(input.clone());
            if self.fail_spawns {
                return Err("provider spawn failed".to_owned());
            }
            let mut processes = self.processes.lock().expect("processes lock");
            let process = Arc::new(HistoryTestPty::new(processes.len() as u32 + 1));
            processes.push(process.clone());
            Ok(process)
        }
    }

    #[derive(Debug)]
    struct ControllableSubprocessInspector {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
        inspection: SubprocessInspection,
    }

    impl TerminalSubprocessInspector for ControllableSubprocessInspector {
        fn inspect(
            &self,
            _terminal_pid: u32,
        ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>>
        {
            Box::pin(async move {
                self.started.notify_one();
                self.release.notified().await;
                Ok(self.inspection.clone())
            })
        }
    }

    #[tokio::test]
    async fn close_during_in_flight_subprocess_inspection_does_not_resurrect_metadata() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let inspector = Arc::new(ControllableSubprocessInspector {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            inspection: SubprocessInspection {
                has_running_subprocess: true,
                child_command_label: Some("codex".to_owned()),
                process_ids: vec![1, 2],
            },
        });
        let manager = TerminalManager::new(
            backend,
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::from_millis(1),
                subprocess_inspector: Some(inspector.clone()),
                ..TerminalManagerOptions::default()
            },
        );
        let mut events = manager.subscribe_events();
        let mut metadata = manager.subscribe_metadata().await;

        manager
            .open(TerminalOpenInput::new(
                "thread-race",
                "term-race",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), inspector.started.notified())
            .await
            .expect("subprocess inspection did not start");

        manager.close("thread-race", Some("term-race")).await;

        loop {
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("closed event timeout")
                .expect("terminal event sender");
            if matches!(
                event,
                TerminalEvent::Closed {
                    ref thread_id,
                    ref terminal_id,
                    ..
                } if thread_id == "thread-race" && terminal_id == "term-race"
            ) {
                break;
            }
        }
        loop {
            let event = tokio::time::timeout(Duration::from_secs(2), metadata.recv())
                .await
                .expect("metadata remove timeout")
                .expect("metadata event sender");
            if matches!(
                event,
                TerminalMetadataEvent::Remove {
                    ref thread_id,
                    ref terminal_id,
                } if thread_id == "thread-race" && terminal_id == "term-race"
            ) {
                break;
            }
        }

        inspector.release.notify_one();

        let (event_after_close, metadata_after_close) = tokio::join!(
            tokio::time::timeout(Duration::from_millis(100), events.recv()),
            tokio::time::timeout(Duration::from_millis(100), metadata.recv()),
        );
        assert!(
            event_after_close.is_err(),
            "terminal event emitted after close: {event_after_close:?}"
        );
        assert!(
            metadata_after_close.is_err(),
            "terminal metadata emitted after close: {metadata_after_close:?}"
        );
    }

    #[tokio::test]
    async fn structured_command_spawns_once_with_exact_program_args_cwd_and_env() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            120,
            30,
        );
        input.env.insert("T4CODE_TEST".to_owned(), "1".to_owned());
        input.command = Some(crate::terminal::TerminalLaunchCommand {
            executable: "/opt/Provider CLI/codex".to_owned(),
            args: vec!["--dangerously-bypass-approvals-and-sandbox".to_owned()],
            label: Some("Codex Terminal".to_owned()),
        });

        let first = manager.open(input.clone()).await.unwrap();
        let second = manager.open(input).await.unwrap();

        assert_eq!(first.pid, second.pid);
        assert_eq!(first.label, "Codex Terminal");
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].executable, "/opt/Provider CLI/codex");
        assert_eq!(
            spawns[0].args,
            vec!["--dangerously-bypass-approvals-and-sandbox"]
        );
        assert_eq!(spawns[0].cwd, root.path());
        assert_eq!(
            spawns[0].env.get("T4CODE_TEST").map(String::as_str),
            Some("1")
        );
    }

    #[tokio::test]
    async fn attach_creates_a_missing_structured_command_without_shell_fallback() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let attachment = manager
            .attach(TerminalAttachInput {
                thread_id: "thread-provider".to_owned(),
                terminal_id: "term-provider".to_owned(),
                cwd: Some(root.path().to_path_buf()),
                worktree_path: Some(root.path().to_path_buf()),
                cols: Some(90),
                rows: Some(28),
                env: std::collections::BTreeMap::new(),
                restart_if_not_running: false,
                command: Some(crate::terminal::TerminalLaunchCommand {
                    executable: "claude".to_owned(),
                    args: vec!["--dangerously-skip-permissions".to_owned()],
                    label: Some("Claude Terminal".to_owned()),
                }),
            })
            .await
            .unwrap();

        assert_eq!(attachment.initial.label, "Claude Terminal");
        assert_eq!(backend.spawns().len(), 1);
        assert_eq!(backend.spawns()[0].executable, "claude");
    }

    #[tokio::test]
    async fn structured_command_failure_does_not_fall_back_to_a_shell_candidate() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend {
            fail_spawns: true,
            ..HistoryTestBackend::default()
        });
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                preferred_shell: Some("/bin/sh".to_owned()),
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            120,
            30,
        );
        input.command = Some(crate::terminal::TerminalLaunchCommand {
            executable: "missing-provider".to_owned(),
            args: vec!["--direct".to_owned()],
            label: Some("Provider Terminal".to_owned()),
        });

        let error = manager.open(input).await.unwrap_err();

        assert!(matches!(
            error,
            TerminalError::Spawn {
                ref attempted,
                ref message,
            } if attempted == &["missing-provider [\"--direct\"]"]
                && message == "provider spawn failed"
        ));
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].executable, "missing-provider");
        assert_eq!(spawns[0].args, ["--direct"]);
    }

    #[tokio::test]
    async fn structured_command_restart_if_not_running_preserves_the_direct_launch() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let command = crate::terminal::TerminalLaunchCommand {
            executable: "claude".to_owned(),
            args: vec!["--dangerously-skip-permissions".to_owned()],
            label: Some("Claude Terminal".to_owned()),
        };
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            90,
            28,
        );
        input.command = Some(command.clone());
        manager.open(input).await.unwrap();

        let mut events = manager.subscribe_events();
        backend
            .latest()
            .exit
            .send(Some(PtyExit {
                exit_code: Some(0),
                signal: None,
            }))
            .unwrap();
        let exited = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(exited, TerminalEvent::Exited { .. }));

        let attachment = manager
            .attach(TerminalAttachInput {
                thread_id: "thread-provider".to_owned(),
                terminal_id: "term-provider".to_owned(),
                cwd: Some(root.path().to_path_buf()),
                worktree_path: Some(root.path().to_path_buf()),
                cols: Some(90),
                rows: Some(28),
                env: std::collections::BTreeMap::new(),
                restart_if_not_running: true,
                command: Some(command),
            })
            .await
            .unwrap();

        assert_eq!(attachment.initial.label, "Claude Terminal");
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 2);
        assert_eq!(spawns[1].executable, "claude");
        assert_eq!(spawns[1].args, ["--dangerously-skip-permissions"]);
    }

    #[tokio::test]
    async fn configured_history_survives_output_and_clear_but_restart_starts_fresh() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                history_line_limit: 2,
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let input = TerminalOpenInput::new(
            "thread-history",
            "term-history",
            root.path().to_path_buf(),
            80,
            24,
        );

        manager.open(input.clone()).await.unwrap();
        let original_session = manager
            .require_session("thread-history", "term-history")
            .await
            .unwrap();
        assert_eq!(original_session.lock().await.history.line_limit(), 2);

        let mut events = manager.subscribe_events();
        let process = backend.latest();
        for chunk in ["one\n", "two\n", "three\n"] {
            process.emit(chunk);
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("output timeout")
                .expect("output event");
            assert!(matches!(event, TerminalEvent::Output { data, .. } if data == chunk));
        }

        let attachment = manager
            .attach(TerminalAttachInput::existing(
                "thread-history",
                "term-history",
            ))
            .await
            .unwrap();
        assert_eq!(attachment.initial.history, "two\nthree\n");

        manager
            .clear("thread-history", "term-history")
            .await
            .unwrap();
        let cleared = manager
            .attach(TerminalAttachInput::existing(
                "thread-history",
                "term-history",
            ))
            .await
            .unwrap();
        assert!(cleared.initial.history.is_empty());
        assert_eq!(original_session.lock().await.history.line_limit(), 2);

        let restarted = manager.restart(input).await.unwrap();
        assert!(restarted.history.is_empty());
        let restarted_session = manager
            .require_session("thread-history", "term-history")
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&original_session, &restarted_session));
        assert_eq!(restarted_session.lock().await.history.line_limit(), 2);
        assert_eq!(backend.processes.lock().expect("processes lock").len(), 2);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_covers_live_lifecycle_attachments_and_metadata() {
        let root = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions {
                history_line_limit: 2,
                preferred_shell: Some("/bin/sh".to_owned()),
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );

        let mut metadata = manager.subscribe_metadata().await;
        assert!(metadata.initial.is_empty());
        assert!(manager.resize("missing", "missing", 80, 24).await.is_ok());
        assert!(matches!(
            manager
                .attach(TerminalAttachInput::existing("missing", "missing"))
                .await,
            Err(TerminalError::NotFound { .. })
        ));

        let input = TerminalOpenInput::new(
            "thread-unit",
            "term-unit",
            root.path().to_path_buf(),
            80,
            24,
        );
        let opened = manager.open(input.clone()).await.unwrap();
        assert_eq!(opened.label, "Terminal unit");
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), metadata.recv())
                .await
                .unwrap(),
            Some(TerminalMetadataEvent::Upsert { .. })
        ));

        let mut attach_input = TerminalAttachInput::existing("thread-unit", "term-unit");
        attach_input.cols = Some(100);
        attach_input.rows = Some(30);
        let mut attachment = manager.attach(attach_input).await.unwrap();
        manager.write("thread-unit", "term-unit", "").await.unwrap();
        manager
            .resize("thread-unit", "term-unit", 120, 40)
            .await
            .unwrap();
        manager.clear("thread-unit", "term-unit").await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), attachment.recv())
                .await
                .unwrap(),
            Some(TerminalEvent::Cleared { .. })
        ));

        let restarted = manager.restart(input).await.unwrap();
        assert_eq!(restarted.status, TerminalStatus::Running);
        manager.close("thread-unit", Some("term-unit")).await;
        manager.shutdown().await;
    }

    #[test]
    fn presentation_helpers_cover_history_and_process_labels() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nthree\n");
        history.push("four\n");
        assert_eq!(history.snapshot(), "three\nfour\n");
        let mut cleared = TerminalHistory::new(0);
        cleared.push("ignored");
        assert!(cleared.snapshot().is_empty());

        assert_eq!(
            normalize_child_command_name("[/usr/bin/node.exe --flag]"),
            Some("node".into())
        );
        assert_eq!(
            normalize_child_command_name("( cargo test )"),
            Some("cargo".into())
        );
        assert_eq!(normalize_child_command_name("[]"), None);
        assert_eq!(terminal_label("custom"), "custom");
        assert_eq!(terminal_label("term-"), "term-");
    }
}
