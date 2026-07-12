use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use crate::{
    orchestration::{
        engine::{
            ActivityInput, OrchestrationCommand, OrchestrationEngine, ProposedPlanInput,
            SessionInput,
        },
        load_snapshot,
    },
    persistence::{ProviderSessionRuntime, Repositories},
    production::{
        operational_logs::ProviderOperationalLog, orchestration_effects::process_compatible_path,
    },
    provider::{
        claude::{
            ClaudeControlRequest, ClaudeProviderRuntime, Decision, RuntimeMode as ClaudeRuntimeMode,
        },
        codex::{
            CodexRuntimeMode, CodexSessionOptions, CodexSessionRuntime, ConnectionConfig,
            JsonRpcConnection,
        },
        cursor::{
            AcpConnectionConfig as CursorConnectionConfig,
            AcpJsonRpcConnection as CursorConnection, CursorSessionOptions, CursorSessionRuntime,
        },
        grok::{
            AcpConnectionConfig as GrokConnectionConfig, AcpJsonRpcConnection as GrokConnection,
            GrokSessionOptions, GrokSessionRuntime,
        },
        opencode::OpenCodeSessionRuntime,
    },
    server_settings::{ProviderBinarySettingsState, ProviderSettingsStore},
};
#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type BoxRuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const DEFAULT_QUEUE_CAPACITY: usize = 32;
const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 128;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct ProviderLaunchRequest {
    pub thread_id: String,
    pub provider: String,
    pub provider_instance_id: Option<String>,
    pub binary_path: String,
    pub cwd: PathBuf,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub resume_cursor: Option<Value>,
    pub environment: BTreeMap<String, String>,
    pub endpoint: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StartedSession {
    pub resume_cursor: Option<Value>,
    pub runtime_payload: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderEvent {
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
}

pub trait ProviderDriver: Send + Sync {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>>;
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>>;
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>>;
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
}

pub trait ProviderDriverFactory: Send + Sync {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>>;
}

#[derive(Clone, Debug)]
pub struct SupervisorOptions {
    pub queue_capacity: usize,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        Self {
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderRuntimeError {
    #[error("provider runtime supervisor is shut down")]
    Shutdown,
    #[error("provider runtime command queue is closed")]
    QueueClosed,
    #[error("provider runtime response was dropped")]
    ResponseDropped,
    #[error("thread {thread_id} has no active provider runtime")]
    SessionNotFound { thread_id: String },
    #[error(
        "cannot perform {action} for thread {thread_id}: the provider session is stale or was lost after restart; start a new turn to relaunch the provider runtime"
    )]
    StaleSession { thread_id: String, action: String },
    #[error("thread {thread_id} already has an active provider runtime")]
    SessionAlreadyExists { thread_id: String },
    #[error("provider {provider} is not supported")]
    UnsupportedProvider { provider: String },
    #[error("provider {provider} does not support {capability} while a session is running")]
    UnsupportedCapability {
        provider: String,
        capability: &'static str,
    },
    #[error("failed to spawn {provider} provider process: {detail}")]
    Spawn { provider: String, detail: String },
    #[error("{provider} provider operation failed: {detail}")]
    Provider { provider: String, detail: String },
    #[error("provider runtime persistence failed: {0}")]
    Persistence(String),
    #[error("provider event projection failed: {0}")]
    Orchestration(String),
}

#[derive(Clone)]
pub struct ProviderRuntimeSupervisor {
    sender: mpsc::Sender<SupervisorMessage>,
    stopped: CancellationToken,
    worker: Arc<Mutex<Option<JoinHandle<()>>>>,
}

enum SupervisorMessage {
    Launch {
        request: Box<ProviderLaunchRequest>,
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
    Handle {
        command: Box<OrchestrationCommand>,
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
    Shutdown {
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
}

struct SessionEntry {
    launch: ProviderLaunchRequest,
    driver: Arc<dyn ProviderDriver>,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    event_task: JoinHandle<()>,
    event_cancellation: CancellationToken,
}

impl ProviderRuntimeSupervisor {
    #[must_use]
    pub fn start(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        options: SupervisorOptions,
    ) -> Self {
        Self::start_inner(engine, factory, options, None)
    }

    #[must_use]
    pub(crate) fn start_with_operational_log(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        options: SupervisorOptions,
        operational_log: ProviderOperationalLog,
    ) -> Self {
        Self::start_inner(engine, factory, options, Some(operational_log))
    }

    fn start_inner(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        options: SupervisorOptions,
        operational_log: Option<ProviderOperationalLog>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(options.queue_capacity.max(1));
        let stopped = CancellationToken::new();
        let worker_stopped = stopped.clone();
        let worker = tokio::spawn(async move {
            run_supervisor(engine, factory, receiver, worker_stopped, operational_log).await;
        });
        Self {
            sender,
            stopped,
            worker: Arc::new(Mutex::new(Some(worker))),
        }
    }

    pub async fn launch(&self, request: ProviderLaunchRequest) -> Result<(), ProviderRuntimeError> {
        self.request(|response| SupervisorMessage::Launch {
            request: Box::new(request),
            response,
        })
        .await
    }

    pub async fn handle_orchestration(
        &self,
        command: OrchestrationCommand,
    ) -> Result<(), ProviderRuntimeError> {
        self.request(|response| SupervisorMessage::Handle {
            command: Box::new(command),
            response,
        })
        .await
    }

    pub async fn shutdown(&self) -> Result<(), ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Ok(());
        }
        let result = self
            .request(|response| SupervisorMessage::Shutdown { response })
            .await;
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.await;
        }
        result
    }

    async fn request(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<(), ProviderRuntimeError>>) -> SupervisorMessage,
    ) -> Result<(), ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(build(response_tx))
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }
}

