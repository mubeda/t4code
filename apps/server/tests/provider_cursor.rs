use t4code_server::provider::cursor;

use std::{path::PathBuf, time::Duration};

use cursor::{
    AcpConnectionConfig, AcpJsonRpcConnection, CursorSessionOptions, CursorSessionRuntime,
    build_capabilities_from_config_options, discover_models_from_list_available_models,
    parse_about_output, parse_cli_config_channel, parse_version_date, resolve_acp_base_model_id,
    resolve_acp_config_updates,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, duplex},
    sync::mpsc,
    time::timeout,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    fixtures: Vec<String>,
}

#[test]
fn cursor_fixture_manifest_is_complete() {
    let manifest: FixtureManifest =
        serde_json::from_value(fixture("manifest.json")).expect("manifest");
    assert!(!manifest.fixtures.is_empty());
}

#[test]
fn cursor_helper_outputs_match_fixtures() {
    let about_fixture = fixture("about-authenticated.json");
    assert_eq!(
        serde_json::to_value(parse_about_output(
            about_fixture["code"].as_i64().expect("code") as i32,
            about_fixture["stdout"].as_str().expect("stdout"),
            about_fixture["stderr"].as_str().expect("stderr"),
        ))
        .expect("about json"),
        about_fixture["parsed"]
    );

    let capabilities_fixture = fixture("capabilities.json");
    assert_eq!(
        build_capabilities_from_config_options(&capabilities_fixture["options"]),
        capabilities_fixture["expected"]
    );

    let config_updates_fixture = fixture("config-updates.json");
    assert_eq!(
        serde_json::to_value(resolve_acp_config_updates(
            &config_updates_fixture["options"],
            &config_updates_fixture["updates"],
        ))
        .expect("updates json"),
        config_updates_fixture["expected"]
    );

    let discovery_fixture = fixture("model-discovery.json");
    assert_eq!(
        serde_json::to_value(
            discover_models_from_list_available_models(
                &discovery_fixture["response"],
                &discovery_fixture["customModels"]
                    .as_array()
                    .expect("custom models")
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
            .expect("models"),
        )
        .expect("models json"),
        discovery_fixture["expected"]
    );

    assert_eq!(parse_version_date("2026.04.08-c4e73a3"), Some(20260408));
    assert_eq!(
        parse_cli_config_channel(r#"{ "channel": "lab" }"#).as_deref(),
        Some("lab")
    );
    assert_eq!(
        resolve_acp_base_model_id("gpt-5.4[reasoning=medium,context=272k]"),
        "gpt-5.4"
    );
}

#[tokio::test]
async fn cursor_runtime_matches_approval_and_cancel_traces() {
    let (connection, incoming, mut peer) = scripted_peer();
    let runtime = CursorSessionRuntime::new(
        CursorSessionOptions {
            thread_id: "cursor-thread-1".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: "approval-required".to_owned(),
            model: "default".to_owned(),
            resume_session_id: None,
        },
        connection.clone(),
        incoming,
    );

    peer.expect_request("initialize")
        .respond(json!({ "protocolVersion": 1 }));
    peer.expect_request("authenticate")
        .respond(json!({ "status": "ok" }));
    peer.expect_request("session/create")
        .respond(json!({ "sessionId": "cursor-session-1" }));
    peer.expect_request("session/prompt")
        .emit_request(json!({
            "jsonrpc": "2.0",
            "id": 1001,
            "method": "session/request_permission",
            "params": {
                "toolCall": { "title": "`cat server/package.json`" },
                "options": [
                    { "optionId": "allow-once", "kind": "allow_once" },
                    { "optionId": "allow-always", "kind": "allow_always" },
                    { "optionId": "reject-once", "kind": "reject_once" }
                ]
            }
        }))
        .expect_response(json!({
            "jsonrpc": "2.0",
            "id": 1001,
            "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } }
        }))
        .emit_notification_after_response(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-call-1",
                    "title": "Terminal",
                    "status": "in_progress",
                    "rawInput": { "command": ["cat", "server/package.json"] }
                }
            }
        }))
        .emit_notification_after_response(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-call-1",
                    "title": "Terminal",
                    "status": "completed",
                    "rawInput": { "command": ["cat", "server/package.json"] }
                }
            }
        }))
        .emit_notification_after_response(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hello from mock" }
                }
            }
        }))
        .respond(json!({ "stopReason": "end_turn" }));
    peer.expect_request("session/prompt")
        .emit_request(json!({
            "jsonrpc": "2.0",
            "id": 1002,
            "method": "session/request_permission",
            "params": {
                "toolCall": { "title": "`cat server/package.json`" },
                "options": [
                    { "optionId": "allow-once", "kind": "allow_once" },
                    { "optionId": "allow-always", "kind": "allow_always" },
                    { "optionId": "reject-once", "kind": "reject_once" }
                ]
            }
        }))
        .expect_response(json!({
            "jsonrpc": "2.0",
            "id": 1002,
            "result": { "outcome": { "outcome": "cancelled" } }
        }))
        .expect_notification("session/cancel")
        .respond(json!({ "stopReason": "cancelled" }));

    let peer_task = tokio::spawn(peer.run());
    runtime.start().await.expect("start");

    let approval_runtime = runtime.clone();
    let approval_task =
        tokio::spawn(async move { approval_runtime.send_turn("run a tool call").await });
    let mut approval_events = runtime.collect_events(4).await;
    runtime
        .respond_to_request("approval:1001", "accept")
        .await
        .expect("approval response");
    let approval_turn = approval_task
        .await
        .expect("approval join")
        .expect("approval turn");
    approval_events.extend(runtime.collect_events(5).await);
    assert_eq!(approval_turn, "turn-3");
    assert_eq!(approval_events, stable_fixture("trace-approval.json"));

    let cancel_runtime = runtime.clone();
    let cancel_task =
        tokio::spawn(async move { cancel_runtime.send_turn("cancel this turn").await });
    let cancel_started = runtime.next_event().await.expect("cancel started");
    assert_eq!(cancel_started.event_type, "turn.started");
    let request_opened = runtime.next_event().await.expect("request opened");
    assert_eq!(request_opened.event_type, "request.opened");
    runtime.interrupt_turn().await.expect("interrupt");
    cancel_task
        .await
        .expect("cancel join")
        .expect("cancel turn");
    let mut cancel_events = vec![cancel_started.stable_view(), request_opened.stable_view()];
    cancel_events.extend(runtime.collect_events(2).await);
    assert_eq!(cancel_events, stable_fixture("trace-cancel.json"));

    peer_task.await.expect("peer");
}

fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(fixture_directory().join(name)).expect("fixture file"),
    )
    .expect("valid fixture")
}

fn stable_fixture(name: &str) -> Vec<cursor::CursorRuntimeEventStableView> {
    serde_json::from_value(fixture(name)).expect("stable fixture")
}

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/cursor-provider")
}

fn scripted_peer() -> (
    AcpJsonRpcConnection,
    mpsc::UnboundedReceiver<cursor::IncomingEvent>,
    ScriptedPeer,
) {
    let (runtime_stdout, peer_stdout) = duplex(16 * 1024);
    let (peer_stdin, runtime_stdin) = duplex(16 * 1024);
    let (peer_stderr, runtime_stderr) = duplex(16 * 1024);
    let (connection, incoming) = AcpJsonRpcConnection::spawn(
        runtime_stdout,
        runtime_stdin,
        runtime_stderr,
        AcpConnectionConfig::default(),
    );
    (
        connection,
        incoming,
        ScriptedPeer::new(peer_stdin, peer_stdout, peer_stderr),
    )
}

struct ScriptedPeer {
    stdin_reader: tokio::io::DuplexStream,
    stdout_writer: tokio::io::DuplexStream,
    stderr: tokio::io::DuplexStream,
    steps: Vec<PeerStep>,
}

