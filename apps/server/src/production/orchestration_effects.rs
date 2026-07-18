use std::{
    collections::BTreeMap,
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    git::{
        CreateWorktreeInput, GitRepository, OutputPolicy, ProcessError, ProcessRequest,
        ProcessRunner,
    },
    orchestration::engine::{
        ActivityInput, BootstrapSetupInput, BootstrapSetupResult, BootstrapWorktree,
        BoxBootstrapFuture, BoxProjectCommandFuture, OrchestrationCommand, OrchestrationEngine,
        ProjectCommandEffects, ThreadTurnBootstrapEffects, ThreadTurnStartBootstrapPrepareWorktree,
    },
    persistence::{OrchestrationEvent, PersistenceError},
};

pub use super::host_paths::process_compatible_path;
use super::host_paths::{
    HostPathError, normalize_host_path_lexically, resolve_host_directory,
    resolve_host_directory_identity,
};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub type BoxEffectFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupScriptLaunch {
    pub thread_id: String,
    pub terminal_id: String,
    pub script_id: String,
    pub script_name: String,
    pub command: String,
    pub cwd: PathBuf,
    pub worktree_path: PathBuf,
    pub env: BTreeMap<String, String>,
}

pub trait OrchestrationEffectCallbacks: Send + Sync {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>>;

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()>;

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    fn refresh_workspace<'a>(&'a self, cwd: &'a Path) -> BoxEffectFuture<'a, ()>;