pub async fn route_orchestration_command(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: OrchestrationCommand,
) -> Result<(), ProviderRuntimeError> {
    if let OrchestrationCommand::ThreadDelete {
        command_id,
        thread_id,
    } = &command
    {
        let stop = OrchestrationCommand::ThreadSessionStop {
            command_id: format!("{command_id}:provider-stop"),
            thread_id: thread_id.clone(),
            created_at: now(),
        };
        return match supervisor.handle_orchestration(stop).await {
            Err(ProviderRuntimeError::SessionNotFound { .. }) => Ok(()),
            result => result,
        };
    }

    let provider_command = matches!(
        command,
        OrchestrationCommand::ThreadTurnStart { .. }
            | OrchestrationCommand::ThreadTurnInterrupt { .. }
            | OrchestrationCommand::ThreadApprovalRespond { .. }
            | OrchestrationCommand::ThreadUserInputRespond { .. }
            | OrchestrationCommand::ThreadRuntimeModeSet { .. }
            | OrchestrationCommand::ThreadInteractionModeSet { .. }
            | OrchestrationCommand::ThreadSessionStop { .. }
            | OrchestrationCommand::ThreadMetaUpdate {
                model_selection: Some(_),
                ..
            }
    );
    if !provider_command {
        return Ok(());
    }

    let action = command.command_type().to_owned();
    match supervisor.handle_orchestration(command.clone()).await {
        Ok(()) => Ok(()),
        Err(ProviderRuntimeError::SessionNotFound { .. })
            if matches!(command, OrchestrationCommand::ThreadTurnStart { .. }) =>
        {
            let request = launch_request_for_command(engine, settings_root, &command).await?;
            supervisor.launch(request).await?;
            supervisor.handle_orchestration(command).await
        }
        Err(ProviderRuntimeError::SessionNotFound { .. })
            if matches!(
                command,
                OrchestrationCommand::ThreadRuntimeModeSet { .. }
                    | OrchestrationCommand::ThreadInteractionModeSet { .. }
                    | OrchestrationCommand::ThreadMetaUpdate {
                        model_selection: Some(_),
                        ..
                    }
            ) =>
        {
            Ok(())
        }
        Err(ProviderRuntimeError::SessionNotFound { thread_id }) => {
            Err(ProviderRuntimeError::StaleSession { thread_id, action })
        }
        Err(error) => Err(error),
    }
}

pub async fn reconcile_abandoned_provider_sessions(
    engine: &OrchestrationEngine,
) -> Result<(), ProviderRuntimeError> {
    const RESTART_ERROR: &str =
        "Provider session ended when T4Code stopped. Start a new turn to reconnect.";
    let repositories = engine.repositories();
    let runtimes = repositories
        .list_provider_session_runtimes()
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    for mut runtime in runtimes
        .into_iter()
        .filter(|runtime| matches!(runtime.status.as_str(), "connecting" | "running"))
    {
        runtime.status = "error".to_owned();
        runtime.last_seen_at = now();
        repositories
            .upsert_provider_session_runtime(runtime.clone())
            .await
            .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
        let created_at = now();
        engine
            .dispatch(OrchestrationCommand::ThreadSessionSet {
                command_id: format!("provider-restart-reconcile:{}", Uuid::new_v4()),
                thread_id: runtime.thread_id.clone(),
                session: SessionInput {
                    thread_id: runtime.thread_id,
                    status: "error".to_owned(),
                    provider_name: Some(runtime.provider_name),
                    provider_instance_id: runtime.provider_instance_id,
                    runtime_mode: runtime.runtime_mode,
                    active_turn_id: None,
                    last_error: Some(RESTART_ERROR.to_owned()),
                    updated_at: created_at.clone(),
                },
                created_at,
            })
            .await
            .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))?;
    }
    Ok(())
}

async fn launch_request_for_command(
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: &OrchestrationCommand,
) -> Result<ProviderLaunchRequest, ProviderRuntimeError> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        model_selection,
        runtime_mode,
        interaction_mode,
        ..
    } = command
    else {
        return Err(ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: "only a turn start can launch a provider runtime".to_owned(),
        });
    };
    let repositories = engine.repositories();
    let thread = repositories
        .get_thread(thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.clone(),
        })?;
    let project = repositories
        .get_project(thread.project_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: format!("project {} was not found", thread.project_id),
        })?;
    let selection = model_selection.as_ref().unwrap_or(&thread.model_selection);
    let instance_id = selection
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or("codex")
        .to_owned();
    let settings = ProviderSettingsStore::new(settings_root)
        .get()
        .await
        .map_err(|error| ProviderRuntimeError::Provider {
            provider: instance_id.clone(),
            detail: error.to_string(),
        })?;
    let instance = settings.provider_instances.get(&instance_id);
    let driver = instance
        .map(|value| value.driver.as_str())
        .unwrap_or(instance_id.as_str());
    let provider = match driver {
        "claudeAgent" | "claude" => "claudeAgent",
        "codex" => "codex",
        "cursor" => "cursor",
        "grok" => "grok",
        "opencode" => "opencode",
        other => {
            return Err(ProviderRuntimeError::UnsupportedProvider {
                provider: other.to_owned(),
            });
        }
    };
    let binary = provider_binary_settings(&settings.providers, provider, instance);
    if !binary.enabled || binary.binary_path.trim().is_empty() {
        return Err(ProviderRuntimeError::UnsupportedProvider {
            provider: provider.to_owned(),
        });
    }
    let environment = instance
        .into_iter()
        .flat_map(|value| value.environment.iter())
        .filter(|entry| !entry.name.trim().is_empty() && !entry.value_redacted)
        .map(|entry| (entry.name.clone(), entry.value.clone()))
        .collect();
    let persisted = repositories
        .get_provider_session_runtime(thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .filter(|runtime| {
            runtime.provider_name == provider
                && runtime.provider_instance_id.as_deref() == Some(instance_id.as_str())
        });
    Ok(ProviderLaunchRequest {
        thread_id: thread_id.clone(),
        provider: provider.to_owned(),
        provider_instance_id: Some(instance_id),
        binary_path: binary.binary_path.clone(),
        cwd: process_compatible_path(
            thread
                .worktree_path
                .map_or_else(|| PathBuf::from(project.workspace_root), PathBuf::from),
        ),
        runtime_mode: runtime_mode.clone(),
        interaction_mode: interaction_mode.clone(),
        model: model_from_selection(selection),
        resume_cursor: persisted.and_then(|runtime| runtime.resume_cursor),
        environment,
        endpoint: (!binary.server_url.trim().is_empty()).then(|| binary.server_url.clone()),
    })
}

