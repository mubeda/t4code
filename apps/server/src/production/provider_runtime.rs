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
    process::configure_background_command_wrap,
    production::{
        connect_mcp::ConnectMcpService, operational_logs::ProviderOperationalLog,
        orchestration_effects::process_compatible_path,
    },
    provider::{
        attachments::{AttachmentMaterializer, MaterializedImage},
        claude::{
            ClaudeControlRequest, ClaudeProviderRuntime, Decision, RuntimeMode as ClaudeRuntimeMode,
        },
        codex::{
            CodexHomeLayout, CodexRuntimeMode, CodexSessionOptions, CodexSessionRuntime,
            ConnectionConfig, JsonRpcConnection, materialize_codex_shadow_home,
            resolve_codex_home_layout,
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
    sync::{Mutex, RwLock, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type BoxRuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const DEFAULT_QUEUE_CAPACITY: usize = 32;
const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 128;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

/// Prevent host diagnostics settings from turning provider stderr into a high-volume event stream.
pub(crate) fn sanitize_provider_subprocess_environment(command: &mut tokio::process::Command) {
    command.env_remove("RUST_LOG");
}

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
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub agent: Option<String>,
    pub resume_cursor: Option<Value>,
    pub environment: BTreeMap<String, String>,
    pub endpoint: Option<String>,
    pub server_password: Option<String>,
    pub mcp: Option<ProviderMcpConfig>,
    pub codex_home: Option<CodexHomeLayout>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderMcpConfig {
    pub endpoint: String,
    pub authorization_header: String,
    pub provider_session_id: String,
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
    fn set_interaction_mode(
        &self,
        _mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async { Ok(()) })
    }
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
    connect_mcp: Arc<RwLock<Option<Arc<ConnectMcpService>>>>,
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
            connect_mcp: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn attach_connect_mcp(&self, service: Arc<ConnectMcpService>) {
        *self.connect_mcp.write().await = Some(service);
    }

    pub async fn launch(
        &self,
        mut request: ProviderLaunchRequest,
    ) -> Result<(), ProviderRuntimeError> {
        if request.mcp.is_none()
            && let Some(connect) = self.connect_mcp.read().await.clone()
        {
            let provider_instance_id = request
                .provider_instance_id
                .clone()
                .unwrap_or_else(|| request.provider.clone());
            let issued = connect
                .issue_mcp_credential(request.thread_id.clone(), provider_instance_id)
                .await
                .map_err(|error| ProviderRuntimeError::Provider {
                    provider: request.provider.clone(),
                    detail: format!("could not issue T4Code MCP credential: {error:?}"),
                })?;
            request.mcp = Some(ProviderMcpConfig {
                endpoint: issued.endpoint,
                authorization_header: issued.authorization_header,
                provider_session_id: issued.provider_session_id,
            });
        }
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
    for runtime in runtimes
        .into_iter()
        .filter(|runtime| matches!(runtime.status.as_str(), "connecting" | "ready" | "running"))
    {
        let thread_id = runtime.thread_id.clone();
        if let Err(error) =
            reconcile_abandoned_provider_session(engine, &repositories, runtime, RESTART_ERROR)
                .await
        {
            tracing::warn!(
                thread_id,
                %error,
                "abandoned provider session remains eligible for startup reconciliation retry"
            );
        }
    }
    Ok(())
}

async fn reconcile_abandoned_provider_session(
    engine: &OrchestrationEngine,
    repositories: &Repositories,
    mut runtime: ProviderSessionRuntime,
    restart_error: &str,
) -> Result<(), ProviderRuntimeError> {
    let projected_at = runtime.last_seen_at.clone();
    let projection_is_complete = repositories
        .get_thread_session(runtime.thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .is_some_and(|session| {
            session.status == "error"
                && session.provider_name.as_deref() == Some(runtime.provider_name.as_str())
                && session.provider_instance_id == runtime.provider_instance_id
                && session.runtime_mode == runtime.runtime_mode
                && session.active_turn_id.is_none()
                && session.last_error.as_deref() == Some(restart_error)
                && session.updated_at == projected_at
        });
    if !projection_is_complete {
        engine
            .dispatch(OrchestrationCommand::ThreadSessionSet {
                command_id: format!("provider-restart-reconcile:{}", Uuid::new_v4()),
                thread_id: runtime.thread_id.clone(),
                session: SessionInput {
                    thread_id: runtime.thread_id.clone(),
                    status: "error".to_owned(),
                    provider_name: Some(runtime.provider_name.clone()),
                    provider_instance_id: runtime.provider_instance_id.clone(),
                    runtime_mode: runtime.runtime_mode.clone(),
                    active_turn_id: None,
                    last_error: Some(restart_error.to_owned()),
                    updated_at: projected_at.clone(),
                },
                created_at: projected_at,
            })
            .await
            .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))?;
    }

    runtime.status = "error".to_owned();
    runtime.last_seen_at = now();
    repositories
        .upsert_provider_session_runtime(runtime)
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))
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
    let codex_home = (provider == "codex").then(|| {
        let config = instance.map(|value| &value.config);
        resolve_codex_home_layout(
            config
                .and_then(|value| value.get("homePath"))
                .and_then(Value::as_str),
            config
                .and_then(|value| value.get("shadowHomePath"))
                .and_then(Value::as_str),
            dirs::home_dir()
                .as_deref()
                .unwrap_or_else(|| Path::new(".")),
        )
    });
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
        service_tier: selection_string_option(selection, "serviceTier"),
        effort: selection_string_option(selection, "reasoningEffort"),
        agent: selection_string_option(selection, "agent"),
        resume_cursor: persisted.and_then(|runtime| runtime.resume_cursor),
        environment,
        endpoint: (!binary.server_url.trim().is_empty()).then(|| binary.server_url.clone()),
        server_password: (!binary.server_password.is_empty())
            .then(|| binary.server_password.clone()),
        mcp: None,
        codex_home,
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
            match entry
                .driver
                .set_interaction_mode(interaction_mode.clone())
                .await
            {
                Ok(()) => {
                    entry.launch.interaction_mode = interaction_mode;
                    persist_entry(&engine.repositories(), entry, "ready").await
                }
                Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                    let mut launch = entry.launch.clone();
                    launch.interaction_mode = interaction_mode;
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

fn selection_string_option(selection: &Value, id: &str) -> Option<String> {
    selection
        .get("options")
        .and_then(Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
        })
        .and_then(|option| option.get("value"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_provider_command(text: &str) -> Option<(&str, &str)> {
    let command = text.strip_prefix('/')?;
    let split = command.find(char::is_whitespace).unwrap_or(command.len());
    let name = &command[..split];
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return None;
    }
    Some((name, command[split..].trim()))
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
                        if matches!(error, ProviderRuntimeError::Orchestration(_))
                            && provider_thread_was_deleted(&engine.repositories(), &launch.thread_id)
                                .await
                        {
                            return;
                        }
                        tracing::warn!(%error, "failed to project provider runtime event");
                    }
                }
            }
        }
    })
}