    fn launch_setup_script<'a>(&'a self, _input: SetupScriptLaunch) -> BoxEffectFuture<'a, ()> {
        Box::pin(async {
            Err(
                "the production terminal callback is unavailable for setup script launch"
                    .to_owned(),
            )
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EffectsOptions {
    pub queue_capacity: usize,
}

impl Default for EffectsOptions {
    fn default() -> Self {
        Self { queue_capacity: 64 }
    }
}

#[derive(Debug, Error)]
pub enum OrchestrationEffectsError {
    #[error("workspace root does not exist: {0}")]
    WorkspaceMissing(PathBuf),
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("failed to access workspace root {path}: {source}")]
    WorkspaceIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("native git operation failed: {0}")]
    Git(#[from] ProcessError),
    #[error("orchestration persistence failed: {0}")]
    Persistence(#[from] PersistenceError),
    #[error("orchestration effect failed: {0}")]
    Effect(String),
}

pub async fn normalize_project_workspace_root(
    workspace_root: &Path,
    create_if_missing: bool,
) -> Result<PathBuf, OrchestrationEffectsError> {
    resolve_host_directory(workspace_root, create_if_missing)
        .await
        .map_err(map_host_path_error)
}

async fn canonicalize_project_workspace_root(
    workspace_root: &Path,
    allow_missing: bool,
) -> Result<PathBuf, OrchestrationEffectsError> {
    resolve_host_directory_identity(workspace_root, allow_missing)
        .await
        .map_err(map_host_path_error)
}

fn map_host_path_error(error: HostPathError) -> OrchestrationEffectsError {
    match error {
        HostPathError::Missing(path) => OrchestrationEffectsError::WorkspaceMissing(path),
        HostPathError::NotDirectory(path) => OrchestrationEffectsError::WorkspaceNotDirectory(path),
        HostPathError::HomeDirectoryUnavailable(path) => OrchestrationEffectsError::WorkspaceIo {
            path,
            source: std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home directory is unavailable",
            ),
        },
        HostPathError::Io { path, source } => {
            OrchestrationEffectsError::WorkspaceIo { path, source }
        }
    }
}

#[derive(Default)]
struct ProductionProjectCommandEffects;

impl ProjectCommandEffects for ProductionProjectCommandEffects {
    fn normalize_workspace_root_lexically(&self, workspace_root: &str) -> String {
        normalize_host_path_lexically(Path::new(workspace_root))
            .to_string_lossy()
            .into_owned()
    }

    fn canonicalize_workspace_root<'a>(
        &'a self,
        workspace_root: &'a str,
        allow_missing: bool,
    ) -> BoxProjectCommandFuture<'a, String> {
        Box::pin(async move {
            canonicalize_project_workspace_root(Path::new(workspace_root), allow_missing)
                .await
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
    }

    fn prepare_project_create<'a>(
        &'a self,
        workspace_root: &'a str,
        create_if_missing: bool,
        initialize_git: bool,
    ) -> BoxProjectCommandFuture<'a, ()> {
        Box::pin(async move {
            let normalized =
                normalize_project_workspace_root(Path::new(workspace_root), create_if_missing)
                    .await
                    .map_err(|error| error.to_string())?;
            let normalized_display = normalized.to_string_lossy();
            if normalized_display != workspace_root {
                return Err(format!(
                    "workspace root changed while preparing project creation: expected {workspace_root}, resolved {normalized_display}"
                ));
            }
            if initialize_git {
                GitRepository::default()
                    .init(&normalized, &CancellationToken::new())
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
}

pub fn install_project_command_effects(engine: &OrchestrationEngine) {
    engine.set_project_command_effects(Arc::new(ProductionProjectCommandEffects));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSetupScript {
    id: String,
    name: String,
    command: String,
    run_on_worktree_create: bool,
}

struct ProductionBootstrapEffects {
    repositories: crate::persistence::Repositories,
    callbacks: Arc<dyn OrchestrationEffectCallbacks>,
    cancellation: CancellationToken,
}

impl ThreadTurnBootstrapEffects for ProductionBootstrapEffects {
    fn prepare_worktree<'a>(
        &'a self,
        input: ThreadTurnStartBootstrapPrepareWorktree,
    ) -> BoxBootstrapFuture<'a, BootstrapWorktree> {
        Box::pin(async move {
            let cwd = PathBuf::from(&input.project_cwd);
            let remove_branch = input.branch.is_some();
            let ref_name = if input.start_from_origin == Some(true) {
                fetch_origin_base(&cwd, &input.base_branch, &self.cancellation).await?
            } else {
                input.base_branch.clone()
            };
            let result = GitRepository::default()
                .create_worktree(
                    CreateWorktreeInput {
                        cwd,
                        ref_name,
                        new_ref_name: input.branch,
                        base_ref_name: None,
                        path: None,
                    },
                    &self.cancellation,
                )
                .await
                .map_err(|error| error.to_string())?;
            let path = PathBuf::from(&result.worktree.path);
            let worktree = BootstrapWorktree {
                repository_root: input.project_cwd,
                branch: result.worktree.ref_name,
                path: result.worktree.path,
                remove_branch,
            };
            if let Err(error) = self.callbacks.refresh_workspace(&path).await {
                let cleanup = remove_bootstrap_worktree(&worktree, &self.cancellation).await;
                return Err(match cleanup {
                    Ok(()) => format!("worktree was created but workspace refresh failed: {error}"),
                    Err(cleanup_error) => format!(
                        "worktree was created but workspace refresh failed: {error}; cleanup failed: {cleanup_error}"
                    ),
                });
            }
            Ok(worktree)
        })
    }

    fn run_setup_script<'a>(
        &'a self,
        input: BootstrapSetupInput,
    ) -> BoxBootstrapFuture<'a, BootstrapSetupResult> {
        Box::pin(async move {
            let project = if let Some(project_id) = input.project_id {
                self.repositories
                    .get_project(project_id)
                    .await
                    .map_err(|error| error.to_string())?
            } else if let Some(project_cwd) = input.project_cwd {
                self.repositories
                    .list_projects()
                    .await
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .find(|project| project.workspace_root == project_cwd)
            } else {
                None
            }
            .ok_or_else(|| "project was not found for setup script execution".to_owned())?;
            let scripts: Vec<ProjectSetupScript> = serde_json::from_value(project.scripts)
                .map_err(|error| format!("project setup scripts are invalid: {error}"))?;
            let Some(script) = scripts
                .into_iter()
                .find(|script| script.run_on_worktree_create)
            else {
                return Ok(BootstrapSetupResult::NoScript);
            };
            let terminal_id = format!("setup-{}", script.id);
            let worktree_path = PathBuf::from(&input.worktree_path);
            let env = BTreeMap::from([
                ("T4CODE_PROJECT_ROOT".to_owned(), project.workspace_root),
                (
                    "T4CODE_WORKTREE_PATH".to_owned(),
                    input.worktree_path.clone(),
                ),
            ]);
            self.callbacks
                .launch_setup_script(SetupScriptLaunch {
                    thread_id: input.thread_id,
                    terminal_id: terminal_id.clone(),
                    script_id: script.id.clone(),
                    script_name: script.name.clone(),
                    command: script.command,
                    cwd: worktree_path.clone(),
                    worktree_path,
                    env,
                })
                .await?;
            Ok(BootstrapSetupResult::Started {
                script_id: script.id,
                script_name: script.name,
                terminal_id,
            })
        })
    }

    fn cleanup_thread_resources<'a>(&'a self, thread_id: &'a str) -> BoxBootstrapFuture<'a, ()> {
        Box::pin(async move {
            let provider_error = self.callbacks.stop_provider(thread_id).await.err();
            let terminal_error = self.callbacks.close_terminals(thread_id).await.err();
            match (provider_error, terminal_error) {
                (None, None) => Ok(()),
                (Some(provider), None) => Err(format!("provider cleanup failed: {provider}")),
                (None, Some(terminals)) => Err(format!("terminal cleanup failed: {terminals}")),
                (Some(provider), Some(terminals)) => Err(format!(
                    "provider cleanup failed: {provider}; terminal cleanup failed: {terminals}"
                )),
            }
        })
    }

    fn remove_worktree<'a>(&'a self, worktree: BootstrapWorktree) -> BoxBootstrapFuture<'a, ()> {
        Box::pin(async move { remove_bootstrap_worktree(&worktree, &self.cancellation).await })
    }
}

