use t4code_server::production::provider_runtime;

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
};

use provider_runtime::{
    BoxRuntimeFuture, NativeProviderDriverFactory, ProviderDriver, ProviderDriverFactory,
    ProviderEvent, ProviderLaunchRequest, ProviderRuntimeError, ProviderRuntimeSupervisor,
    StartedSession, SupervisorOptions, reconcile_abandoned_provider_sessions,
    route_orchestration_command,
};
use serde_json::{Value, json};
use t4code_server::{
    orchestration::{
        engine::{
            EngineOptions, OrchestrationCommand, OrchestrationEngine, SessionInput,
            ThreadMessageInput,
        },
        load_snapshot,
    },
    persistence::{Database, ProviderSessionRuntime, run_migrations},
};
use tempfile::TempDir;
use tokio::sync::mpsc;

const NOW: &str = "2026-07-10T10:00:00.000Z";

#[derive(Default)]
struct DriverState {
    starts: usize,
    sends: Vec<String>,
    interrupts: Vec<Option<String>>,
    approvals: Vec<(String, String)>,
    answers: Vec<(String, Value)>,
    modes: Vec<String>,
    models: Vec<String>,
    shutdowns: usize,
}

struct FakeDriver {
    state: Arc<StdMutex<DriverState>>,
    events: tokio::sync::Mutex<mpsc::Receiver<ProviderEvent>>,
}

impl ProviderDriver for FakeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().starts += 1;
            Ok(StartedSession {
                resume_cursor: Some(json!({ "sessionId": "provider-session-1" })),
                runtime_payload: Some(json!({ "transport": "native" })),
            })
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
            self.state.lock().unwrap().modes.push(mode);
            Ok(())
        })
    }

    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.state.lock().unwrap().models.push(model);
            Ok(())
        })
    }

    fn rollback(&self, _turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async { Ok(()) })
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
        _request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
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
    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(database, EngineOptions::default())
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
    engine
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