async fn provider_thread_was_deleted(repositories: &Repositories, thread_id: &str) -> bool {
    repositories
        .get_thread(thread_id.to_owned())
        .await
        .ok()
        .flatten()
        .is_some_and(|thread| thread.deleted_at.is_some())
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

#[derive(Clone, Debug)]
pub struct NativeProviderDriverFactory {
    attachments: AttachmentMaterializer,
}

impl NativeProviderDriverFactory {
    #[must_use]
    pub fn new(attachments_dir: PathBuf) -> Self {
        Self {
            attachments: AttachmentMaterializer::new(attachments_dir),
        }
    }
}

impl ProviderDriverFactory for NativeProviderDriverFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            match request.provider.as_str() {
                "codex" => Ok(
                    Arc::new(CodexDriver::spawn(request, self.attachments.clone()).await?)
                        as Arc<dyn ProviderDriver>,
                ),
                "cursor" => Ok(Arc::new(
                    CursorDriver::spawn(request, self.attachments.clone()).await?,
                ) as Arc<dyn ProviderDriver>),
                "grok" => Ok(
                    Arc::new(GrokDriver::spawn(request, self.attachments.clone()).await?)
                        as Arc<dyn ProviderDriver>,
                ),
                "opencode" => Ok(Arc::new(
                    OpenCodeDriver::spawn(request, self.attachments.clone()).await?,
                ) as Arc<dyn ProviderDriver>),
                "claude" | "claudeAgent" => Ok(Arc::new(
                    ClaudeDriver::spawn(request, self.attachments.clone()).await?,
                ) as Arc<dyn ProviderDriver>),
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
        sanitize_provider_subprocess_environment(command);
    });
    configure_background_command_wrap(&mut command);
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
    let extensions = provider_executable_extensions();
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

#[cfg(windows)]
fn provider_executable_extensions() -> &'static [&'static str] {
    WINDOWS_PROVIDER_EXECUTABLE_EXTENSIONS
}

#[cfg(not(windows))]
fn provider_executable_extensions() -> &'static [&'static str] {
    &[""]
}

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
    attachments: AttachmentMaterializer,
}

impl CodexDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
    ) -> Result<Self, ProviderRuntimeError> {
        if let Some(layout) = request.codex_home.as_ref() {
            materialize_codex_shadow_home(layout)
                .await
                .map_err(provider_error("codex"))?;
            if let Some(effective_home) = layout.effective_home_path.as_ref() {
                request.environment.insert(
                    "CODEX_HOME".to_owned(),
                    effective_home.to_string_lossy().into_owned(),
                );
            }
        }
        let mut args = Vec::new();
        if let Some(mcp) = request.mcp.as_ref() {
            request.environment.insert(
                "T4CODE_MCP_BEARER_TOKEN".to_owned(),
                mcp.authorization_header
                    .strip_prefix("Bearer ")
                    .unwrap_or(&mcp.authorization_header)
                    .to_owned(),
            );
            args.extend([
                "-c".to_owned(),
                format!("mcp_servers.t4code.url={}", mcp.endpoint),
                "-c".to_owned(),
                "mcp_servers.t4code.bearer_token_env_var=\"T4CODE_MCP_BEARER_TOKEN\"".to_owned(),
            ]);
        }
        args.push("app-server".to_owned());
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
                service_tier: request.service_tier,
                effort: request.effort,
                resume_cursor,
            },
            connection,
            incoming,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            attachments,
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
            let text = if let Some(("goal", objective)) = parse_provider_command(&text)
                && !objective.is_empty()
            {
                self.runtime
                    .set_goal(objective)
                    .await
                    .map_err(provider_error("codex"))?;
                objective.to_owned()
            } else {
                text
            };
            let attachments: Vec<Value> = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("codex"))?
                .into_iter()
                .map(codex_image)
                .collect();
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
    attachments: AttachmentMaterializer,
}
impl CursorDriver {
    async fn spawn(
        request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
    ) -> Result<Self, ProviderRuntimeError> {
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
        let runtime = CursorSessionRuntime::new(
            CursorSessionOptions {
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                runtime_mode: request.runtime_mode,
                interaction_mode: request.interaction_mode,
                model: request.model.unwrap_or_default(),
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
                mcp_servers: acp_mcp_servers(request.mcp.as_ref()),
            },
            connection,
            incoming,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            attachments,
        })
    }
}

impl ProviderDriver for CursorDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let session_id = self
                .runtime
                .start()
                .await
                .map_err(provider_error("cursor"))?;
            Ok(StartedSession {
                resume_cursor: Some(json!({
                    "schemaVersion": 1,
                    "sessionId": session_id,
                })),
                runtime_payload: None,
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let attachments = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("cursor"))?
                .into_iter()
                .map(acp_image)
                .collect();
            self.runtime
                .send_turn(Some(&text), attachments)
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
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_runtime_mode(&mode)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_interaction_mode(&mode)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("cursor"))
        })
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
    requested_model: Option<String>,
    attachments: AttachmentMaterializer,
}
impl GrokDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
    ) -> Result<Self, ProviderRuntimeError> {
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
                mcp_servers: acp_mcp_servers(request.mcp.as_ref()),
                runtime_mode: request.runtime_mode,
                interaction_mode: request.interaction_mode,
            },
            connection,
            incoming,
            auth_method_id,
            resume_session_id,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            requested_model: request.model,
            attachments,
        })
    }
}

