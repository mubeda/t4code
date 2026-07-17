use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
};

use rusqlite::{OptionalExtension, Row, Transaction, params};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::checkpointing;
use crate::persistence::{
    CheckpointDiffBlob, CommandReceipt, Database, NewOrchestrationEvent, OrchestrationEvent,
    PersistenceError, ProjectionPendingApproval, ProjectionProject, ProjectionState,
    ProjectionThread, ProjectionThreadActivity, ProjectionThreadMessage,
    ProjectionThreadProposedPlan, ProjectionThreadSession, ProjectionTurn, Repositories,
};

const TURN_UPSERT_SQL: &str = "INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id, turn_id) DO UPDATE SET pending_message_id=excluded.pending_message_id, source_proposed_plan_thread_id=excluded.source_proposed_plan_thread_id, source_proposed_plan_id=excluded.source_proposed_plan_id, assistant_message_id=excluded.assistant_message_id, state=excluded.state, requested_at=excluded.requested_at, started_at=excluded.started_at, completed_at=excluded.completed_at, checkpoint_turn_count=excluded.checkpoint_turn_count, checkpoint_ref=excluded.checkpoint_ref, checkpoint_status=excluded.checkpoint_status, checkpoint_files_json=excluded.checkpoint_files_json";
const PROJECTOR_NAMES: [&str; 9] = [
    "projection.projects",
    "projection.thread-messages",
    "projection.thread-proposed-plans",
    "projection.thread-activities",
    "projection.thread-sessions",
    "projection.thread-turns",
    "projection.checkpoints",
    "projection.pending-approvals",
    "projection.threads",
];

fn server_command_id(scope: &str) -> String {
    format!("server:{scope}:{}", Uuid::new_v4())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[derive(Clone, Debug, Default)]
pub enum OptionalNullable<T> {
    #[default]
    Missing,
    Present(Option<T>),
}

impl<T> OptionalNullable<T> {
    fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    fn as_ref(&self) -> Option<Option<&T>> {
        match self {
            Self::Missing => None,
            Self::Present(value) => Some(value.as_ref()),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for OptionalNullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(Self::Present)
    }
}

impl<T: Serialize> Serialize for OptionalNullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Missing => serializer.serialize_none(),
            Self::Present(value) => value.serialize(serializer),
        }
    }
}

