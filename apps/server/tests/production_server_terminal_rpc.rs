use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

use t4code_server::production::server_terminal::{
    JsonFuture, JsonStream, ProductionServerControl, ServerTerminalServices,
    register_server_terminal_rpc,
};
use t4code_server::{
    RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime, cloud, diagnostics,
    provider_usage, terminal,
};

#[derive(Debug)]
struct FixtureControl;

impl ProductionServerControl for FixtureControl {
    fn call(
        &self,
        method: &'static str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> JsonFuture {
        Box::pin(async move {
            Ok(match method {
                "server.getConfig" => json!({ "source": "rust", "payload": payload }),
                "server.getSettings" => json!({ "automaticGitFetchInterval": 30000 }),
                _ => json!({ "method": method, "payload": payload }),
            })
        })
    }

    fn subscribe(&self, method: &'static str, _cancellation: CancellationToken) -> JsonStream {
        let (sender, receiver) = mpsc::channel(2);
        sender
            .try_send(Ok(vec![json!({ "source": "rust", "method": method })]))
            .expect("fixture stream has capacity");
        receiver
    }
}

#[tokio::test]
async fn registrar_serves_concrete_server_and_terminal_metadata_rpcs() {
    let temp = TempDir::new().expect("temporary directory");
    let services = fixture_services();
    let mut registry = RpcRegistry::empty();
    register_server_terminal_rpc(&mut registry, services);
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("Rust server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_request(&mut socket, "1", "server.getConfig", json!({})).await;
    assert_eq!(
        success_value(next_message(&mut socket).await),
        json!({
            "source": "rust",
            "payload": {}
        })
    );

    send_request(&mut socket, "2", "server.getProviderUsage", json!({})).await;
    let usage = success_value(next_message(&mut socket).await);
    assert_eq!(usage["isFetching"], false);
    assert_eq!(usage["providers"][0]["provider"], "claude");
    assert_eq!(usage["providers"][1]["provider"], "codex");

    send_request(&mut socket, "3", "subscribeTerminalMetadata", json!({})).await;
    let chunk = next_message(&mut socket).await;
    assert!(matches!(
        chunk,
        ServerMessage::Chunk { values, .. }
            if values == vec![json!({ "type": "snapshot", "terminals": [] })]
    ));
    send_ack(&mut socket, "3").await;

    let terminal_payload = json!({
        "threadId": "thread-1",
        "terminalId": "term-1",
        "cwd": temp.path().to_string_lossy(),
        "cols": 120,
        "rows": 30,
        "env": {}
    });
    send_request(&mut socket, "4", "terminal.open", terminal_payload.clone()).await;
    let first = next_message(&mut socket).await;
    let second = next_message(&mut socket).await;
    assert_terminal_open_and_metadata_upsert([first, second]);

    send_request(&mut socket, "5", "terminal.open", terminal_payload).await;
    assert!(matches!(
        next_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));

    socket.close(None).await.expect("socket closes");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

fn assert_terminal_open_and_metadata_upsert(messages: [ServerMessage; 2]) {
    assert!(messages.iter().any(|message| matches!(
        message,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    )));
    assert!(messages.iter().any(|message| matches!(
        message,
        ServerMessage::Chunk { values, .. }
            if values.iter().any(|value|
                value["type"] == "upsert"
                    && value["terminal"]["terminalId"] == "term-1"
                    && value["terminal"]["status"] == "running"
            )
    )));
}

#[test]
fn registrar_source_contains_every_owned_rpc_name() {
    let source = include_str!("../src/production/server_terminal.rs");
    for method in [
        "terminal.open",
        "terminal.attach",
        "terminal.write",
        "terminal.resize",
        "terminal.clear",
        "terminal.restart",
        "terminal.close",
        "subscribeTerminalEvents",
        "subscribeTerminalMetadata",
        "server.getConfig",
        "server.getProcessDiagnostics",
        "server.getProcessResourceHistory",
        "server.getProviderUsage",
        "server.getSettings",
        "server.getTraceDiagnostics",
        "server.refreshProviders",
        "server.refreshProviderUsage",
        "server.removeKeybinding",
        "server.signalProcess",
        "server.updateProvider",
        "server.updateSettings",
        "server.upsertKeybinding",
        "subscribeServerConfig",
        "subscribeServerLifecycle",
        "subscribeDiscoveredLocalServers",
        "cloud.getRelayClientStatus",
        "cloud.installRelayClient",
    ] {
        assert!(source.contains(method), "registrar is missing {method}");
    }
}

fn fixture_services() -> ServerTerminalServices {
    let sampler = Arc::new(diagnostics::NativeProcessSampler::default());
    let monitor = Arc::new(diagnostics::DiagnosticsMonitor::new(
        sampler.clone(),
        Duration::from_secs(60),
    ));
    let usage = provider_usage::ProviderUsageService::new(
        Vec::new(),
        Arc::new(time::OffsetDateTime::now_utc),
    );
    let relay = cloud::RelayClientService::new(
        || async {
            cloud::RelayClientStatus::Missing {
                version: "1.0.0".into(),
            }
        },
        |_report| async {
            Ok(cloud::RelayClientStatus::Missing {
                version: "1.0.0".into(),
            })
        },
    );
    ServerTerminalServices::new(
        terminal::TerminalManager::default(),
        sampler,
        monitor,
        usage,
        relay,
        Arc::new(FixtureControl),
    )
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

async fn send_request(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: &str,
    tag: &str,
    payload: Value,
) {
    let message =
        json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] });
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("request sends");
}

async fn send_ack(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    request_id: &str,
) {
    let message = json!({ "_tag": "Ack", "requestId": request_id });
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("acknowledgement sends");
}

async fn next_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> ServerMessage {
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("response timeout")
        .expect("socket remains open")
        .expect("valid socket message");
    let Message::Text(text) = message else {
        panic!("expected text message")
    };
    serde_json::from_str(&text).expect("valid server message")
}

fn success_value(message: ServerMessage) -> Value {
    match message {
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } => value,
        other => panic!("expected successful RPC response, got {other:?}"),
    }
}