fn provider_binary_settings(
    providers: &crate::server_settings::ProvidersState,
    provider: &str,
    instance: Option<&crate::server_settings::ProviderInstanceState>,
) -> ProviderBinarySettingsState {
    let mut settings = match provider {
        "claudeAgent" => providers.claude_agent.clone(),
        "cursor" => providers.cursor.clone(),
        "grok" => providers.grok.clone(),
        "opencode" => providers.opencode.clone(),
        _ => providers.codex.clone(),
    };
    if let Some(instance) = instance {
        settings.enabled = instance.enabled;
        let config_string = |name: &str| {
            instance
                .config
                .get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        if let Some(binary_path) = config_string("binaryPath") {
            settings.binary_path = binary_path;
        }
        if let Some(server_url) =
            config_string("serverUrl").or_else(|| config_string("apiEndpoint"))
        {
            settings.server_url = server_url;
        }
        if let Some(server_password) = config_string("serverPassword") {
            settings.server_password = server_password;
        }
    }
    settings
}

async fn run_supervisor(
    engine: OrchestrationEngine,
    factory: Arc<dyn ProviderDriverFactory>,
    mut receiver: mpsc::Receiver<SupervisorMessage>,
    stopped: CancellationToken,
    operational_log: Option<ProviderOperationalLog>,
) {
    let mut sessions = HashMap::<String, SessionEntry>::new();
    while let Some(message) = receiver.recv().await {
        match message {
            SupervisorMessage::Launch { request, response } => {
                let result = launch_session(
                    &engine,
                    &factory,
                    &mut sessions,
                    *request,
                    operational_log.as_ref(),
                )
                .await;
                let _ = response.send(result);
            }
            SupervisorMessage::Handle { command, response } => {
                let result = handle_command(
                    &engine,
                    &factory,
                    &mut sessions,
                    *command,
                    operational_log.as_ref(),
                )
                .await;
                let _ = response.send(result);
            }
            SupervisorMessage::Shutdown { response } => {
                let result = shutdown_sessions(&engine.repositories(), &mut sessions).await;
                stopped.cancel();
                let _ = response.send(result);
                return;
            }
        }
    }
    let _ = shutdown_sessions(&engine.repositories(), &mut sessions).await;
    stopped.cancel();
}

async fn launch_session(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    sessions: &mut HashMap<String, SessionEntry>,
    request: ProviderLaunchRequest,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    if sessions.contains_key(&request.thread_id) {
        return Err(ProviderRuntimeError::SessionAlreadyExists {
            thread_id: request.thread_id,
        });
    }
    let driver = factory.create(request.clone()).await?;
    persist_runtime(
        &engine.repositories(),
        &request,
        "connecting",
        request.resume_cursor.clone(),
        None,
    )
    .await?;
    let started = match driver.start().await {
        Ok(started) => started,
        Err(error) => {
            let _ = driver.shutdown().await;
            persist_runtime(
                &engine.repositories(),
                &request,
                "error",
                request.resume_cursor.clone(),
                Some(json!({ "error": error.to_string() })),
            )
            .await?;
            return Err(error);
        }
    };
    persist_runtime(
        &engine.repositories(),
        &request,
        "ready",
        started.resume_cursor.clone(),
        started.runtime_payload.clone(),
    )
    .await?;
    dispatch_session_state(engine, &request, "ready", None, None).await?;

    let cancellation = CancellationToken::new();
    let event_task = spawn_event_pump(
        engine.clone(),
        driver.clone(),
        request.clone(),
        started.resume_cursor.clone(),
        started.runtime_payload.clone(),
        cancellation.clone(),
        operational_log.cloned(),
    );
    sessions.insert(
        request.thread_id.clone(),
        SessionEntry {
            launch: request,
            driver,
            resume_cursor: started.resume_cursor,
            runtime_payload: started.runtime_payload,
            event_task,
            event_cancellation: cancellation,
        },
    );
    Ok(())
}

async fn handle_command(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    sessions: &mut HashMap<String, SessionEntry>,
    command: OrchestrationCommand,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    let thread_id = command_thread_id(&command)
        .map(str::to_owned)
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: format!(
                "{} is not a provider runtime command",
                command.command_type()
            ),
        })?;
    if matches!(command, OrchestrationCommand::ThreadSessionStop { .. }) {
        return stop_session(&engine.repositories(), sessions, &thread_id).await;
    }
    let entry =
        sessions
            .get_mut(&thread_id)
            .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                thread_id: thread_id.clone(),
            })?;

    match command {
        OrchestrationCommand::ThreadTurnStart {
            message,
            model_selection,
            interaction_mode,
            ..
        } => {
            if let Some(model) = model_selection.as_ref().and_then(model_from_selection)
                && entry.launch.model.as_deref() != Some(model.as_str())
            {
                entry.driver.set_model(model.clone()).await?;
                entry.launch.model = Some(model);
            }
            let turn_id = entry
                .driver
                .send(message.text, message.attachments, interaction_mode)
                .await?;
            persist_entry(&engine.repositories(), entry, "running").await?;
            dispatch_session_state(engine, &entry.launch, "running", turn_id, None).await
        }
        OrchestrationCommand::ThreadTurnInterrupt { turn_id, .. } => {
            entry.driver.interrupt(turn_id).await?;
            persist_entry(&engine.repositories(), entry, "ready").await
        }
        OrchestrationCommand::ThreadApprovalRespond {
            request_id,
            decision,
            ..
        } => entry.driver.approve(request_id, decision).await,
        OrchestrationCommand::ThreadUserInputRespond {
            request_id,
            answers,
            ..
        } => entry.driver.answer(request_id, answers).await,
        OrchestrationCommand::ThreadRuntimeModeSet { runtime_mode, .. } => {
            match entry.driver.set_mode(runtime_mode.clone()).await {
                Ok(()) => {
                    entry.launch.runtime_mode = runtime_mode;
                    persist_entry(&engine.repositories(), entry, "ready").await
                }
                Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                    let mut launch = entry.launch.clone();
                    launch.runtime_mode = runtime_mode;
                    restart_session(
                        engine,
                        factory,
                        sessions,
                        &thread_id,
                        launch,
                        operational_log,
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        }
        OrchestrationCommand::ThreadInteractionModeSet {
            interaction_mode, ..
        } => {
            entry.launch.interaction_mode = interaction_mode;
            persist_entry(&engine.repositories(), entry, "ready").await
        }
        OrchestrationCommand::ThreadMetaUpdate {
            model_selection: Some(selection),
            ..
        } => {
            if let Some(model) = model_from_selection(&selection) {
                match entry.driver.set_model(model.clone()).await {
                    Ok(()) => {
                        entry.launch.model = Some(model);
                        persist_entry(&engine.repositories(), entry, "ready").await?;
                    }
                    Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                        let mut launch = entry.launch.clone();
                        launch.model = Some(model);
                        return restart_session(
                            engine,
                            factory,
                            sessions,
                            &thread_id,
                            launch,
                            operational_log,
                        )
                        .await;
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        }
        OrchestrationCommand::ThreadCheckpointRevert { turn_count, .. } => {
            entry.driver.rollback(turn_count).await
        }
        _ => Ok(()),
    }
}

async fn restart_session(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
    mut launch: ProviderLaunchRequest,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    if let Some(entry) = sessions.remove(thread_id) {
        launch.resume_cursor = entry.resume_cursor.clone();
        entry.event_cancellation.cancel();
        let _ = entry.event_task.await;
        entry.driver.shutdown().await?;
    }
    engine
        .repositories()
        .delete_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    launch_session(engine, factory, sessions, launch, operational_log).await
}

fn command_thread_id(command: &OrchestrationCommand) -> Option<&str> {
    match command {
        OrchestrationCommand::ThreadCreate { thread_id, .. }
        | OrchestrationCommand::ThreadDelete { thread_id, .. }
        | OrchestrationCommand::ThreadArchive { thread_id, .. }
        | OrchestrationCommand::ThreadUnarchive { thread_id, .. }
        | OrchestrationCommand::ThreadMetaUpdate { thread_id, .. }
        | OrchestrationCommand::ThreadRuntimeModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadInteractionModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadTurnStart { thread_id, .. }
        | OrchestrationCommand::ThreadTurnInterrupt { thread_id, .. }
        | OrchestrationCommand::ThreadApprovalRespond { thread_id, .. }
        | OrchestrationCommand::ThreadUserInputRespond { thread_id, .. }
        | OrchestrationCommand::ThreadCheckpointRevert { thread_id, .. }
        | OrchestrationCommand::ThreadSessionStop { thread_id, .. }
        | OrchestrationCommand::ThreadSessionSet { thread_id, .. }
        | OrchestrationCommand::ThreadMessageAssistantDelta { thread_id, .. }
        | OrchestrationCommand::ThreadMessageAssistantComplete { thread_id, .. }
        | OrchestrationCommand::ThreadProposedPlanUpsert { thread_id, .. }
        | OrchestrationCommand::ThreadTurnDiffComplete { thread_id, .. }
        | OrchestrationCommand::ThreadActivityAppend { thread_id, .. }
        | OrchestrationCommand::ThreadRevertComplete { thread_id, .. } => Some(thread_id),
        _ => None,
    }
}

fn model_from_selection(selection: &Value) -> Option<String> {
    selection
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && !model.eq_ignore_ascii_case("auto"))
        .map(str::to_owned)
}

fn spawn_event_pump(
    engine: OrchestrationEngine,
    driver: Arc<dyn ProviderDriver>,
    launch: ProviderLaunchRequest,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    cancellation: CancellationToken,
    operational_log: Option<ProviderOperationalLog>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                event = driver.next_event() => {
                    let Some(event) = event else { return; };
                    if let Some(log) = &operational_log {
                        let _ = log.record(&event);
                    }
                    if let Err(error) = project_provider_event(
                        &engine,
                        &launch,
                        resume_cursor.clone(),
                        runtime_payload.clone(),
                        event,
                    ).await {
                        tracing::warn!(%error, "failed to project provider runtime event");
                    }
                }
            }
        }
    })
}

