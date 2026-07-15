use t4code_server::production::provider_runtime;

use std::{
    collections::VecDeque,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Command,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use provider_runtime::{
    BoxRuntimeFuture, NativeProviderDriverFactory, ProviderDriver, ProviderDriverFactory,
    ProviderEvent, ProviderLaunchRequest, ProviderRuntimeError, ProviderRuntimeSupervisor,
    StartedSession, SupervisorOptions, reconcile_abandoned_provider_sessions,
    route_orchestration_command,
};
use serde_json::{Value, json};
use t4code_server::{
    RequestId, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
    orchestration::{
        engine::{
            EngineOptions, OrchestrationCommand, OrchestrationEngine, SessionInput,
            ThreadMessageInput,
        },
        load_snapshot,
    },
    persistence::{Database, ProviderSessionRuntime, run_migrations},
    production::{
        orchestration_effects::{
            self, BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks,
            OrchestrationEffects,
        },
        orchestration_rpc::register_orchestration_rpc_with_provider,
    },
};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{WebSocketStream, connect_async, tungstenite::Message};

const NOW: &str = "2026-07-10T10:00:00.000Z";

#[derive(Default)]
struct DriverState {
    launches: Vec<ProviderLaunchRequest>,
    start_results: VecDeque<Result<StartedSession, ProviderRuntimeError>>,
    starts: usize,
    sends: Vec<String>,
    interrupts: Vec<Option<String>>,
    approvals: Vec<(String, String)>,
    answers: Vec<(String, Value)>,
    modes: Vec<String>,
    set_mode_results: VecDeque<Result<(), ProviderRuntimeError>>,
    interaction_modes: Vec<String>,
    set_interaction_mode_results: VecDeque<Result<(), ProviderRuntimeError>>,
    models: Vec<String>,
    set_model_results: VecDeque<Result<(), ProviderRuntimeError>>,
    rollbacks: Vec<i64>,
    rollback_observations: Vec<(i64, Option<String>)>,
    rollback_workspace: Option<PathBuf>,
    rollback_error: Option<String>,
    shutdowns: usize,
}

struct FakeDriver {
    state: Arc<StdMutex<DriverState>>,
    events: tokio::sync::Mutex<mpsc::Receiver<ProviderEvent>>,
}

fn started_session(session_id: &str) -> StartedSession {
    StartedSession {
        resume_cursor: Some(json!({ "sessionId": session_id })),
        runtime_payload: Some(json!({ "transport": "native" })),
    }
}

impl ProviderDriver for FakeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let result = {
                let mut state = self.state.lock().unwrap();
                state.starts += 1;
                state
                    .start_results
                    .pop_front()
                    .unwrap_or_else(|| Ok(started_session("provider-session-1")))
            };
            result
        })
    }

    fn send(
        &self,
        text: String,
        _attachments: Vec<Value>,
        _interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().sends.push(text);
            Ok(Some("provider-turn-1".to_owned()))
        })
    }

    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().interrupts.push(turn_id);
            Ok(())
        })
    }

    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .approvals
                .push((request_id, decision));
            Ok(())
        })
    }

    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state
                .lock()
                .unwrap()
                .answers
                .push((request_id, answers));
            Ok(())
        })
    }

    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = {
                let mut state = self.state.lock().unwrap();
                state.modes.push(mode);
                state.set_mode_results.pop_front().unwrap_or(Ok(()))
            };
            result
        })
    }

    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = {
                let mut state = self.state.lock().unwrap();
                state.interaction_modes.push(mode);
                state
                    .set_interaction_mode_results
                    .pop_front()
                    .unwrap_or(Ok(()))
            };
            result
        })
    }

    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = {
                let mut state = self.state.lock().unwrap();
                state.models.push(model);
                state.set_model_results.pop_front().unwrap_or(Ok(()))
            };
            result
        })
    }

    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let (workspace, error) = {
                let mut state = self.state.lock().unwrap();
                state.rollbacks.push(turn_count);
                (
                    state.rollback_workspace.clone(),
                    state.rollback_error.clone(),
                )
            };
            let restored = workspace.map(|workspace| {
                std::fs::read_to_string(workspace.join("tracked.txt"))
                    .expect("restored checkpoint is readable")
                    .replace("\r\n", "\n")
            });
            self.state
                .lock()
                .unwrap()
                .rollback_observations
                .push((turn_count, restored));
            if let Some(detail) = error {
                return Err(ProviderRuntimeError::Provider {
                    provider: "codex".to_owned(),
                    detail,
                });
            }
            Ok(())
        })
    }

    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { self.events.lock().await.recv().await })
    }

    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().shutdowns += 1;
            Ok(())
        })
    }
}

struct FakeFactory {
    state: Arc<StdMutex<DriverState>>,
    events: StdMutex<VecDeque<mpsc::Receiver<ProviderEvent>>>,
}

impl ProviderDriverFactory for FakeFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().launches.push(request);
            let events = self
                .events
                .lock()
                .unwrap()
                .pop_front()
                .expect("event receiver");
            Ok(Arc::new(FakeDriver {
                state: self.state.clone(),
                events: tokio::sync::Mutex::new(events),
            }) as Arc<dyn ProviderDriver>)
        })
    }
}

async fn engine() -> OrchestrationEngine {
    engine_and_database().await.0
}