fn optional_nullable_is_missing<T>(value: &OptionalNullable<T>) -> bool {
    value.is_missing()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThreadMessageInput {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub role: String,
    pub text: String,
    pub attachments: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionInput {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub status: String,
    #[serde(rename = "providerName")]
    pub provider_name: Option<String>,
    #[serde(
        rename = "providerInstanceId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_instance_id: Option<String>,
    #[serde(rename = "runtimeMode", default = "default_runtime_mode")]
    pub runtime_mode: String,
    #[serde(rename = "activeTurnId")]
    pub active_turn_id: Option<String>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposedPlanInput {
    pub id: String,
    #[serde(rename = "turnId")]
    pub turn_id: Option<String>,
    #[serde(rename = "planMarkdown")]
    pub plan_markdown: String,
    #[serde(rename = "implementedAt", default)]
    pub implemented_at: Option<String>,
    #[serde(rename = "implementationThreadId", default)]
    pub implementation_thread_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivityInput {
    pub id: String,
    pub tone: String,
    pub kind: String,
    pub summary: String,
    pub payload: Value,
    #[serde(rename = "turnId")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnStartBootstrapCreateThread {
    pub project_id: String,
    pub title: String,
    pub model_selection: Value,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnStartBootstrapPrepareWorktree {
    pub project_cwd: String,
    pub base_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_from_origin: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnStartBootstrap {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_thread: Option<ThreadTurnStartBootstrapCreateThread>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare_worktree: Option<ThreadTurnStartBootstrapPrepareWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_setup_script: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapWorktree {
    pub repository_root: String,
    pub branch: String,
    pub path: String,
    pub remove_branch: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootstrapSetupInput {
    pub thread_id: String,
    pub project_id: Option<String>,
    pub project_cwd: Option<String>,
    pub worktree_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BootstrapSetupResult {
    NoScript,
    Started {
        script_id: String,
        script_name: String,
        terminal_id: String,
    },
}

pub type BoxBootstrapFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub trait ThreadTurnBootstrapEffects: Send + Sync {
    fn prepare_worktree<'a>(
        &'a self,
        input: ThreadTurnStartBootstrapPrepareWorktree,
    ) -> BoxBootstrapFuture<'a, BootstrapWorktree>;

    fn run_setup_script<'a>(
        &'a self,
        input: BootstrapSetupInput,
    ) -> BoxBootstrapFuture<'a, BootstrapSetupResult>;

    fn cleanup_thread_resources<'a>(&'a self, thread_id: &'a str) -> BoxBootstrapFuture<'a, ()>;

    fn remove_worktree<'a>(&'a self, worktree: BootstrapWorktree) -> BoxBootstrapFuture<'a, ()>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OrchestrationCommand {
    #[serde(rename = "project.create")]
    ProjectCreate {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        title: String,
        #[serde(rename = "workspaceRoot")]
        workspace_root: String,
        #[serde(
            rename = "createWorkspaceRootIfMissing",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        create_workspace_root_if_missing: Option<bool>,
        #[serde(
            rename = "defaultModelSelection",
            default,
            skip_serializing_if = "optional_nullable_is_missing"
        )]
        default_model_selection: OptionalNullable<Value>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "project.meta.update")]
    ProjectMetaUpdate {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(
            rename = "workspaceRoot",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        workspace_root: Option<String>,
        #[serde(
            rename = "defaultModelSelection",
            default,
            skip_serializing_if = "optional_nullable_is_missing"
        )]
        default_model_selection: OptionalNullable<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scripts: Option<Vec<Value>>,
    },
    #[serde(rename = "project.delete")]
    ProjectDelete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        force: Option<bool>,
    },
    #[serde(rename = "thread.create")]
    ThreadCreate {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(rename = "modelSelection")]
        model_selection: Value,
        #[serde(rename = "runtimeMode")]
        runtime_mode: String,
        #[serde(rename = "interactionMode", default = "default_interaction_mode")]
        interaction_mode: String,
        branch: Option<String>,
        #[serde(rename = "worktreePath")]
        worktree_path: Option<String>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.delete")]
    ThreadDelete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "thread.archive")]
    ThreadArchive {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "thread.unarchive")]
    ThreadUnarchive {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "thread.meta.update")]
    ThreadMetaUpdate {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(
            rename = "modelSelection",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        model_selection: Option<Value>,
        #[serde(default, skip_serializing_if = "optional_nullable_is_missing")]
        branch: OptionalNullable<String>,
        #[serde(
            rename = "worktreePath",
            default,
            skip_serializing_if = "optional_nullable_is_missing"
        )]
        worktree_path: OptionalNullable<String>,
    },
    #[serde(rename = "thread.runtime-mode.set")]
    ThreadRuntimeModeSet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runtimeMode")]
        runtime_mode: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.interaction-mode.set")]
    ThreadInteractionModeSet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "interactionMode")]
        interaction_mode: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.turn.start")]
    ThreadTurnStart {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        message: ThreadMessageInput,
        #[serde(
            rename = "modelSelection",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        model_selection: Option<Value>,
        #[serde(rename = "titleSeed", default, skip_serializing_if = "Option::is_none")]
        title_seed: Option<String>,
        #[serde(rename = "runtimeMode", default = "default_runtime_mode")]
        runtime_mode: String,
        #[serde(rename = "interactionMode", default = "default_interaction_mode")]
        interaction_mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bootstrap: Option<Box<ThreadTurnStartBootstrap>>,
        #[serde(
            rename = "sourceProposedPlan",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_proposed_plan: Option<Value>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.turn.interrupt")]
    ThreadTurnInterrupt {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.approval.respond")]
    ThreadApprovalRespond {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        decision: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.user-input.respond")]
    ThreadUserInputRespond {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        answers: Value,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.checkpoint.revert")]
    ThreadCheckpointRevert {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnCount")]
        turn_count: i64,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.session.stop")]
    ThreadSessionStop {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.session.set")]
    ThreadSessionSet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        session: SessionInput,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.message.assistant.delta")]
    ThreadMessageAssistantDelta {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        delta: String,
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.message.assistant.complete")]
    ThreadMessageAssistantComplete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.proposed-plan.upsert")]
    ThreadProposedPlanUpsert {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "proposedPlan")]
        proposed_plan: ProposedPlanInput,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.turn.diff.complete")]
    ThreadTurnDiffComplete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "checkpointTurnCount")]
        checkpoint_turn_count: i64,
        #[serde(rename = "checkpointRef")]
        checkpoint_ref: String,
        status: String,
        files: Value,
        #[serde(rename = "assistantMessageId")]
        assistant_message_id: Option<String>,
        #[serde(rename = "completedAt")]
        completed_at: String,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.activity.append")]
    ThreadActivityAppend {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        activity: ActivityInput,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
    #[serde(rename = "thread.revert.complete")]
    ThreadRevertComplete {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnCount")]
        turn_count: i64,
        #[serde(rename = "createdAt")]
        created_at: String,
    },
}

fn default_runtime_mode() -> String {
    "full-access".to_owned()
}
fn default_interaction_mode() -> String {
    "default".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DispatchResult {
    pub sequence: i64,
}

#[derive(Clone, Debug, Default)]
pub struct EngineOptions {
    pub queue_capacity: usize,
    pub test_hooks: TestHooks,
}

#[derive(Clone, Debug, Default)]
pub struct TestHooks {
    fail_next_projector: Arc<StdMutex<Option<FailProjectorOnce>>>,
}

#[derive(Clone, Debug)]
struct FailProjectorOnce {
    projector: String,
    event_type: Option<String>,
}

impl TestHooks {
    pub fn fail_next_projector(&self, projector: impl Into<String>, event_type: Option<&str>) {
        *self.fail_next_projector.lock().expect("failpoint mutex") = Some(FailProjectorOnce {
            projector: projector.into(),
            event_type: event_type.map(str::to_owned),
        });
    }

    fn maybe_fail(&self, projector: &str, event_type: &str) -> Result<(), OrchestrationError> {
        let mut guard = self.fail_next_projector.lock().expect("failpoint mutex");
        let should_fail = guard
            .as_ref()
            .map(|failpoint| {
                failpoint.projector == projector
                    && failpoint
                        .event_type
                        .as_deref()
                        .is_none_or(|candidate| candidate == event_type)
            })
            .unwrap_or(false);
        if should_fail {
            *guard = None;
            return Err(OrchestrationError::InjectedProjectorFailure {
                projector: projector.to_owned(),
                event_type: event_type.to_owned(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone)]
pub enum OrchestrationError {
    #[error("orchestration command invariant failed ({command_type}): {detail}")]
    Invariant {
        command_type: String,
        detail: String,
    },
    #[error("command previously rejected ({command_id}): {detail}")]
    PreviouslyRejected { command_id: String, detail: String },
    #[error("orchestration worker has already shut down")]
    WorkerClosed,
    #[error("orchestration worker cancelled")]
    Cancelled,
    #[error("orchestration response channel dropped")]
    ResponseDropped,
    #[error(transparent)]
    Persistence(#[from] Arc<PersistenceError>),
    #[error("projector {projector} failed for {event_type}")]
    InjectedProjectorFailure {
        projector: String,
        event_type: String,
    },
    #[error("thread turn bootstrap failed during {stage}: {detail}")]
    Bootstrap { stage: &'static str, detail: String },
}

#[derive(Clone, Debug)]
struct CommandModel {
    projects: BTreeMap<String, ProjectState>,
    threads: BTreeMap<String, ThreadState>,
}

#[derive(Clone, Debug)]
struct ProjectState {
    deleted_at: Option<String>,
}

#[derive(Clone, Debug)]
struct ThreadState {
    project_id: String,
    kind: String,
    runtime_mode: String,
    interaction_mode: String,
    archived_at: Option<String>,
    deleted_at: Option<String>,
}

#[derive(Debug)]
struct CommandEnvelope {
    command: OrchestrationCommand,
    response: oneshot::Sender<Result<DispatchResult, OrchestrationError>>,
}

#[derive(Clone)]
pub struct OrchestrationEngine {
    repositories: Repositories,
    sender: mpsc::Sender<CommandEnvelope>,
    events: broadcast::Sender<OrchestrationEvent>,
    shutdown: CancellationToken,
    worker: Arc<tokio::sync::Mutex<Option<JoinHandle<()>>>>,
    bootstrap_effects: Arc<StdMutex<Option<Arc<dyn ThreadTurnBootstrapEffects>>>>,
}

impl OrchestrationEngine {
    pub async fn start(
        database: Database,
        options: EngineOptions,
    ) -> Result<Self, OrchestrationError> {
        let repositories = Repositories::new(database);
        bootstrap_projectors(&repositories, &options.test_hooks).await?;
        rebuild_all_thread_derived_fields(repositories.database()).await?;
        let initial_model = load_command_model(&repositories).await?;
        let (sender, receiver) = mpsc::channel(options.queue_capacity.max(1));
        let (events, _) = broadcast::channel(128);
        let shutdown = CancellationToken::new();
        let worker = spawn_worker(
            repositories.clone(),
            initial_model,
            receiver,
            events.clone(),
            shutdown.clone(),
            options.test_hooks.clone(),
        );
        Ok(Self {
            repositories,
            sender,
            events,
            shutdown,
            worker: Arc::new(tokio::sync::Mutex::new(Some(worker))),
            bootstrap_effects: Arc::new(StdMutex::new(None)),
        })
    }

    pub async fn dispatch(
        &self,
        command: OrchestrationCommand,
    ) -> Result<DispatchResult, OrchestrationError> {
        if matches!(
            command,
            OrchestrationCommand::ThreadTurnStart {
                bootstrap: Some(_),
                ..
            }
        ) {
            return self.dispatch_bootstrap_turn(command).await;
        }
        self.dispatch_plain(command).await
    }

    async fn dispatch_plain(
        &self,
        command: OrchestrationCommand,
    ) -> Result<DispatchResult, OrchestrationError> {
        if self.shutdown.is_cancelled() {
            return Err(OrchestrationError::Cancelled);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(CommandEnvelope {
                command,
                response: response_tx,
            })
            .await
            .map_err(|_| OrchestrationError::WorkerClosed)?;
        response_rx
            .await
            .map_err(|_| OrchestrationError::ResponseDropped)?
    }

    async fn dispatch_bootstrap_turn(
        &self,
        command: OrchestrationCommand,
    ) -> Result<DispatchResult, OrchestrationError> {
        let OrchestrationCommand::ThreadTurnStart {
            command_id,
            thread_id,
            message,
            model_selection,
            title_seed,
            runtime_mode,
            interaction_mode,
            bootstrap: Some(bootstrap),
            source_proposed_plan,
            created_at,
        } = command
        else {
            return self.dispatch_plain(command).await;
        };

        let ThreadTurnStartBootstrap {
            create_thread,
            prepare_worktree,
            run_setup_script,
        } = *bootstrap;

        let mut created_thread = false;
        let target_project_id = create_thread
            .as_ref()
            .map(|create| create.project_id.clone());
        let target_project_cwd = prepare_worktree
            .as_ref()
            .map(|prepare| prepare.project_cwd.clone());
        let mut target_worktree_path = create_thread
            .as_ref()
            .and_then(|create| create.worktree_path.clone());
        let mut prepared_worktree = None;
        let mut setup_started = false;
        if let Some(create) = create_thread {
            self.dispatch_plain(OrchestrationCommand::ThreadCreate {
                command_id: server_command_id("bootstrap-thread-create"),
                thread_id: thread_id.clone(),
                project_id: create.project_id,
                title: create.title,
                kind: None,
                model_selection: create.model_selection,
                runtime_mode: create.runtime_mode,
                interaction_mode: create.interaction_mode,
                branch: create.branch,
                worktree_path: create.worktree_path,
                created_at: create.created_at,
            })
            .await?;
            created_thread = true;
        }

        let result = async {
            if let Some(prepare) = prepare_worktree {
                let effects =
                    self.bootstrap_effects()
                        .ok_or_else(|| OrchestrationError::Bootstrap {
                            stage: "worktree preparation",
                            detail: "production bootstrap effects are not registered".to_owned(),
                        })?;
                let worktree = effects.prepare_worktree(prepare).await.map_err(|detail| {
                    OrchestrationError::Bootstrap {
                        stage: "worktree preparation",
                        detail,
                    }
                })?;
                target_worktree_path = Some(worktree.path.clone());
                prepared_worktree = Some(worktree.clone());
                self.dispatch_plain(OrchestrationCommand::ThreadMetaUpdate {
                    command_id: server_command_id("bootstrap-thread-meta-update"),
                    thread_id: thread_id.clone(),
                    title: None,
                    model_selection: None,
                    branch: OptionalNullable::Present(Some(worktree.branch.clone())),
                    worktree_path: OptionalNullable::Present(Some(worktree.path.clone())),
                })
                .await?;
            }

            if run_setup_script == Some(true)
                && let Some(worktree_path) = target_worktree_path
            {
                setup_started = self
                    .run_bootstrap_setup(
                        &thread_id,
                        target_project_id,
                        target_project_cwd,
                        worktree_path,
                    )
                    .await?;
            }

            self.dispatch_plain(OrchestrationCommand::ThreadTurnStart {
                command_id,
                thread_id: thread_id.clone(),
                message,
                model_selection,
                title_seed,
                runtime_mode,
                interaction_mode,
                bootstrap: None,
                source_proposed_plan,
                created_at,
            })
            .await
        }
        .await;
        if let Err(mut error) = result {
            if setup_started
                && let Some(effects) = self.bootstrap_effects()
                && let Err(cleanup_error) = effects.cleanup_thread_resources(&thread_id).await
            {
                error = OrchestrationError::Bootstrap {
                    stage: "rollback",
                    detail: format!("{error}; thread resource cleanup failed: {cleanup_error}"),
                };
            }
            if let Some(worktree) = prepared_worktree
                && let Some(effects) = self.bootstrap_effects()
                && let Err(cleanup_error) = effects.remove_worktree(worktree).await
            {
                error = OrchestrationError::Bootstrap {
                    stage: "rollback",
                    detail: format!("{error}; worktree cleanup failed: {cleanup_error}"),
                };
            }
            if created_thread {
                let _ = self
                    .dispatch_plain(OrchestrationCommand::ThreadDelete {
                        command_id: server_command_id("bootstrap-thread-delete"),
                        thread_id,
                    })
                    .await;
            }
            return Err(error);
        }
        result
    }

    fn bootstrap_effects(&self) -> Option<Arc<dyn ThreadTurnBootstrapEffects>> {
        self.bootstrap_effects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_bootstrap_effects(&self, effects: Arc<dyn ThreadTurnBootstrapEffects>) {
        *self
            .bootstrap_effects
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(effects);
    }

    async fn run_bootstrap_setup(
        &self,
        thread_id: &str,
        project_id: Option<String>,
        project_cwd: Option<String>,
        worktree_path: String,
    ) -> Result<bool, OrchestrationError> {
        let requested_at = now_iso();
        let result = match self.bootstrap_effects() {
            Some(effects) => {
                effects
                    .run_setup_script(BootstrapSetupInput {
                        thread_id: thread_id.to_owned(),
                        project_id,
                        project_cwd,
                        worktree_path: worktree_path.clone(),
                    })
                    .await
            }
            None => Err("production bootstrap effects are not registered".to_owned()),
        };
        match result {
            Ok(BootstrapSetupResult::NoScript) => Ok(false),
            Ok(BootstrapSetupResult::Started {
                script_id,
                script_name,
                terminal_id,
            }) => {
                let payload = json!({"scriptId":script_id,"scriptName":script_name,"terminalId":terminal_id,"worktreePath":worktree_path});
                for (kind, summary, created_at) in [
                    (
                        "setup-script.requested",
                        "Starting setup script",
                        requested_at,
                    ),
                    ("setup-script.started", "Setup script started", now_iso()),
                ] {
                    self.append_bootstrap_activity(
                        thread_id,
                        "info",
                        kind,
                        summary,
                        payload.clone(),
                        created_at,
                    )
                    .await;
                }
                Ok(true)
            }
            Err(detail) => {
                self.append_bootstrap_activity(
                    thread_id,
                    "error",
                    "setup-script.failed",
                    "Setup script failed to start",
                    json!({"detail":detail,"worktreePath":worktree_path}),
                    requested_at,
                )
                .await;
                Err(OrchestrationError::Bootstrap {
                    stage: "setup script launch",
                    detail,
                })
            }
        }
    }

    async fn append_bootstrap_activity(
        &self,
        thread_id: &str,
        tone: &str,
        kind: &str,
        summary: &str,
        payload: Value,
        created_at: String,
    ) {
        let _ = self
            .dispatch_plain(OrchestrationCommand::ThreadActivityAppend {
                command_id: server_command_id(kind),
                thread_id: thread_id.to_owned(),
                activity: ActivityInput {
                    id: Uuid::new_v4().to_string(),
                    tone: tone.to_owned(),
                    kind: kind.to_owned(),
                    summary: summary.to_owned(),
                    payload,
                    turn_id: None,
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            })
            .await;
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<OrchestrationEvent> {
        self.events.subscribe()
    }

    pub async fn read_events(
        &self,
        from_sequence_exclusive: i64,
    ) -> Result<Vec<OrchestrationEvent>, OrchestrationError> {
        read_all_events(&self.repositories, from_sequence_exclusive)
            .await
            .map_err(Into::into)
    }

    pub fn repositories(&self) -> Repositories {
        self.repositories.clone()
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.await;
        }
    }
}

fn spawn_worker(
    repositories: Repositories,
    mut model: CommandModel,
    mut receiver: mpsc::Receiver<CommandEnvelope>,
    events: broadcast::Sender<OrchestrationEvent>,
    shutdown: CancellationToken,
    hooks: TestHooks,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                envelope = receiver.recv() => {
                    let Some(envelope) = envelope else {
                        break;
                    };
                    let result = process_envelope(&repositories, &mut model, &events, &hooks, envelope.command).await;
                    let _ = envelope.response.send(result);
                }
            }
        }
    })
}

async fn process_envelope(
    repositories: &Repositories,
    model: &mut CommandModel,
    events: &broadcast::Sender<OrchestrationEvent>,
    hooks: &TestHooks,
    command: OrchestrationCommand,
) -> Result<DispatchResult, OrchestrationError> {
    let command_id = command.command_id().to_owned();
    let occurred_at = match command.occurred_at() {
        Some(value) => value.to_owned(),
        None => current_timestamp(repositories.database()).await?,
    };
    if let Some(receipt) = repositories
        .get_command_receipt(command_id.clone())
        .await
        .map_err(wrap_persistence)?
    {
        if receipt.status == "accepted" {
            return Ok(DispatchResult {
                sequence: receipt.result_sequence,
            });
        }
        return Err(OrchestrationError::PreviouslyRejected {
            command_id,
            detail: receipt
                .error
                .unwrap_or_else(|| "Previously rejected.".to_owned()),
        });
    }

    let planned = match plan_command(repositories, model, &command, &occurred_at).await {
        Ok(planned) => planned,
        Err(error) => {
            let aggregate = command.aggregate_ref();
            repositories
                .upsert_command_receipt(CommandReceipt {
                    command_id: command.command_id().to_owned(),
                    aggregate_kind: aggregate.0.to_owned(),
                    aggregate_id: aggregate.1.to_owned(),
                    accepted_at: occurred_at,
                    result_sequence: current_max_sequence(repositories).await.unwrap_or(0),
                    status: "rejected".to_owned(),
                    error: Some(error.to_string()),
                })
                .await
                .map_err(wrap_persistence)?;
            return Err(error);
        }
    };

    let committed = persist_command(repositories, hooks, &planned, &command_id).await?;
    apply_to_model(model, &committed);
    for event in &committed {
        let _ = events.send(event.clone());
    }
    let last_sequence = committed
        .back()
        .map(|event| event.sequence)
        .ok_or_else(|| OrchestrationError::Invariant {
            command_type: command.command_type().to_owned(),
            detail: "Command produced no events.".to_owned(),
        })?;
    Ok(DispatchResult {
        sequence: last_sequence,
    })
}

async fn plan_command(
    repositories: &Repositories,
    model: &CommandModel,
    command: &OrchestrationCommand,
    occurred_at: &str,
) -> Result<Vec<NewOrchestrationEvent>, OrchestrationError> {
    let metadata = Value::Object(Default::default());
    match command {
        OrchestrationCommand::ProjectCreate {
            command_id,
            project_id,
            title,
            workspace_root,
            default_model_selection,
            created_at,
            ..
        } => {
            if model.projects.contains_key(project_id) {
                return invariant(
                    command,
                    format!("Project '{project_id}' already exists and cannot be created twice."),
                );
            }
            let default_thread_id = Uuid::new_v4().to_string();
            let project_selection = default_model_selection
                .as_ref()
                .and_then(|value| value.cloned())
                .unwrap_or(Value::Null);
            let selection = default_model_selection
                .as_ref()
                .and_then(|value| value.cloned())
                .unwrap_or_else(|| json!({"instanceId":"codex","model":"gpt-5"}));
            Ok(vec![
                make_event(
                    "project.created",
                    "project",
                    project_id,
                    created_at,
                    command_id,
                    metadata.clone(),
                    json!({"projectId":project_id,"title":title,"workspaceRoot":workspace_root,"defaultModelSelection":project_selection,"scripts":[],"createdAt":created_at,"updatedAt":created_at}),
                ),
                make_event(
                    "thread.created",
                    "thread",
                    &default_thread_id,
                    created_at,
                    command_id,
                    metadata,
                    json!({"threadId":default_thread_id,"projectId":project_id,"title":title,"kind":"default","modelSelection":selection,"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":created_at,"updatedAt":created_at}),
                ),
            ])
        }
        OrchestrationCommand::ProjectMetaUpdate {
            command_id,
            project_id,
            title,
            workspace_root,
            default_model_selection,
            scripts,
        } => {
            require_project(model, command, project_id)?;
            let mut payload = json!({"projectId":project_id,"updatedAt":occurred_at});
            insert_optional(&mut payload, "title", title.as_ref().map(|v| json!(v)));
            insert_optional(
                &mut payload,
                "workspaceRoot",
                workspace_root.as_ref().map(|v| json!(v)),
            );
            insert_optional(
                &mut payload,
                "defaultModelSelection",
                default_model_selection
                    .as_ref()
                    .map(|value| value.cloned().unwrap_or(Value::Null)),
            );
            insert_optional(&mut payload, "scripts", scripts.as_ref().map(|v| json!(v)));
            Ok(vec![make_event(
                "project.meta-updated",
                "project",
                project_id,
                occurred_at,
                command_id,
                metadata,
                payload,
            )])
        }
        OrchestrationCommand::ProjectDelete {
            command_id,
            project_id,
            force,
        } => {
            require_project(model, command, project_id)?;
            let active: Vec<_> = model
                .threads
                .iter()
                .filter(|(_, thread)| {
                    thread.project_id == *project_id && thread.deleted_at.is_none()
                })
                .collect();
            if force != &Some(true) && active.iter().any(|(_, thread)| thread.kind != "default") {
                return invariant(
                    command,
                    format!(
                        "Project '{project_id}' is not empty and cannot be deleted without force=true."
                    ),
                );
            }
            let mut events: Vec<_> = active
                .into_iter()
                .map(|(thread_id, _)| {
                    make_event(
                        "thread.deleted",
                        "thread",
                        thread_id,
                        occurred_at,
                        command_id,
                        metadata.clone(),
                        json!({"threadId":thread_id,"deletedAt":occurred_at}),
                    )
                })
                .collect();
            events.push(make_event(
                "project.deleted",
                "project",
                project_id,
                occurred_at,
                command_id,
                metadata,
                json!({"projectId":project_id,"deletedAt":occurred_at}),
            ));
            Ok(events)
        }
        OrchestrationCommand::ThreadCreate {
            command_id,
            thread_id,
            project_id,
            title,
            kind,
            model_selection,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            created_at,
        } => {
            require_project(model, command, project_id)?;
            if kind.as_deref() == Some("default")
                && model.threads.values().any(|thread| {
                    thread.project_id == project_id.as_str()
                        && thread.kind == "default"
                        && thread.deleted_at.is_none()
                })
            {
                return invariant(
                    command,
                    format!("Project '{project_id}' already has a canonical default thread."),
                );
            }
            if model.threads.contains_key(thread_id) {
                return invariant(
                    command,
                    format!("Thread '{thread_id}' already exists and cannot be created twice."),
                );
            }
            let mut payload = json!({"threadId":thread_id,"projectId":project_id,"title":title,"modelSelection":model_selection,"runtimeMode":runtime_mode,"interactionMode":interaction_mode,"branch":branch,"worktreePath":worktree_path,"createdAt":created_at,"updatedAt":created_at});
            insert_optional(&mut payload, "kind", kind.as_ref().map(|v| json!(v)));
            Ok(vec![make_event(
                "thread.created",
                "thread",
                thread_id,
                created_at,
                command_id,
                metadata,
                payload,
            )])
        }
        OrchestrationCommand::ThreadDelete {
            command_id,
            thread_id,
        } => {
            let thread = require_thread(model, command, thread_id)?;
            if thread.kind == "default" {
                return invariant(
                    command,
                    format!("Default thread '{thread_id}' cannot be deleted directly."),
                );
            }
            Ok(vec![make_event(
                "thread.deleted",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                json!({"threadId":thread_id,"deletedAt":occurred_at}),
            )])
        }
        OrchestrationCommand::ThreadArchive {
            command_id,
            thread_id,
        } => {
            let thread = require_thread(model, command, thread_id)?;
            if thread.kind == "default" {
                return invariant(
                    command,
                    format!("Default thread '{thread_id}' cannot be archived directly."),
                );
            }
            if thread.archived_at.is_some() {
                return invariant(
                    command,
                    format!("Thread '{thread_id}' is already archived."),
                );
            }
            Ok(vec![make_event(
                "thread.archived",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                json!({"threadId":thread_id,"archivedAt":occurred_at,"updatedAt":occurred_at}),
            )])
        }
        OrchestrationCommand::ThreadUnarchive {
            command_id,
            thread_id,
        } => {
            let thread = require_thread(model, command, thread_id)?;
            if thread.archived_at.is_none() {
                return invariant(command, format!("Thread '{thread_id}' is not archived."));
            }
            Ok(vec![make_event(
                "thread.unarchived",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                json!({"threadId":thread_id,"updatedAt":occurred_at}),
            )])
        }
        OrchestrationCommand::ThreadMetaUpdate {
            command_id,
            thread_id,
            title,
            model_selection,
            branch,
            worktree_path,
        } => {
            require_thread(model, command, thread_id)?;
            let mut payload = json!({"threadId":thread_id,"updatedAt":occurred_at});
            insert_optional(&mut payload, "title", title.as_ref().map(|v| json!(v)));
            insert_optional(&mut payload, "modelSelection", model_selection.clone());
            insert_optional(
                &mut payload,
                "branch",
                branch
                    .as_ref()
                    .map(|value| value.map_or(Value::Null, |value| json!(value))),
            );
            insert_optional(
                &mut payload,
                "worktreePath",
                worktree_path
                    .as_ref()
                    .map(|value| value.map_or(Value::Null, |value| json!(value))),
            );
            Ok(vec![make_event(
                "thread.meta-updated",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                payload,
            )])
        }
        OrchestrationCommand::ThreadRuntimeModeSet {
            command_id,
            thread_id,
            runtime_mode,
            ..
        } => {
            require_thread(model, command, thread_id)?;
            Ok(vec![make_event(
                "thread.runtime-mode-set",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                json!({"threadId":thread_id,"runtimeMode":runtime_mode,"updatedAt":occurred_at}),
            )])
        }
        OrchestrationCommand::ThreadInteractionModeSet {
            command_id,
            thread_id,
            interaction_mode,
            ..
        } => {
            require_thread(model, command, thread_id)?;
            Ok(vec![make_event(
                "thread.interaction-mode-set",
                "thread",
                thread_id,
                occurred_at,
                command_id,
                metadata,
                json!({"threadId":thread_id,"interactionMode":interaction_mode,"updatedAt":occurred_at}),
            )])
        }
        OrchestrationCommand::ThreadTurnStart {
            command_id,
            thread_id,
            message,
            model_selection,
            title_seed,
            source_proposed_plan,
            created_at,
            ..
        } => {
            let thread = require_thread(model, command, thread_id)?;
            if let Some(source) = source_proposed_plan {
                let source_thread_id = required_command_string(command, source, "threadId")?;
                let source_plan_id = required_command_string(command, source, "planId")?;
                let source_thread = require_thread(model, command, &source_thread_id)?;
                if source_thread.project_id != thread.project_id {
                    return invariant(
                        command,
                        format!(
                            "Proposed plan '{source_plan_id}' belongs to thread '{source_thread_id}' in a different project."
                        ),
                    );
                }
                let plan_exists = repositories
                    .list_proposed_plans_by_thread(source_thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?
                    .iter()
                    .any(|plan| plan.plan_id == source_plan_id);
                if !plan_exists {
                    return invariant(
                        command,
                        format!(
                            "Proposed plan '{source_plan_id}' does not exist on thread '{source_thread_id}'."
                        ),
                    );
                }
            }
            let user = make_event(
                "thread.message-sent",
                "thread",
                thread_id,
                created_at,
                command_id,
                metadata.clone(),
                json!({"threadId":thread_id,"messageId":message.message_id,"role":"user","text":message.text,"attachments":message.attachments,"turnId":null,"streaming":false,"createdAt":created_at,"updatedAt":created_at}),
            );
            let mut payload = json!({"threadId":thread_id,"messageId":message.message_id,"runtimeMode":thread.runtime_mode,"interactionMode":thread.interaction_mode,"createdAt":created_at});
            insert_optional(&mut payload, "modelSelection", model_selection.clone());
            insert_optional(
                &mut payload,
                "titleSeed",
                title_seed.as_ref().map(|v| json!(v)),
            );
            insert_optional(
                &mut payload,
                "sourceProposedPlan",
                source_proposed_plan.clone(),
            );
            let mut start = make_event(
                "thread.turn-start-requested",
                "thread",
                thread_id,
                created_at,
                command_id,
                metadata,
                payload,
            );
            start.causation_event_id = Some(user.event_id.clone());
            Ok(vec![user, start])
        }
        OrchestrationCommand::ThreadTurnInterrupt {
            command_id,
            thread_id,
            turn_id,
            created_at,
        } => event_with_optional(
            command,
            "thread.turn-interrupt-requested",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"createdAt":created_at}),
            "turnId",
            turn_id.as_ref().map(|v| json!(v)),
            model,
        ),
        OrchestrationCommand::ThreadApprovalRespond {
            command_id,
            thread_id,
            request_id,
            decision,
            created_at,
        } => {
            require_thread(model, command, thread_id)?;
            Ok(vec![make_event(
                "thread.approval-response-requested",
                "thread",
                thread_id,
                created_at,
                command_id,
                json!({"requestId":request_id}),
                json!({"threadId":thread_id,"requestId":request_id,"decision":decision,"createdAt":created_at}),
            )])
        }
        OrchestrationCommand::ThreadUserInputRespond {
            command_id,
            thread_id,
            request_id,
            answers,
            created_at,
        } => {
            require_thread(model, command, thread_id)?;
            Ok(vec![make_event(
                "thread.user-input-response-requested",
                "thread",
                thread_id,
                created_at,
                command_id,
                json!({"requestId":request_id}),
                json!({"threadId":thread_id,"requestId":request_id,"answers":answers,"createdAt":created_at}),
            )])
        }
        OrchestrationCommand::ThreadCheckpointRevert {
            command_id,
            thread_id,
            turn_count,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.checkpoint-revert-requested",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"turnCount":turn_count,"createdAt":created_at}),
        ),
        OrchestrationCommand::ThreadSessionStop {
            command_id,
            thread_id,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.session-stop-requested",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"createdAt":created_at}),
        ),
        OrchestrationCommand::ThreadSessionSet {
            command_id,
            thread_id,
            session,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.session-set",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"session":session}),
        ),
        OrchestrationCommand::ThreadMessageAssistantDelta {
            command_id,
            thread_id,
            message_id,
            delta,
            turn_id,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.message-sent",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"messageId":message_id,"role":"assistant","text":delta,"turnId":turn_id,"streaming":true,"createdAt":created_at,"updatedAt":created_at}),
        ),
        OrchestrationCommand::ThreadMessageAssistantComplete {
            command_id,
            thread_id,
            message_id,
            turn_id,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.message-sent",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"messageId":message_id,"role":"assistant","text":"","turnId":turn_id,"streaming":false,"createdAt":created_at,"updatedAt":created_at}),
        ),
        OrchestrationCommand::ThreadProposedPlanUpsert {
            command_id,
            thread_id,
            proposed_plan,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.proposed-plan-upserted",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"proposedPlan":proposed_plan}),
        ),
        OrchestrationCommand::ThreadTurnDiffComplete {
            command_id,
            thread_id,
            turn_id,
            checkpoint_turn_count,
            checkpoint_ref,
            status,
            files,
            assistant_message_id,
            completed_at,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.turn-diff-completed",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"turnId":turn_id,"checkpointTurnCount":checkpoint_turn_count,"checkpointRef":checkpoint_ref,"status":status,"files":files,"assistantMessageId":assistant_message_id,"completedAt":completed_at}),
        ),
        OrchestrationCommand::ThreadActivityAppend {
            command_id,
            thread_id,
            activity,
            created_at,
        } => {
            let event_metadata = activity
                .payload
                .get("requestId")
                .and_then(Value::as_str)
                .map_or(metadata, |request_id| json!({"requestId":request_id}));
            simple_thread_event(
                model,
                command,
                "thread.activity-appended",
                command_id,
                thread_id,
                created_at,
                event_metadata,
                json!({"threadId":thread_id,"activity":activity}),
            )
        }
        OrchestrationCommand::ThreadRevertComplete {
            command_id,
            thread_id,
            turn_count,
            created_at,
        } => simple_thread_event(
            model,
            command,
            "thread.reverted",
            command_id,
            thread_id,
            created_at,
            metadata,
            json!({"threadId":thread_id,"turnCount":turn_count}),
        ),
    }
}

fn invariant<T>(command: &OrchestrationCommand, detail: String) -> Result<T, OrchestrationError> {
    Err(OrchestrationError::Invariant {
        command_type: command.command_type().to_owned(),
        detail,
    })
}

fn require_project<'a>(
    model: &'a CommandModel,
    command: &OrchestrationCommand,
    project_id: &str,
) -> Result<&'a ProjectState, OrchestrationError> {
    let Some(project) = model.projects.get(project_id) else {
        return invariant(
            command,
            format!(
                "Project '{project_id}' does not exist for command '{}'.",
                command.command_type()
            ),
        );
    };
    if project.deleted_at.is_some() {
        return invariant(command, format!("Project '{project_id}' is deleted."));
    }
    Ok(project)
}

fn require_thread<'a>(
    model: &'a CommandModel,
    command: &OrchestrationCommand,
    thread_id: &str,
) -> Result<&'a ThreadState, OrchestrationError> {
    let Some(thread) = model.threads.get(thread_id) else {
        return Err(OrchestrationError::Invariant {
            command_type: command.command_type().to_owned(),
            detail: format!(
                "Thread '{thread_id}' does not exist for command '{}'.",
                command.command_type()
            ),
        });
    };
    if thread.deleted_at.is_some() {
        return Err(OrchestrationError::Invariant {
            command_type: command.command_type().to_owned(),
            detail: format!("Thread '{thread_id}' is deleted."),
        });
    }
    Ok(thread)
}

#[allow(clippy::too_many_arguments)]
fn simple_thread_event(
    model: &CommandModel,
    command: &OrchestrationCommand,
    event_type: &str,
    command_id: &str,
    thread_id: &str,
    occurred_at: &str,
    metadata: Value,
    payload: Value,
) -> Result<Vec<NewOrchestrationEvent>, OrchestrationError> {
    require_thread(model, command, thread_id)?;
    Ok(vec![make_event(
        event_type,
        "thread",
        thread_id,
        occurred_at,
        command_id,
        metadata,
        payload,
    )])
}

#[allow(clippy::too_many_arguments)]
fn event_with_optional(
    command: &OrchestrationCommand,
    event_type: &str,
    command_id: &str,
    thread_id: &str,
    occurred_at: &str,
    metadata: Value,
    mut payload: Value,
    key: &str,
    value: Option<Value>,
    model: &CommandModel,
) -> Result<Vec<NewOrchestrationEvent>, OrchestrationError> {
    insert_optional(&mut payload, key, value);
    simple_thread_event(
        model,
        command,
        event_type,
        command_id,
        thread_id,
        occurred_at,
        metadata,
        payload,
    )
}

fn insert_optional(target: &mut Value, key: &str, value: Option<Value>) {
    if let (Some(object), Some(value)) = (target.as_object_mut(), value) {
        object.insert(key.to_owned(), value);
    }
}

fn required_command_string(
    command: &OrchestrationCommand,
    value: &Value,
    key: &str,
) -> Result<String, OrchestrationError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| OrchestrationError::Invariant {
            command_type: command.command_type().to_owned(),
            detail: format!("Command field '{key}' must be a string."),
        })
}

async fn persist_command(
    repositories: &Repositories,
    hooks: &TestHooks,
    events: &[NewOrchestrationEvent],
    command_id: &str,
) -> Result<VecDeque<OrchestrationEvent>, OrchestrationError> {
    let repositories = repositories.clone();
    let hooks = hooks.clone();
    let event_list = events.to_vec();
    let command_id = command_id.to_owned();
    let committed = repositories
        .database()
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let mut committed = VecDeque::new();
            for planned in &event_list {
                let saved = append_event_tx(&transaction, planned.clone())?;
                for projector in PROJECTOR_NAMES {
                    hooks
                        .maybe_fail(projector, &saved.event.event_type)
                        .map_err(projector_failure_to_persistence)?;
                    apply_projector_tx(&transaction, projector, &saved)?;
                    upsert_projection_state_tx(
                        &transaction,
                        projector,
                        saved.sequence,
                        &saved.event.occurred_at,
                    )?;
                }
                if saved.event.aggregate_kind == "thread" {
                    rebuild_thread_derived_fields_tx(&transaction, &saved.event.aggregate_id)?;
                }
                committed.push_back(saved);
            }
            let last_saved = committed.back().cloned().ok_or_else(|| {
                PersistenceError::Corrupt("planned command emitted no events".to_owned())
            })?;
            upsert_command_receipt_tx(
                &transaction,
                CommandReceipt {
                    command_id,
                    aggregate_kind: last_saved.event.aggregate_kind.clone(),
                    aggregate_id: last_saved.event.aggregate_id.clone(),
                    accepted_at: last_saved.event.occurred_at.clone(),
                    result_sequence: last_saved.sequence,
                    status: "accepted".to_owned(),
                    error: None,
                },
            )?;
            transaction.commit()?;
            Ok(committed)
        })
        .await
        .map_err(wrap_persistence)?;
    Ok(committed)
}

fn apply_to_model(model: &mut CommandModel, events: &VecDeque<OrchestrationEvent>) {
    for event in events {
        match event.event.event_type.as_str() {
            "project.created" => {
                if let Some(project_id) =
                    event.event.payload.get("projectId").and_then(Value::as_str)
                {
                    model
                        .projects
                        .insert(project_id.to_owned(), ProjectState { deleted_at: None });
                }
            }
            "thread.created" => {
                let payload = &event.event.payload;
                if let Some(thread_id) = payload.get("threadId").and_then(Value::as_str) {
                    model.threads.insert(
                        thread_id.to_owned(),
                        ThreadState {
                            project_id: payload
                                .get("projectId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                            kind: payload
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("workspace")
                                .to_owned(),
                            runtime_mode: payload
                                .get("runtimeMode")
                                .and_then(Value::as_str)
                                .unwrap_or("full-access")
                                .to_owned(),
                            interaction_mode: payload
                                .get("interactionMode")
                                .and_then(Value::as_str)
                                .unwrap_or("default")
                                .to_owned(),
                            archived_at: None,
                            deleted_at: None,
                        },
                    );
                }
            }
            "project.deleted" => {
                if let Some(project) = model.projects.get_mut(&event.event.aggregate_id) {
                    project.deleted_at = Some(event.event.occurred_at.clone());
                }
            }
            "thread.deleted" => {
                if let Some(thread) = model.threads.get_mut(&event.event.aggregate_id) {
                    thread.deleted_at = Some(event.event.occurred_at.clone());
                }
            }
            "thread.archived" => {
                if let Some(thread) = model.threads.get_mut(&event.event.aggregate_id) {
                    thread.archived_at = Some(event.event.occurred_at.clone());
                }
            }
            "thread.unarchived" => {
                if let Some(thread) = model.threads.get_mut(&event.event.aggregate_id) {
                    thread.archived_at = None;
                }
            }
            "thread.runtime-mode-set" => {
                if let Some(thread) = model.threads.get_mut(&event.event.aggregate_id)
                    && let Some(value) = event
                        .event
                        .payload
                        .get("runtimeMode")
                        .and_then(Value::as_str)
                {
                    thread.runtime_mode = value.to_owned();
                }
            }
            "thread.interaction-mode-set" => {
                if let Some(thread) = model.threads.get_mut(&event.event.aggregate_id)
                    && let Some(value) = event
                        .event
                        .payload
                        .get("interactionMode")
                        .and_then(Value::as_str)
                {
                    thread.interaction_mode = value.to_owned();
                }
            }
            _ => {}
        }
    }
}

async fn bootstrap_projectors(
    repositories: &Repositories,
    hooks: &TestHooks,
) -> Result<(), OrchestrationError> {
    for projector in PROJECTOR_NAMES {
        let start_sequence = repositories
            .get_projection_state(projector.to_owned())
            .await
            .map_err(wrap_persistence)?
            .map(|state| state.last_applied_sequence)
            .unwrap_or(0);
        let events = read_all_events(repositories, start_sequence)
            .await
            .map_err(OrchestrationError::from)?;
        for event in events {
            let database = repositories.database().clone();
            let projector = projector.to_owned();
            let occurred_at = event.event.occurred_at.clone();
            let hooks = hooks.clone();
            database
                .call(move |connection| {
                    let transaction = connection.transaction()?;
                    hooks
                        .maybe_fail(&projector, &event.event.event_type)
                        .map_err(projector_failure_to_persistence)?;
                    apply_projector_tx(&transaction, &projector, &event)?;
                    upsert_projection_state_tx(
                        &transaction,
                        &projector,
                        event.sequence,
                        &occurred_at,
                    )?;
                    if projector == "projection.threads" && event.event.aggregate_kind == "thread" {
                        rebuild_thread_derived_fields_tx(&transaction, &event.event.aggregate_id)?;
                    }
                    transaction.commit()?;
                    Ok(())
                })
                .await
                .map_err(wrap_persistence)?;
        }
    }
    Ok(())
}

async fn read_all_events(
    repositories: &Repositories,
    from_sequence_exclusive: i64,
) -> Result<Vec<OrchestrationEvent>, Arc<PersistenceError>> {
    let mut cursor = from_sequence_exclusive;
    let mut all = Vec::new();
    loop {
        let batch = repositories
            .read_events_from_sequence(cursor, 128)
            .await
            .map_err(Arc::new)?;
        if batch.is_empty() {
            break;
        }
        cursor = batch.last().map(|event| event.sequence).unwrap_or(cursor);
        all.extend(batch);
    }
    Ok(all)
}

async fn load_command_model(
    repositories: &Repositories,
) -> Result<CommandModel, OrchestrationError> {
    let mut projects = BTreeMap::new();
    let mut threads = BTreeMap::new();
    for project in repositories
        .list_projects()
        .await
        .map_err(wrap_persistence)?
    {
        projects.insert(
            project.project_id.clone(),
            ProjectState {
                deleted_at: project.deleted_at.clone(),
            },
        );
        for thread in repositories
            .list_threads_by_project(project.project_id.clone())
            .await
            .map_err(wrap_persistence)?
        {
            threads.insert(
                thread.thread_id.clone(),
                ThreadState {
                    project_id: thread.project_id.clone(),
                    kind: thread.kind.clone(),
                    runtime_mode: thread.runtime_mode.clone(),
                    interaction_mode: thread.interaction_mode.clone(),
                    archived_at: thread.archived_at.clone(),
                    deleted_at: thread.deleted_at.clone(),
                },
            );
        }
    }
    Ok(CommandModel { projects, threads })
}

async fn current_max_sequence(repositories: &Repositories) -> Result<i64, OrchestrationError> {
    let events = repositories
        .read_events_from_sequence(0, 1_000)
        .await
        .map_err(wrap_persistence)?;
    Ok(events.last().map(|event| event.sequence).unwrap_or(0))
}

async fn current_timestamp(database: &Database) -> Result<String, OrchestrationError> {
    database
        .clone()
        .call(|connection| {
            connection
                .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                    row.get(0)
                })
                .map_err(Into::into)
        })
        .await
        .map_err(wrap_persistence)
}