async fn project_provider_event(
    engine: &OrchestrationEngine,
    launch: &ProviderLaunchRequest,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    event: ProviderEvent,
) -> Result<(), ProviderRuntimeError> {
    let created_at = now();
    let command_id = format!("provider:{}", Uuid::new_v4());
    let assistant_message_id = assistant_message_id(&event);
    if event.event_type == "turn.completed" {
        let state = event
            .payload
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let failed = state == "failed";
        let last_error = failed.then(|| provider_completion_error(&event.payload));
        let status = if failed { "error" } else { "ready" };
        persist_runtime(
            &engine.repositories(),
            launch,
            status,
            resume_cursor,
            runtime_payload,
        )
        .await?;
        dispatch_session_state(engine, launch, status, None, last_error).await?;
        let has_assistant_content = if failed {
            load_snapshot(&engine.repositories())
                .await
                .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
                .messages
                .iter()
                .any(|message| message.message_id == assistant_message_id)
        } else {
            true
        };
        if has_assistant_content {
            engine
                .dispatch(OrchestrationCommand::ThreadMessageAssistantComplete {
                    command_id: format!("{command_id}:assistant-complete"),
                    thread_id: event.thread_id.clone(),
                    message_id: assistant_message_id.clone(),
                    turn_id: event.turn_id.clone(),
                    created_at: created_at.clone(),
                })
                .await
                .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))?;
        }
    }
    let command = match event.event_type.as_str() {
        "content.delta"
        | "message.assistant.delta"
        | "assistant.message.delta"
        | "item.agent_message.delta" => OrchestrationCommand::ThreadMessageAssistantDelta {
            command_id,
            thread_id: event.thread_id,
            message_id: assistant_message_id.clone(),
            delta: event
                .payload
                .get("delta")
                .or_else(|| event.payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            turn_id: event.turn_id,
            created_at,
        },
        "message.assistant.completed" | "assistant.message.completed" => {
            OrchestrationCommand::ThreadMessageAssistantComplete {
                command_id,
                thread_id: event.thread_id,
                message_id: event
                    .payload
                    .get("messageId")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant")
                    .to_owned(),
                turn_id: event.turn_id,
                created_at,
            }
        }
        "turn.proposed.completed" => {
            let turn_id = event.turn_id;
            OrchestrationCommand::ThreadProposedPlanUpsert {
                command_id,
                thread_id: event.thread_id,
                proposed_plan: ProposedPlanInput {
                    id: format!("plan:{}", Uuid::new_v4()),
                    turn_id,
                    plan_markdown: event
                        .payload
                        .get("planMarkdown")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    implemented_at: None,
                    implementation_thread_id: None,
                    created_at: created_at.clone(),
                    updated_at: created_at.clone(),
                },
                created_at,
            }
        }
        _ => {
            let (tone, kind) = if event.event_type == "turn.completed"
                && event.payload.get("state").and_then(Value::as_str) == Some("failed")
            {
                ("error", "provider.error")
            } else {
                event_activity_shape(&event.event_type)
            };
            let mut payload = event.payload;
            if let Some(request_id) = event.request_id {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("requestId".to_owned(), Value::String(request_id));
                } else {
                    payload = json!({ "requestId": request_id, "detail": payload });
                }
            }
            OrchestrationCommand::ThreadActivityAppend {
                command_id,
                thread_id: event.thread_id,
                activity: ActivityInput {
                    id: format!("activity:{}", Uuid::new_v4()),
                    tone: tone.to_owned(),
                    kind: kind.to_owned(),
                    summary: event.event_type,
                    payload,
                    turn_id: event.turn_id,
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            }
        }
    };
    engine
        .dispatch(command)
        .await
        .map(|_| ())
        .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))
}