async fn engine_and_database() -> (OrchestrationEngine, Database) {
    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(database.clone(), EngineOptions::default())
        .await
        .unwrap();
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create", "commandId":"project", "projectId":"p1", "title":"Project",
                "workspaceRoot":"C:/repo", "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create", "commandId":"thread", "threadId":"t1", "projectId":"p1",
                "title":"Thread", "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "branch":null, "worktreePath":null, "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    (engine, database)
}

fn launch() -> ProviderLaunchRequest {
    ProviderLaunchRequest {
        thread_id: "t1".to_owned(),
        provider: "codex".to_owned(),
        provider_instance_id: Some("codex".to_owned()),
        binary_path: "codex".to_owned(),
        cwd: "C:/repo".into(),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        model: Some("gpt-5".to_owned()),
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

fn persisted_runtime(thread_id: &str, status: &str, last_seen_at: &str) -> ProviderSessionRuntime {
    ProviderSessionRuntime {
        thread_id: thread_id.to_owned(),
        provider_name: "codex".to_owned(),
        provider_instance_id: Some("codex".to_owned()),
        adapter_key: "codex-app-server".to_owned(),
        runtime_mode: "full-access".to_owned(),
        status: status.to_owned(),
        last_seen_at: last_seen_at.to_owned(),
        resume_cursor: Some(json!({"threadId":format!("provider-{thread_id}")})),
        runtime_payload: None,
    }
}

async fn project_session(engine: &OrchestrationEngine, thread_id: &str, status: &str) {
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: format!("{thread_id}-{status}-session"),
            thread_id: thread_id.to_owned(),
            session: SessionInput {
                thread_id: thread_id.to_owned(),
                status: status.to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: None,
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
}

struct SupervisorEffectsCallbacks {
    supervisor: Arc<ProviderRuntimeSupervisor>,
    workspace: PathBuf,
}

impl OrchestrationEffectCallbacks for SupervisorEffectsCallbacks {
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move { Ok(Some(self.workspace.clone())) })
    }

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.supervisor
                .handle_orchestration(OrchestrationCommand::ThreadCheckpointRevert {
                    command_id: format!("effects:provider-rollback:{thread_id}:{turns}"),
                    thread_id: thread_id.to_owned(),
                    turn_count: turns,
                    created_at: NOW.to_owned(),
                })
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn stop_provider<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn close_terminals<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn refresh_workspace<'a>(&'a self, _cwd: &'a Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git output is UTF-8")
        .trim()
        .to_owned()
}

fn git_succeeds(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git starts")
        .success()
}

fn initialize_repository() -> TempDir {
    let directory = TempDir::new().expect("temporary repository");
    git(directory.path(), &["init"]);
    git(directory.path(), &["config", "user.name", "T4Code Test"]);
    git(
        directory.path(),
        &["config", "user.email", "t4code@example.test"],
    );
    std::fs::write(directory.path().join("tracked.txt"), "baseline\n").unwrap();
    git(directory.path(), &["add", "."]);
    git(directory.path(), &["commit", "-m", "baseline"]);
    directory
}

async fn project_checkpoint(
    engine: &OrchestrationEngine,
    workspace: &Path,
    turn_count: i64,
    content: &str,
) {
    std::fs::write(workspace.join("tracked.txt"), content).unwrap();
    orchestration_effects::capture_checkpoint(workspace, "t1", turn_count)
        .await
        .unwrap();
    if turn_count > 0 {
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.turn.diff.complete",
                    "commandId":format!("diff-{turn_count}"),
                    "threadId":"t1",
                    "turnId":format!("turn-{turn_count}"),
                    "checkpointTurnCount":turn_count,
                    "checkpointRef":orchestration_effects::checkpoint_ref("t1", turn_count),
                    "status":"ready",
                    "files":[],
                    "assistantMessageId":format!("assistant-{turn_count}"),
                    "completedAt":NOW,
                    "createdAt":NOW
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
}

async fn wait_for_event(
    events: &mut tokio::sync::broadcast::Receiver<t4code_server::persistence::OrchestrationEvent>,
    predicate: impl Fn(&t4code_server::persistence::OrchestrationEvent) -> bool,
) {
    timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(event) if predicate(&event) => return,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    panic!("orchestration event stream closed")
                }
            }
        }
    })
    .await
    .expect("expected orchestration event");
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

async fn rpc_request<S>(socket: &mut WebSocketStream<S>, id: &str, payload: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({
                "_tag":"Request",
                "id":id,
                "tag":"orchestration.dispatchCommand",
                "payload":payload,
                "headers":[]
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send orchestration RPC request");
}

async fn rpc_response<S>(socket: &mut WebSocketStream<S>, id: &str) -> Result<Value, Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(10), socket.next())
        .await
        .expect("orchestration RPC response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = frame else {
        panic!("expected text WebSocket message, got {frame:?}");
    };
    match serde_json::from_str::<ServerMessage>(&text).expect("valid server RPC message") {
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Success { value },
        } if request_id == RequestId::try_from(id).unwrap() => Ok(value.unwrap_or(Value::Null)),
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Failure { cause },
        } if request_id == RequestId::try_from(id).unwrap() => {
            Err(serde_json::to_value(cause).unwrap())
        }
        message => panic!("unexpected orchestration RPC response: {message:?}"),
    }
}