async fn rebuild_all_thread_derived_fields(database: &Database) -> Result<(), OrchestrationError> {
    let database = database.clone();
    database
        .call(|connection| {
            let thread_ids = {
                let mut statement = connection
                    .prepare("SELECT thread_id FROM projection_threads ORDER BY thread_id ASC")?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let transaction = connection.transaction()?;
            for thread_id in thread_ids {
                rebuild_thread_derived_fields_tx(&transaction, &thread_id)?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await
        .map_err(wrap_persistence)
}

fn apply_projector_tx(
    transaction: &Transaction<'_>,
    projector: &str,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    match projector {
        "projection.projects" => apply_projects_projector_tx(transaction, event),
        "projection.thread-messages" => apply_messages_projector_tx(transaction, event),
        "projection.thread-proposed-plans" => apply_plans_projector_tx(transaction, event),
        "projection.thread-activities" => apply_activities_projector_tx(transaction, event),
        "projection.thread-sessions" => apply_sessions_projector_tx(transaction, event),
        "projection.thread-turns" => apply_turns_projector_tx(transaction, event),
        "projection.checkpoints" => apply_checkpoints_projector_tx(transaction, event),
        "projection.pending-approvals" => apply_pending_approvals_projector_tx(transaction, event),
        "projection.threads" => apply_threads_projector_tx(transaction, event),
        _ => Ok(()),
    }
}

fn apply_projects_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    let payload = &event.event.payload;
    match event.event.event_type.as_str() {
        "project.created" => {
            transaction.execute(
        "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL) \
         ON CONFLICT (project_id) DO UPDATE SET \
           title = excluded.title, workspace_root = excluded.workspace_root, \
           default_model_selection_json = excluded.default_model_selection_json, scripts_json = excluded.scripts_json, \
           created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
        params![
            required_str(payload, "projectId")?,
            required_str(payload, "title")?,
            required_str(payload, "workspaceRoot")?,
            optional_json_string(payload.get("defaultModelSelection"))?,
            {
                let scripts = payload
                    .get("scripts")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new()));
                json_string(&scripts)?
            },
            required_str(payload, "createdAt")?,
            required_str(payload, "updatedAt")?,
        ],
    )?;
        }
        "project.meta-updated" => {
            transaction.execute(
            "UPDATE projection_projects SET title = COALESCE(?, title), workspace_root = COALESCE(?, workspace_root), default_model_selection_json = CASE WHEN ? THEN ? ELSE default_model_selection_json END, scripts_json = COALESCE(?, scripts_json), updated_at = ? WHERE project_id = ?",
            params![
                optional_string(payload.get("title")),
                optional_string(payload.get("workspaceRoot")),
                payload.get("defaultModelSelection").is_some(),
                optional_json_string(payload.get("defaultModelSelection"))?,
                payload.get("scripts").map(json_string).transpose()?,
                required_str(payload, "updatedAt")?,
                required_str(payload, "projectId")?,
            ],
        )?;
        }
        "project.deleted" => {
            transaction.execute("UPDATE projection_projects SET deleted_at = ?, updated_at = ? WHERE project_id = ?", params![required_str(payload, "deletedAt")?, required_str(payload, "deletedAt")?, required_str(payload, "projectId")?])?;
        }
        _ => {}
    }
    Ok(())
}

fn apply_threads_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type == "thread.created" {
        let payload = &event.event.payload;
        transaction.execute(
            "INSERT INTO projection_threads (thread_id, project_id, title, kind, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at, latest_user_message_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan, deleted_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 0, 0, 0, NULL) \
             ON CONFLICT (thread_id) DO UPDATE SET \
               project_id = excluded.project_id, title = excluded.title, kind = excluded.kind, \
               model_selection_json = excluded.model_selection_json, runtime_mode = excluded.runtime_mode, \
               interaction_mode = excluded.interaction_mode, branch = excluded.branch, worktree_path = excluded.worktree_path, \
               created_at = excluded.created_at, updated_at = excluded.updated_at, archived_at = excluded.archived_at, \
               latest_user_message_at = excluded.latest_user_message_at, pending_approval_count = excluded.pending_approval_count, \
               pending_user_input_count = excluded.pending_user_input_count, has_actionable_proposed_plan = excluded.has_actionable_proposed_plan, deleted_at = excluded.deleted_at",
            params![
                required_str(payload, "threadId")?,
                required_str(payload, "projectId")?,
                required_str(payload, "title")?,
                payload.get("kind").and_then(Value::as_str).unwrap_or("workspace"),
                {
                    let model_selection = payload
                        .get("modelSelection")
                        .cloned()
                        .unwrap_or(Value::Null);
                    json_string(&model_selection)?
                },
                required_str(payload, "runtimeMode")?,
                required_str(payload, "interactionMode")?,
                optional_string(payload.get("branch")),
                optional_string(payload.get("worktreePath")),
                required_str(payload, "createdAt")?,
                required_str(payload, "updatedAt")?,
            ],
        )?;
    } else {
        let payload = &event.event.payload;
        match event.event.event_type.as_str() {
            "thread.deleted" => {
                transaction.execute("UPDATE projection_threads SET deleted_at = ?, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"deletedAt")?, required_str(payload,"deletedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.archived" => {
                transaction.execute("UPDATE projection_threads SET archived_at = ?, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"archivedAt")?, required_str(payload,"updatedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.unarchived" => {
                transaction.execute("UPDATE projection_threads SET archived_at = NULL, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"updatedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.meta-updated" => {
                transaction.execute("UPDATE projection_threads SET title = COALESCE(?, title), model_selection_json = COALESCE(?, model_selection_json), branch = CASE WHEN ? THEN ? ELSE branch END, worktree_path = CASE WHEN ? THEN ? ELSE worktree_path END, updated_at = ? WHERE thread_id = ?", params![optional_string(payload.get("title")), payload.get("modelSelection").map(json_string).transpose()?, payload.get("branch").is_some(), optional_string(payload.get("branch")), payload.get("worktreePath").is_some(), optional_string(payload.get("worktreePath")), required_str(payload,"updatedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.runtime-mode-set" => {
                transaction.execute("UPDATE projection_threads SET runtime_mode = ?, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"runtimeMode")?, required_str(payload,"updatedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.interaction-mode-set" => {
                transaction.execute("UPDATE projection_threads SET interaction_mode = ?, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"interactionMode")?, required_str(payload,"updatedAt")?, required_str(payload,"threadId")?])?;
            }
            "thread.session-set" => {
                transaction.execute("UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?", params![optional_string(payload.pointer("/session/activeTurnId")), event.event.occurred_at, required_str(payload,"threadId")?])?;
            }
            "thread.turn-diff-completed" => {
                transaction.execute("UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?", params![required_str(payload,"turnId")?, event.event.occurred_at, required_str(payload,"threadId")?])?;
            }
            _ if event.event.aggregate_kind == "thread" => {
                transaction.execute(
                    "UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?",
                    params![event.event.occurred_at, event.event.aggregate_id],
                )?;
            }
            _ => {}
        }
    }
    if event.event.aggregate_kind == "thread" {
        rebuild_thread_derived_fields_tx(transaction, &event.event.aggregate_id)?;
    }
    Ok(())
}

fn apply_messages_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type == "thread.reverted" {
        transaction.execute(
            "DELETE FROM projection_thread_messages WHERE thread_id = ? AND turn_id IN (SELECT json_extract(payload_json, '$.turnId') FROM orchestration_events WHERE event_type = 'thread.turn-diff-completed' AND stream_id = ? AND CAST(json_extract(payload_json, '$.checkpointTurnCount') AS INTEGER) > ?)",
            params![required_str(&event.event.payload, "threadId")?, required_str(&event.event.payload, "threadId")?, required_i64(&event.event.payload, "turnCount")?],
        )?;
        return Ok(());
    }
    if event.event.event_type != "thread.message-sent" {
        return Ok(());
    }
    let payload = &event.event.payload;
    transaction.execute(
        "INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (message_id) DO UPDATE SET \
           thread_id = excluded.thread_id, turn_id = excluded.turn_id, role = excluded.role, \
           text = CASE WHEN excluded.is_streaming = 1 THEN projection_thread_messages.text || excluded.text WHEN excluded.text = '' THEN projection_thread_messages.text ELSE excluded.text END, \
           attachments_json = COALESCE(excluded.attachments_json, projection_thread_messages.attachments_json), \
           is_streaming = excluded.is_streaming, updated_at = excluded.updated_at",
        params![
            required_str(payload, "messageId")?,
            required_str(payload, "threadId")?,
            optional_string(payload.get("turnId")),
            required_str(payload, "role")?,
            required_str(payload, "text")?,
            payload.get("attachments").map(json_string).transpose()?,
            payload.get("streaming").and_then(Value::as_bool).unwrap_or(false),
            required_str(payload, "createdAt")?,
            required_str(payload, "updatedAt")?,
        ],
    )?;
    Ok(())
}

fn apply_plans_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type == "thread.reverted" {
        transaction.execute("DELETE FROM projection_thread_proposed_plans WHERE thread_id = ? AND turn_id IN (SELECT json_extract(payload_json, '$.turnId') FROM orchestration_events WHERE event_type = 'thread.turn-diff-completed' AND stream_id = ? AND CAST(json_extract(payload_json, '$.checkpointTurnCount') AS INTEGER) > ?)", params![required_str(&event.event.payload,"threadId")?, required_str(&event.event.payload,"threadId")?, required_i64(&event.event.payload,"turnCount")?])?;
        return Ok(());
    }
    if event.event.event_type != "thread.proposed-plan-upserted" {
        return Ok(());
    }
    let payload = &event.event.payload;
    let plan = payload
        .get("proposedPlan")
        .ok_or_else(|| PersistenceError::Corrupt("missing proposedPlan payload".to_owned()))?;
    transaction.execute(
        "INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, implemented_at, implementation_thread_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (plan_id) DO UPDATE SET \
           thread_id = excluded.thread_id, turn_id = excluded.turn_id, plan_markdown = excluded.plan_markdown, \
           implemented_at = excluded.implemented_at, implementation_thread_id = excluded.implementation_thread_id, \
           created_at = excluded.created_at, updated_at = excluded.updated_at",
        params![
            required_str(plan, "id")?,
            required_str(payload, "threadId")?,
            optional_string(plan.get("turnId")),
            required_str(plan, "planMarkdown")?,
            optional_string(plan.get("implementedAt")),
            optional_string(plan.get("implementationThreadId")),
            required_str(plan, "createdAt")?,
            required_str(plan, "updatedAt")?,
        ],
    )?;
    Ok(())
}

fn apply_activities_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type == "thread.reverted" {
        transaction.execute("DELETE FROM projection_thread_activities WHERE thread_id = ? AND turn_id IN (SELECT json_extract(payload_json, '$.turnId') FROM orchestration_events WHERE event_type = 'thread.turn-diff-completed' AND stream_id = ? AND CAST(json_extract(payload_json, '$.checkpointTurnCount') AS INTEGER) > ?)", params![required_str(&event.event.payload,"threadId")?, required_str(&event.event.payload,"threadId")?, required_i64(&event.event.payload,"turnCount")?])?;
        return Ok(());
    }
    if event.event.event_type != "thread.activity-appended" {
        return Ok(());
    }
    let payload = &event.event.payload;
    let activity = payload
        .get("activity")
        .ok_or_else(|| PersistenceError::Corrupt("missing activity payload".to_owned()))?;
    transaction.execute(
        "INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (activity_id) DO UPDATE SET \
           thread_id = excluded.thread_id, turn_id = excluded.turn_id, tone = excluded.tone, kind = excluded.kind, \
           summary = excluded.summary, payload_json = excluded.payload_json, sequence = excluded.sequence, created_at = excluded.created_at",
        params![
            required_str(activity, "id")?,
            required_str(payload, "threadId")?,
            optional_string(activity.get("turnId")),
            required_str(activity, "tone")?,
            required_str(activity, "kind")?,
            required_str(activity, "summary")?,
            {
                let activity_payload = activity.get("payload").cloned().unwrap_or(Value::Null);
                json_string(&activity_payload)?
            },
            activity.get("sequence").and_then(Value::as_i64).unwrap_or(event.sequence),
            required_str(activity, "createdAt")?,
        ],
    )?;
    Ok(())
}

fn apply_sessions_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type != "thread.session-set" {
        return Ok(());
    }
    let payload = &event.event.payload;
    let session = payload
        .get("session")
        .ok_or_else(|| PersistenceError::Corrupt("missing session payload".to_owned()))?;
    transaction.execute(
        "INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (thread_id) DO UPDATE SET \
           status = excluded.status, provider_name = excluded.provider_name, provider_instance_id = excluded.provider_instance_id, \
           runtime_mode = excluded.runtime_mode, active_turn_id = excluded.active_turn_id, last_error = excluded.last_error, updated_at = excluded.updated_at",
        params![
            required_str(payload, "threadId")?,
            required_str(session, "status")?,
            optional_string(session.get("providerName")),
            optional_string(session.get("providerInstanceId")),
            session.get("runtimeMode").and_then(Value::as_str).unwrap_or("full-access"),
            optional_string(session.get("activeTurnId")),
            optional_string(session.get("lastError")),
            required_str(session, "updatedAt")?,
        ],
    )?;
    Ok(())
}

fn apply_turns_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    let payload = &event.event.payload;
    match event.event.event_type.as_str() {
        "thread.turn-start-requested" => {
            let thread_id = required_str(payload, "threadId")?;
            transaction.execute(
                "DELETE FROM projection_turns WHERE thread_id = ? AND turn_id IS NULL",
                [&thread_id],
            )?;
            transaction.execute("INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json) VALUES (?, NULL, ?, ?, ?, NULL, 'running', ?, NULL, NULL, NULL, NULL, NULL, '[]')", params![thread_id, required_str(payload,"messageId")?, optional_string(payload.pointer("/sourceProposedPlan/threadId")), optional_string(payload.pointer("/sourceProposedPlan/planId")), required_str(payload,"createdAt")?])?;
        }
        "thread.session-set" => {
            let session = payload
                .get("session")
                .ok_or_else(|| PersistenceError::Corrupt("missing session payload".to_owned()))?;
            let thread_id = required_str(payload, "threadId")?;
            let status = required_str(session, "status")?;
            let updated_at = required_str(session, "updatedAt")?;
            if status == "running" {
                if let Some(turn_id) = optional_string(session.get("activeTurnId")) {
                    transaction.execute("UPDATE projection_turns SET state = 'completed', completed_at = ? WHERE thread_id = ? AND turn_id IS NOT NULL AND turn_id <> ? AND state = 'running'", params![updated_at, thread_id, turn_id])?;
                    let existing_turn = transaction
                        .query_row(
                            "SELECT 1 FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                            params![thread_id, turn_id],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    let updated = if existing_turn {
                        let updated = transaction.execute("UPDATE projection_turns SET state = 'running', started_at = COALESCE(started_at, ?) WHERE thread_id = ? AND turn_id = ?", params![updated_at, thread_id, turn_id])?;
                        transaction.execute(
                            "DELETE FROM projection_turns WHERE thread_id = ? AND turn_id IS NULL",
                            [&thread_id],
                        )?;
                        updated
                    } else {
                        transaction.execute("UPDATE projection_turns SET turn_id = ?, state = 'running', started_at = COALESCE(started_at, ?) WHERE row_id = (SELECT row_id FROM projection_turns WHERE thread_id = ? AND turn_id IS NULL ORDER BY row_id DESC LIMIT 1)", params![turn_id, updated_at, thread_id])?
                    };
                    if updated == 0 {
                        transaction.execute(
                            TURN_UPSERT_SQL,
                            params![
                                thread_id,
                                turn_id,
                                Option::<String>::None,
                                Option::<String>::None,
                                Option::<String>::None,
                                Option::<String>::None,
                                "running",
                                updated_at,
                                Some(updated_at.clone()),
                                Option::<String>::None,
                                Option::<i64>::None,
                                Option::<String>::None,
                                Option::<String>::None,
                                "[]"
                            ],
                        )?;
                    }
                }
            } else {
                let state = if status == "error" {
                    "error"
                } else if status == "interrupted" {
                    "interrupted"
                } else {
                    "completed"
                };
                transaction.execute("UPDATE projection_turns SET state = ?, completed_at = ? WHERE thread_id = ? AND turn_id IS NOT NULL AND state = 'running'", params![state, updated_at, thread_id])?;
            }
        }
        "thread.message-sent" => {
            if required_str(payload, "role")? != "assistant" {
                return Ok(());
            }
            let Some(turn_id) = optional_string(payload.get("turnId")) else {
                return Ok(());
            };
            let thread_id = required_str(payload, "threadId")?;
            let running = transaction.query_row("SELECT 1 FROM projection_thread_sessions WHERE thread_id = ? AND status = 'running' AND active_turn_id = ?", params![thread_id, turn_id], |_| Ok(())).optional()?.is_some();
            let streaming = payload
                .get("streaming")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let settles = !streaming && !running;
            let updated_at = required_str(payload, "updatedAt")?;
            let created_at = required_str(payload, "createdAt")?;
            let updated = transaction.execute("UPDATE projection_turns SET assistant_message_id = ?, state = CASE WHEN ? THEN CASE WHEN state IN ('interrupted', 'error') THEN state ELSE 'completed' END ELSE state END, started_at = COALESCE(started_at, ?), completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END WHERE thread_id = ? AND turn_id = ?", params![required_str(payload,"messageId")?, settles, created_at.clone(), settles, updated_at.clone(), thread_id.clone(), turn_id.clone()])?;
            if updated == 0 {
                transaction.execute(
                    TURN_UPSERT_SQL,
                    params![
                        thread_id,
                        turn_id,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        Some(required_str(payload, "messageId")?),
                        if settles { "completed" } else { "running" },
                        created_at,
                        Some(created_at.clone()),
                        settles.then_some(updated_at),
                        Option::<i64>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        "[]"
                    ],
                )?;
            }
        }
        "thread.turn-interrupt-requested" => {
            let Some(turn_id) = optional_string(payload.get("turnId")) else {
                return Ok(());
            };
            let thread_id = required_str(payload, "threadId")?;
            let created_at = required_str(payload, "createdAt")?;
            let updated = transaction.execute("UPDATE projection_turns SET state = 'interrupted', started_at = COALESCE(started_at, ?), completed_at = COALESCE(completed_at, ?) WHERE thread_id = ? AND turn_id = ?", params![created_at.clone(), created_at.clone(), thread_id.clone(), turn_id.clone()])?;
            if updated == 0 {
                transaction.execute(
                    TURN_UPSERT_SQL,
                    params![
                        thread_id,
                        turn_id,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        "interrupted",
                        created_at,
                        Some(created_at.clone()),
                        Some(created_at.clone()),
                        Option::<i64>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        "[]"
                    ],
                )?;
            }
        }
        "thread.turn-diff-completed" => {
            let thread_id = required_str(payload, "threadId")?;
            let turn_id = required_str(payload, "turnId")?;
            let completed_at = required_str(payload, "completedAt")?;
            let running = transaction.query_row("SELECT 1 FROM projection_thread_sessions WHERE thread_id = ? AND status = 'running' AND active_turn_id = ?", params![thread_id, turn_id], |_| Ok(())).optional()?.is_some();
            let status = required_str(payload, "status")?;
            let next_state = if running {
                "running"
            } else if status == "error" {
                "error"
            } else {
                "completed"
            };
            let checkpoint_turn_count = required_i64(payload, "checkpointTurnCount")?;
            transaction.execute("UPDATE projection_turns SET checkpoint_turn_count = NULL, checkpoint_ref = NULL, checkpoint_status = NULL, checkpoint_files_json = '[]' WHERE thread_id = ? AND turn_id <> ? AND checkpoint_turn_count = ?", params![thread_id, turn_id, checkpoint_turn_count])?;
            let files = json_string(payload.get("files").unwrap_or(&Value::Array(Vec::new())))?;
            let updated = transaction.execute("UPDATE projection_turns SET assistant_message_id = ?, state = ?, started_at = COALESCE(started_at, ?), completed_at = ?, checkpoint_turn_count = ?, checkpoint_ref = ?, checkpoint_status = ?, checkpoint_files_json = ? WHERE thread_id = ? AND turn_id = ?", params![optional_string(payload.get("assistantMessageId")), next_state, completed_at, completed_at, checkpoint_turn_count, required_str(payload,"checkpointRef")?, status, files, thread_id, turn_id])?;
            if updated == 0 {
                transaction.execute(
                    TURN_UPSERT_SQL,
                    params![
                        thread_id,
                        turn_id,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        optional_string(payload.get("assistantMessageId")),
                        next_state,
                        completed_at,
                        Some(completed_at.clone()),
                        Some(completed_at.clone()),
                        Some(checkpoint_turn_count),
                        Some(required_str(payload, "checkpointRef")?),
                        Some(status),
                        files
                    ],
                )?;
            }
        }
        "thread.reverted" => {
            transaction.execute(
                "DELETE FROM projection_turns WHERE thread_id = ? AND (checkpoint_turn_count IS NULL OR checkpoint_turn_count > ?)",
                params![
                    required_str(payload, "threadId")?,
                    required_i64(payload, "turnCount")?
                ],
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn apply_checkpoints_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    if event.event.event_type != "thread.checkpoint.saved" {
        return Ok(());
    }
    let payload = &event.event.payload;
    let thread_id = required_str(payload, "threadId")?;
    let turn_id = required_str(payload, "turnId")?;
    let checkpoint_turn_count = required_i64(payload, "checkpointTurnCount")?;
    let completed_at = required_str(payload, "completedAt")?;
    transaction.execute(
        "UPDATE projection_turns SET checkpoint_turn_count = NULL, checkpoint_ref = NULL, checkpoint_status = NULL, checkpoint_files_json = '[]' \
         WHERE thread_id = ? AND checkpoint_turn_count = ?",
        params![thread_id, checkpoint_turn_count],
    )?;
    transaction.execute(
        TURN_UPSERT_SQL,
        params![
            thread_id,
            turn_id,
            Option::<String>::None,
            Option::<String>::None,
            Option::<String>::None,
            optional_string(payload.get("assistantMessageId")),
            if required_str(payload, "status")? == "error" {
                "error".to_owned()
            } else {
                "completed".to_owned()
            },
            completed_at,
            Some(completed_at.clone()),
            Some(completed_at.clone()),
            Some(checkpoint_turn_count),
            Some(required_str(payload, "checkpointRef")?),
            Some(required_str(payload, "status")?),
            {
                let checkpoint_files = payload
                    .get("files")
                    .cloned()
                    .unwrap_or_else(checkpointing::empty_files);
                json_string(&checkpoint_files)?
            },
        ],
    )?;
    let diff = required_str(payload, "diff")?;
    checkpointing::upsert_diff_blob(
        transaction,
        &thread_id,
        checkpoint_turn_count.saturating_sub(1),
        checkpoint_turn_count,
        &diff,
        &completed_at,
    )?;
    Ok(())
}

fn apply_pending_approvals_projector_tx(
    transaction: &Transaction<'_>,
    event: &OrchestrationEvent,
) -> Result<(), PersistenceError> {
    let payload = &event.event.payload;
    let (request_id, thread_id, turn_id, status, decision, created_at, resolved_at) =
        match event.event.event_type.as_str() {
            "thread.approval-response-requested" => (
                required_str(payload, "requestId")?,
                required_str(payload, "threadId")?,
                None,
                "resolved".to_owned(),
                optional_string(payload.get("decision")),
                required_str(payload, "createdAt")?,
                Some(required_str(payload, "createdAt")?),
            ),
            "thread.activity-appended" => {
                let activity = payload.get("activity").ok_or_else(|| {
                    PersistenceError::Corrupt("missing activity payload".to_owned())
                })?;
                let kind = required_str(activity, "kind")?;
                if kind != "approval.requested" && kind != "approval.resolved" {
                    return Ok(());
                }
                let request_id = activity
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        event
                            .event
                            .metadata
                            .get("requestId")
                            .and_then(Value::as_str)
                    })
                    .ok_or_else(|| {
                        PersistenceError::Corrupt("approval activity missing requestId".to_owned())
                    })?
                    .to_owned();
                let created_at = required_str(activity, "createdAt")?;
                let resolved = kind == "approval.resolved";
                (
                    request_id,
                    required_str(payload, "threadId")?,
                    optional_string(activity.get("turnId")),
                    if resolved { "resolved" } else { "pending" }.to_owned(),
                    if resolved {
                        optional_string(activity.pointer("/payload/decision"))
                    } else {
                        None
                    },
                    created_at.clone(),
                    resolved.then_some(created_at),
                )
            }
            _ => return Ok(()),
        };
    let existing = transaction
        .query_row(
            "SELECT thread_id, turn_id, status, created_at FROM projection_pending_approvals WHERE request_id = ?",
            [&request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )
        .optional()?;
    if status == "pending" && existing.as_ref().is_some_and(|row| row.2 == "resolved") {
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, decision, created_at, resolved_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (request_id) DO UPDATE SET \
           thread_id = excluded.thread_id, turn_id = excluded.turn_id, status = excluded.status, decision = excluded.decision, \
           created_at = excluded.created_at, resolved_at = excluded.resolved_at",
        params![
            request_id,
            existing.as_ref().map_or(thread_id, |row| row.0.clone()),
            existing.as_ref().and_then(|row| row.1.clone()).or(turn_id),
            status,
            decision,
            existing.as_ref().map_or(created_at, |row| row.3.clone()),
            resolved_at,
        ],
    )?;
    Ok(())
}

fn rebuild_thread_derived_fields_tx(
    transaction: &Transaction<'_>,
    thread_id: &str,
) -> Result<(), PersistenceError> {
    let latest_turn_id = transaction
        .query_row(
            "SELECT turn_id FROM projection_turns WHERE thread_id = ? AND turn_id IS NOT NULL ORDER BY requested_at DESC, turn_id DESC LIMIT 1",
            [thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let latest_user_message_at = transaction
        .query_row(
            "SELECT created_at FROM projection_thread_messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC, message_id DESC LIMIT 1",
            [thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let pending_approval_count = transaction.query_row(
        "SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ? AND status = 'pending'",
        [thread_id],
        |row| row.get::<_, i64>(0),
    )?;
    let has_actionable_proposed_plan = transaction.query_row(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM projection_thread_proposed_plans WHERE thread_id = ? AND implemented_at IS NULL) THEN 1 ELSE 0 END",
        [thread_id],
        |row| row.get::<_, i64>(0),
    )?;
    let session_updated_at = transaction
        .query_row(
            "SELECT updated_at FROM projection_thread_sessions WHERE thread_id = ? LIMIT 1",
            [thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let latest_turn_updated_at = transaction
        .query_row(
            "SELECT COALESCE(completed_at, started_at, requested_at) FROM projection_turns WHERE thread_id = ? ORDER BY requested_at DESC, turn_id DESC LIMIT 1",
            [thread_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let updated_at = session_updated_at
        .or(latest_turn_updated_at)
        .or_else(|| latest_user_message_at.clone());
    transaction.execute(
        "UPDATE projection_threads SET latest_turn_id = ?, latest_user_message_at = ?, pending_approval_count = ?, pending_user_input_count = 0, has_actionable_proposed_plan = ?, updated_at = COALESCE(?, updated_at) WHERE thread_id = ?",
        params![
            latest_turn_id,
            latest_user_message_at,
            pending_approval_count,
            has_actionable_proposed_plan,
            updated_at,
            thread_id,
        ],
    )?;
    Ok(())
}

fn append_event_tx(
    transaction: &Transaction<'_>,
    event: NewOrchestrationEvent,
) -> Result<OrchestrationEvent, PersistenceError> {
    Ok(transaction.query_row(
        "INSERT INTO orchestration_events ( \
           event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, \
           command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json \
         ) VALUES (?, ?, ?, COALESCE(( \
           SELECT stream_version + 1 FROM orchestration_events \
           WHERE aggregate_kind = ? AND stream_id = ? \
           ORDER BY stream_version DESC LIMIT 1 \
         ), 0), ?, ?, ?, ?, ?, ?, ?, ?) \
         RETURNING sequence, event_id, event_type, aggregate_kind, stream_id, occurred_at, \
           command_id, causation_event_id, correlation_id, payload_json, metadata_json",
        params![
            event.event_id,
            event.aggregate_kind,
            event.aggregate_id,
            event.aggregate_kind,
            event.aggregate_id,
            event.event_type,
            event.occurred_at,
            event.command_id,
            event.causation_event_id,
            event.correlation_id,
            infer_actor_kind(&event),
            json_string(&event.payload)?,
            json_string(&event.metadata)?,
        ],
        decode_event_row,
    )?)
}

fn upsert_command_receipt_tx(
    transaction: &Transaction<'_>,
    receipt: CommandReceipt,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (command_id) DO UPDATE SET \
           aggregate_kind = excluded.aggregate_kind, aggregate_id = excluded.aggregate_id, accepted_at = excluded.accepted_at, \
           result_sequence = excluded.result_sequence, status = excluded.status, error = excluded.error",
        params![
            receipt.command_id,
            receipt.aggregate_kind,
            receipt.aggregate_id,
            receipt.accepted_at,
            receipt.result_sequence,
            receipt.status,
            receipt.error
        ],
    )?;
    Ok(())
}

fn upsert_projection_state_tx(
    transaction: &Transaction<'_>,
    projector: &str,
    sequence: i64,
    updated_at: &str,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence, updated_at = excluded.updated_at",
        params![projector, sequence, updated_at],
    )?;
    Ok(())
}

fn infer_actor_kind(event: &NewOrchestrationEvent) -> &'static str {
    match event.command_id.as_deref() {
        Some(command_id) if command_id.starts_with("provider:") => "provider",
        Some(command_id) if command_id.starts_with("server:") => "server",
        Some(_) => "client",
        None if event.metadata.get("providerTurnId").is_some()
            || event.metadata.get("providerItemId").is_some()
            || event.metadata.get("adapterKey").is_some() =>
        {
            "provider"
        }
        None => "server",
    }
}

fn decode_event_row(row: &Row<'_>) -> rusqlite::Result<OrchestrationEvent> {
    Ok(OrchestrationEvent {
        sequence: row.get(0)?,
        event: NewOrchestrationEvent {
            event_id: row.get(1)?,
            event_type: row.get(2)?,
            aggregate_kind: row.get(3)?,
            aggregate_id: row.get(4)?,
            occurred_at: row.get(5)?,
            command_id: row.get(6)?,
            causation_event_id: row.get(7)?,
            correlation_id: row.get(8)?,
            payload: serde_json::from_str(&row.get::<_, String>(9)?).map_err(to_sql_error)?,
            metadata: serde_json::from_str(&row.get::<_, String>(10)?).map_err(to_sql_error)?,
        },
    })
}

fn json_string(value: &Value) -> Result<String, PersistenceError> {
    serde_json::to_string(value).map_err(to_corrupt_error)
}

fn optional_json_string(value: Option<&Value>) -> Result<Option<String>, PersistenceError> {
    value.map(json_string).transpose()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn required_str(payload: &Value, key: &str) -> Result<String, PersistenceError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| PersistenceError::Corrupt(format!("missing string payload field '{key}'")))
}

fn required_i64(payload: &Value, key: &str) -> Result<i64, PersistenceError> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| PersistenceError::Corrupt(format!("missing integer payload field '{key}'")))
}

fn to_corrupt_error(error: serde_json::Error) -> PersistenceError {
    PersistenceError::Corrupt(format!("could not encode JSON for SQLite TEXT: {error}"))
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn wrap_persistence(error: PersistenceError) -> OrchestrationError {
    if let PersistenceError::Corrupt(detail) = &error
        && let Some((projector, event_type)) = decode_projector_failure(detail)
    {
        return OrchestrationError::InjectedProjectorFailure {
            projector,
            event_type,
        };
    }
    OrchestrationError::Persistence(Arc::new(error))
}

fn projector_failure_to_persistence(error: OrchestrationError) -> PersistenceError {
    match error {
        OrchestrationError::InjectedProjectorFailure {
            projector,
            event_type,
        } => PersistenceError::Corrupt(format!("__projector_failure__:{projector}:{event_type}")),
        other => PersistenceError::Corrupt(other.to_string()),
    }
}

fn decode_projector_failure(detail: &str) -> Option<(String, String)> {
    let prefix = "__projector_failure__:";
    let remainder = detail.strip_prefix(prefix)?;
    let (projector, event_type) = remainder.split_once(':')?;
    Some((projector.to_owned(), event_type.to_owned()))
}

fn make_event(
    event_type: &str,
    aggregate_kind: &str,
    aggregate_id: &str,
    occurred_at: &str,
    command_id: &str,
    metadata: Value,
    payload: Value,
) -> NewOrchestrationEvent {
    NewOrchestrationEvent {
        event_id: Uuid::new_v4().to_string(),
        event_type: event_type.to_owned(),
        aggregate_kind: aggregate_kind.to_owned(),
        aggregate_id: aggregate_id.to_owned(),
        occurred_at: occurred_at.to_owned(),
        command_id: Some(command_id.to_owned()),
        causation_event_id: None,
        correlation_id: Some(command_id.to_owned()),
        payload,
        metadata,
    }
}

impl OrchestrationCommand {
    pub fn command_type(&self) -> &'static str {
        match self {
            Self::ProjectCreate { .. } => "project.create",
            Self::ProjectMetaUpdate { .. } => "project.meta.update",
            Self::ProjectDelete { .. } => "project.delete",
            Self::ThreadCreate { .. } => "thread.create",
            Self::ThreadDelete { .. } => "thread.delete",
            Self::ThreadArchive { .. } => "thread.archive",
            Self::ThreadUnarchive { .. } => "thread.unarchive",
            Self::ThreadMetaUpdate { .. } => "thread.meta.update",
            Self::ThreadRuntimeModeSet { .. } => "thread.runtime-mode.set",
            Self::ThreadInteractionModeSet { .. } => "thread.interaction-mode.set",
            Self::ThreadTurnStart { .. } => "thread.turn.start",
            Self::ThreadTurnInterrupt { .. } => "thread.turn.interrupt",
            Self::ThreadApprovalRespond { .. } => "thread.approval.respond",
            Self::ThreadUserInputRespond { .. } => "thread.user-input.respond",
            Self::ThreadCheckpointRevert { .. } => "thread.checkpoint.revert",
            Self::ThreadSessionStop { .. } => "thread.session.stop",
            Self::ThreadSessionSet { .. } => "thread.session.set",
            Self::ThreadMessageAssistantDelta { .. } => "thread.message.assistant.delta",
            Self::ThreadMessageAssistantComplete { .. } => "thread.message.assistant.complete",
            Self::ThreadProposedPlanUpsert { .. } => "thread.proposed-plan.upsert",
            Self::ThreadTurnDiffComplete { .. } => "thread.turn.diff.complete",
            Self::ThreadActivityAppend { .. } => "thread.activity.append",
            Self::ThreadRevertComplete { .. } => "thread.revert.complete",
        }
    }

    pub fn command_id(&self) -> &str {
        match self {
            Self::ProjectCreate { command_id, .. }
            | Self::ProjectMetaUpdate { command_id, .. }
            | Self::ProjectDelete { command_id, .. }
            | Self::ThreadCreate { command_id, .. }
            | Self::ThreadDelete { command_id, .. }
            | Self::ThreadArchive { command_id, .. }
            | Self::ThreadUnarchive { command_id, .. }
            | Self::ThreadMetaUpdate { command_id, .. }
            | Self::ThreadRuntimeModeSet { command_id, .. }
            | Self::ThreadInteractionModeSet { command_id, .. }
            | Self::ThreadTurnStart { command_id, .. }
            | Self::ThreadTurnInterrupt { command_id, .. }
            | Self::ThreadApprovalRespond { command_id, .. }
            | Self::ThreadUserInputRespond { command_id, .. }
            | Self::ThreadCheckpointRevert { command_id, .. }
            | Self::ThreadSessionStop { command_id, .. }
            | Self::ThreadSessionSet { command_id, .. }
            | Self::ThreadMessageAssistantDelta { command_id, .. }
            | Self::ThreadMessageAssistantComplete { command_id, .. }
            | Self::ThreadProposedPlanUpsert { command_id, .. }
            | Self::ThreadTurnDiffComplete { command_id, .. }
            | Self::ThreadActivityAppend { command_id, .. }
            | Self::ThreadRevertComplete { command_id, .. } => command_id,
        }
    }

    pub fn occurred_at(&self) -> Option<&str> {
        match self {
            Self::ProjectMetaUpdate { .. }
            | Self::ProjectDelete { .. }
            | Self::ThreadDelete { .. }
            | Self::ThreadArchive { .. }
            | Self::ThreadUnarchive { .. }
            | Self::ThreadMetaUpdate { .. } => None,
            Self::ProjectCreate { created_at, .. }
            | Self::ThreadCreate { created_at, .. }
            | Self::ThreadRuntimeModeSet { created_at, .. }
            | Self::ThreadInteractionModeSet { created_at, .. }
            | Self::ThreadTurnStart { created_at, .. }
            | Self::ThreadTurnInterrupt { created_at, .. }
            | Self::ThreadApprovalRespond { created_at, .. }
            | Self::ThreadUserInputRespond { created_at, .. }
            | Self::ThreadCheckpointRevert { created_at, .. }
            | Self::ThreadSessionStop { created_at, .. }
            | Self::ThreadSessionSet { created_at, .. }
            | Self::ThreadMessageAssistantDelta { created_at, .. }
            | Self::ThreadMessageAssistantComplete { created_at, .. }
            | Self::ThreadProposedPlanUpsert { created_at, .. }
            | Self::ThreadTurnDiffComplete { created_at, .. }
            | Self::ThreadActivityAppend { created_at, .. }
            | Self::ThreadRevertComplete { created_at, .. } => Some(created_at),
        }
    }

    pub fn aggregate_ref(&self) -> (&str, &str) {
        match self {
            Self::ProjectCreate { project_id, .. } => ("project", project_id),
            Self::ProjectMetaUpdate { project_id, .. } | Self::ProjectDelete { project_id, .. } => {
                ("project", project_id)
            }
            Self::ThreadCreate { thread_id, .. }
            | Self::ThreadDelete { thread_id, .. }
            | Self::ThreadArchive { thread_id, .. }
            | Self::ThreadUnarchive { thread_id, .. }
            | Self::ThreadMetaUpdate { thread_id, .. }
            | Self::ThreadRuntimeModeSet { thread_id, .. }
            | Self::ThreadInteractionModeSet { thread_id, .. }
            | Self::ThreadTurnStart { thread_id, .. }
            | Self::ThreadTurnInterrupt { thread_id, .. }
            | Self::ThreadApprovalRespond { thread_id, .. }
            | Self::ThreadUserInputRespond { thread_id, .. }
            | Self::ThreadCheckpointRevert { thread_id, .. }
            | Self::ThreadSessionStop { thread_id, .. }
            | Self::ThreadSessionSet { thread_id, .. }
            | Self::ThreadMessageAssistantDelta { thread_id, .. }
            | Self::ThreadMessageAssistantComplete { thread_id, .. }
            | Self::ThreadProposedPlanUpsert { thread_id, .. }
            | Self::ThreadTurnDiffComplete { thread_id, .. }
            | Self::ThreadActivityAppend { thread_id, .. }
            | Self::ThreadRevertComplete { thread_id, .. } => ("thread", thread_id),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub projects: Vec<ProjectionProject>,
    pub threads: Vec<ProjectionThread>,
    pub messages: Vec<ProjectionThreadMessage>,
    pub activities: Vec<ProjectionThreadActivity>,
    pub sessions: Vec<ProjectionThreadSession>,
    pub approvals: Vec<ProjectionPendingApproval>,
    pub proposed_plans: Vec<ProjectionThreadProposedPlan>,
    pub turns: Vec<ProjectionTurn>,
    pub checkpoints: Vec<ProjectionCheckpointRow>,
    pub states: Vec<ProjectionState>,
    pub receipts: Vec<CommandReceipt>,
    pub diffs: Vec<CheckpointDiffBlob>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectionCheckpointRow {
    pub thread_id: String,
    pub turn_id: String,
    pub checkpoint_turn_count: i64,
    pub checkpoint_ref: String,
    pub status: String,
    pub files: Value,
    pub assistant_message_id: Option<String>,
    pub completed_at: String,
}

pub async fn load_snapshot(repositories: &Repositories) -> Result<Snapshot, OrchestrationError> {
    let projects = repositories
        .list_projects()
        .await
        .map_err(wrap_persistence)?;
    let mut threads = Vec::new();
    let mut messages = Vec::new();
    let mut activities = Vec::new();
    let mut sessions = Vec::new();
    let mut approvals = Vec::new();
    let mut proposed_plans = Vec::new();
    let mut turns = Vec::new();
    let mut checkpoints = Vec::new();
    let mut seen_threads = Vec::new();
    for project in &projects {
        for thread in repositories
            .list_threads_by_project(project.project_id.clone())
            .await
            .map_err(wrap_persistence)?
        {
            seen_threads.push(thread.thread_id.clone());
            messages.extend(
                repositories
                    .list_messages_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?,
            );
            activities.extend(
                repositories
                    .list_activities_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?,
            );
            if let Some(session) = repositories
                .get_thread_session(thread.thread_id.clone())
                .await
                .map_err(wrap_persistence)?
            {
                sessions.push(session);
            }
            approvals.extend(
                repositories
                    .list_pending_approvals_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?,
            );
            proposed_plans.extend(
                repositories
                    .list_proposed_plans_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?,
            );
            turns.extend(
                repositories
                    .list_turns_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?,
            );
            checkpoints.extend(
                repositories
                    .list_checkpoints_by_thread(thread.thread_id.clone())
                    .await
                    .map_err(wrap_persistence)?
                    .into_iter()
                    .map(|checkpoint| ProjectionCheckpointRow {
                        thread_id: checkpoint.thread_id,
                        turn_id: checkpoint.turn_id,
                        checkpoint_turn_count: checkpoint.checkpoint_turn_count,
                        checkpoint_ref: checkpoint.checkpoint_ref,
                        status: checkpoint.status,
                        files: checkpoint.files,
                        assistant_message_id: checkpoint.assistant_message_id,
                        completed_at: checkpoint.completed_at,
                    }),
            );
            threads.push(thread);
        }
    }
    let states = repositories
        .list_projection_states()
        .await
        .map_err(wrap_persistence)?;
    let receipts = list_receipts(repositories.database()).await?;
    let diffs = list_diffs(repositories.database()).await?;
    threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    messages.sort_by(|left, right| left.message_id.cmp(&right.message_id));
    activities.sort_by(|left, right| left.activity_id.cmp(&right.activity_id));
    sessions.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    approvals.sort_by(|left, right| left.request_id.cmp(&right.request_id));
    proposed_plans.sort_by(|left, right| left.plan_id.cmp(&right.plan_id));
    turns.sort_by(|left, right| {
        left.thread_id
            .cmp(&right.thread_id)
            .then_with(|| left.turn_id.cmp(&right.turn_id))
    });
    checkpoints.sort_by(|left, right| {
        left.thread_id
            .cmp(&right.thread_id)
            .then_with(|| left.checkpoint_turn_count.cmp(&right.checkpoint_turn_count))
    });
    Ok(Snapshot {
        projects,
        threads,
        messages,
        activities,
        sessions,
        approvals,
        proposed_plans,
        turns,
        checkpoints,
        states,
        receipts,
        diffs,
    })
}

async fn list_receipts(database: &Database) -> Result<Vec<CommandReceipt>, OrchestrationError> {
    database
        .clone()
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error \
                 FROM orchestration_command_receipts ORDER BY accepted_at ASC, command_id ASC",
            )?;
            statement
                .query_map([], |row| {
                    Ok(CommandReceipt {
                        command_id: row.get(0)?,
                        aggregate_kind: row.get(1)?,
                        aggregate_id: row.get(2)?,
                        accepted_at: row.get(3)?,
                        result_sequence: row.get(4)?,
                        status: row.get(5)?,
                        error: row.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .await
        .map_err(wrap_persistence)
}

async fn list_diffs(database: &Database) -> Result<Vec<CheckpointDiffBlob>, OrchestrationError> {
    database
        .clone()
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT thread_id, from_turn_count, to_turn_count, diff, created_at FROM checkpoint_diff_blobs ORDER BY thread_id ASC, to_turn_count ASC",
            )?;
            statement
                .query_map([], |row| {
                    Ok(CheckpointDiffBlob {
                        thread_id: row.get(0)?,
                        from_turn_count: row.get(1)?,
                        to_turn_count: row.get(2)?,
                        diff: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
        })
        .await
        .map_err(wrap_persistence)
}

#[cfg(test)]
mod tests {
    use crate::persistence::run_migrations;

    use super::*;

    struct NoopBootstrapEffects;

    impl ThreadTurnBootstrapEffects for NoopBootstrapEffects {
        fn prepare_worktree<'a>(
            &'a self,
            input: ThreadTurnStartBootstrapPrepareWorktree,
        ) -> BoxBootstrapFuture<'a, BootstrapWorktree> {
            Box::pin(async move {
                Ok(BootstrapWorktree {
                    repository_root: input.project_cwd.clone(),
                    branch: input.base_branch,
                    path: input.project_cwd,
                    remove_branch: false,
                })
            })
        }

        fn run_setup_script<'a>(
            &'a self,
            _input: BootstrapSetupInput,
        ) -> BoxBootstrapFuture<'a, BootstrapSetupResult> {
            Box::pin(async { Ok(BootstrapSetupResult::NoScript) })
        }

        fn cleanup_thread_resources<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> BoxBootstrapFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }

        fn remove_worktree<'a>(
            &'a self,
            _worktree: BootstrapWorktree,
        ) -> BoxBootstrapFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    fn projector_event(event_type: &str, payload: Value, metadata: Value) -> OrchestrationEvent {
        OrchestrationEvent {
            sequence: 99,
            event: NewOrchestrationEvent {
                event_id: Uuid::new_v4().to_string(),
                event_type: event_type.to_owned(),
                aggregate_kind: "thread".to_owned(),
                aggregate_id: "projector-thread".to_owned(),
                occurred_at: "2026-07-10T10:00:00.000Z".to_owned(),
                command_id: Some("projector-edge".to_owned()),
                causation_event_id: None,
                correlation_id: None,
                payload,
                metadata,
            },
        }
    }

    #[tokio::test]
    async fn projector_edges_reject_corrupt_payloads_and_preserve_resolved_approvals() {
        const CREATED_AT: &str = "2026-07-10T10:00:00.000Z";

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                let transaction = connection.transaction()?;

                apply_projects_projector_tx(
                    &transaction,
                    &projector_event(
                        "project.created",
                        json!({
                            "projectId":"projector-project",
                            "title":"Projector",
                            "workspaceRoot":"C:/projector",
                            "defaultModelSelection":null,
                            "createdAt":CREATED_AT,
                            "updatedAt":CREATED_AT
                        }),
                        json!({}),
                    ),
                )?;

                for error in [
                    apply_plans_projector_tx(
                        &transaction,
                        &projector_event(
                            "thread.proposed-plan-upserted",
                            json!({"threadId":"projector-thread"}),
                            json!({}),
                        ),
                    ),
                    apply_activities_projector_tx(
                        &transaction,
                        &projector_event(
                            "thread.activity-appended",
                            json!({"threadId":"projector-thread"}),
                            json!({}),
                        ),
                    ),
                    apply_sessions_projector_tx(
                        &transaction,
                        &projector_event(
                            "thread.session-set",
                            json!({"threadId":"projector-thread"}),
                            json!({}),
                        ),
                    ),
                    apply_turns_projector_tx(
                        &transaction,
                        &projector_event(
                            "thread.session-set",
                            json!({"threadId":"projector-thread"}),
                            json!({}),
                        ),
                    ),
                    apply_pending_approvals_projector_tx(
                        &transaction,
                        &projector_event(
                            "thread.activity-appended",
                            json!({"threadId":"projector-thread"}),
                            json!({}),
                        ),
                    ),
                ] {
                    assert!(matches!(error, Err(PersistenceError::Corrupt(_))));
                }

                apply_pending_approvals_projector_tx(
                    &transaction,
                    &projector_event(
                        "thread.approval-response-requested",
                        json!({
                            "requestId":"resolved-request",
                            "threadId":"projector-thread",
                            "decision":"approved",
                            "createdAt":CREATED_AT
                        }),
                        json!({}),
                    ),
                )?;
                apply_pending_approvals_projector_tx(
                    &transaction,
                    &projector_event(
                        "thread.activity-appended",
                        json!({
                            "threadId":"projector-thread",
                            "activity":{
                                "id":"approval-activity",
                                "kind":"approval.requested",
                                "createdAt":CREATED_AT,
                                "payload":{}
                            }
                        }),
                        json!({"requestId":"resolved-request"}),
                    ),
                )?;
                let status: String = transaction.query_row(
                    "SELECT status FROM projection_pending_approvals WHERE request_id = ?",
                    ["resolved-request"],
                    |row| row.get(0),
                )?;
                assert_eq!(status, "resolved");

                let missing_request_id = apply_pending_approvals_projector_tx(
                    &transaction,
                    &projector_event(
                        "thread.activity-appended",
                        json!({
                            "threadId":"projector-thread",
                            "activity":{
                                "id":"missing-request",
                                "kind":"approval.requested",
                                "createdAt":CREATED_AT,
                                "payload":{}
                            }
                        }),
                        json!({}),
                    ),
                );
                assert!(matches!(
                    missing_request_id,
                    Err(PersistenceError::Corrupt(_))
                ));

                transaction.rollback()?;
                Ok(())
            })
            .await
            .expect("projector edges execute");
    }

    #[tokio::test]
    async fn unit_build_covers_engine_projection_failure_bootstrap_and_lifecycle_paths() {
        const CREATED_AT: &str = "2026-07-10T10:00:00.000Z";

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let hooks = TestHooks::default();
        hooks.fail_next_projector("projection.projects", Some("project.created"));
        let engine = OrchestrationEngine::start(
            database,
            EngineOptions {
                queue_capacity: 0,
                test_hooks: hooks,
            },
        )
        .await
        .expect("engine starts");
        let command =
            |value| serde_json::from_value::<OrchestrationCommand>(value).expect("command decodes");

        let helper_command = command(json!({
            "type":"project.delete",
            "commandId":"helper-command",
            "projectId":"missing-project"
        }));
        let missing = OptionalNullable::<Value>::Missing;
        assert!(missing.is_missing());
        assert!(optional_nullable_is_missing(&missing));
        assert_eq!(
            required_command_string(&helper_command, &json!({"key":"value"}), "key").unwrap(),
            "value"
        );
        assert!(required_command_string(&helper_command, &json!({}), "key").is_err());
        assert!(invariant::<()>(&helper_command, "injected".to_owned()).is_err());
        let json_error = serde_json::from_str::<Value>("{").unwrap_err();
        assert!(matches!(
            to_corrupt_error(json_error),
            PersistenceError::Corrupt(_)
        ));
        let json_error = serde_json::from_str::<Value>("{").unwrap_err();
        assert!(matches!(
            to_sql_error(json_error),
            rusqlite::Error::FromSqlConversionFailure(..)
        ));
        TestHooks::default().fail_next_projector("projection.threads".to_owned(), None);

        let project = json!({
            "type":"project.create",
            "commandId":"project",
            "projectId":"p1",
            "title":"Project",
            "workspaceRoot":"C:/repo",
            "createWorkspaceRootIfMissing":true,
            "defaultModelSelection":null,
            "createdAt":CREATED_AT
        });
        assert!(matches!(
            engine.dispatch(command(project.clone())).await,
            Err(OrchestrationError::InjectedProjectorFailure { .. })
        ));
        engine
            .dispatch(command(project))
            .await
            .expect("project retry succeeds");

        let bootstrap_error = engine
            .dispatch(command(json!({
                "type":"thread.turn.start",
                "commandId":"bootstrap-turn",
                "threadId":"bootstrap-thread",
                "message":{"messageId":"bootstrap-message","role":"user","text":"build","attachments":[]},
                "bootstrap":{
                    "createThread":{
                        "projectId":"p1",
                        "title":"Bootstrap",
                        "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                        "runtimeMode":"full-access",
                        "interactionMode":"default",
                        "branch":null,
                        "worktreePath":null,
                        "createdAt":CREATED_AT
                    },
                    "prepareWorktree":{
                        "projectCwd":"C:/repo",
                        "baseBranch":"main"
                    }
                },
                "createdAt":CREATED_AT
            })))
            .await
            .expect_err("missing bootstrap effects fail closed");
        assert!(matches!(
            bootstrap_error,
            OrchestrationError::Bootstrap {
                stage: "worktree preparation",
                ..
            }
        ));

        let commands = [
            json!({"type":"project.meta.update","commandId":"project-meta","projectId":"p1","title":"Renamed","workspaceRoot":"C:/repo-renamed","defaultModelSelection":{"instanceId":"codex","model":"gpt-5"}}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t1","projectId":"p1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":CREATED_AT}),
            json!({"type":"thread.meta.update","commandId":"thread-meta","threadId":"t1","title":"Thread 2","branch":"main","worktreePath":null}),
            json!({"type":"thread.runtime-mode.set","commandId":"runtime-mode","threadId":"t1","runtimeMode":"approval-required","createdAt":CREATED_AT}),
            json!({"type":"thread.interaction-mode.set","commandId":"interaction-mode","threadId":"t1","interactionMode":"plan","createdAt":CREATED_AT}),
            json!({"type":"thread.turn.start","commandId":"turn-start","threadId":"t1","message":{"messageId":"m-user","role":"user","text":"hello","attachments":[]},"titleSeed":"Coverage title","createdAt":CREATED_AT}),
            json!({"type":"thread.session.set","commandId":"session","threadId":"t1","session":{"threadId":"t1","status":"running","providerName":"codex","providerInstanceId":"codex","runtimeMode":"approval-required","activeTurnId":"turn-1","lastError":null,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.message.assistant.delta","commandId":"delta","threadId":"t1","messageId":"m-assistant","delta":"hello","turnId":"turn-1","createdAt":CREATED_AT}),
            json!({"type":"thread.proposed-plan.upsert","commandId":"plan","threadId":"t1","proposedPlan":{"id":"plan-1","turnId":"turn-1","planMarkdown":"Do it","createdAt":CREATED_AT,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.activity.append","commandId":"activity","threadId":"t1","activity":{"id":"activity-1","tone":"tool","kind":"command","summary":"ran","payload":{"requestId":"request-1"},"turnId":"turn-1","createdAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.turn.diff.complete","commandId":"diff","threadId":"t1","turnId":"turn-1","completedAt":CREATED_AT,"checkpointRef":"checkpoint-1","status":"ready","files":[{"path":"a.rs","kind":"modified","additions":2,"deletions":1}],"assistantMessageId":"m-assistant","checkpointTurnCount":1,"createdAt":CREATED_AT}),
            json!({"type":"thread.message.assistant.complete","commandId":"complete","threadId":"t1","messageId":"m-assistant","turnId":"turn-1","createdAt":CREATED_AT}),
        ];
        for value in commands {
            engine
                .dispatch(command(value))
                .await
                .expect("command succeeds");
        }

        assert!(matches!(
            engine
                .dispatch(command(json!({
                    "type":"project.delete",
                    "commandId":"project-delete-not-empty",
                    "projectId":"p1"
                })))
                .await,
            Err(OrchestrationError::Invariant { .. })
        ));
        assert!(matches!(
            engine
                .dispatch(command(json!({
                    "type":"thread.turn.start",
                    "commandId":"missing-source-plan",
                    "threadId":"t1",
                    "message":{"messageId":"missing-plan-message","role":"user","text":"implement","attachments":[]},
                    "sourceProposedPlan":{"threadId":"t1","planId":"missing-plan"},
                    "createdAt":CREATED_AT
                })))
                .await,
            Err(OrchestrationError::Invariant { .. })
        ));

        engine
            .repositories()
            .upsert_command_receipt(CommandReceipt {
                command_id: "previously-rejected".to_owned(),
                aggregate_kind: "project".to_owned(),
                aggregate_id: "p1".to_owned(),
                accepted_at: CREATED_AT.to_owned(),
                result_sequence: 0,
                status: "rejected".to_owned(),
                error: None,
            })
            .await
            .expect("receipt fixture inserts");
        assert!(matches!(
            engine
                .dispatch(command(json!({
                    "type":"project.meta.update",
                    "commandId":"previously-rejected",
                    "projectId":"p1",
                    "title":"Ignored"
                })))
                .await,
            Err(OrchestrationError::PreviouslyRejected { detail, .. })
                if detail == "Previously rejected."
        ));

        let mut subscriber = engine.subscribe_events();
        engine
            .dispatch(command(json!({
                "type":"thread.session.stop",
                "commandId":"session-stop",
                "threadId":"t1",
                "createdAt":CREATED_AT
            })))
            .await
            .expect("session stops");
        assert_eq!(
            subscriber
                .recv()
                .await
                .expect("streamed event")
                .event
                .event_type,
            "thread.session-stop-requested"
        );

        let events = engine.read_events(0).await.expect("events");
        assert!(events.len() >= 18);
        for value in [
            json!({"type":"thread.proposed-plan.upsert","commandId":"plan-2","threadId":"t1","proposedPlan":{"id":"plan-2","turnId":"turn-2","planMarkdown":"Do the second thing","createdAt":CREATED_AT,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.turn.start","commandId":"turn-start-2","threadId":"t1","message":{"messageId":"m-user-2","role":"user","text":"continue","attachments":[]},"createdAt":CREATED_AT}),
            json!({"type":"thread.turn.diff.complete","commandId":"diff-2","threadId":"t1","turnId":"turn-2","completedAt":CREATED_AT,"checkpointRef":"checkpoint-2","status":"ready","files":[],"assistantMessageId":null,"checkpointTurnCount":2,"createdAt":CREATED_AT}),
            json!({"type":"thread.create","commandId":"thread-2","threadId":"t2","projectId":"p1","title":"Thread 2","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":CREATED_AT}),
            json!({"type":"thread.session.set","commandId":"session-2","threadId":"t2","session":{"threadId":"t2","status":"running","providerName":"codex","providerInstanceId":"codex","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.create","commandId":"thread-3","threadId":"t4","projectId":"p1","title":"Thread 3","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":CREATED_AT}),
            json!({"type":"thread.session.set","commandId":"session-3","threadId":"t4","session":{"threadId":"t4","status":"ready","providerName":"codex","providerInstanceId":"codex","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
        ] {
            engine
                .dispatch(command(value))
                .await
                .expect("additional projection command succeeds");
        }
        for request_id in ["approval-b", "approval-a"] {
            engine
                .repositories()
                .upsert_pending_approval(ProjectionPendingApproval {
                    request_id: request_id.to_owned(),
                    thread_id: "t1".to_owned(),
                    turn_id: Some("turn-2".to_owned()),
                    status: "pending".to_owned(),
                    decision: None,
                    created_at: CREATED_AT.to_owned(),
                    resolved_at: None,
                })
                .await
                .expect("approval fixture inserts");
        }
        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot");
        assert_eq!(snapshot.projects[0].title, "Renamed");
        assert!(
            snapshot
                .threads
                .iter()
                .any(|thread| thread.thread_id == "t1")
        );
        assert!(
            snapshot
                .messages
                .iter()
                .any(|message| { message.message_id == "m-assistant" && message.text == "hello" })
        );
        assert_eq!(snapshot.diffs.len(), 0);
        assert_eq!(
            required_str(&json!({"value":"text"}), "value").unwrap(),
            "text"
        );
        assert!(required_str(&json!({}), "value").is_err());
        assert_eq!(required_i64(&json!({"value":7}), "value").unwrap(), 7);
        assert!(required_i64(&json!({}), "value").is_err());

        let effects = Arc::new(NoopBootstrapEffects);
        let worktree = effects
            .prepare_worktree(ThreadTurnStartBootstrapPrepareWorktree {
                project_cwd: "C:/repo".to_owned(),
                base_branch: "main".to_owned(),
                branch: None,
                start_from_origin: None,
            })
            .await
            .expect("noop worktree");
        assert_eq!(
            effects
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "t1".to_owned(),
                    project_id: Some("p1".to_owned()),
                    project_cwd: Some("C:/repo".to_owned()),
                    worktree_path: worktree.path.clone(),
                })
                .await,
            Ok(BootstrapSetupResult::NoScript)
        );
        effects
            .cleanup_thread_resources("t1")
            .await
            .expect("noop cleanup");
        effects
            .remove_worktree(worktree)
            .await
            .expect("noop worktree cleanup");

        let poisoned_effects = engine.bootstrap_effects.clone();
        let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = poisoned_effects.lock().expect("mutex initially healthy");
            panic!("poison bootstrap effects mutex");
        }));
        assert!(panic_result.is_err());
        assert!(engine.bootstrap_effects().is_none());
        engine.set_bootstrap_effects(effects);
        assert!(engine.bootstrap_effects().is_some());

        engine.shutdown().await;
        assert!(matches!(
            engine
                .dispatch(command(json!({
                    "type":"thread.archive",
                    "commandId":"after-shutdown",
                    "threadId":"t1"
                })))
                .await,
            Err(OrchestrationError::Cancelled)
        ));
    }
}