fn assistant_message_id(event: &ProviderEvent) -> String {
    event
        .payload
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            event
                .turn_id
                .as_ref()
                .map(|turn_id| format!("assistant:{turn_id}"))
        })
        .unwrap_or_else(|| format!("assistant:{}", event.thread_id))
}

fn provider_completion_error(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("Provider turn failed.")
        .to_owned()
}

fn event_activity_shape(event_type: &str) -> (&'static str, &'static str) {
    match event_type {
        "request.opened" => ("approval", "approval.requested"),
        "request.resolved" => ("approval", "approval.resolved"),
        "user-input.requested" => ("approval", "user-input.requested"),
        "user-input.resolved" => ("approval", "user-input.resolved"),
        event if event.contains("error") || event.contains("failed") => ("error", "provider.error"),
        event if event.starts_with("turn.") => ("info", "provider.turn"),
        event if event.starts_with("session.") => ("info", "provider.session"),
        _ => ("tool", "provider.event"),
    }
}

async fn dispatch_session_state(
    engine: &OrchestrationEngine,
    request: &ProviderLaunchRequest,
    status: &str,
    active_turn_id: Option<String>,
    last_error: Option<String>,
) -> Result<(), ProviderRuntimeError> {
    let created_at = now();
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: format!("provider-session:{}", Uuid::new_v4()),
            thread_id: request.thread_id.clone(),
            session: SessionInput {
                thread_id: request.thread_id.clone(),
                status: status.to_owned(),
                provider_name: Some(request.provider.clone()),
                provider_instance_id: request.provider_instance_id.clone(),
                runtime_mode: request.runtime_mode.clone(),
                active_turn_id,
                last_error,
                updated_at: created_at.clone(),
            },
            created_at,
        })
        .await
        .map(|_| ())
        .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))
}

async fn persist_entry(
    repositories: &Repositories,
    entry: &SessionEntry,
    status: &str,
) -> Result<(), ProviderRuntimeError> {
    persist_runtime(
        repositories,
        &entry.launch,
        status,
        entry.resume_cursor.clone(),
        entry.runtime_payload.clone(),
    )
    .await
}

async fn persist_runtime(
    repositories: &Repositories,
    request: &ProviderLaunchRequest,
    status: &str,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
) -> Result<(), ProviderRuntimeError> {
    repositories
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: request.thread_id.clone(),
            provider_name: request.provider.clone(),
            provider_instance_id: request.provider_instance_id.clone(),
            adapter_key: native_adapter_key(&request.provider).to_owned(),
            runtime_mode: request.runtime_mode.clone(),
            status: status.to_owned(),
            last_seen_at: now(),
            resume_cursor,
            runtime_payload,
        })
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))
}

fn native_adapter_key(provider: &str) -> &'static str {
    match provider {
        "codex" => "codex-app-server",
        "claude" | "claudeAgent" => "claude-stream-json",
        "cursor" => "cursor-acp",
        "grok" => "grok-acp",
        "opencode" => "opencode-http",
        _ => "native-provider",
    }
}

async fn stop_session(
    repositories: &Repositories,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
) -> Result<(), ProviderRuntimeError> {
    let Some(entry) = sessions.remove(thread_id) else {
        return Err(ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.to_owned(),
        });
    };
    entry.event_cancellation.cancel();
    let result = entry.driver.shutdown().await;
    entry.event_task.abort();
    let _ = entry.event_task.await;
    repositories
        .delete_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    result
}

async fn shutdown_sessions(
    repositories: &Repositories,
    sessions: &mut HashMap<String, SessionEntry>,
) -> Result<(), ProviderRuntimeError> {
    let thread_ids = sessions.keys().cloned().collect::<Vec<_>>();
    let mut first_error = None;
    for thread_id in thread_ids {
        if let Err(error) = stop_session(repositories, sessions, &thread_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[derive(Clone, Debug, Default)]
pub struct NativeProviderDriverFactory;

impl ProviderDriverFactory for NativeProviderDriverFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            match request.provider.as_str() {
                "codex" => {
                    Ok(Arc::new(CodexDriver::spawn(request).await?) as Arc<dyn ProviderDriver>)
                }
                "cursor" => {
                    Ok(Arc::new(CursorDriver::spawn(request).await?) as Arc<dyn ProviderDriver>)
                }
                "grok" => {
                    Ok(Arc::new(GrokDriver::spawn(request).await?) as Arc<dyn ProviderDriver>)
                }
                "opencode" => {
                    Ok(Arc::new(OpenCodeDriver::spawn(request).await?) as Arc<dyn ProviderDriver>)
                }
                "claude" | "claudeAgent" => {
                    Ok(Arc::new(ClaudeDriver::spawn(request).await?) as Arc<dyn ProviderDriver>)
                }
                provider => Err(ProviderRuntimeError::UnsupportedProvider {
                    provider: provider.to_owned(),
                }),
            }
        })
    }
}

type SharedChild = Arc<Mutex<Box<dyn ChildWrapper>>>;

