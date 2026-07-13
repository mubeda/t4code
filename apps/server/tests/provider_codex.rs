use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};
use t4code_server::provider::codex::{
    BuildTurnStartInput, CodexRuntimeMode, CodexSessionOptions, CodexSessionRuntime,
    ConnectionConfig, IncomingEvent, JsonRpcConnection, RuntimeEventStableView,
    build_initialize_params, build_turn_start_params, is_recoverable_thread_resume_error,
    parse_model_list_response, parse_skills_list_response, probe_provider,
};

#[test]
fn missing_codex_rollout_is_a_recoverable_resume_failure() {
    assert!(is_recoverable_thread_resume_error(
        "no rollout found for thread id 019f5662-6e5e-70d1-9074-06a0ba8761d0"
    ));
}

#[test]
fn automatic_codex_model_resolves_to_the_supported_default() {
    let payload = build_turn_start_params(&BuildTurnStartInput {
        thread_id: "provider-thread-1".to_owned(),
        runtime_mode: CodexRuntimeMode::FullAccess,
        prompt: Some("hello".to_owned()),
        attachments: vec![],
        model: Some("auto".to_owned()),
        service_tier: None,
        effort: None,
        interaction_mode: Some("default".to_owned()),
    });
    assert_eq!(payload["model"], "gpt-5.4");
    assert_eq!(payload["collaborationMode"]["settings"]["model"], "gpt-5.4");
}
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, duplex},
    sync::mpsc,
    time::timeout,
};

#[tokio::test]
async fn helper_outputs_match_canonical_codex_fixtures() {
    let initialize_fixture = fixture("initialize-params.json");
    assert_eq!(build_initialize_params("0.1.1"), initialize_fixture);

    let default_turn_fixture = fixture("turn-start-default.json");
    assert_eq!(
        build_turn_start_params(&BuildTurnStartInput {
            thread_id: "provider-thread-1".to_owned(),
            runtime_mode: CodexRuntimeMode::AutoAcceptEdits,
            prompt: Some("Implement it".to_owned()),
            attachments: vec![json!({
                "type": "image",
                "url": "data:image/png;base64,abc",
            })],
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            interaction_mode: Some("default".to_owned()),
        }),
        default_turn_fixture
    );

    let plan_turn_fixture = fixture("turn-start-plan.json");
    assert_eq!(
        build_turn_start_params(&BuildTurnStartInput {
            thread_id: "provider-thread-1".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            prompt: Some("Make a plan".to_owned()),
            attachments: vec![],
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: Some("medium".to_owned()),
            interaction_mode: Some("plan".to_owned()),
        }),
        plan_turn_fixture
    );

    let model_fixture = fixture("model-discovery.json");
    let parsed_models = parse_model_list_response(
        &model_fixture["response"],
        &["custom-alpha".to_owned(), "gpt-5.3-codex".to_owned()],
    )
    .expect("models parse");
    assert_eq!(
        serde_json::to_value(parsed_models).expect("models json"),
        model_fixture["parsed"]
    );

    let skills_fixture = fixture("skill-discovery.json");
    let parsed_skills = parse_skills_list_response(
        &skills_fixture["response"],
        skills_fixture["cwd"].as_str().expect("fixture cwd"),
    )
    .expect("skills parse");
    assert_eq!(
        serde_json::to_value(parsed_skills).expect("skills json"),
        skills_fixture["parsed"]
    );
}