#[tokio::test]
async fn routes_orchestration_commands_and_persists_resume_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());

    supervisor.launch(launch()).await.unwrap();
    supervisor
        .handle_orchestration(OrchestrationCommand::ThreadTurnStart {
            command_id: "turn".to_owned(),
            thread_id: "t1".to_owned(),
            message: ThreadMessageInput {
                message_id: "m1".to_owned(),
                role: "user".to_owned(),
                text: "hello".to_owned(),
                attachments: vec![],
            },
            model_selection: None,
            title_seed: None,
            runtime_mode: "full-access".to_owned(),
            interaction_mode: "default".to_owned(),
            bootstrap: None,
            source_proposed_plan: None,
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"provider-turn-1","createdAt":NOW})).unwrap()).await.unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":NOW})).unwrap()).await.unwrap();
    supervisor.handle_orchestration(serde_json::from_value(json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":NOW})).unwrap()).await.unwrap();

    let persisted = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.resume_cursor,
        Some(json!({ "sessionId": "provider-session-1" }))
    );
    assert_eq!(persisted.status, "ready");
    {
        let state = state.lock().unwrap();
        assert_eq!(state.sends, ["hello"]);
        assert_eq!(state.interrupts, [Some("provider-turn-1".to_owned())]);
        assert_eq!(state.approvals, [("r1".to_owned(), "accept".to_owned())]);
        assert_eq!(state.answers, [("r2".to_owned(), json!({"q":"a"}))]);
    }
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn routes_the_complete_live_session_lifecycle_and_stops_idempotently() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    let settings = TempDir::new().unwrap();

    supervisor.launch(launch()).await.unwrap();
    let duplicate = supervisor
        .launch(launch())
        .await
        .expect_err("a live thread must have exactly one provider session");
    assert!(matches!(
        duplicate,
        ProviderRuntimeError::SessionAlreadyExists { thread_id } if thread_id == "t1"
    ));

    for value in [
        json!({"type":"thread.runtime-mode.set","commandId":"mode","threadId":"t1","runtimeMode":"approval-required","createdAt":NOW}),
        json!({"type":"thread.interaction-mode.set","commandId":"interaction","threadId":"t1","interactionMode":"plan","createdAt":NOW}),
        json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.1"}}),
    ] {
        route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            serde_json::from_value(value).unwrap(),
        )
        .await
        .unwrap();
    }

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.modes, ["approval-required"]);
        assert_eq!(state.interaction_modes, ["plan"]);
        assert_eq!(state.models, ["gpt-5.1"]);
        assert!(state.rollbacks.is_empty());
    }

    let delete: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.delete",
        "commandId":"delete",
        "threadId":"t1",
        "createdAt":NOW
    }))
    .unwrap();
    route_orchestration_command(
        &supervisor,
        &engine,
        &settings.path().to_path_buf(),
        delete.clone(),
    )
    .await
    .unwrap();
    route_orchestration_command(&supervisor, &engine, &settings.path().to_path_buf(), delete)
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().shutdowns, 1);
    assert!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .is_none()
    );

    supervisor.shutdown().await.unwrap();
    supervisor.shutdown().await.unwrap();
    let error = supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.session.stop",
                "commandId":"after-shutdown",
                "threadId":"t1",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .expect_err("commands after shutdown must fail explicitly");
    assert!(matches!(error, ProviderRuntimeError::Shutdown));
}