fn spawn_child(
    request: &ProviderLaunchRequest,
    args: &[String],
    pipe_output: bool,
) -> Result<Box<dyn ChildWrapper>, ProviderRuntimeError> {
    let provider = request.provider.clone();
    let executable = resolve_provider_executable(&request.binary_path).ok_or_else(|| {
        ProviderRuntimeError::Spawn {
            provider: provider.clone(),
            detail: format!("provider executable was not found: {}", request.binary_path),
        }
    })?;
    let (program, prefix_args) = provider_launch_program(&executable);
    let mut command = CommandWrap::with_new(program, |command| {
        command
            .args(prefix_args)
            .args(args)
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(if pipe_output {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(if pipe_output {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        command.envs(&request.environment);
    });
    command.wrap(KillOnDrop);
    #[cfg(windows)]
    command.wrap(JobObject);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    command
        .spawn()
        .map_err(|error| ProviderRuntimeError::Spawn {
            provider,
            detail: error.to_string(),
        })
}

pub(crate) fn resolve_provider_executable(input: &str) -> Option<PathBuf> {
    let path = PathBuf::from(input);
    if path.is_file() {
        return Some(path);
    }
    if path.components().count() > 1 {
        return None;
    }
    let extensions: &[&str] = if cfg!(windows) {
        WINDOWS_PROVIDER_EXECUTABLE_EXTENSIONS
    } else {
        &[""]
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .find_map(|directory| {
            extensions.iter().find_map(|extension| {
                let candidate = if extension.is_empty() {
                    directory.join(input)
                } else {
                    directory.join(format!("{input}.{extension}"))
                };
                candidate.is_file().then_some(candidate)
            })
        })
}

#[cfg(windows)]
const WINDOWS_PROVIDER_EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "com", "cmd", "bat", "ps1"];

pub(crate) fn provider_launch_program(executable: &Path) -> (PathBuf, Vec<String>) {
    let extension = executable
        .extension()
        .and_then(|extension| extension.to_str());
    if cfg!(windows) && extension.is_some_and(|extension| extension.eq_ignore_ascii_case("ps1")) {
        return (
            PathBuf::from("powershell.exe"),
            vec![
                "-NoLogo".to_owned(),
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-ExecutionPolicy".to_owned(),
                "Bypass".to_owned(),
                "-File".to_owned(),
                executable.to_string_lossy().into_owned(),
            ],
        );
    }
    if cfg!(windows)
        && extension.is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        return (
            std::env::var_os("ComSpec")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("cmd.exe")),
            vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                executable.to_string_lossy().into_owned(),
            ],
        );
    }
    (executable.to_path_buf(), Vec::new())
}

async fn kill_child(child: &SharedChild) {
    let mut child = child.lock().await;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
}

fn runtime_mode(value: &str) -> CodexRuntimeMode {
    match value {
        "approval-required" => CodexRuntimeMode::ApprovalRequired,
        "auto-accept-edits" => CodexRuntimeMode::AutoAcceptEdits,
        _ => CodexRuntimeMode::FullAccess,
    }
}

struct CodexDriver {
    runtime: CodexSessionRuntime,
    child: SharedChild,
}

impl CodexDriver {
    async fn spawn(request: ProviderLaunchRequest) -> Result<Self, ProviderRuntimeError> {
        let args = vec!["app-server".to_owned()];
        let mut child = spawn_child(&request, &args, true)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            JsonRpcConnection::spawn(stdout, stdin, stderr, ConnectionConfig::default());
        let resume_cursor = request.resume_cursor.as_ref().and_then(resume_string);
        let runtime = CodexSessionRuntime::new(
            CodexSessionOptions {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                runtime_mode: runtime_mode(&request.runtime_mode),
                model: request.model,
                service_tier: None,
                effort: None,
                resume_cursor,
            },
            connection,
            incoming,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
        })
    }
}

impl ProviderDriver for CodexDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let session = self
                .runtime
                .start()
                .await
                .map_err(provider_error("codex"))?;
            Ok(StartedSession {
                resume_cursor: session
                    .resume_cursor
                    .map(|value| json!({ "threadId": value })),
                runtime_payload: Some(json!({ "model": session.model, "cwd": session.cwd })),
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .send_turn(Some(text), attachments, Some(interaction_mode))
                .await
                .map(|turn| Some(turn.turn_id))
                .map_err(provider_error("codex"))
        })
    }
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn(turn_id)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn set_mode(&self, _mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("codex", "post-start runtime mode changes")
    }
    fn set_model(&self, _model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("codex", "post-start model changes")
    }
    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let count = u64::try_from(turn_count).map_err(|_| ProviderRuntimeError::Provider {
                provider: "codex".to_owned(),
                detail: "turn count must be non-negative".to_owned(),
            })?;
            self.runtime
                .rollback_thread(count)
                .await
                .map(|_| ())
                .map_err(provider_error("codex"))
        })
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = self
                .runtime
                .shutdown()
                .await
                .map_err(provider_error("codex"));
            kill_child(&self.child).await;
            result
        })
    }
}

struct CursorDriver {
    runtime: CursorSessionRuntime,
    child: SharedChild,
    resume_cursor: Option<Value>,
}
impl CursorDriver {
    async fn spawn(request: ProviderLaunchRequest) -> Result<Self, ProviderRuntimeError> {
        let mut args = Vec::new();
        if let Some(endpoint) = request.endpoint.as_ref() {
            args.extend(["-e".to_owned(), endpoint.clone()]);
        }
        args.push("acp".to_owned());
        let mut child = spawn_child(&request, &args, true)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            CursorConnection::spawn(stdout, stdin, stderr, CursorConnectionConfig::default());
        let resume_cursor = request.resume_cursor.clone();
        let runtime = CursorSessionRuntime::new(
            CursorSessionOptions {
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                runtime_mode: request.runtime_mode,
                model: request.model.unwrap_or_default(),
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
            },
            connection,
            incoming,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            resume_cursor,
        })
    }
}

impl ProviderDriver for CursorDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .start()
                .await
                .map_err(provider_error("cursor"))?;
            Ok(StartedSession {
                resume_cursor: self.resume_cursor.clone(),
                runtime_payload: None,
            })
        })
    }
    fn send(
        &self,
        text: String,
        _: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .send_turn(&text)
                .await
                .map(Some)
                .map_err(provider_error("cursor"))
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn()
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_mode(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("cursor", "post-start runtime mode changes")
    }
    fn set_model(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("cursor", "post-start model changes")
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("cursor", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            kill_child(&self.child).await;
            Ok(())
        })
    }
}

struct GrokDriver {
    runtime: GrokSessionRuntime,
    child: SharedChild,
}
impl GrokDriver {
    async fn spawn(mut request: ProviderLaunchRequest) -> Result<Self, ProviderRuntimeError> {
        request
            .environment
            .entry("GROK_OAUTH2_REFERRER".to_owned())
            .or_insert_with(|| "t4code".to_owned());
        let auth_method_id = if request
            .environment
            .get("XAI_API_KEY")
            .is_some_and(|value| !value.trim().is_empty())
        {
            "xai.api_key"
        } else {
            "cached_token"
        }
        .to_owned();
        let args = vec!["agent".to_owned(), "stdio".to_owned()];
        let mut child = spawn_child(&request, &args, true)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            GrokConnection::spawn(stdout, stdin, stderr, GrokConnectionConfig::default());
        let resume_session_id = request.resume_cursor.as_ref().and_then(resume_string);
        let runtime = GrokSessionRuntime::new_with_auth_and_resume(
            GrokSessionOptions {
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
            },
            connection,
            incoming,
            auth_method_id,
            resume_session_id,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
        })
    }
}