#[tokio::test]
async fn probe_matches_fixture_corpus() {
    let scenario = fixture("probe-scenario.json");
    let (connection, _incoming, mut peer) = scripted_peer();
    peer.expect_request("initialize", scenario["initializeRequest"].clone())
        .respond(scenario["initializeResponse"].clone());
    peer.expect_notification("initialized");
    peer.expect_request("account/read", json!({}))
        .respond(scenario["accountResponse"].clone());
    peer.expect_request("model/list", json!({}))
        .respond(scenario["modelListFirst"].clone());
    peer.expect_request("model/list", json!({ "cursor": "cursor-2" }))
        .respond(scenario["modelListSecond"].clone());
    peer.expect_request(
        "skills/list",
        json!({ "cwds": [scenario["cwd"].as_str().expect("cwd")] }),
    )
    .respond(scenario["skillsResponse"].clone());

    let peer_task = tokio::spawn(peer.run());
    let snapshot = probe_provider(
        &connection,
        "0.1.1",
        scenario["cwd"].as_str().expect("cwd"),
        &["custom-alpha".to_owned()],
    )
    .await
    .expect("probe succeeds");
    let expected = scenario["expectedSnapshot"].clone();
    assert_eq!(
        serde_json::to_value(snapshot).expect("snapshot json"),
        expected
    );
    peer_task.await.expect("peer task");
}

#[tokio::test]
async fn session_runtime_matches_text_tool_and_approval_traces() {
    let (connection, incoming, mut peer) = scripted_peer();
    let runtime = CodexSessionRuntime::new(
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "fixture-thread".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            resume_cursor: None,
        },
        connection.clone(),
        incoming,
    );

    peer.expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({
            "userAgent": "mock-codex-app-server",
            "codexHome": "/tmp/codex-home",
            "platformFamily": "unix",
            "platformOs": "linux",
        }));
    peer.expect_notification("initialized");
    peer.expect_request(
        "thread/start",
        json!({
            "cwd": "/tmp/project",
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
            "model": "gpt-5.3-codex",
            "serviceTier": null,
        }),
    )
    .respond(json!({
        "cwd": "/tmp/project",
        "model": "gpt-5.3-codex",
        "thread": { "id": "provider-thread-1" }
    }));
    peer.expect_request(
        "thread/goal/set",
        json!({
            "threadId": "provider-thread-1",
            "objective": "Finish the provider parity work",
            "status": "active",
        }),
    )
    .respond(json!({ "goal": { "status": "active" } }));
    peer.expect_request("turn/start", fixture("turn-start-text.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-1",
                "delta": "I will make a small update.\n"
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-1",
                "delta": "Done.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));
    peer.expect_request("turn/start", fixture("turn-start-tool.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_notification(json!({
            "method": "item/started",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo integration"
                }
            }
        }))
        .emit_notification(json!({
            "method": "item/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo integration"
                }
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-2",
                "delta": "Applied the requested edit.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));
    peer.expect_request("turn/start", fixture("turn-start-approval.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_request(json!({
            "id": 1001,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-approval-1",
                "reason": "Please approve command"
            }
        }))
        .expect_response(json!({
            "id": 1001,
            "result": { "decision": "accept" }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-3",
                "delta": "Approval received and command executed.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));

    let peer_task = tokio::spawn(peer.run());

    runtime.start().await.expect("runtime starts");
    let startup_events = runtime.collect_events(2).await;
    assert_eq!(startup_events[0].event_type, "session.connecting");
    assert_eq!(startup_events[1].event_type, "session.ready");

    runtime
        .set_goal("Finish the provider parity work")
        .await
        .expect("goal is set through app-server");

    runtime
        .send_turn(Some("Small text turn".to_owned()), vec![], None)
        .await
        .expect("text turn");
    let text_events = runtime.collect_events(4).await;
    assert_eq!(text_events, stable_fixture("trace-text.json"));

    runtime
        .send_turn(Some("Run a tool".to_owned()), vec![], None)
        .await
        .expect("tool turn");
    let tool_events = runtime.collect_events(5).await;
    assert_eq!(tool_events, stable_fixture("trace-tool.json"));

    runtime
        .send_turn(Some("Needs approval".to_owned()), vec![], None)
        .await
        .expect("approval turn");
    let mut approval_events = runtime.collect_events(2).await;
    assert_eq!(
        &approval_events[..2],
        &stable_fixture("trace-approval-prefix.json")[..2]
    );
    runtime
        .respond_to_request("approval:1001", "accept")
        .await
        .expect("approval response");
    approval_events.extend(runtime.collect_events(3).await);
    assert_eq!(approval_events, stable_fixture("trace-approval.json"));

    peer_task.await.expect("peer task");
}

#[tokio::test]
async fn reconnect_resume_fallback_and_shutdown_stay_correlated() {
    let reconnect_fixture = fixture("reconnect-scenario.json");

    let (connection_a, incoming_a, mut peer_a) = scripted_peer();
    let runtime = CodexSessionRuntime::new(
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "fixture-thread".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            resume_cursor: None,
        },
        connection_a.clone(),
        incoming_a,
    );
    peer_a
        .expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({ "userAgent": "mock-a" }));
    peer_a.expect_notification("initialized");
    peer_a
        .expect_request(
            "thread/start",
            reconnect_fixture["initialThreadStartRequest"].clone(),
        )
        .respond(reconnect_fixture["initialThreadStartResponse"].clone());
    let peer_a_task = tokio::spawn(peer_a.run());
    runtime.start().await.expect("initial start");
    peer_a_task.await.expect("peer a");

    let (connection_b, incoming_b, mut peer_b) = scripted_peer();
    peer_b
        .expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({ "userAgent": "mock-b" }));
    peer_b.expect_notification("initialized");
    peer_b
        .expect_request("thread/resume", reconnect_fixture["resumeRequest"].clone())
        .respond_error(json!({
            "code": -32603,
            "message": "Thread does not exist"
        }));
    peer_b
        .expect_request(
            "thread/start",
            reconnect_fixture["fallbackThreadStartRequest"].clone(),
        )
        .respond(reconnect_fixture["fallbackThreadStartResponse"].clone());
    peer_b
        .expect_request(
            "thread/rollback",
            json!({
                "threadId": "provider-thread-2",
                "numTurns": 1
            }),
        )
        .respond(json!({
            "thread": {
                "id": "provider-thread-2",
                "turns": [
                    { "id": "fixture-turn", "items": [] }
                ]
            }
        }));
    peer_b
        .expect_request("shutdown", Value::Null)
        .respond(Value::Null);
    let peer_b_task = tokio::spawn(peer_b.run());

    runtime
        .reconnect(connection_b.clone(), incoming_b)
        .await
        .expect("reconnect");
    let rollback = runtime.rollback_thread(1).await.expect("rollback");
    assert_eq!(rollback.thread_id, "provider-thread-2");
    runtime.shutdown().await.expect("shutdown");
    peer_b_task.await.expect("peer b");
}

fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(fixture_directory().join(name)).expect("fixture file"),
    )
    .expect("valid fixture json")
}

fn stable_fixture(name: &str) -> Vec<RuntimeEventStableView> {
    serde_json::from_value(fixture(name)).expect("stable trace fixture")
}

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/codex-provider")
}

fn scripted_peer() -> (
    JsonRpcConnection,
    mpsc::UnboundedReceiver<IncomingEvent>,
    ScriptedPeer,
) {
    let (runtime_stdout, peer_stdout) = duplex(16 * 1024);
    let (peer_stdin, runtime_stdin) = duplex(16 * 1024);
    let (peer_stderr, runtime_stderr) = duplex(16 * 1024);
    let (connection, incoming) = JsonRpcConnection::spawn(
        runtime_stdout,
        runtime_stdin,
        runtime_stderr,
        ConnectionConfig::default(),
    );
    (
        connection,
        incoming,
        ScriptedPeer::new(peer_stdout, peer_stdin, peer_stderr),
    )
}

struct ScriptedPeer {
    stdout: tokio::io::DuplexStream,
    stdin: tokio::io::DuplexStream,
    stderr: tokio::io::DuplexStream,
    steps: Vec<PeerStep>,
}

impl ScriptedPeer {
    fn new(
        stdout: tokio::io::DuplexStream,
        stdin: tokio::io::DuplexStream,
        stderr: tokio::io::DuplexStream,
    ) -> Self {
        Self {
            stdout,
            stdin,
            stderr,
            steps: Vec::new(),
        }
    }