#[tokio::test]
async fn launch_failure_persists_the_error_and_keeps_the_thread_relaunchable() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Err(ProviderRuntimeError::Provider {
                provider: "codex".to_owned(),
                detail: "bootstrap failed".to_owned(),
            }),
            Ok(started_session("provider-session-2")),
        ]),
        ..DriverState::default()
    }));
    let (_events_tx1, events_rx1) = mpsc::channel(1);
    let (_events_tx2, events_rx2) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx1, events_rx2])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());

    let error = supervisor
        .launch(launch())
        .await
        .expect_err("a failed provider bootstrap must surface to the caller");
    assert!(matches!(
        error,
        ProviderRuntimeError::Provider { provider, detail }
            if provider == "codex" && detail == "bootstrap failed"
    ));

    let failed_runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed_runtime.status, "error");
    assert_eq!(
        failed_runtime.runtime_payload,
        Some(json!({"error":"codex provider operation failed: bootstrap failed"}))
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.shutdowns, 1);
        assert_eq!(state.launches.len(), 1);
    }

    supervisor
        .launch(launch())
        .await
        .expect("a failed bootstrap must not leave a ghost live session behind");

    let recovered_runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered_runtime.status, "ready");
    assert_eq!(
        recovered_runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-2"}))
    );
    assert_eq!(state.lock().unwrap().starts, 2);

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn unsupported_live_capabilities_restart_the_runtime_with_updated_launch_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([
            Ok(started_session("provider-session-1")),
            Ok(started_session("provider-session-2")),
            Ok(started_session("provider-session-3")),
        ]),
        set_mode_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "runtime mode switch",
        })]),
        set_model_results: VecDeque::from([Err(ProviderRuntimeError::UnsupportedCapability {
            provider: "codex".to_owned(),
            capability: "model switch",
        })]),
        ..DriverState::default()
    }));
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([
            mpsc::channel(1).1,
            mpsc::channel(1).1,
            mpsc::channel(1).1,
        ])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());

    supervisor.launch(launch()).await.unwrap();
    supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.runtime-mode.set",
                "commandId":"restart-mode",
                "threadId":"t1",
                "runtimeMode":"approval-required",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.meta.update",
                "commandId":"restart-model",
                "threadId":"t1",
                "modelSelection":{"instanceId":"codex","model":"gpt-5.1"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();

    let launches = state.lock().unwrap().launches.clone();
    assert_eq!(launches.len(), 3);
    assert_eq!(launches[1].runtime_mode, "approval-required");
    assert_eq!(
        launches[1].resume_cursor,
        Some(json!({"sessionId":"provider-session-1"}))
    );
    assert_eq!(launches[2].runtime_mode, "approval-required");
    assert_eq!(launches[2].interaction_mode, "default");
    assert_eq!(launches[2].model.as_deref(), Some("gpt-5.1"));
    assert_eq!(
        launches[2].resume_cursor,
        Some(json!({"sessionId":"provider-session-2"}))
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 3);
        assert_eq!(state.shutdowns, 2);
        assert_eq!(state.modes, ["approval-required"]);
        assert!(state.interaction_modes.is_empty());
        assert_eq!(state.models, ["gpt-5.1"]);
    }

    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "ready");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-3"}))
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn interaction_mode_provider_failure_preserves_the_live_launch_state() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState {
        start_results: VecDeque::from([Ok(started_session("provider-session-1"))]),
        set_interaction_mode_results: VecDeque::from([Err(ProviderRuntimeError::Provider {
            provider: "claude".to_owned(),
            detail: "set permission mode failed".to_owned(),
        })]),
        ..DriverState::default()
    }));
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([mpsc::channel(1).1])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    let mut request = launch();
    request.provider = "claude".to_owned();
    request.provider_instance_id = Some("claude".to_owned());
    request.binary_path = "claude".to_owned();

    supervisor.launch(request).await.unwrap();
    let error = supervisor
        .handle_orchestration(
            serde_json::from_value(json!({
                "type":"thread.interaction-mode.set",
                "commandId":"failed-interaction",
                "threadId":"t1",
                "interactionMode":"plan",
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .expect_err("adapter interaction-mode failures must surface without restarting");
    assert!(matches!(
        error,
        ProviderRuntimeError::Provider { provider, detail }
            if provider == "claude" && detail == "set permission mode failed"
    ));

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.shutdowns, 0);
        assert_eq!(state.launches.len(), 1);
        assert_eq!(state.launches[0].interaction_mode, "default");
        assert_eq!(state.interaction_modes, ["plan"]);
    }
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "ready");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"sessionId":"provider-session-1"}))
    );

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_event_aliases_user_input_and_proposed_plans_with_request_context() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    supervisor.launch(launch()).await.unwrap();

    for event in [
        ProviderEvent {
            event_type: "assistant.message.delta".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"messageId":"assistant-explicit","text":"Plan incoming"}),
        },
        ProviderEvent {
            event_type: "assistant.message.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"messageId":"assistant-explicit"}),
        },
        ProviderEvent {
            event_type: "request.opened".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!({"requestType":"command_execution_approval","command":"cargo check"}),
        },
        ProviderEvent {
            event_type: "request.resolved".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!("accepted"),
        },
        ProviderEvent {
            event_type: "user-input.requested".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("input-1".to_owned()),
            payload: json!({
                "questions":[{
                    "id":"cwd",
                    "header":"Workspace",
                    "question":"Need a path",
                    "options":[
                        {"label":"repo","description":"Use the repository root"},
                        {"label":"worktree","description":"Use the current worktree"}
                    ]
                }]
            }),
        },
        ProviderEvent {
            event_type: "user-input.resolved".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("input-1".to_owned()),
            payload: json!("workspace chosen"),
        },
        ProviderEvent {
            event_type: "turn.proposed.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: None,
            payload: json!({"planMarkdown":"1. Inspect\n2. Fix\n3. Verify"}),
        },
    ] {
        events_tx.send(event).await.unwrap();
    }

    match tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.message_id == "assistant-explicit");
            let thread = snapshot
                .threads
                .iter()
                .find(|thread| thread.thread_id == "t1");
            let activities = snapshot
                .activities
                .iter()
                .filter(|activity| activity.thread_id == "t1")
                .collect::<Vec<_>>();
            let plan = snapshot
                .proposed_plans
                .iter()
                .find(|plan| plan.thread_id == "t1" && plan.turn_id.as_deref() == Some("turn-1"));
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            let approval = approvals
                .iter()
                .find(|approval| approval.request_id == "approval-1");
            let approval_resolved = activities.iter().find(|activity| {
                activity.kind == "approval.resolved"
                    && activity.payload["requestId"] == "approval-1"
                    && activity.payload["detail"] == "accepted"
            });
            let user_input_requested = activities.iter().find(|activity| {
                activity.kind == "user-input.requested"
                    && activity.payload["requestId"] == "input-1"
                    && activity.payload["questions"][0]["id"] == "cwd"
            });
            let user_input_resolved = activities.iter().find(|activity| {
                activity.kind == "user-input.resolved"
                    && activity.payload["requestId"] == "input-1"
                    && activity.payload["detail"] == "workspace chosen"
            });
            if assistant
                .is_some_and(|message| message.text == "Plan incoming" && !message.is_streaming)
                && thread.is_some_and(|thread| {
                    thread.pending_approval_count == 0 && thread.has_actionable_proposed_plan == 1
                })
                && plan.is_some_and(|plan| plan.plan_markdown.contains("Inspect"))
                && approval.is_some_and(|approval| approval.status == "resolved")
                && approval_resolved.is_some()
                && user_input_requested.is_some()
                && user_input_resolved.is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    {
        Ok(()) => {}
        Err(error) => {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            panic!(
                "provider event aliases must project into durable orchestration state: {error:?}\nassistant={:?}\nthread={:?}\nplan={:?}\napprovals={approvals:?}\nactivities={:?}",
                snapshot
                    .messages
                    .iter()
                    .find(|message| message.message_id == "assistant-explicit"),
                snapshot
                    .threads
                    .iter()
                    .find(|thread| thread.thread_id == "t1"),
                snapshot.proposed_plans.iter().find(
                    |plan| plan.thread_id == "t1" && plan.turn_id.as_deref() == Some("turn-1")
                ),
                snapshot
                    .activities
                    .iter()
                    .filter(|activity| activity.thread_id == "t1")
                    .collect::<Vec<_>>()
            );
        }
    }

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkpoint_rpc_rolls_back_once_after_restore_with_the_computed_delta() {
    let repository = initialize_repository();
    let engine = engine().await;
    for (turn_count, content) in [
        (0, "baseline\n"),
        (1, "one\n"),
        (2, "two\n"),
        (3, "three\n"),
    ] {
        project_checkpoint(&engine, repository.path(), turn_count, content).await;
    }

    let state = Arc::new(StdMutex::new(DriverState {
        rollback_workspace: Some(repository.path().to_path_buf()),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let supervisor = Arc::new(ProviderRuntimeSupervisor::start(
        engine.clone(),
        Arc::new(FakeFactory {
            state: state.clone(),
            events: StdMutex::new(VecDeque::from([events_rx])),
        }),
        SupervisorOptions::default(),
    ));
    let mut provider_launch = launch();
    provider_launch.cwd = repository.path().to_path_buf();
    supervisor.launch(provider_launch).await.unwrap();
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(SupervisorEffectsCallbacks {
            supervisor: supervisor.clone(),
            workspace: repository.path().to_path_buf(),
        }),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let settings = TempDir::new().unwrap();
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc_with_provider(
        &mut registry,
        engine.clone(),
        supervisor.clone(),
        settings.path().to_path_buf(),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&settings), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    let mut events = engine.subscribe_events();

    rpc_request(
        &mut socket,
        "1",
        json!({
            "type":"thread.checkpoint.revert",
            "commandId":"rollback-success",
            "threadId":"t1",
            "turnCount":1,
            "createdAt":NOW
        }),
    )
    .await;
    rpc_response(&mut socket, "1")
        .await
        .expect("checkpoint RPC is accepted");
    wait_for_event(&mut events, |event| {
        event.event.event_type == "thread.reverted"
    })
    .await;

    effects.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.rollbacks, [2]);
        assert_eq!(state.rollback_observations, [(2, Some("one\n".to_owned()))]);
    }
    for stale_turn in [2, 3] {
        assert!(!git_succeeds(
            repository.path(),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &orchestration_effects::checkpoint_ref("t1", stale_turn),
            ]
        ));
    }

    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
    supervisor.shutdown().await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn checkpoint_rpc_reports_effect_failure_without_a_direct_or_second_rollback() {
    let repository = initialize_repository();
    let engine = engine().await;
    for (turn_count, content) in [
        (0, "baseline\n"),
        (1, "one\n"),
        (2, "two\n"),
        (3, "three\n"),
    ] {
        project_checkpoint(&engine, repository.path(), turn_count, content).await;
    }

    let state = Arc::new(StdMutex::new(DriverState {
        rollback_workspace: Some(repository.path().to_path_buf()),
        rollback_error: Some("injected provider rollback failure".to_owned()),
        ..DriverState::default()
    }));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let supervisor = Arc::new(ProviderRuntimeSupervisor::start(
        engine.clone(),
        Arc::new(FakeFactory {
            state: state.clone(),
            events: StdMutex::new(VecDeque::from([events_rx])),
        }),
        SupervisorOptions::default(),
    ));
    let mut provider_launch = launch();
    provider_launch.cwd = repository.path().to_path_buf();
    supervisor.launch(provider_launch).await.unwrap();
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(SupervisorEffectsCallbacks {
            supervisor: supervisor.clone(),
            workspace: repository.path().to_path_buf(),
        }),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let settings = TempDir::new().unwrap();
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc_with_provider(
        &mut registry,
        engine.clone(),
        supervisor.clone(),
        settings.path().to_path_buf(),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&settings), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    let mut events = engine.subscribe_events();

    rpc_request(
        &mut socket,
        "2",
        json!({
            "type":"thread.checkpoint.revert",
            "commandId":"rollback-failure",
            "threadId":"t1",
            "turnCount":1,
            "createdAt":NOW
        }),
    )
    .await;
    rpc_response(&mut socket, "2")
        .await
        .expect("checkpoint command acceptance is independent of its asynchronous effect");
    wait_for_event(&mut events, |event| {
        event.event.event_type == "thread.activity-appended"
            && event.event.payload["activity"]["kind"] == "checkpoint.revert.failed"
    })
    .await;

    effects.shutdown().await;
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );
    {
        let state = state.lock().unwrap();
        assert_eq!(state.rollbacks, [2]);
        assert_eq!(state.rollback_observations, [(2, Some("one\n".to_owned()))]);
    }
    let events = engine.read_events(0).await.unwrap();
    assert!(
        !events
            .iter()
            .any(|event| event.event.event_type == "thread.reverted")
    );
    for preserved_turn in [2, 3] {
        assert!(git_succeeds(
            repository.path(),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &orchestration_effects::checkpoint_ref("t1", preserved_turn),
            ]
        ));
    }

    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
    supervisor.shutdown().await.unwrap();
    engine.shutdown().await;
}