impl ScriptedPeer {
    fn new(
        stdin_reader: tokio::io::DuplexStream,
        stdout_writer: tokio::io::DuplexStream,
        stderr: tokio::io::DuplexStream,
    ) -> Self {
        Self {
            stdin_reader,
            stdout_writer,
            stderr,
            steps: Vec::new(),
        }
    }

    fn expect_request(&mut self, method: &str) -> &mut PeerStep {
        self.steps.push(PeerStep::ExpectRequest {
            method: method.to_owned(),
            response: None,
            emits: Vec::new(),
            emits_after_follow_up: Vec::new(),
            expected_follow_up: None,
            expected_notification: None,
        });
        self.steps.last_mut().expect("step")
    }

    async fn run(self) {
        let mut reader = BufReader::new(self.stdin_reader);
        let mut writer = self.stdout_writer;
        let _stderr = self.stderr;
        for step in self.steps {
            match step {
                PeerStep::ExpectRequest {
                    method,
                    response,
                    emits,
                    emits_after_follow_up,
                    expected_follow_up,
                    expected_notification,
                } => {
                    let message =
                        read_json_message(&mut reader, &format!("request:{method}")).await;
                    assert_eq!(message["method"], method);
                    for emit in emits {
                        write_json(&mut writer, emit).await;
                    }
                    if let Some(expected_response) = expected_follow_up {
                        let follow_up =
                            read_json_message(&mut reader, &format!("follow-up:{method}")).await;
                        assert_eq!(follow_up, expected_response);
                    }
                    for emit in emits_after_follow_up {
                        write_json(&mut writer, emit).await;
                    }
                    if let Some(expected_notification) = expected_notification {
                        let notification = read_json_message(
                            &mut reader,
                            &format!("notification:{expected_notification}"),
                        )
                        .await;
                        assert_eq!(notification["method"], expected_notification);
                    }
                    if let Some(result) = response {
                        write_json(
                            &mut writer,
                            json!({ "jsonrpc": "2.0", "id": message["id"].clone(), "result": result }),
                        )
                        .await;
                    }
                }
            }
        }
    }
}

enum PeerStep {
    ExpectRequest {
        method: String,
        response: Option<Value>,
        emits: Vec<Value>,
        emits_after_follow_up: Vec<Value>,
        expected_follow_up: Option<Value>,
        expected_notification: Option<String>,
    },
}

impl PeerStep {
    fn respond(&mut self, result: Value) -> &mut Self {
        let PeerStep::ExpectRequest { response, .. } = self;
        *response = Some(result);
        self
    }

    fn emit_request(&mut self, value: Value) -> &mut Self {
        let PeerStep::ExpectRequest { emits, .. } = self;
        emits.push(value);
        self
    }

    fn emit_notification_after_response(&mut self, value: Value) -> &mut Self {
        let PeerStep::ExpectRequest {
            emits_after_follow_up,
            ..
        } = self;
        emits_after_follow_up.push(value);
        self
    }

    fn expect_response(&mut self, value: Value) -> &mut Self {
        let PeerStep::ExpectRequest {
            expected_follow_up, ..
        } = self;
        *expected_follow_up = Some(value);
        self
    }

    fn expect_notification(&mut self, method: &str) -> &mut Self {
        let PeerStep::ExpectRequest {
            expected_notification,
            ..
        } = self;
        *expected_notification = Some(method.to_owned());
        self
    }
}

async fn read_json_message<R>(reader: &mut BufReader<R>, context: &str) -> Value
where
    R: AsyncRead + Unpin,
{
    let line = timeout(Duration::from_secs(5), async {
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await.expect("read line");
        buffer
    })
    .await
    .unwrap_or_else(|_| panic!("message timeout while waiting for {context}"));
    serde_json::from_str(line.trim_end()).expect("valid json")
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
    writer.flush().await.expect("flush");
}