    fn expect_request(&mut self, method: &str, params: Value) -> &mut PeerStep {
        self.steps.push(PeerStep::ExpectRequest {
            method: method.to_owned(),
            params,
            response: None,
            response_error: None,
            emits: Vec::new(),
            expected_follow_up_response: None,
        });
        self.steps.last_mut().expect("request step")
    }

    fn expect_notification(&mut self, method: &str) {
        self.steps.push(PeerStep::ExpectNotification {
            method: method.to_owned(),
        });
    }

    async fn run(self) {
        let mut reader = BufReader::new(self.stdin);
        let mut writer = self.stdout;
        let _stderr = self.stderr;
        for step in self.steps {
            match step {
                PeerStep::ExpectRequest {
                    method,
                    params,
                    response,
                    response_error,
                    emits,
                    expected_follow_up_response,
                } => {
                    let message = read_json_message(&mut reader).await;
                    assert_eq!(message["method"], method);
                    assert_eq!(message["params"], params);
                    if let Some(result) = response {
                        write_json(
                            &mut writer,
                            json!({
                                "id": message["id"].clone(),
                                "result": result,
                            }),
                        )
                        .await;
                    } else if let Some(error) = response_error {
                        write_json(
                            &mut writer,
                            json!({
                                "id": message["id"].clone(),
                                "error": error,
                            }),
                        )
                        .await;
                    }
                    let mut expected_follow_up_response = expected_follow_up_response;
                    for emit in emits {
                        let requires_response =
                            emit.get("id").is_some() && emit.get("method").is_some();
                        write_json(&mut writer, emit).await;
                        if requires_response
                            && let Some(expected_response) = expected_follow_up_response.take()
                        {
                            let follow_up = read_json_message(&mut reader).await;
                            assert_eq!(follow_up, expected_response);
                        }
                    }
                    if let Some(expected_response) = expected_follow_up_response {
                        let follow_up = read_json_message(&mut reader).await;
                        assert_eq!(follow_up, expected_response);
                    }
                }
                PeerStep::ExpectNotification { method } => {
                    let message = read_json_message(&mut reader).await;
                    assert_eq!(message["method"], method);
                    assert!(message.get("id").is_none());
                }
            }
        }
    }
}

enum PeerStep {
    ExpectRequest {
        method: String,
        params: Value,
        response: Option<Value>,
        response_error: Option<Value>,
        emits: Vec<Value>,
        expected_follow_up_response: Option<Value>,
    },
    ExpectNotification {
        method: String,
    },
}

impl PeerStep {
    fn respond(&mut self, result: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { response, .. } = self {
            *response = Some(result);
        }
        self
    }

    fn respond_error(&mut self, error: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { response_error, .. } = self {
            *response_error = Some(error);
        }
        self
    }

    fn emit_notification(&mut self, notification: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { emits, .. } = self {
            emits.push(notification);
        }
        self
    }

    fn emit_request(&mut self, request: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { emits, .. } = self {
            emits.push(request);
        }
        self
    }

    fn expect_response(&mut self, response: Value) -> &mut Self {
        if let PeerStep::ExpectRequest {
            expected_follow_up_response,
            ..
        } = self
        {
            *expected_follow_up_response = Some(response);
        }
        self
    }
}

async fn read_json_message<R>(reader: &mut BufReader<R>) -> Value
where
    R: AsyncRead + Unpin,
{
    let line = timeout(Duration::from_secs(2), async {
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await.expect("read line");
        buffer
    })
    .await
    .expect("message timeout");
    serde_json::from_str(line.trim_end()).expect("valid json line")
}

async fn write_json<W>(writer: &mut W, value: Value)
where
    W: AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    writer
        .write_all(format!("{value}\n").as_bytes())
        .await
        .expect("write json");
    writer.flush().await.expect("flush json");
}