async fn remove_bootstrap_worktree(
    worktree: &BootstrapWorktree,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let repository_root = PathBuf::from(&worktree.repository_root);
    GitRepository::default()
        .remove_worktree(
            &repository_root,
            Path::new(&worktree.path),
            true,
            cancellation,
        )
        .await
        .map_err(|error| error.to_string())?;
    if worktree.remove_branch {
        run_bootstrap_git(
            &repository_root,
            ["branch", "-D", worktree.branch.as_str()],
            cancellation,
        )
        .await?;
    }
    Ok(())
}

async fn fetch_origin_base(
    cwd: &Path,
    base_branch: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    run_bootstrap_git(cwd, ["fetch", "origin"], cancellation).await?;
    let branch = base_branch.strip_prefix("origin/").unwrap_or(base_branch);
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let output =
        run_bootstrap_git(cwd, ["rev-parse", "--verify", &remote_ref], cancellation).await?;
    let commit = output.trim();
    if commit.is_empty() {
        return Err(format!(
            "origin branch '{base_branch}' resolved to an empty commit"
        ));
    }
    Ok(commit.to_owned())
}

async fn run_bootstrap_git<const N: usize>(
    cwd: &Path,
    args: [&str; N],
    cancellation: &CancellationToken,
) -> Result<String, String> {
    ProcessRunner
        .run(
            ProcessRequest {
                operation: format!("bootstrap.git.{}", args[0]),
                command: PathBuf::from("git"),
                args: args.into_iter().map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env: Vec::new(),
                stdin: None,
                timeout: GIT_TIMEOUT,
                max_output_bytes: GIT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit: false,
            },
            cancellation,
        )
        .await
        .map(|output| output.stdout)
        .map_err(bootstrap_process_error)
}

fn bootstrap_process_error(error: ProcessError) -> String {
    let detail = match &error {
        ProcessError::NonZeroExit { stderr, stdout, .. } => [stderr.as_ref(), stdout.as_ref()]
            .into_iter()
            .map(str::trim)
            .find(|value| !value.is_empty()),
        _ => None,
    };
    let summary = detail.map_or_else(|| error.to_string(), |detail| format!("{error}: {detail}"));
    crate::diagnostics::redact_sensitive_text(&summary)
}

pub struct OrchestrationEffects {
    cancellation: CancellationToken,
    producer: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    worker: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl OrchestrationEffects {
    pub async fn start(
        engine: OrchestrationEngine,
        callbacks: Arc<dyn OrchestrationEffectCallbacks>,
        options: EffectsOptions,
    ) -> Result<Self, OrchestrationEffectsError> {
        let subscription = engine.subscribe_events();
        let cancellation = CancellationToken::new();
        let (sender, receiver) = mpsc::channel(options.queue_capacity.max(1));

        install_project_command_effects(&engine);
        engine.set_bootstrap_effects(Arc::new(ProductionBootstrapEffects {
            repositories: engine.repositories(),
            callbacks: callbacks.clone(),
            cancellation: cancellation.clone(),
        }));

        let worker = tokio::spawn(run_worker(
            engine.clone(),
            callbacks,
            receiver,
            cancellation.clone(),
        ));
        let producer = tokio::spawn(run_producer(
            engine,
            sender,
            cancellation.clone(),
            subscription,
        ));

        Ok(Self {
            cancellation,
            producer: tokio::sync::Mutex::new(Some(producer)),
            worker: tokio::sync::Mutex::new(Some(worker)),
        })
    }

    pub async fn shutdown(&self) {
        self.cancellation.cancel();
        if let Some(producer) = self.producer.lock().await.take() {
            let _ = producer.await;
        }
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.await;
        }
    }
}