#[tokio::test]
async fn restart_reconciles_abandoned_running_provider_sessions() {
    let engine = engine().await;
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: "running-session".to_owned(),
            thread_id: "t1".to_owned(),
            session: SessionInput {
                thread_id: "t1".to_owned(),
                status: "running".to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: Some("provider-turn-1".to_owned()),
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    engine
        .repositories()
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: "t1".to_owned(),
            provider_name: "codex".to_owned(),
            provider_instance_id: Some("codex".to_owned()),
            adapter_key: "codex-app-server".to_owned(),
            runtime_mode: "full-access".to_owned(),
            status: "running".to_owned(),
            last_seen_at: NOW.to_owned(),
            resume_cursor: Some(json!({"threadId":"provider-thread-1"})),
            runtime_payload: None,
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == "t1")
        .unwrap();
    assert_eq!(session.status, "error");
    assert_eq!(session.active_turn_id, None);
    assert!(
        session
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("Start a new turn"))
    );
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "error");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"threadId":"provider-thread-1"}))
    );
}

#[tokio::test]
async fn restart_reconciles_abandoned_ready_provider_sessions() {
    let engine = engine().await;
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: "ready-session".to_owned(),
            thread_id: "t1".to_owned(),
            session: SessionInput {
                thread_id: "t1".to_owned(),
                status: "ready".to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: None,
                last_error: None,
                updated_at: NOW.to_owned(),
            },
            created_at: NOW.to_owned(),
        })
        .await
        .unwrap();
    engine
        .repositories()
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: "t1".to_owned(),
            provider_name: "codex".to_owned(),
            provider_instance_id: Some("codex".to_owned()),
            adapter_key: "codex-app-server".to_owned(),
            runtime_mode: "full-access".to_owned(),
            status: "ready".to_owned(),
            last_seen_at: NOW.to_owned(),
            resume_cursor: Some(json!({"threadId":"provider-thread-ready"})),
            runtime_payload: None,
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == "t1")
        .unwrap();
    assert_eq!(session.status, "error");
    assert_eq!(session.active_turn_id, None);
    assert!(
        session
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("Start a new turn"))
    );
    let runtime = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "error");
    assert_eq!(
        runtime.resume_cursor,
        Some(json!({"threadId":"provider-thread-ready"}))
    );
}

