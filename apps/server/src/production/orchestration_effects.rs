use std::{
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
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
    git::{OutputPolicy, ProcessError, ProcessRequest, ProcessRunner},
    orchestration::engine::{ActivityInput, OrchestrationCommand, OrchestrationEngine},
    persistence::{OrchestrationEvent, PersistenceError},
};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub type BoxEffectFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub trait OrchestrationEffectCallbacks: Send + Sync {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>>;

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()>;

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    fn refresh_workspace<'a>(&'a self, cwd: &'a Path) -> BoxEffectFuture<'a, ()>;
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
    match tokio::fs::metadata(workspace_root).await {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(OrchestrationEffectsError::WorkspaceNotDirectory(
                workspace_root.to_path_buf(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_if_missing => {
            tokio::fs::create_dir_all(workspace_root)
                .await
                .map_err(|source| OrchestrationEffectsError::WorkspaceIo {
                    path: workspace_root.to_path_buf(),
                    source,
                })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(OrchestrationEffectsError::WorkspaceMissing(
                workspace_root.to_path_buf(),
            ));
        }
        Err(source) => {
            return Err(OrchestrationEffectsError::WorkspaceIo {
                path: workspace_root.to_path_buf(),
                source,
            });
        }
    }

    tokio::fs::canonicalize(workspace_root)
        .await
        .map_err(|source| OrchestrationEffectsError::WorkspaceIo {
            path: workspace_root.to_path_buf(),
            source,
        })
}

pub async fn normalize_project_create_command(
    command: &mut OrchestrationCommand,
) -> Result<(), OrchestrationEffectsError> {
    if let OrchestrationCommand::ProjectCreate {
        workspace_root,
        create_workspace_root_if_missing,
        ..
    } = command
    {
        let normalized = normalize_project_workspace_root(
            Path::new(workspace_root),
            create_workspace_root_if_missing.unwrap_or(false),
        )
        .await?;
        *workspace_root = normalized.to_string_lossy().into_owned();
    }
    Ok(())
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
        return Ok(Some(worktree_path.into()));
    }
    Ok(repositories
        .get_project(thread.project_id)
        .await?
        .map(|project| PathBuf::from(project.workspace_root)))
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