impl ProviderDriver for GrokDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let id = self.runtime.start().await.map_err(provider_error("grok"))?;
            if let Some(model) = self.requested_model.as_deref() {
                self.runtime
                    .set_model(model)
                    .await
                    .map_err(provider_error("grok"))?;
            }
            Ok(StartedSession {
                resume_cursor: Some(json!({"schemaVersion":1,"sessionId": id})),
                runtime_payload: None,
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let attachments = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("grok"))?
                .into_iter()
                .map(acp_image)
                .collect();
            self.runtime
                .send_turn(Some(&text), attachments)
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
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_runtime_mode(&mode)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_interaction_mode(&mode)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("grok"))
        })
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
    attachments: AttachmentMaterializer,
}
impl OpenCodeDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
    ) -> Result<Self, ProviderRuntimeError> {
        if let Some(endpoint) = request.endpoint.as_ref() {
            let runtime = OpenCodeSessionRuntime::new_with_options(
                endpoint,
                &request.thread_id,
                &request.cwd.to_string_lossy(),
                request.model.as_deref(),
                request.server_password.as_deref(),
                request.agent.as_deref(),
            )
            .map_err(provider_error("opencode"))?;
            runtime.configure_runtime_mode(&request.runtime_mode).await;
            return Ok(Self {
                runtime,
                child: None,
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
                attachments,
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
        let local_password = Uuid::new_v4().to_string();
        request.environment.insert(
            "OPENCODE_SERVER_PASSWORD".to_owned(),
            local_password.clone(),
        );
        let args = vec![
            "serve".to_owned(),
            "--hostname=127.0.0.1".to_owned(),
            format!("--port={port}"),
        ];
        let child = Arc::new(Mutex::new(spawn_child(&request, &args, false)?));
        wait_for_endpoint(&endpoint, &child).await?;
        let runtime = OpenCodeSessionRuntime::new_with_options(
            &endpoint,
            &request.thread_id,
            &request.cwd.to_string_lossy(),
            request.model.as_deref(),
            Some(&local_password),
            request.agent.as_deref(),
        )
        .map_err(provider_error("opencode"))?;
        runtime.configure_runtime_mode(&request.runtime_mode).await;
        if let Some(mcp) = request.mcp.as_ref() {
            runtime
                .add_mcp_server("t4code", &mcp.endpoint, &mcp.authorization_header)
                .await
                .map_err(provider_error("opencode"))?;
        }
        Ok(Self {
            runtime,
            child: Some(child),
            resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
            attachments,
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
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let attachments: Vec<Value> = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("opencode"))?
                .into_iter()
                .map(opencode_file)
                .collect();
            let turn = if attachments.is_empty() {
                match parse_provider_command(&text) {
                    Some((command, arguments)) => {
                        self.runtime.send_command(command, arguments).await
                    }
                    None => self.runtime.send_turn(Some(&text), attachments).await,
                }
            } else {
                self.runtime.send_turn(Some(&text), attachments).await
            };
            turn.map(Some).map_err(provider_error("opencode"))
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
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_permission(&request_id, &decision)
                .await
                .map_err(provider_error("opencode"))
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
                .map_err(provider_error("opencode"))
        })
    }
    fn set_mode(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("opencode", "post-start runtime mode changes")
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("opencode"))
        })
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
    configured_runtime_mode: Mutex<String>,
    interaction_mode: Mutex<String>,
    sequence: Mutex<u64>,
    attachments: AttachmentMaterializer,
}