#[tokio::test]
async fn reconciliation_keeps_projection_failures_retryable_and_continues_later_rows() {
    let engine = engine().await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime(
            "missing-thread",
            "ready",
            "2026-07-10T09:59:00.000Z",
        ))
        .await
        .unwrap();
    project_session(&engine, "t1", "ready").await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime("t1", "ready", NOW))
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .expect("one malformed persisted row must not abort startup reconciliation");

    let missing = engine
        .repositories()
        .get_provider_session_runtime("missing-thread".to_owned())
        .await
        .unwrap()
        .unwrap();
    let valid = engine
        .repositories()
        .get_provider_session_runtime("t1".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        missing.status, "ready",
        "failed projection remains retryable"
    );
    assert_eq!(valid.status, "error", "later rows still reconcile");
    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .find(|session| session.thread_id == "t1")
            .unwrap()
            .status,
        "error"
    );

    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create",
                "commandId":"create-missing-thread",
                "threadId":"missing-thread",
                "projectId":"p1",
                "title":"Recovered thread",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "branch":null,
                "worktreePath":null,
                "createdAt":NOW
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    let event_count = engine.read_events(0).await.unwrap().len();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();

    let recovered = engine
        .repositories()
        .get_provider_session_runtime("missing-thread".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, "error");
    assert_eq!(engine.read_events(0).await.unwrap().len(), event_count);
}

#[tokio::test]
async fn reconciliation_retries_runtime_write_after_projection_without_duplicate_events() {
    let (engine, database) = engine_and_database().await;
    project_session(&engine, "t1", "ready").await;
    engine
        .repositories()
        .upsert_provider_session_runtime(persisted_runtime("t1", "ready", NOW))
        .await
        .unwrap();
    database
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER fail_provider_runtime_reconciliation
                 BEFORE UPDATE ON provider_session_runtime
                 WHEN NEW.thread_id = 't1' AND NEW.status = 'error'
                 BEGIN
                   SELECT RAISE(FAIL, 'injected provider runtime write failure');
                 END;",
            )?;
            Ok(())
        })
        .await
        .unwrap();

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .expect("runtime write failure is isolated and retried on restart");

    let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .find(|session| session.thread_id == "t1")
            .unwrap()
            .status,
        "error",
        "projection is committed before marking the runtime row reconciled"
    );
    assert_eq!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .unwrap()
            .status,
        "ready",
        "failed runtime write leaves the row eligible for retry"
    );
    let projected_event_count = engine.read_events(0).await.unwrap().len();

    database
        .call(|connection| {
            connection.execute_batch("DROP TRIGGER fail_provider_runtime_reconciliation;")?;
            Ok(())
        })
        .await
        .unwrap();
    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    assert_eq!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .unwrap()
            .status,
        "error"
    );
    assert_eq!(
        engine.read_events(0).await.unwrap().len(),
        projected_event_count,
        "retry reuses the same reconciliation command"
    );

    reconcile_abandoned_provider_sessions(&engine)
        .await
        .unwrap();
    assert_eq!(
        engine.read_events(0).await.unwrap().len(),
        projected_event_count,
        "completed reconciliation is idempotent"
    );
}

