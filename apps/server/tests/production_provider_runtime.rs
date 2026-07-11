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
    StartedSession, SupervisorOptions, route_orchestration_command,
};
use serde_json::{Value, json};
use t4code_server::{
    orchestration::engine::{
        EngineOptions, OrchestrationCommand, OrchestrationEngine, ThreadMessageInput,
    },
    persistence::{Database, run_migrations},
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
        resume_cursor: None,
        environment: Default::default(),
        endpoint: None,
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
    let factory = NativeProviderDriverFactory;
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
    let factory = NativeProviderDriverFactory;
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