impl ProviderDriver for GrokDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let id = self.runtime.start().await.map_err(provider_error("grok"))?;
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId": id})),
                runtime_payload: None,
            })
        })
    }
    fn send(
        &self,
        text: String,
        _: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .send_turn(&text)
                .await
                .map(Some)
                .map_err(provider_error("grok"))
        })
    }
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let Some(turn_id) = turn_id else {
                return Ok(());
            };
            self.runtime
                .interrupt_turn(&turn_id)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_mode(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("grok", "post-start runtime mode changes")
    }
    fn set_model(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("grok", "post-start model changes")
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("grok", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            kill_child(&self.child).await;
            Ok(())
        })
    }
}

struct OpenCodeDriver {
    runtime: OpenCodeSessionRuntime,
    child: Option<SharedChild>,
    resume_session_id: Option<String>,
}
impl OpenCodeDriver {
    async fn spawn(request: ProviderLaunchRequest) -> Result<Self, ProviderRuntimeError> {
        if let Some(endpoint) = request.endpoint.as_ref() {
            return Ok(Self {
                runtime: OpenCodeSessionRuntime::new(
                    endpoint,
                    &request.thread_id,
                    &request.cwd.to_string_lossy(),
                    request.model.as_deref(),
                ),
                child: None,
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
            });
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(provider_error("opencode"))?;
        let port = listener
            .local_addr()
            .map_err(provider_error("opencode"))?
            .port();
        drop(listener);
        let endpoint = format!("http://127.0.0.1:{port}");
        let args = vec![
            "serve".to_owned(),
            "--hostname=127.0.0.1".to_owned(),
            format!("--port={port}"),
        ];
        let child = Arc::new(Mutex::new(spawn_child(&request, &args, false)?));
        wait_for_endpoint(&endpoint, &child).await?;
        Ok(Self {
            runtime: OpenCodeSessionRuntime::new(
                &endpoint,
                &request.thread_id,
                &request.cwd.to_string_lossy(),
                request.model.as_deref(),
            ),
            child: Some(child),
            resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
        })
    }
}

impl ProviderDriver for OpenCodeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let id = match &self.resume_session_id {
                Some(session_id) => self.runtime.resume(session_id).await,
                None => self.runtime.start().await,
            }
            .map_err(provider_error("opencode"))?;
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":id})),
                runtime_payload: None,
            })
        })
    }
    fn send(
        &self,
        text: String,
        _: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .send_turn(&text)
                .await
                .map(Some)
                .map_err(provider_error("opencode"))
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn()
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn approve(
        &self,
        _: String,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("opencode", "approval responses")
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn set_mode(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("opencode", "post-start runtime mode changes")
    }
    fn set_model(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("opencode", "post-start model changes")
    }
    fn rollback(&self, count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let count = usize::try_from(count).map_err(|_| ProviderRuntimeError::Provider {
                provider: "opencode".to_owned(),
                detail: "turn count must be non-negative".to_owned(),
            })?;
            self.runtime
                .rollback_thread(count)
                .await
                .map(|_| ())
                .map_err(provider_error("opencode"))
        })
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = self
                .runtime
                .stop()
                .await
                .map_err(provider_error("opencode"));
            if let Some(child) = &self.child {
                kill_child(child).await;
            }
            result
        })
    }
}

struct ClaudeDriver {
    provider: String,
    runtime: Arc<Mutex<ClaudeProviderRuntime>>,
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    events: Mutex<mpsc::Receiver<ProviderEvent>>,
    child: SharedChild,
    session_id: String,
    runtime_mode: Mutex<ClaudeRuntimeMode>,
    sequence: Mutex<u64>,
}

impl ClaudeDriver {
    async fn spawn(request: ProviderLaunchRequest) -> Result<Self, ProviderRuntimeError> {
        let mode = claude_mode(&request.runtime_mode, &request.interaction_mode);
        let session_id = request
            .resume_cursor
            .as_ref()
            .and_then(resume_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut args = vec![
            "--input-format".to_owned(),
            "stream-json".to_owned(),
            "--output-format".to_owned(),
            "stream-json".to_owned(),
            "--include-partial-messages".to_owned(),
            "--verbose".to_owned(),
            "--permission-mode".to_owned(),
            claude_permission_arg(mode).to_owned(),
        ];
        if request.resume_cursor.is_some() {
            args.extend(["--resume".to_owned(), session_id.clone()]);
        } else {
            args.extend(["--session-id".to_owned(), session_id.clone()]);
        }
        if let Some(model) = request.model.as_ref() {
            args.extend(["--model".to_owned(), model.clone()]);
        }
        let mut child = spawn_child(&request, &args, true)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let runtime = Arc::new(Mutex::new(ClaudeProviderRuntime::new(
            request.thread_id.clone(),
            session_id.clone(),
        )));
        let (events_tx, events_rx) = mpsc::channel(DEFAULT_EVENT_QUEUE_CAPACITY);
        spawn_claude_output(
            runtime.clone(),
            request.thread_id.clone(),
            stdout,
            stderr,
            events_tx,
        );
        Ok(Self {
            provider: request.provider,
            runtime,
            writer: Mutex::new(Box::new(stdin)),
            events: Mutex::new(events_rx),
            child: Arc::new(Mutex::new(child)),
            session_id,
            runtime_mode: Mutex::new(mode),
            sequence: Mutex::new(0),
        })
    }

    async fn write_json(&self, value: Value) -> Result<(), ProviderRuntimeError> {
        let mut bytes = serde_json::to_vec(&value).map_err(provider_error(&self.provider))?;
        bytes.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&bytes)
            .await
            .map_err(provider_error(&self.provider))?;
        writer.flush().await.map_err(provider_error(&self.provider))
    }

    async fn next_sequence(&self) -> u64 {
        let mut value = self.sequence.lock().await;
        *value += 1;
        *value
    }
}