#[tokio::test]
async fn first_turn_autostarts_the_projected_native_provider() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    let command = OrchestrationCommand::ThreadTurnStart {
        command_id: "autostart-turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "autostart-message".to_owned(),
            role: "user".to_owned(),
            text: "start natively".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(command.clone()).await.unwrap();
    let settings = TempDir::new().unwrap();
    route_orchestration_command(
        &supervisor,
        &engine,
        &settings.path().to_path_buf(),
        command,
    )
    .await
    .unwrap();

    {
        let state = state.lock().unwrap();
        assert_eq!(state.starts, 1);
        assert_eq!(state.sends, ["start natively"]);
    }
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_runtime_accepts_durable_thread_settings_for_the_next_turn() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::new()),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    let settings = TempDir::new().unwrap();
    let commands = [
        json!({"type":"thread.runtime-mode.set","commandId":"runtime-mode","threadId":"t1","runtimeMode":"approval-required","createdAt":NOW}),
        json!({"type":"thread.interaction-mode.set","commandId":"interaction-mode","threadId":"t1","interactionMode":"plan","createdAt":NOW}),
        json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.1"}}),
    ];

    for value in commands {
        let command: OrchestrationCommand = serde_json::from_value(value).unwrap();
        engine.dispatch(command.clone()).await.unwrap();
        route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            command,
        )
        .await
        .expect("durable settings remain valid without a live provider runtime");
    }

    assert_eq!(state.lock().unwrap().starts, 0);
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_runtime_rejects_ephemeral_commands_as_stale_session_actions() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::new()),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    let settings = TempDir::new().unwrap();
    let commands = [
        json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"turn-1","createdAt":NOW}),
        json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":NOW}),
        json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":NOW}),
        json!({"type":"thread.session.stop","commandId":"stop","threadId":"t1","createdAt":NOW}),
    ];

    for value in commands {
        let command: OrchestrationCommand = serde_json::from_value(value).unwrap();
        let action = command.command_type().to_owned();
        let error = route_orchestration_command(
            &supervisor,
            &engine,
            &settings.path().to_path_buf(),
            command,
        )
        .await
        .expect_err("missing runtime command must fail");
        let message = error.to_string();

        assert!(matches!(
            error,
            ProviderRuntimeError::StaleSession {
                thread_id,
                action: failed_action,
            } if thread_id == "t1" && failed_action == action
        ));
        assert!(message.contains("start a new turn"), "{message}");
    }

    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn persisted_session_without_live_runtime_rejects_commands_until_next_turn_start() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(8);
    let first_factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let first_supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        first_factory,
        SupervisorOptions::default(),
    );
    first_supervisor.launch(launch()).await.unwrap();

    let replacement_factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::new()),
    });
    let replacement_supervisor = ProviderRuntimeSupervisor::start(
        engine.clone(),
        replacement_factory,
        SupervisorOptions::default(),
    );
    let settings = TempDir::new().unwrap();
    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.approval.respond",
        "commandId":"stale-approval",
        "threadId":"t1",
        "requestId":"r1",
        "decision":"accept",
        "createdAt":NOW
    }))
    .unwrap();

    let error = route_orchestration_command(
        &replacement_supervisor,
        &engine,
        &settings.path().to_path_buf(),
        command,
    )
    .await
    .expect_err("lost live runtime must not acknowledge the command");

    assert!(matches!(
        error,
        ProviderRuntimeError::StaleSession { thread_id, action }
            if thread_id == "t1" && action == "thread.approval.respond"
    ));
    assert_eq!(state.lock().unwrap().starts, 1);

    replacement_supervisor.shutdown().await.unwrap();
    first_supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn normalizes_provider_approval_events_into_orchestration_projection() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    supervisor.launch(launch()).await.unwrap();
    events_tx
        .send(ProviderEvent {
            event_type: "request.opened".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            request_id: Some("approval-1".to_owned()),
            payload: json!({"requestType":"command_execution_approval","detail":"cargo test"}),
        })
        .await
        .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let approvals = engine
                .repositories()
                .list_pending_approvals_by_thread("t1".to_owned())
                .await
                .unwrap();
            if approvals.len() == 1 {
                break approvals;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn projects_content_and_completion_into_a_settled_assistant_turn() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(8);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    supervisor.launch(launch()).await.unwrap();
    let start = OrchestrationCommand::ThreadTurnStart {
        command_id: "turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "m1".to_owned(),
            role: "user".to_owned(),
            text: "hello".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(start.clone()).await.unwrap();
    supervisor.handle_orchestration(start).await.unwrap();

    for event in [
        ProviderEvent {
            event_type: "content.delta".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"streamKind":"assistant_text","delta":"CODEX_OK"}),
        },
        ProviderEvent {
            event_type: "turn.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"state":"completed"}),
        },
    ] {
        events_tx.send(event).await.unwrap();
    }

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.thread_id == "t1" && message.role == "assistant");
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.thread_id == "t1");
            let turn = snapshot.turns.iter().find(|turn| {
                turn.thread_id == "t1" && turn.turn_id.as_deref() == Some("provider-turn-1")
            });
            let runtime = engine
                .repositories()
                .get_provider_session_runtime("t1".to_owned())
                .await
                .unwrap();
            if assistant.is_some_and(|message| message.text == "CODEX_OK" && !message.is_streaming)
                && session.is_some_and(|session| {
                    session.status == "ready" && session.active_turn_id.is_none()
                })
                && turn.is_some_and(|turn| turn.state == "completed")
                && runtime.is_some_and(|runtime| runtime.status == "ready")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("provider completion must settle the projected turn");
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_provider_completion_clears_running_state_and_preserves_the_error() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (events_tx, events_rx) = mpsc::channel(4);
    let factory = Arc::new(FakeFactory {
        state,
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    supervisor.launch(launch()).await.unwrap();
    let start = OrchestrationCommand::ThreadTurnStart {
        command_id: "failed-turn".to_owned(),
        thread_id: "t1".to_owned(),
        message: ThreadMessageInput {
            message_id: "m-failed".to_owned(),
            role: "user".to_owned(),
            text: "fail".to_owned(),
            attachments: vec![],
        },
        model_selection: None,
        title_seed: None,
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        bootstrap: None,
        source_proposed_plan: None,
        created_at: NOW.to_owned(),
    };
    engine.dispatch(start.clone()).await.unwrap();
    supervisor.handle_orchestration(start).await.unwrap();
    events_tx
        .send(ProviderEvent {
            event_type: "turn.completed".to_owned(),
            thread_id: "t1".to_owned(),
            turn_id: Some("provider-turn-1".to_owned()),
            request_id: None,
            payload: json!({"state":"failed","error":{"message":"model unavailable"}}),
        })
        .await
        .unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = load_snapshot(&engine.repositories()).await.unwrap();
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.thread_id == "t1");
            let failure = snapshot
                .activities
                .iter()
                .find(|activity| activity.thread_id == "t1" && activity.kind == "provider.error");
            let assistant = snapshot
                .messages
                .iter()
                .find(|message| message.thread_id == "t1" && message.role == "assistant");
            let runtime = engine
                .repositories()
                .get_provider_session_runtime("t1".to_owned())
                .await
                .unwrap();
            if session.is_some_and(|session| {
                session.status == "error"
                    && session.active_turn_id.is_none()
                    && session.last_error.as_deref() == Some("model unavailable")
            }) && failure.is_some_and(|activity| {
                activity.tone == "error"
                    && activity.payload["error"]["message"] == "model unavailable"
            }) && assistant.is_none()
                && runtime.is_some_and(|runtime| runtime.status == "error")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("failed provider completion must be terminal and actionable");
    supervisor.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_stops_every_driver_and_removes_runtime_rows() {
    let engine = engine().await;
    let state = Arc::new(StdMutex::new(DriverState::default()));
    let (_events_tx, events_rx) = mpsc::channel(1);
    let factory = Arc::new(FakeFactory {
        state: state.clone(),
        events: StdMutex::new(VecDeque::from([events_rx])),
    });
    let supervisor =
        ProviderRuntimeSupervisor::start(engine.clone(), factory, SupervisorOptions::default());
    supervisor.launch(launch()).await.unwrap();
    supervisor.shutdown().await.unwrap();
    assert_eq!(state.lock().unwrap().shutdowns, 1);
    assert!(
        engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .is_none()
    );
}

#[test]
fn provider_driver_trait_is_send_and_sync() {
    fn assert_future<T: Future + Send>(_: Pin<Box<T>>) {}
    let _ = assert_future::<std::future::Ready<()>>;
    fn assert_driver<T: ProviderDriver + Send + Sync>() {}
    assert_driver::<FakeDriver>();
}

#[tokio::test]
async fn native_factory_rejects_unknown_providers_without_a_fallback() {
    let factory = NativeProviderDriverFactory::new(TempDir::new().unwrap().path().to_path_buf());
    let mut request = launch();
    request.provider = "node-fallback".to_owned();
    let error = match factory.create(request).await {
        Ok(_) => panic!("unknown provider unexpectedly created"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ProviderRuntimeError::UnsupportedProvider { provider } if provider == "node-fallback"
    ));
}

#[tokio::test]
async fn native_factory_routes_resume_to_the_native_adapter_without_a_fallback() {
    let factory = NativeProviderDriverFactory::new(TempDir::new().unwrap().path().to_path_buf());
    let mut request = launch();
    request.provider = "opencode".to_owned();
    request.binary_path = "t4code-missing-opencode-resume-fixture".to_owned();
    request.resume_cursor = Some(json!({"sessionId":"old-session"}));
    let error = match factory.create(request).await {
        Ok(_) => panic!("missing native provider unexpectedly spawned"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ProviderRuntimeError::Spawn { provider, .. } if provider == "opencode"
    ));
}