impl ClaudeDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
    ) -> Result<Self, ProviderRuntimeError> {
        let mode = claude_mode(&request.runtime_mode, &request.interaction_mode);
        let session_id = request
            .resume_cursor
            .as_ref()
            .and_then(resume_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        request
            .environment
            .entry("CLAUDE_CODE_ENTRYPOINT".to_owned())
            .or_insert_with(|| "sdk-rust".to_owned());
        let mut args = vec![
            "--print".to_owned(),
            "--input-format".to_owned(),
            "stream-json".to_owned(),
            "--output-format".to_owned(),
            "stream-json".to_owned(),
            "--include-partial-messages".to_owned(),
            "--verbose".to_owned(),
            "--setting-sources=user,project,local".to_owned(),
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
        if let Some(agent) = request.agent.as_ref() {
            args.extend(["--agent".to_owned(), agent.clone()]);
        }
        if let Some(mcp) = request.mcp.as_ref() {
            let config = json!({
                "mcpServers": {
                    "t4code": {
                        "type": "http",
                        "url": mcp.endpoint,
                        "headers": { "Authorization": mcp.authorization_header },
                    }
                }
            });
            args.extend(["--mcp-config".to_owned(), config.to_string()]);
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
            configured_runtime_mode: Mutex::new(request.runtime_mode),
            interaction_mode: Mutex::new(request.interaction_mode),
            sequence: Mutex::new(0),
            attachments,
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

    async fn apply_mode(&self) -> Result<(), ProviderRuntimeError> {
        let runtime_mode = self.configured_runtime_mode.lock().await.clone();
        let interaction_mode = self.interaction_mode.lock().await.clone();
        let mode = claude_mode(&runtime_mode, &interaction_mode);
        *self.runtime_mode.lock().await = mode;
        let request = ClaudeControlRequest::set_permission_mode(
            self.next_sequence().await,
            mode.permission_mode(),
        );
        self.write_json(json!({"type":"control_request","request":request}))
            .await
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
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let turn_id = Uuid::new_v4().to_string();
            let attachments = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("claude"))?
                .into_iter()
                .map(claude_image)
                .collect();
            let content = crate::provider::attachments::prompt_parts(Some(&text), attachments);
            self.runtime
                .lock()
                .await
                .start_turn(crate::provider::claude::TurnInput {
                    turn_id: turn_id.clone(),
                    input: text.clone(),
                });
            self.write_json(json!({"type":"user","session_id":self.session_id,"message":{"role":"user","content":content},"parent_tool_use_id":null})).await?;
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
            *self.configured_runtime_mode.lock().await = mode;
            self.apply_mode().await
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            *self.interaction_mode.lock().await = mode;
            self.apply_mode().await
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

fn attachment_error(
    provider: &str,
) -> impl FnOnce(crate::provider::attachments::AttachmentMaterializationError) -> ProviderRuntimeError + '_
{
    provider_error(provider)
}

fn codex_image(image: MaterializedImage) -> Value {
    json!({
        "type": "image",
        "url": format!("data:{};base64,{}", image.mime_type, image.base64_data),
    })
}

fn acp_image(image: MaterializedImage) -> Value {
    json!({
        "type": "image",
        "data": image.base64_data,
        "mimeType": image.mime_type,
    })
}

fn claude_image(image: MaterializedImage) -> Value {
    json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": image.mime_type,
            "data": image.base64_data,
        },
    })
}

fn opencode_file(image: MaterializedImage) -> Value {
    json!({
        "type": "file",
        "mime": image.mime_type,
        "url": image.file_url,
        "filename": image.name,
    })
}

fn acp_mcp_servers(mcp: Option<&ProviderMcpConfig>) -> Vec<Value> {
    mcp.map_or_else(Vec::new, |mcp| {
        vec![json!({
            "type": "http",
            "name": "t4code",
            "url": mcp.endpoint,
            "headers": [{
                "name": "Authorization",
                "value": mcp.authorization_header,
            }],
        })]
    })
}

#[cfg(test)]
mod attachment_adapter_tests {
    use super::*;

    fn image() -> MaterializedImage {
        MaterializedImage {
            name: "screen.png".to_owned(),
            mime_type: "image/png".to_owned(),
            base64_data: "aW1hZ2U=".to_owned(),
            file_url: "file:///state/attachments/image-1".to_owned(),
        }
    }

    #[test]
    fn materialized_images_match_each_provider_wire_format() {
        assert_eq!(
            codex_image(image()),
            json!({ "type": "image", "url": "data:image/png;base64,aW1hZ2U=" })
        );
        assert_eq!(
            acp_image(image()),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" })
        );
        assert_eq!(
            claude_image(image()),
            json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": "aW1hZ2U=" }
            })
        );
        assert_eq!(
            opencode_file(image()),
            json!({
                "type": "file",
                "mime": "image/png",
                "url": "file:///state/attachments/image-1",
                "filename": "screen.png"
            })
        );
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
            if child
                .lock()
                .await
                .try_wait()
                .map_err(provider_error("opencode"))?
                .is_some()
            {
                return Err(ProviderRuntimeError::Provider {
                    provider: "opencode".to_owned(),
                    detail: "server process exited before claiming its reserved port".to_owned(),
                });
            }
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
    use super::{ProviderDriver, ProviderDriverFactory};
    use crate::{
        orchestration::engine::{EngineOptions, OrchestrationCommand},
        persistence::{Database, ProviderSessionRuntime, run_migrations},
        server_settings::{
            ProviderEnvironmentVariableState, ProviderInstanceState, ProviderSettingsState,
            ProvidersState,
        },
    };
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex as StdMutex};
    use tempfile::TempDir;
    use tokio::{net::TcpListener, sync::mpsc, time::timeout};

    #[derive(Default)]
    struct SupervisorDriverState {
        launches: usize,
        starts: usize,
        sends: Vec<String>,
        interrupts: usize,
        approvals: usize,
        answers: usize,
        modes: Vec<String>,
        interaction_modes: Vec<String>,
        models: Vec<String>,
        rollbacks: Vec<i64>,
        shutdowns: usize,
    }

    struct SupervisorDriver {
        state: Arc<StdMutex<SupervisorDriverState>>,
        events: tokio::sync::Mutex<mpsc::Receiver<super::ProviderEvent>>,
    }

    impl ProviderDriver for SupervisorDriver {
        fn start(
            &self,
        ) -> super::BoxRuntimeFuture<'_, Result<super::StartedSession, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                self.state.lock().unwrap().starts += 1;
                Ok(super::StartedSession {
                    resume_cursor: Some(json!({"sessionId":"unit-session"})),
                    runtime_payload: Some(json!({"transport":"unit"})),
                })
            })
        }

        fn send(
            &self,
            text: String,
            _: Vec<Value>,
            _: String,
        ) -> super::BoxRuntimeFuture<'_, Result<Option<String>, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                self.state.lock().unwrap().sends.push(text);
                Ok(Some("unit-turn".to_owned()))
            })
        }

        fn interrupt(
            &self,
            _: Option<String>,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().interrupts += 1;
                Ok(())
            })
        }

        fn approve(
            &self,
            _: String,
            _: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().approvals += 1;
                Ok(())
            })
        }

        fn answer(
            &self,
            _: String,
            _: Value,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().answers += 1;
                Ok(())
            })
        }

        fn set_mode(
            &self,
            mode: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().modes.push(mode);
                Ok(())
            })
        }

        fn set_interaction_mode(
            &self,
            mode: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().interaction_modes.push(mode);
                Ok(())
            })
        }

        fn set_model(
            &self,
            model: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().models.push(model);
                Ok(())
            })
        }

        fn rollback(
            &self,
            turn_count: i64,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().rollbacks.push(turn_count);
                Ok(())
            })
        }

        fn next_event(&self) -> super::BoxRuntimeFuture<'_, Option<super::ProviderEvent>> {
            Box::pin(async move { self.events.lock().await.recv().await })
        }

        fn shutdown(&self) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().shutdowns += 1;
                Ok(())
            })
        }
    }

    struct SupervisorFactory {
        state: Arc<StdMutex<SupervisorDriverState>>,
        events: StdMutex<Option<mpsc::Receiver<super::ProviderEvent>>>,
    }

    impl ProviderDriverFactory for SupervisorFactory {
        fn create(
            &self,
            _: super::ProviderLaunchRequest,
        ) -> super::BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                self.state.lock().unwrap().launches += 1;
                Ok(Arc::new(SupervisorDriver {
                    state: self.state.clone(),
                    events: tokio::sync::Mutex::new(
                        self.events.lock().unwrap().take().expect("event receiver"),
                    ),
                }) as Arc<dyn ProviderDriver>)
            })
        }
    }

    async fn supervisor_engine() -> super::OrchestrationEngine {
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = super::OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .unwrap();
        for command in [
            json!({"type":"project.create","commandId":"project","projectId":"p1","title":"Project","workspaceRoot":"/tmp/project","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t1","projectId":"p1","title":"Thread","kind":"workspace","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-07-16T00:00:00Z"}),
        ] {
            engine
                .dispatch(serde_json::from_value(command).unwrap())
                .await
                .unwrap();
        }
        engine
    }

    fn native_launch(temp: &TempDir, provider: &str) -> super::ProviderLaunchRequest {
        super::ProviderLaunchRequest {
            thread_id: "native-test-thread".to_owned(),
            provider: provider.to_owned(),
            provider_instance_id: Some(provider.to_owned()),
            binary_path: format!("missing-{provider}"),
            cwd: temp.path().to_path_buf(),
            runtime_mode: "approval-required".to_owned(),
            interaction_mode: "default".to_owned(),
            model: Some("test-model".to_owned()),
            service_tier: None,
            effort: None,
            agent: None,
            resume_cursor: None,
            environment: Default::default(),
            endpoint: None,
            server_password: None,
            mcp: None,
            codex_home: None,
        }
    }

    #[cfg(unix)]
    fn executable_fixture(temp: &TempDir, name: &str, contents: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let executable = temp.path().join(name);
        std::fs::write(&executable, contents).expect("provider fixture should write");
        let mut permissions = std::fs::metadata(&executable)
            .expect("provider fixture metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions)
            .expect("provider fixture should be executable");
        executable
    }

    #[tokio::test]
    async fn unit_supervisor_covers_complete_command_routing_and_shutdown_lifecycle() {
        let engine = supervisor_engine().await;
        let state = Arc::new(StdMutex::new(SupervisorDriverState::default()));
        let (events_tx, events_rx) = mpsc::channel(4);
        let factory = Arc::new(SupervisorFactory {
            state: state.clone(),
            events: StdMutex::new(Some(events_rx)),
        });
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            factory,
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();
        let settings_root = temp.path().join("settings");
        std::fs::create_dir(&settings_root).unwrap();
        let mut settings = ProviderSettingsState::default();
        settings.provider_instances.insert(
            "codex-custom".to_owned(),
            ProviderInstanceState {
                driver: "codex".to_owned(),
                enabled: true,
                display_name: Some("Custom Codex".to_owned()),
                environment: vec![
                    ProviderEnvironmentVariableState {
                        name: "UNIT_ENV".to_owned(),
                        value: "enabled".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                    ProviderEnvironmentVariableState {
                        name: String::new(),
                        value: "ignored".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                ],
                config: json!({
                    "binaryPath": "/bin/sh",
                    "serverUrl": "http://127.0.0.1:4773",
                    "serverPassword": "fixture-password",
                    "homePath": temp.path().join("shared-home"),
                    "shadowHomePath": temp.path().join("shadow-home")
                }),
            },
        );
        std::fs::write(
            settings_root.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let launch_command = serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"launch-options",
            "threadId":"t1",
            "message":{"messageId":"launch-message","role":"user","text":"launch","attachments":[]},
            "modelSelection":{
                "instanceId":"codex-custom",
                "model":"gpt-5.2",
                "options":[
                    {"id":"serviceTier","value":"fast"},
                    {"id":"reasoningEffort","value":"high"},
                    {"id":"agent","value":"reviewer"}
                ]
            },
            "runtimeMode":"full-access",
            "interactionMode":"plan",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        let missing_thread_command = serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"missing-launch",
            "threadId":"missing",
            "message":{"messageId":"missing-message","role":"user","text":"launch","attachments":[]},
            "modelSelection":{"instanceId":"codex-custom","model":"gpt-5.2"},
            "runtimeMode":"full-access",
            "interactionMode":"plan",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        assert!(matches!(
            super::launch_request_for_command(&engine, &settings_root, &missing_thread_command)
                .await,
            Err(super::ProviderRuntimeError::SessionNotFound { .. })
        ));
        let blocked_settings_root = temp.path().join("blocked-settings");
        std::fs::write(&blocked_settings_root, "not a directory").unwrap();
        assert!(
            super::launch_request_for_command(&engine, &blocked_settings_root, &launch_command)
                .await
                .is_err()
        );
        engine
            .repositories()
            .upsert_provider_session_runtime(ProviderSessionRuntime {
                thread_id: "t1".to_owned(),
                provider_name: "claudeAgent".to_owned(),
                provider_instance_id: Some("other-instance".to_owned()),
                adapter_key: "unit".to_owned(),
                runtime_mode: "full-access".to_owned(),
                status: "running".to_owned(),
                last_seen_at: "2026-07-16T00:00:00Z".to_owned(),
                resume_cursor: Some(json!({"threadId":"ignored"})),
                runtime_payload: None,
            })
            .await
            .unwrap();
        let resolved_launch =
            super::launch_request_for_command(&engine, &settings_root, &launch_command)
                .await
                .unwrap();
        assert_eq!(
            resolved_launch.provider_instance_id.as_deref(),
            Some("codex-custom")
        );
        assert_eq!(
            resolved_launch.environment.get("UNIT_ENV"),
            Some(&"enabled".to_owned())
        );
        assert_eq!(resolved_launch.service_tier.as_deref(), Some("fast"));
        assert_eq!(resolved_launch.effort.as_deref(), Some("high"));
        assert_eq!(resolved_launch.agent.as_deref(), Some("reviewer"));
        assert_eq!(
            resolved_launch.endpoint.as_deref(),
            Some("http://127.0.0.1:4773")
        );
        assert_eq!(
            resolved_launch.server_password.as_deref(),
            Some("fixture-password")
        );
        assert!(resolved_launch.codex_home.is_some());
        assert!(resolved_launch.resume_cursor.is_none());
        engine
            .repositories()
            .upsert_provider_session_runtime(ProviderSessionRuntime {
                thread_id: "t1".to_owned(),
                provider_name: "codex".to_owned(),
                provider_instance_id: Some("codex-custom".to_owned()),
                adapter_key: "unit".to_owned(),
                runtime_mode: "full-access".to_owned(),
                status: "running".to_owned(),
                last_seen_at: "2026-07-16T00:00:01Z".to_owned(),
                resume_cursor: Some(json!({"threadId":"resume-unit"})),
                runtime_payload: None,
            })
            .await
            .unwrap();
        assert_eq!(
            super::launch_request_for_command(&engine, &settings_root, &launch_command)
                .await
                .unwrap()
                .resume_cursor,
            Some(json!({"threadId":"resume-unit"}))
        );

        let mut launch = native_launch(&temp, "codex");
        launch.thread_id = "t1".to_owned();
        launch.cwd = temp.path().to_path_buf();
        supervisor.launch(launch.clone()).await.unwrap();
        assert!(matches!(
            supervisor.launch(launch).await,
            Err(super::ProviderRuntimeError::SessionAlreadyExists { .. })
        ));

        for command in [
            json!({"type":"thread.turn.start","commandId":"turn","threadId":"t1","message":{"messageId":"m1","role":"user","text":"hello","attachments":[]},"modelSelection":{"instanceId":"codex","model":"gpt-5.1"},"runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"unit-turn","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.runtime-mode.set","commandId":"mode","threadId":"t1","runtimeMode":"approval-required","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.interaction-mode.set","commandId":"interaction","threadId":"t1","interactionMode":"plan","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.2"}}),
            json!({"type":"thread.checkpoint.revert","commandId":"revert","threadId":"t1","turnCount":2,"createdAt":"2026-07-16T00:00:00Z"}),
        ] {
            supervisor
                .handle_orchestration(serde_json::from_value(command).unwrap())
                .await
                .unwrap();
        }

        let project_command: OrchestrationCommand = serde_json::from_value(json!({
            "type":"project.create","commandId":"unsupported","projectId":"p2","title":"Project","workspaceRoot":"/tmp/p2","createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        assert!(
            supervisor
                .handle_orchestration(project_command)
                .await
                .is_err()
        );
        assert!(
            supervisor
                .handle_orchestration(
                    serde_json::from_value(json!({"type":"thread.turn.interrupt","commandId":"missing","threadId":"missing","turnId":null,"createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
                )
                .await
                .is_err()
        );
        supervisor
            .handle_orchestration(
                serde_json::from_value(json!({"type":"thread.session.stop","commandId":"stop","threadId":"t1","createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
            )
            .await
            .unwrap();
        drop(events_tx);
        supervisor.shutdown().await.unwrap();
        supervisor.shutdown().await.unwrap();
        assert!(matches!(
            supervisor
                .handle_orchestration(
                    serde_json::from_value(json!({"type":"thread.session.stop","commandId":"late","threadId":"t1","createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
                )
                .await,
            Err(super::ProviderRuntimeError::Shutdown)
        ));

        let state = state.lock().unwrap();
        assert_eq!(state.launches, 1);
        assert_eq!(state.starts, 1);
        assert_eq!(state.sends, ["hello"]);
        assert_eq!(state.interrupts, 1);
        assert_eq!(state.approvals, 1);
        assert_eq!(state.answers, 1);
        assert_eq!(state.modes, ["approval-required"]);
        assert_eq!(state.interaction_modes, ["plan"]);
        assert_eq!(state.models, ["gpt-5.1", "gpt-5.2"]);
        assert_eq!(state.rollbacks, [2]);
        assert_eq!(state.shutdowns, 1);
        drop(state);
        engine.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let factory = super::NativeProviderDriverFactory::new(temp.path().join("attachments"));

        let claude_fixture = executable_fixture(
            &temp,
            "claude-fixture.sh",
            "#!/bin/sh\nprintf '%s\\n' 'fixture warning' >&2\ncat >/dev/null\n",
        );
        let mut claude_request = native_launch(&temp, "claudeAgent");
        claude_request.binary_path = claude_fixture.to_string_lossy().into_owned();
        claude_request.model = Some("claude-sonnet".to_owned());
        claude_request.agent = Some("reviewer".to_owned());
        claude_request.resume_cursor = Some(json!({"sessionId":"claude-session"}));
        let claude = super::ClaudeDriver::spawn(claude_request, factory.attachments.clone())
            .await
            .expect("Claude driver should create");
        assert_eq!(
            claude
                .start()
                .await
                .expect("Claude should start")
                .resume_cursor,
            Some(json!({"sessionId":"claude-session"})),
        );
        assert!(
            claude
                .send("hello".to_owned(), Vec::new(), "default".to_owned())
                .await
                .expect("Claude turn should send")
                .is_some()
        );
        claude
            .interrupt(None)
            .await
            .expect("Claude should interrupt");
        claude
            .approve("approval-1".to_owned(), "acceptForSession".to_owned())
            .await
            .expect("Claude approval should resolve");
        claude
            .approve("approval-2".to_owned(), "deny".to_owned())
            .await
            .expect("Claude denial should resolve");
        claude.runtime.lock().await.open_user_input_request(
            crate::provider::claude::UserInputRequestInput {
                tool_name: "AskUserQuestion".to_owned(),
                input: json!({"questions":[{"question":"Continue?"}]}),
                tool_use_id: "tool-1".to_owned(),
            },
            "question-1",
        );
        claude
            .answer("question-1".to_owned(), json!({"answer":"yes"}))
            .await
            .expect("Claude user input should resolve");
        claude
            .set_mode("auto-accept-edits".to_owned())
            .await
            .expect("Claude mode should update");
        claude
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("Claude interaction mode should update");
        assert!(claude.set_model("other".to_owned()).await.is_err());
        assert!(claude.rollback(1).await.is_err());
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), claude.next_event())
                .await
                .expect("Claude event timeout")
                .expect("Claude stderr event")
                .event_type,
            "session.stderr",
        );
        claude.shutdown().await.expect("Claude should shut down");

        let mut fresh_claude_request = native_launch(&temp, "claudeAgent");
        fresh_claude_request.binary_path = claude_fixture.to_string_lossy().into_owned();
        let fresh_claude =
            super::ClaudeDriver::spawn(fresh_claude_request, factory.attachments.clone())
                .await
                .expect("fresh Claude driver should create");
        fresh_claude
            .shutdown()
            .await
            .expect("fresh Claude should shut down");

        let codex_fixture = executable_fixture(
            &temp,
            "codex-fixture.sh",
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fixture"}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"cwd":"/tmp","model":"gpt-5","thread":{"id":"native-codex-thread"}}}\n' "$id" ;;
    *'"method":"thread/goal/set"'*) printf '{"id":%s,"result":{"goal":{"status":"active"}}}\n' "$id" ;;
    *'"method":"turn/start"'*) printf '{"id":%s,"result":{"turn":{"id":"native-codex-turn"}}}\n' "$id" ;;
    *'"method":"turn/interrupt"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/rollback"'*) printf '{"id":%s,"result":{"thread":{"id":"native-codex-thread","turns":[]}}}\n' "$id" ;;
    *'"method":"shutdown"'*) printf '{"id":%s,"result":null}\n' "$id" ;;
  esac
done
"#,
        );
        let mut codex_request = native_launch(&temp, "codex");
        codex_request.binary_path = codex_fixture.to_string_lossy().into_owned();
        let codex = factory
            .create(codex_request)
            .await
            .expect("Codex driver should create");
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), codex.start())
                .await
                .expect("Codex start timeout")
                .expect("Codex should start")
                .resume_cursor,
            Some(json!({"threadId":"native-codex-thread"})),
        );
        assert!(
            !timeout(std::time::Duration::from_secs(2), codex.next_event())
                .await
                .expect("Codex event timeout")
                .expect("Codex startup event")
                .event_type
                .is_empty()
        );
        codex
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("Codex default interaction mode should be accepted");
        assert!(
            codex
                .send("hello".to_owned(), Vec::new(), "default".to_owned())
                .await
                .expect("Codex turn should send")
                .is_some()
        );
        assert!(
            codex
                .send(
                    "/goal finish coverage".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                )
                .await
                .expect("Codex goal should send")
                .is_some()
        );
        codex.interrupt(None).await.expect("Codex should interrupt");
        codex.rollback(0).await.expect("Codex should roll back");
        assert!(codex.rollback(-1).await.is_err());
        assert!(
            codex
                .set_mode("approval-required".to_owned())
                .await
                .is_err()
        );
        assert!(codex.set_model("other".to_owned()).await.is_err());
        assert!(
            codex
                .approve("unknown".to_owned(), "accept".to_owned())
                .await
                .is_err()
        );
        assert!(codex.answer("unknown".to_owned(), json!({})).await.is_err());
        codex.shutdown().await.expect("Codex should shut down");

        let acp_fixture = executable_fixture(
            &temp,
            "acp-fixture.sh",
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"cursor-session","configOptions":[{"id":"model","category":"model"}],"modes":{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Agent"},{"id":"architect","name":"Plan"}]}}}\n' "$id" ;;
    *'"method":"session/create"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session","modes":{"currentModeId":"code","availableModes":[{"id":"code","name":"Agent"},{"id":"ask","name":"Ask"}]}}}\n' "$id" ;;
    *'"method":"session/set_config_option"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[]}}\n' "$id" ;;
    *'"method":"session/set_mode"'*|*'"method":"session/set_model"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/prompt"'*) sleep 0.1; printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id" ;;
  esac
done
"#,
        );
        for provider in ["cursor", "grok"] {
            let mut request = native_launch(&temp, provider);
            request.binary_path = acp_fixture.to_string_lossy().into_owned();
            if provider == "grok" {
                request
                    .environment
                    .insert("XAI_API_KEY".to_owned(), "unit-key".to_owned());
            }
            let driver = factory
                .create(request)
                .await
                .expect("ACP driver should create");
            assert!(
                driver
                    .start()
                    .await
                    .expect("ACP driver should start")
                    .resume_cursor
                    .is_some()
            );
            assert!(
                !timeout(std::time::Duration::from_secs(2), driver.next_event())
                    .await
                    .expect("ACP event timeout")
                    .expect("ACP startup event")
                    .event_type
                    .is_empty()
            );
            let turn = driver
                .send("hello".to_owned(), Vec::new(), "default".to_owned())
                .await
                .expect("ACP turn should send")
                .expect("ACP turn id");
            driver
                .interrupt(Some(turn))
                .await
                .expect("ACP turn should interrupt");
            driver
                .set_model("updated-model".to_owned())
                .await
                .expect("ACP model should update");
            driver
                .set_mode("full-access".to_owned())
                .await
                .expect("ACP mode should update");
            driver
                .set_interaction_mode("plan".to_owned())
                .await
                .expect("ACP interaction mode should update");
            assert!(driver.rollback(1).await.is_err());
            assert!(
                driver
                    .approve("unknown".to_owned(), "accept".to_owned())
                    .await
                    .is_err()
            );
            assert!(
                driver
                    .answer("unknown".to_owned(), json!({}))
                    .await
                    .is_err()
            );
            driver
                .shutdown()
                .await
                .expect("ACP driver should shut down");
        }
    }

    #[tokio::test]
    async fn native_opencode_adapter_covers_live_session_turn_and_control_commands() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let app = Router::new()
            .route(
                "/session",
                post(|| async { Json(json!({"id":"native-opencode-session"})) }),
            )
            .route("/event", get(|| async { "" }))
            .route(
                "/session/{session_id}/prompt_async",
                post(|| async { Json(json!({})) }),
            )
            .route(
                "/session/{session_id}/command",
                post(|| async { Json(json!({})) }),
            )
            .route(
                "/session/{session_id}/abort",
                post(|| async { Json(json!({})) }),
            )
            .route(
                "/session/{session_id}/message",
                get(|| async { Json(json!({"data":[]})) }),
            )
            .route(
                "/session/{session_id}/revert",
                post(|| async { Json(json!({})) }),
            );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("OpenCode fixture should bind");
        let address = listener.local_addr().expect("OpenCode fixture address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("OpenCode fixture should serve");
        });

        let temp = TempDir::new().expect("OpenCode fixture directory");
        let endpoint_child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 2"])
            .spawn()
            .expect("endpoint child should spawn");
        let endpoint_child: Box<dyn process_wrap::tokio::ChildWrapper> = Box::new(endpoint_child);
        let endpoint_child = Arc::new(tokio::sync::Mutex::new(endpoint_child));
        super::wait_for_endpoint(&format!("http://{address}"), &endpoint_child)
            .await
            .expect("live endpoint should become ready");
        super::kill_child(&endpoint_child).await;
        let factory = super::NativeProviderDriverFactory::new(temp.path().join("attachments"));
        let mut request = native_launch(&temp, "opencode");
        request.endpoint = Some(format!("http://{address}"));
        request.server_password = Some("secret".to_owned());
        request.agent = Some("reviewer".to_owned());
        request.model = Some("openai/gpt-5".to_owned());
        let driver = factory
            .create(request)
            .await
            .expect("OpenCode driver should create");
        assert_eq!(
            driver
                .start()
                .await
                .expect("OpenCode should start")
                .resume_cursor,
            Some(json!({"sessionId":"native-opencode-session"})),
        );
        driver
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("OpenCode default interaction mode should be accepted");
        assert!(
            driver
                .send("hello".to_owned(), Vec::new(), "default".to_owned())
                .await
                .expect("OpenCode turn should send")
                .is_some()
        );
        assert!(
            driver
                .send(
                    "/review src/provider".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                )
                .await
                .expect("OpenCode command should send")
                .is_some()
        );
        driver
            .interrupt(None)
            .await
            .expect("OpenCode should interrupt");
        driver
            .set_model("openai/gpt-5.4".to_owned())
            .await
            .expect("OpenCode model should update");
        driver.rollback(0).await.expect("OpenCode should roll back");
        assert!(driver.rollback(-1).await.is_err());
        assert!(driver.set_mode("full-access".to_owned()).await.is_err());
        assert!(
            driver
                .approve("unknown".to_owned(), "accept".to_owned())
                .await
                .is_err()
        );
        assert!(
            driver
                .answer("unknown".to_owned(), json!({}))
                .await
                .is_err()
        );
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), driver.next_event())
                .await
                .expect("OpenCode event timeout")
                .expect("OpenCode event")
                .event_type,
            "session.started",
        );
        driver.shutdown().await.expect("OpenCode should shut down");
        server.abort();
    }

    #[test]
    fn automatic_model_selection_uses_the_provider_default() {
        assert_eq!(super::model_from_selection(&json!({"model":"auto"})), None);
        assert_eq!(
            super::model_from_selection(&json!({"model":"gpt-5.4"})),
            Some("gpt-5.4".to_owned())
        );
    }

    #[test]
    fn provider_string_options_are_extracted_from_canonical_selections() {
        let selection = json!({
            "model": "gpt-5.4",
            "options": [
                { "id": "reasoningEffort", "value": "high" },
                { "id": "serviceTier", "value": "fast" }
            ]
        });

        assert_eq!(
            super::selection_string_option(&selection, "reasoningEffort"),
            Some("high".to_owned())
        );
        assert_eq!(
            super::selection_string_option(&selection, "serviceTier"),
            Some("fast".to_owned())
        );
        assert_eq!(
            super::selection_string_option(
                &json!({"options":[{"id":"serviceTier","value":"  "}]}),
                "serviceTier"
            ),
            None
        );
        assert_eq!(
            super::selection_string_option(
                &json!({"options":[{"id":"serviceTier","value":42}]}),
                "serviceTier"
            ),
            None
        );
        assert_eq!(
            super::selection_string_option(&json!({"options":[]}), "serviceTier"),
            None
        );
        assert_eq!(
            super::selection_string_option(&json!({"options":{}}), "serviceTier"),
            None
        );
    }

    #[test]
    fn provider_commands_are_parsed_without_stealing_plain_or_malformed_text() {
        assert_eq!(super::parse_provider_command("hello"), None);
        assert_eq!(super::parse_provider_command("/"), None);
        assert_eq!(super::parse_provider_command("/ bad"), None);
        assert_eq!(super::parse_provider_command("/bad! command"), None);
        assert_eq!(
            super::parse_provider_command("/goal  ship the feature  "),
            Some(("goal", "ship the feature"))
        );
        assert_eq!(
            super::parse_provider_command("/mcp:reload_now.v2"),
            Some(("mcp:reload_now.v2", ""))
        );
        assert_eq!(
            super::parse_provider_command("/review\t staged changes"),
            Some(("review", "staged changes"))
        );
    }

    #[test]
    fn provider_projection_helpers_preserve_contract_fallbacks() {
        let event = |payload, turn_id: Option<&str>| super::ProviderEvent {
            event_type: "provider.event".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: turn_id.map(str::to_owned),
            request_id: None,
            payload,
        };
        assert_eq!(
            super::assistant_message_id(&event(json!({"messageId":"message-1"}), Some("turn-1"))),
            "message-1"
        );
        assert_eq!(
            super::assistant_message_id(&event(json!({}), Some("turn-1"))),
            "assistant:turn-1"
        );
        assert_eq!(
            super::assistant_message_id(&event(json!({}), None)),
            "assistant:thread-1"
        );

        assert_eq!(
            super::provider_completion_error(&json!({"error":{"message":"nested"}})),
            "nested"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"error":"flat"})),
            "flat"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"message":"top-level"})),
            "top-level"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"error":{}})),
            "Provider turn failed."
        );

        for (event_type, expected) in [
            ("request.opened", ("approval", "approval.requested")),
            ("request.resolved", ("approval", "approval.resolved")),
            ("user-input.requested", ("approval", "user-input.requested")),
            ("user-input.resolved", ("approval", "user-input.resolved")),
            ("provider.failed", ("error", "provider.error")),
            ("provider.error", ("error", "provider.error")),
            ("turn.started", ("info", "provider.turn")),
            ("session.ready", ("info", "provider.session")),
            ("tool.started", ("tool", "provider.event")),
        ] {
            assert_eq!(super::event_activity_shape(event_type), expected);
        }
    }

    #[test]
    fn provider_runtime_metadata_maps_every_native_adapter_and_resume_shape() {
        for (provider, adapter) in [
            ("codex", "codex-app-server"),
            ("claude", "claude-stream-json"),
            ("claudeAgent", "claude-stream-json"),
            ("cursor", "cursor-acp"),
            ("grok", "grok-acp"),
            ("opencode", "opencode-http"),
            ("future-provider", "native-provider"),
        ] {
            assert_eq!(super::native_adapter_key(provider), adapter);
        }

        assert_eq!(
            super::resume_string(&json!("plain-session")),
            Some("plain-session".to_owned())
        );
        assert_eq!(
            super::resume_string(&json!({"threadId":"thread-session"})),
            Some("thread-session".to_owned())
        );
        assert_eq!(
            super::resume_string(&json!({"sessionId":"provider-session"})),
            Some("provider-session".to_owned())
        );
        assert_eq!(super::resume_string(&json!({"sessionId":7})), None);

        assert!(matches!(
            super::runtime_mode("approval-required"),
            crate::provider::codex::CodexRuntimeMode::ApprovalRequired
        ));
        assert!(matches!(
            super::runtime_mode("auto-accept-edits"),
            crate::provider::codex::CodexRuntimeMode::AutoAcceptEdits
        ));
        assert!(matches!(
            super::runtime_mode("full-access"),
            crate::provider::codex::CodexRuntimeMode::FullAccess
        ));

        for (runtime_mode, interaction_mode, permission) in [
            ("full-access", "default", "bypassPermissions"),
            ("approval-required", "default", "default"),
            ("auto-accept-edits", "default", "acceptEdits"),
            ("full-access", "plan", "plan"),
        ] {
            assert_eq!(
                super::claude_permission_arg(super::claude_mode(runtime_mode, interaction_mode)),
                permission
            );
        }
    }

    #[test]
    fn provider_commands_do_not_inherit_host_rust_logging() {
        let mut command = tokio::process::Command::new("provider-fixture");
        command.env("RUST_LOG", "info");

        super::sanitize_provider_subprocess_environment(&mut command);

        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(name, value)| { name == "RUST_LOG" && value.is_none() })
        );
    }

    #[test]
    fn provider_mcp_configuration_matches_the_acp_wire_contract() {
        assert!(super::acp_mcp_servers(None).is_empty());
        assert_eq!(
            super::acp_mcp_servers(Some(&super::ProviderMcpConfig {
                endpoint: "http://127.0.0.1:7777/mcp".to_owned(),
                authorization_header: "Bearer secret".to_owned(),
                provider_session_id: "session-1".to_owned(),
            })),
            [json!({
                "type":"http",
                "name":"t4code",
                "url":"http://127.0.0.1:7777/mcp",
                "headers":[{"name":"Authorization","value":"Bearer secret"}],
            })]
        );
    }

    #[test]
    fn executable_resolution_accepts_an_explicit_file_and_rejects_a_missing_path() {
        let directory = tempfile::TempDir::new().unwrap();
        let executable = directory.path().join("provider-fixture.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        assert_eq!(
            super::resolve_provider_executable(&executable.to_string_lossy()),
            Some(executable.clone())
        );
        assert_eq!(
            super::resolve_provider_executable(
                &directory.path().join("missing/provider").to_string_lossy()
            ),
            None
        );
        assert_eq!(
            super::provider_launch_program(&executable),
            (executable, Vec::new())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_launch_program_wraps_shell_scripts_without_profiles() {
        let (program, args) = super::provider_launch_program(std::path::Path::new("provider.ps1"));
        assert_eq!(program, std::path::PathBuf::from("powershell.exe"));
        assert_eq!(
            args,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "provider.ps1",
            ]
        );

        let (program, args) = super::provider_launch_program(std::path::Path::new("provider.cmd"));
        assert_eq!(
            program,
            std::env::var_os("ComSpec")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("cmd.exe"))
        );
        assert_eq!(args, ["/d", "/s", "/c", "provider.cmd"]);
    }

    #[tokio::test]
    async fn unsupported_capabilities_and_provider_errors_keep_actionable_context() {
        let error = super::unsupported::<()>("cursor", "checkpoint rollback")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            super::ProviderRuntimeError::UnsupportedCapability {
                provider,
                capability: "checkpoint rollback"
            } if provider == "cursor"
        ));
        assert_eq!(
            super::pipe_error("claude", "stderr").to_string(),
            "failed to spawn claude provider process: child did not expose stderr"
        );
        assert_eq!(
            super::provider_error("grok")("protocol closed").to_string(),
            "grok provider operation failed: protocol closed"
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

    #[cfg(not(windows))]
    #[test]
    fn non_windows_executable_resolution_uses_exact_name() {
        assert_eq!(super::provider_executable_extensions(), &[""]);
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