impl ProviderDriver for ClaudeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let mode = *self.runtime_mode.lock().await;
            let events = self.runtime.lock().await.start_session(mode, None);
            drop(events);
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":self.session_id})),
                runtime_payload: Some(json!({"transport":"stream-json"})),
            })
        })
    }
    fn send(
        &self,
        text: String,
        _: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let turn_id = Uuid::new_v4().to_string();
            self.runtime
                .lock()
                .await
                .start_turn(crate::provider::claude::TurnInput {
                    turn_id: turn_id.clone(),
                    input: text.clone(),
                });
            self.write_json(json!({"type":"user","session_id":self.session_id,"message":{"role":"user","content":[{"type":"text","text":text}]},"parent_tool_use_id":null})).await?;
            Ok(Some(turn_id))
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let control = ClaudeControlRequest::interrupt(self.next_sequence().await);
            self.write_json(json!({"type":"control_request","request":control}))
                .await
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let accepted = matches!(decision.as_str(), "accept" | "acceptForSession");
            self.runtime.lock().await.resolve_permission_request(
                &request_id,
                if accepted {
                    Decision::Accept
                } else {
                    Decision::Deny
                },
            );
            self.write_json(json!({"type":"control_response","response":{"request_id":request_id,"subtype":"success","response":{"behavior":if accepted {"allow"} else {"deny"}}}})).await
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .lock()
                .await
                .resolve_user_input_request(&request_id, answers.clone());
            self.write_json(json!({"type":"control_response","response":{"request_id":request_id,"subtype":"success","response":answers}})).await
        })
    }
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let mode = claude_mode(&mode, "default");
            *self.runtime_mode.lock().await = mode;
            let request = ClaudeControlRequest::set_permission_mode(
                self.next_sequence().await,
                mode.permission_mode(),
            );
            self.write_json(json!({"type":"control_request","request":request}))
                .await
        })
    }
    fn set_model(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("claude", "post-start model changes")
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("claude", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { self.events.lock().await.recv().await })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let _ = self.writer.lock().await.shutdown().await;
            kill_child(&self.child).await;
            Ok(())
        })
    }
}

fn spawn_claude_output(
    runtime: Arc<Mutex<ClaudeProviderRuntime>>,
    thread_id: String,
    stdout: impl tokio::io::AsyncRead + Send + Unpin + 'static,
    stderr: impl tokio::io::AsyncRead + Send + Unpin + 'static,
    sender: mpsc::Sender<ProviderEvent>,
) {
    let stdout_sender = sender.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str(&line) else {
                continue;
            };
            let events = runtime.lock().await.handle_message(message);
            for event in events {
                if stdout_sender
                    .send(ProviderEvent {
                        event_type: event.event_type,
                        thread_id: event.thread_id,
                        turn_id: event.turn_id,
                        request_id: event.request_id,
                        payload: event.payload,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if sender
                .send(ProviderEvent {
                    event_type: "session.stderr".to_owned(),
                    thread_id: thread_id.clone(),
                    turn_id: None,
                    request_id: None,
                    payload: json!({"message":line}),
                })
                .await
                .is_err()
            {
                return;
            }
        }
    });
}

fn claude_mode(runtime_mode: &str, interaction_mode: &str) -> ClaudeRuntimeMode {
    if interaction_mode == "plan" {
        return ClaudeRuntimeMode::Plan;
    }
    match runtime_mode {
        "approval-required" => ClaudeRuntimeMode::ApprovalRequired,
        "auto-accept-edits" => ClaudeRuntimeMode::AutoAcceptEdits,
        _ => ClaudeRuntimeMode::FullAccess,
    }
}

fn claude_permission_arg(mode: ClaudeRuntimeMode) -> &'static str {
    match mode {
        ClaudeRuntimeMode::FullAccess => "bypassPermissions",
        ClaudeRuntimeMode::ApprovalRequired => "default",
        ClaudeRuntimeMode::AutoAcceptEdits => "acceptEdits",
        ClaudeRuntimeMode::Plan => "plan",
    }
}

fn resume_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| {
        value
            .get("threadId")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn pipe_error(provider: &str, stream: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::Spawn {
        provider: provider.to_owned(),
        detail: format!("child did not expose {stream}"),
    }
}

fn provider_error<E: std::fmt::Display>(
    provider: &str,
) -> impl FnOnce(E) -> ProviderRuntimeError + '_ {
    move |error| ProviderRuntimeError::Provider {
        provider: provider.to_owned(),
        detail: error.to_string(),
    }
}

fn unsupported<T>(
    provider: &str,
    capability: &'static str,
) -> BoxRuntimeFuture<'static, Result<T, ProviderRuntimeError>>
where
    T: Send + 'static,
{
    let provider = provider.to_owned();
    Box::pin(async move {
        Err(ProviderRuntimeError::UnsupportedCapability {
            provider,
            capability,
        })
    })
}

async fn wait_for_endpoint(
    endpoint: &str,
    child: &SharedChild,
) -> Result<(), ProviderRuntimeError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if reqwest::get(endpoint).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            kill_child(child).await;
            return Err(ProviderRuntimeError::Provider {
                provider: "opencode".to_owned(),
                detail: "server did not become ready within 5 seconds".to_owned(),
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use crate::server_settings::{ProviderInstanceState, ProvidersState};
    use serde_json::json;

    #[test]
    fn automatic_model_selection_uses_the_provider_default() {
        assert_eq!(super::model_from_selection(&json!({"model":"auto"})), None);
        assert_eq!(
            super::model_from_selection(&json!({"model":"gpt-5.4"})),
            Some("gpt-5.4".to_owned())
        );
    }

    #[test]
    fn session_and_turn_events_use_a_contract_activity_tone() {
        assert_eq!(
            super::event_activity_shape("session.ready"),
            ("info", "provider.session")
        );
        assert_eq!(
            super::event_activity_shape("turn.completed"),
            ("info", "provider.turn")
        );
    }

    #[test]
    fn explicit_instance_overrides_legacy_binary_settings() {
        let providers = ProvidersState::default();
        assert!(!providers.cursor.enabled);
        let instance = ProviderInstanceState {
            driver: "cursor".to_owned(),
            enabled: true,
            display_name: None,
            environment: Vec::new(),
            config: json!({
                "binaryPath": "cursor-agent",
                "apiEndpoint": "http://127.0.0.1:3210",
            }),
        };

        let resolved = super::provider_binary_settings(&providers, "cursor", Some(&instance));
        assert!(resolved.enabled);
        assert_eq!(resolved.binary_path, "cursor-agent");
        assert_eq!(resolved.server_url, "http://127.0.0.1:3210");
    }

    #[cfg(windows)]
    #[test]
    fn windows_executable_resolution_prefers_cmd_over_powershell_shims() {
        let cmd_index = super::WINDOWS_PROVIDER_EXECUTABLE_EXTENSIONS
            .iter()
            .position(|extension| *extension == "cmd")
            .expect("cmd extension");
        let powershell_index = super::WINDOWS_PROVIDER_EXECUTABLE_EXTENSIONS
            .iter()
            .position(|extension| *extension == "ps1")
            .expect("PowerShell extension");

        assert!(cmd_index < powershell_index);
    }
}