async fn run_producer(
    engine: OrchestrationEngine,
    sender: mpsc::Sender<OrchestrationEvent>,
    cancellation: CancellationToken,
    mut subscription: broadcast::Receiver<OrchestrationEvent>,
) {
    let mut last_sequence = 0;
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return,
            received = subscription.recv() => match received {
                Ok(event) => {
                    last_sequence = event.sequence;
                    if is_reactor_event(&event)
                        && sender.send(event).await.is_err()
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    match engine.read_events(last_sequence).await {
                        Ok(events) => {
                            for event in events {
                                last_sequence = event.sequence;
                                if is_reactor_event(&event)
                                    && sender.send(event).await.is_err()
                                {
                                    return;
                                }
                            }
                        }
                        Err(error) => tracing::warn!(%error, "failed to recover orchestration effect events after receiver lag"),
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

fn is_reactor_event(event: &OrchestrationEvent) -> bool {
    matches!(
        event.event.event_type.as_str(),
        "thread.turn-start-requested"
            | "thread.message-sent"
            | "thread.turn-diff-completed"
            | "thread.checkpoint-revert-requested"
            | "thread.deleted"
    )
}

async fn run_worker(
    engine: OrchestrationEngine,
    callbacks: Arc<dyn OrchestrationEffectCallbacks>,
    mut receiver: mpsc::Receiver<OrchestrationEvent>,
    cancellation: CancellationToken,
) {
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return,
            event = receiver.recv() => {
                let Some(event) = event else { return };
                if let Err(error) = process_event(&engine, callbacks.as_ref(), &event, &cancellation).await {
                    tracing::warn!(event_type = %event.event.event_type, sequence = event.sequence, %error, "orchestration side effect failed");
                    append_failure_activity(&engine, &event, &error.to_string()).await;
                }
            }
        }
    }
}

async fn process_event(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    match event.event.event_type.as_str() {
        "thread.turn-start-requested" => {
            ensure_baseline(engine, callbacks, event, cancellation).await
        }
        "thread.message-sent" => {
            let payload = &event.event.payload;
            if payload.get("role").and_then(Value::as_str) == Some("user")
                && payload.get("streaming").and_then(Value::as_bool) == Some(false)
                && payload.get("turnId").is_none_or(Value::is_null)
            {
                ensure_baseline(engine, callbacks, event, cancellation).await
            } else {
                Ok(())
            }
        }
        "thread.turn-diff-completed"
            if event.event.payload.get("status").and_then(Value::as_str) == Some("missing") =>
        {
            capture_missing_checkpoint(engine, callbacks, event, cancellation).await
        }
        "thread.checkpoint-revert-requested" => {
            revert_checkpoint(engine, callbacks, event, cancellation).await
        }
        "thread.deleted" => {
            cleanup_deleted_thread(callbacks, event).await;
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn resolve_workspace(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
) -> Result<Option<PathBuf>, OrchestrationEffectsError> {
    if let Some(cwd) = callbacks
        .workspace_for_thread(thread_id)
        .await
        .map_err(OrchestrationEffectsError::Effect)?
    {
        return Ok(Some(cwd));
    }
    let repositories = engine.repositories();
    let Some(thread) = repositories.get_thread(thread_id.to_owned()).await? else {
        return Ok(None);
    };
    if let Some(worktree_path) = thread.worktree_path {
        return Ok(Some(process_compatible_path(worktree_path.into())));
    }
    Ok(repositories
        .get_project(thread.project_id)
        .await?
        .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
}

async fn ensure_baseline(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(cwd) = resolve_workspace(engine, callbacks, thread_id).await? else {
        return Ok(());
    };
    if !is_git_repository(&cwd, cancellation).await? {
        return Ok(());
    }
    let turn_count = engine
        .repositories()
        .list_checkpoints_by_thread(thread_id.to_owned())
        .await?
        .into_iter()
        .map(|checkpoint| checkpoint.checkpoint_turn_count)
        .max()
        .unwrap_or(0);
    let reference = checkpoint_ref(thread_id, turn_count);
    if !has_ref(&cwd, &reference, cancellation).await? {
        capture_checkpoint_with_cancellation(&cwd, thread_id, turn_count, cancellation).await?;
    }
    Ok(())
}

async fn capture_missing_checkpoint(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let payload = &event.event.payload;
    let Some(thread_id) = payload.get("threadId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(turn_id) = payload.get("turnId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(turn_count) = payload.get("checkpointTurnCount").and_then(Value::as_i64) else {
        return Ok(());
    };
    let Some(cwd) = resolve_workspace(engine, callbacks, thread_id).await? else {
        return Ok(());
    };
    if !is_git_repository(&cwd, cancellation).await? {
        return Ok(());
    }

    let existing = engine
        .repositories()
        .get_turn_by_id(thread_id.to_owned(), turn_id.to_owned())
        .await?;
    if existing
        .as_ref()
        .and_then(|turn| turn.checkpoint_status.as_deref())
        .is_some_and(|status| status != "missing")
    {
        return Ok(());
    }

    let target_ref = checkpoint_ref(thread_id, turn_count);
    capture_checkpoint_with_cancellation(&cwd, thread_id, turn_count, cancellation).await?;
    callbacks
        .refresh_workspace(&cwd)
        .await
        .map_err(OrchestrationEffectsError::Effect)?;

    let from_ref = checkpoint_ref(thread_id, turn_count.saturating_sub(1));
    let files = if has_ref(&cwd, &from_ref, cancellation).await? {
        diff_file_summaries(&cwd, &from_ref, &target_ref, cancellation).await?
    } else {
        Vec::new()
    };
    let completed_at = payload
        .get("completedAt")
        .and_then(Value::as_str)
        .unwrap_or(&event.event.occurred_at)
        .to_owned();
    let assistant_message_id = payload
        .get("assistantMessageId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| Some(format!("assistant:{turn_id}")));

    engine
        .dispatch(OrchestrationCommand::ThreadTurnDiffComplete {
            command_id: server_id("checkpoint-turn-diff-complete"),
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.to_owned(),
            checkpoint_turn_count: turn_count,
            checkpoint_ref: target_ref,
            status: "ready".to_owned(),
            files: Value::Array(files),
            assistant_message_id,
            completed_at: completed_at.clone(),
            created_at: completed_at.clone(),
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: server_id("checkpoint-captured-activity"),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: "info".to_owned(),
                kind: "checkpoint.captured".to_owned(),
                summary: "Checkpoint captured".to_owned(),
                payload: json!({"turnCount":turn_count,"status":"ready"}),
                turn_id: Some(turn_id.to_owned()),
                sequence: None,
                created_at: completed_at.clone(),
            },
            created_at: completed_at,
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    Ok(())
}

async fn revert_checkpoint(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let payload = &event.event.payload;
    let thread_id = required_str(payload, "threadId")?;
    let turn_count = payload
        .get("turnCount")
        .and_then(Value::as_i64)
        .ok_or_else(|| OrchestrationEffectsError::Effect("missing turnCount".to_owned()))?;
    let cwd = resolve_workspace(engine, callbacks, thread_id)
        .await?
        .ok_or_else(|| {
            OrchestrationEffectsError::Effect(
                "No active provider session with workspace cwd is bound to this thread.".to_owned(),
            )
        })?;
    if !is_git_repository(&cwd, cancellation).await? {
        return Err(OrchestrationEffectsError::Effect(
            "Checkpoints are unavailable because this project is not a git repository.".to_owned(),
        ));
    }

    let checkpoints = engine
        .repositories()
        .list_checkpoints_by_thread(thread_id.to_owned())
        .await?;
    let current_turn_count = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.checkpoint_turn_count)
        .max()
        .unwrap_or(0);
    if turn_count > current_turn_count {
        return Err(OrchestrationEffectsError::Effect(format!(
            "Checkpoint turn count {turn_count} exceeds current turn count {current_turn_count}."
        )));
    }
    let target_ref = if turn_count == 0 {
        checkpoint_ref(thread_id, 0)
    } else {
        checkpoints
            .iter()
            .find(|checkpoint| checkpoint.checkpoint_turn_count == turn_count)
            .map(|checkpoint| checkpoint.checkpoint_ref.clone())
            .ok_or_else(|| {
                OrchestrationEffectsError::Effect(format!(
                    "Checkpoint ref for turn {turn_count} is unavailable in read model."
                ))
            })?
    };
    if !restore_checkpoint(&cwd, &target_ref, turn_count == 0, cancellation).await? {
        return Err(OrchestrationEffectsError::Effect(format!(
            "Filesystem checkpoint is unavailable for turn {turn_count}."
        )));
    }
    callbacks
        .refresh_workspace(&cwd)
        .await
        .map_err(OrchestrationEffectsError::Effect)?;
    let rolled_back_turns = current_turn_count.saturating_sub(turn_count);
    if rolled_back_turns > 0 {
        callbacks
            .rollback_provider(thread_id, rolled_back_turns)
            .await
            .map_err(OrchestrationEffectsError::Effect)?;
    }
    for checkpoint in checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.checkpoint_turn_count > turn_count)
    {
        delete_ref(&cwd, &checkpoint.checkpoint_ref, cancellation).await?;
    }
    let created_at = now_iso();
    engine
        .dispatch(OrchestrationCommand::ThreadRevertComplete {
            command_id: server_id("checkpoint-revert-complete"),
            thread_id: thread_id.to_owned(),
            turn_count,
            created_at,
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    Ok(())
}

async fn cleanup_deleted_thread(
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
) {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return;
    };
    if let Err(error) = callbacks.stop_provider(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped provider session stop");
    }
    if let Err(error) = callbacks.close_terminals(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped terminal close");
    }
}

async fn append_failure_activity(
    engine: &OrchestrationEngine,
    event: &OrchestrationEvent,
    detail: &str,
) {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let (kind, summary, turn_id, payload) =
        if event.event.event_type == "thread.checkpoint-revert-requested" {
            (
                "checkpoint.revert.failed",
                "Checkpoint revert failed",
                None,
                json!({"turnCount":event.event.payload.get("turnCount"),"detail":detail}),
            )
        } else {
            (
                "checkpoint.capture.failed",
                "Checkpoint capture failed",
                event
                    .event
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                json!({"detail":detail}),
            )
        };
    let created_at = now_iso();
    let _ = engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: server_id("checkpoint-effect-failure"),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: "error".to_owned(),
                kind: kind.to_owned(),
                summary: summary.to_owned(),
                payload,
                turn_id,
                sequence: None,
                created_at: created_at.clone(),
            },
            created_at,
        })
        .await;
}

pub fn checkpoint_ref(thread_id: &str, turn_count: i64) -> String {
    format!(
        "refs/t4code/checkpoints/{}/turn/{turn_count}",
        URL_SAFE_NO_PAD.encode(thread_id)
    )
}

pub async fn capture_checkpoint(
    cwd: &Path,
    thread_id: &str,
    turn_count: i64,
) -> Result<(), OrchestrationEffectsError> {
    capture_checkpoint_with_cancellation(cwd, thread_id, turn_count, &CancellationToken::new())
        .await
}

async fn capture_checkpoint_with_cancellation(
    cwd: &Path,
    thread_id: &str,
    turn_count: i64,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let common_dir = run_git(
        cwd,
        &["rev-parse", "--git-common-dir"],
        &[],
        false,
        cancellation,
    )
    .await?
    .stdout;
    let common_dir = PathBuf::from(common_dir.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        cwd.join(common_dir)
    };
    let temporary_index = common_dir.join(format!("t4code-checkpoint-index-{}", Uuid::new_v4()));
    let reference = checkpoint_ref(thread_id, turn_count);
    let env = checkpoint_environment(&temporary_index);

    let result = async {
        let head = run_git(
            cwd,
            &["rev-parse", "--verify", "HEAD^{commit}"],
            &env,
            true,
            cancellation,
        )
        .await?;
        if head.exit_code == 0 {
            run_git(cwd, &["read-tree", "HEAD"], &env, false, cancellation).await?;
        }
        run_git(cwd, &["add", "-A", "--", "."], &env, false, cancellation).await?;
        let tree = run_git(cwd, &["write-tree"], &env, false, cancellation)
            .await?
            .stdout;
        let message = format!("t4code checkpoint ref={reference}");
        let commit = run_git(
            cwd,
            &["commit-tree", tree.trim(), "-m", &message],
            &env,
            false,
            cancellation,
        )
        .await?
        .stdout;
        run_git(
            cwd,
            &["update-ref", &reference, commit.trim()],
            &[],
            false,
            cancellation,
        )
        .await?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(temporary_index).await;
    result
}

async fn is_git_repository(
    cwd: &Path,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        &["rev-parse", "--is-inside-work-tree"],
        &[],
        true,
        cancellation,
    )
    .await?;
    Ok(output.exit_code == 0 && output.stdout.trim() == "true")
}

async fn has_ref(
    cwd: &Path,
    reference: &str,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    Ok(run_git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
        &[],
        true,
        cancellation,
    )
    .await?
    .exit_code
        == 0)
}

async fn restore_checkpoint(
    cwd: &Path,
    reference: &str,
    fallback_to_head: bool,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    let revision = if has_ref(cwd, reference, cancellation).await? {
        reference.to_owned()
    } else if fallback_to_head
        && run_git(
            cwd,
            &["rev-parse", "--verify", "HEAD^{commit}"],
            &[],
            true,
            cancellation,
        )
        .await?
        .exit_code
            == 0
    {
        "HEAD".to_owned()
    } else {
        return Ok(false);
    };
    run_git(
        cwd,
        &[
            "restore",
            "--source",
            &revision,
            "--worktree",
            "--staged",
            "--",
            ".",
        ],
        &[],
        false,
        cancellation,
    )
    .await?;
    run_git(cwd, &["clean", "-fd", "--", "."], &[], false, cancellation).await?;
    if run_git(
        cwd,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        &[],
        true,
        cancellation,
    )
    .await?
    .exit_code
        == 0
    {
        run_git(
            cwd,
            &["reset", "--quiet", "--", "."],
            &[],
            false,
            cancellation,
        )
        .await?;
    }
    Ok(true)
}

async fn delete_ref(
    cwd: &Path,
    reference: &str,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    run_git(
        cwd,
        &["update-ref", "-d", reference],
        &[],
        true,
        cancellation,
    )
    .await?;
    Ok(())
}

async fn diff_file_summaries(
    cwd: &Path,
    from_ref: &str,
    to_ref: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<Value>, OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        &[
            "diff",
            "--numstat",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            &format!("{from_ref}^{{commit}}"),
            &format!("{to_ref}^{{commit}}"),
        ],
        &[],
        false,
        cancellation,
    )
    .await?;
    let mut files = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let additions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?;
            Some(json!({
                "path": path,
                "kind": "modified",
                "additions": additions.parse::<i64>().unwrap_or(0),
                "deletions": deletions.parse::<i64>().unwrap_or(0),
            }))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok(files)
}

async fn run_git(
    cwd: &Path,
    args: &[&str],
    env: &[(OsString, OsString)],
    allow_non_zero_exit: bool,
    cancellation: &CancellationToken,
) -> Result<crate::git::ProcessOutput, OrchestrationEffectsError> {
    ProcessRunner
        .run(
            ProcessRequest {
                operation: "OrchestrationEffects.git".to_owned(),
                command: PathBuf::from("git"),
                args: args.iter().map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env: env.to_vec(),
                stdin: None,
                timeout: GIT_TIMEOUT,
                max_output_bytes: GIT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit,
            },
            cancellation,
        )
        .await
        .map_err(Into::into)
}

fn checkpoint_environment(index: &Path) -> Vec<(OsString, OsString)> {
    [
        ("GIT_INDEX_FILE", index.to_string_lossy().as_ref()),
        ("GIT_AUTHOR_NAME", "T4Code"),
        ("GIT_AUTHOR_EMAIL", "t4code@users.noreply.github.com"),
        ("GIT_COMMITTER_NAME", "T4Code"),
        ("GIT_COMMITTER_EMAIL", "t4code@users.noreply.github.com"),
    ]
    .into_iter()
    .map(|(key, value)| (OsString::from(key), OsString::from(value)))
    .collect()
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, OrchestrationEffectsError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| OrchestrationEffectsError::Effect(format!("missing {field}")))
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

fn server_id(tag: &str) -> String {
    format!("server:{tag}:{}", Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::persistence::{Database, ProjectionProject, Repositories, run_migrations};

    use super::*;

    #[tokio::test]
    async fn unit_build_covers_workspace_normalization_and_checkpoint_git_lifecycle() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let parent = tempfile::tempdir().expect("workspace parent");
        let missing = parent.path().join("nested/project");
        assert!(matches!(
            normalize_project_workspace_root(&missing, false).await,
            Err(OrchestrationEffectsError::WorkspaceMissing(_))
        ));
        let normalized = normalize_project_workspace_root(&missing, true)
            .await
            .expect("workspace creates");
        assert!(normalized.is_absolute());
        assert_eq!(process_compatible_path(normalized.clone()), normalized);
        let file = parent.path().join("file");
        tokio::fs::write(&file, "not a directory")
            .await
            .expect("file fixture");
        assert!(matches!(
            normalize_project_workspace_root(&file, false).await,
            Err(OrchestrationEffectsError::WorkspaceNotDirectory(_))
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let read_only = parent.path().join("read-only");
            tokio::fs::create_dir(&read_only).await.unwrap();
            tokio::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o500))
                .await
                .unwrap();
            assert!(matches!(
                normalize_project_workspace_root(&read_only.join("child"), true).await,
                Err(OrchestrationEffectsError::WorkspaceIo { .. })
            ));
            tokio::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
        }

        let command_root = parent.path().join("command-project");
        let project_effects = ProductionProjectCommandEffects;
        let canonical_command_root = project_effects
            .canonicalize_workspace_root(command_root.to_string_lossy().as_ref(), true)
            .await
            .expect("project command canonicalizes without creating");
        assert!(Path::new(&canonical_command_root).is_absolute());
        assert!(!command_root.exists());
        project_effects
            .prepare_project_create(&canonical_command_root, true, false)
            .await
            .expect("project command prepares");
        assert!(command_root.is_dir());

        let repository = tempfile::tempdir().expect("repository");
        let cancellation = CancellationToken::new();
        assert!(
            !is_git_repository(repository.path(), &cancellation)
                .await
                .expect("non-repository probe")
        );
        run_git(repository.path(), &["init"], &[], false, &cancellation)
            .await
            .expect("git init");
        run_git(
            repository.path(),
            &["config", "core.autocrlf", "false"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("disable fixture line-ending conversion");
        run_git(
            repository.path(),
            &["config", "user.name", "T4Code Test"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git user name");
        run_git(
            repository.path(),
            &["config", "user.email", "t4code@example.test"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git user email");
        tokio::fs::write(repository.path().join("tracked.txt"), "baseline\n")
            .await
            .expect("baseline file");
        run_git(repository.path(), &["add", "."], &[], false, &cancellation)
            .await
            .expect("git add");
        run_git(
            repository.path(),
            &["commit", "-m", "baseline"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git commit");
        assert!(
            is_git_repository(repository.path(), &cancellation)
                .await
                .expect("repository probe")
        );

        capture_checkpoint(repository.path(), "thread/one", 0)
            .await
            .expect("baseline checkpoint");
        let baseline_ref = checkpoint_ref("thread/one", 0);
        assert!(
            has_ref(repository.path(), &baseline_ref, &cancellation)
                .await
                .expect("baseline ref")
        );
        tokio::fs::write(repository.path().join("tracked.txt"), "changed\n")
            .await
            .expect("changed file");
        tokio::fs::write(repository.path().join("new.txt"), "new\n")
            .await
            .expect("new file");
        capture_checkpoint_with_cancellation(repository.path(), "thread/one", 1, &cancellation)
            .await
            .expect("changed checkpoint");
        let changed_ref = checkpoint_ref("thread/one", 1);
        let files = diff_file_summaries(
            repository.path(),
            &baseline_ref,
            &changed_ref,
            &cancellation,
        )
        .await
        .expect("checkpoint diff");
        assert_eq!(files.len(), 2);
        assert!(
            restore_checkpoint(repository.path(), &baseline_ref, false, &cancellation)
                .await
                .expect("checkpoint restore")
        );
        assert_eq!(
            tokio::fs::read_to_string(repository.path().join("tracked.txt"))
                .await
                .expect("restored file"),
            "baseline\n"
        );
        assert!(!repository.path().join("new.txt").exists());
        assert!(
            restore_checkpoint(
                repository.path(),
                "refs/t4code/checkpoints/missing",
                true,
                &cancellation,
            )
            .await
            .expect("head fallback")
        );
        assert!(
            !restore_checkpoint(
                repository.path(),
                "refs/t4code/checkpoints/missing",
                false,
                &cancellation,
            )
            .await
            .expect("missing checkpoint")
        );
        delete_ref(repository.path(), &changed_ref, &cancellation)
            .await
            .expect("checkpoint ref deletes");
        assert!(
            !has_ref(repository.path(), &changed_ref, &cancellation)
                .await
                .expect("deleted ref")
        );

        assert_eq!(checkpoint_environment(Path::new("index")).len(), 5);
        assert_eq!(
            required_str(&json!({"field":"value"}), "field").unwrap(),
            "value"
        );
        assert!(required_str(&json!({}), "field").is_err());
        assert!(!now_iso().is_empty());
        assert!(server_id("unit").starts_with("server:unit:"));
        assert!(checkpoint_ref("thread/one", 2).contains("dGhyZWFkL29uZQ"));

        struct CleanupCallbacks(AtomicUsize);

        impl OrchestrationEffectCallbacks for CleanupCallbacks {
            fn workspace_for_thread<'a>(
                &'a self,
                _: &'a str,
            ) -> BoxEffectFuture<'a, Option<PathBuf>> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(None) })
            }

            fn rollback_provider<'a>(&'a self, _: &'a str, _: i64) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(()) })
            }

            fn stop_provider<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Err("provider".to_owned()) })
            }

            fn close_terminals<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Err("terminals".to_owned()) })
            }

            fn refresh_workspace<'a>(&'a self, _: &'a Path) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(()) })
            }
        }

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let callbacks = Arc::new(CleanupCallbacks(AtomicUsize::new(0)));
        callbacks
            .workspace_for_thread("thread")
            .await
            .expect("workspace callback");
        callbacks
            .rollback_provider("thread", 1)
            .await
            .expect("rollback callback");
        callbacks
            .refresh_workspace(parent.path())
            .await
            .expect("refresh callback");
        let repositories = Repositories::new(database.clone());
        repositories
            .upsert_project(ProjectionProject {
                project_id: "malformed".to_owned(),
                title: "Malformed".to_owned(),
                workspace_root: parent
                    .path()
                    .join("malformed")
                    .to_string_lossy()
                    .into_owned(),
                default_model_selection: None,
                scripts: json!({"not":"an array"}),
                created_at: "2026-07-16T00:00:00Z".to_owned(),
                updated_at: "2026-07-16T00:00:00Z".to_owned(),
                deleted_at: None,
            })
            .await
            .expect("malformed project fixture");
        repositories
            .upsert_project(ProjectionProject {
                project_id: "empty".to_owned(),
                title: "Empty".to_owned(),
                workspace_root: parent.path().join("empty").to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([]),
                created_at: "2026-07-16T00:00:01Z".to_owned(),
                updated_at: "2026-07-16T00:00:01Z".to_owned(),
                deleted_at: None,
            })
            .await
            .expect("empty project fixture");
        let bootstrap = ProductionBootstrapEffects {
            repositories,
            callbacks: callbacks.clone(),
            cancellation: CancellationToken::new(),
        };
        assert!(
            bootstrap
                .prepare_worktree(ThreadTurnStartBootstrapPrepareWorktree {
                    project_cwd: file.to_string_lossy().into_owned(),
                    base_branch: "main".to_owned(),
                    branch: Some("unit-invalid".to_owned()),
                    start_from_origin: None,
                })
                .await
                .is_err()
        );
        assert!(
            bootstrap
                .remove_worktree(BootstrapWorktree {
                    repository_root: file.to_string_lossy().into_owned(),
                    branch: "unit-invalid".to_owned(),
                    path: parent
                        .path()
                        .join("missing-worktree")
                        .to_string_lossy()
                        .into_owned(),
                    remove_branch: true,
                })
                .await
                .is_err()
        );
        assert!(
            bootstrap_process_error(ProcessError::Spawn {
                operation: "unit".to_owned(),
                command: "missing".to_owned(),
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
            })
            .contains("failed to spawn")
        );
        assert!(
            bootstrap_process_error(ProcessError::NonZeroExit {
                operation: "unit".to_owned(),
                exit_code: 1,
                stdout_length: 6,
                stderr_length: 0,
                stdout: "detail".into(),
                stderr: "".into(),
            })
            .contains("detail")
        );
        assert!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: None,
                    project_cwd: None,
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .is_err()
        );
        assert!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: Some("malformed".to_owned()),
                    project_cwd: None,
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .is_err()
        );
        assert_eq!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: None,
                    project_cwd: Some(parent.path().join("empty").to_string_lossy().into_owned()),
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .expect("empty scripts should be a no-op"),
            BootstrapSetupResult::NoScript
        );
        database
            .call(|connection| {
                connection.execute("DROP TABLE projection_projects", [])?;
                Ok(())
            })
            .await
            .expect("drop project projection");
        for input in [
            BootstrapSetupInput {
                thread_id: "thread".to_owned(),
                project_id: Some("missing".to_owned()),
                project_cwd: None,
                worktree_path: parent.path().to_string_lossy().into_owned(),
            },
            BootstrapSetupInput {
                thread_id: "thread".to_owned(),
                project_id: None,
                project_cwd: Some("missing".to_owned()),
                worktree_path: parent.path().to_string_lossy().into_owned(),
            },
        ] {
            assert!(bootstrap.run_setup_script(input).await.is_err());
        }
        let cleanup_error = bootstrap
            .cleanup_thread_resources("thread")
            .await
            .expect_err("both cleanup callbacks fail");
        assert!(cleanup_error.contains("provider cleanup failed: provider"));
        assert!(cleanup_error.contains("terminal cleanup failed: terminals"));
        assert_eq!(callbacks.0.load(Ordering::Relaxed), 5);
    }
}
