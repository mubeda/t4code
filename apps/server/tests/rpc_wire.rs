use std::{path::PathBuf, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use t4code_server::{
    ACTIVE_RPC_METHODS, CauseItem, ClientMessage, MethodMode, RequestId, RpcExit, RpcRegistry,
    ServerConfig, ServerMessage, ServerRuntime, WireMessage,
};
use tempfile::TempDir;
use tokio::{process::Command, sync::mpsc, time::timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const HUGE_REQUEST_ID: &str = "900719925474099312345";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    methods: Vec<ManifestMethod>,
    stream_method_count: usize,
    expected_top_level_stream_shapes: usize,
    expected_orchestration_event_shapes: usize,
    stream_shape_fixtures: Vec<String>,
    typed_failure_fixtures: Vec<String>,
    stale_method_identifiers: Vec<String>,
    fixtures: Vec<String>,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
struct ManifestMethod {
    name: String,
    mode: MethodMode,
}

#[test]
fn canonical_effect_fixtures_round_trip_without_losing_request_ids() {
    let fixture_directory = fixture_directory();
    let manifest: Manifest = serde_json::from_str(
        &std::fs::read_to_string(fixture_directory.join("manifest.json"))
            .expect("RPC manifest fixture"),
    )
    .expect("valid RPC manifest");

    for fixture in &manifest.fixtures {
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture_directory.join(fixture)).expect("RPC fixture"),
        )
        .expect("valid RPC fixture");
        let decoded: WireMessage =
            serde_json::from_value(expected.clone()).expect("fixture decodes in Rust");
        let encoded = serde_json::to_value(decoded).expect("fixture re-encodes in Rust");
        assert_eq!(encoded, expected, "fixture mismatch: {fixture}");
    }

    let request: ClientMessage = serde_json::from_value(json!({
        "_tag": "Request",
        "id": HUGE_REQUEST_ID,
        "tag": "server.getConfig",
        "payload": {},
        "headers": []
    }))
    .expect("large request id");
    assert_eq!(
        request.request_id().map(RequestId::as_str),
        Some(HUGE_REQUEST_ID)
    );
}

#[test]
fn rust_registry_matches_the_active_typescript_rpc_group() {
    let manifest: Manifest = serde_json::from_str(
        &std::fs::read_to_string(fixture_directory().join("manifest.json"))
            .expect("RPC manifest fixture"),
    )
    .expect("valid RPC manifest");
    let rust_methods = ACTIVE_RPC_METHODS
        .iter()
        .map(|method| ManifestMethod {
            name: method.name.to_owned(),
            mode: method.mode,
        })
        .collect::<Vec<_>>();

    assert_eq!(rust_methods, manifest.methods);
    assert_eq!(rust_methods.len(), 81);
    assert_eq!(
        rust_methods
            .iter()
            .filter(|method| method.mode == MethodMode::Stream)
            .count(),
        manifest.stream_method_count
    );
    assert_eq!(manifest.expected_top_level_stream_shapes, 54);
    assert_eq!(manifest.expected_orchestration_event_shapes, 22);
    assert_eq!(manifest.stream_shape_fixtures.len(), 54);
    assert!(!manifest.typed_failure_fixtures.is_empty());
    assert_eq!(
        manifest.stale_method_identifiers,
        ["projects.add", "projects.list", "projects.remove"]
    );
}

#[test]
fn request_ids_reject_non_decimal_or_empty_values() {
    for invalid in ["", "-1", "+1", "1.0", " 1", "abc"] {
        assert!(
            RequestId::try_from(invalid).is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn chunks_reject_empty_value_arrays() {
    let error = serde_json::from_value::<ServerMessage>(json!({
        "_tag": "Chunk",
        "requestId": "1",
        "values": []
    }))
    .expect_err("Effect chunks are non-empty");

    assert!(error.to_string().contains("at least one value"));
}

#[tokio::test]
async fn websocket_handles_ping_and_lossless_unary_requests() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.echo", |request, _cancellation| async move {
        Ok(request.payload)
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_json(&mut socket, json!({ "_tag": "Ping" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Pong
    ));

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": HUGE_REQUEST_ID,
            "tag": "fixture.echo",
            "payload": { "value": "echo" },
            "headers": []
        }),
    )
    .await;
    let response = next_server_message(&mut socket).await;
    assert_eq!(
        response.request_id().map(RequestId::as_str),
        Some(HUGE_REQUEST_ID)
    );
    assert!(matches!(
        response,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value == json!({ "value": "echo" })
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn unchanged_typescript_effect_client_calls_the_rust_server() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("filesystem.browse", |_request, _cancellation| async move {
        Ok(json!({
            "parentPath": "C:\\fixture",
            "entries": []
        }))
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = workspace_root.join("packages/client-runtime/scripts/rust-rpc-compat-smoke.ts");

    let status = Command::new("node")
        .arg(script)
        .arg(format!("ws://{}/ws", handle.local_addr()))
        .current_dir(&workspace_root)
        .status()
        .await
        .expect("launch unchanged TypeScript client");

    assert!(status.success(), "TypeScript Effect client exited {status}");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn websocket_accepts_batched_client_messages() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.echo", |request, _cancellation| async move {
        Ok(request.payload)
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_json(
        &mut socket,
        json!([
            { "_tag": "Ping" },
            {
                "_tag": "Request",
                "id": "8",
                "tag": "fixture.echo",
                "payload": { "batched": true },
                "headers": []
            }
        ]),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Pong
    ));
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value == json!({ "batched": true })
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn malformed_frames_and_unknown_methods_return_effect_errors() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(test_config(&temp), RpcRegistry::empty())
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    socket
        .send(Message::Text("not-json".into()))
        .await
        .expect("send malformed frame");
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::ClientProtocolError { .. }
    ));

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "9",
            "tag": "fixture.unknown",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Defect { defect }
            if defect == json!("Unknown request tag: fixture.unknown")
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stream_waits_for_one_ack_per_chunk() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_stream("fixture.stream", |_request, _cancellation| {
        let (sender, receiver) = mpsc::channel(1);
        sender
            .try_send(Ok(vec![json!({ "sequence": 1 }), json!({ "sequence": 2 })]))
            .expect("batched items");
        receiver
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "42",
            "tag": "fixture.stream",
            "payload": {},
            "headers": []
        }),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { values, .. }
            if values == vec![json!({ "sequence": 1 }), json!({ "sequence": 2 })]
    ));
    assert!(
        timeout(Duration::from_millis(100), next_server_message(&mut socket))
            .await
            .is_err(),
        "stream completed before the batched Chunk was acknowledged"
    );
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "42" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: None },
            ..
        }
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn eof_still_allows_stream_acknowledgements_before_shutdown() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_stream("fixture.stream", |_request, _cancellation| {
        let (sender, receiver) = mpsc::channel(2);
        sender.try_send(Ok(vec![json!(1)])).expect("first item");
        sender.try_send(Ok(vec![json!(2)])).expect("second item");
        receiver
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "10",
            "tag": "fixture.stream",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { .. }
    ));
    send_json(&mut socket, json!({ "_tag": "Eof" })).await;
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "10" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { .. }
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "10" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: None },
            ..
        }
    ));

    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn panicking_handlers_return_a_connection_defect_without_leaking_the_request() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.panic", |_request, _cancellation| async move {
        panic!("fixture panic")
    });
    registry.register_unary("fixture.echo", |request, _cancellation| async move {
        Ok(request.payload)
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "11",
            "tag": "fixture.panic",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Defect { defect }
            if defect.as_str().is_some_and(|message| message.contains("fixture panic"))
    ));

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "12",
            "tag": "fixture.echo",
            "payload": { "released": true },
            "headers": []
        }),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value == json!({ "released": true })
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn graceful_shutdown_cancels_open_websocket_sessions() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(test_config(&temp), RpcRegistry::empty())
        .await
        .expect("server starts");
    let (_socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("server shutdown must not wait for an idle WebSocket")
        .expect("server joins");
}

#[tokio::test]
async fn interrupt_cancels_an_in_flight_request_and_returns_an_interrupt_exit() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.pending", |_request, cancellation| async move {
        cancellation.cancelled().await;
        Ok(Value::Null)
    });
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "77",
            "tag": "fixture.pending",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    send_json(
        &mut socket,
        json!({ "_tag": "Interrupt", "requestId": "77" }),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Failure { cause },
            ..
        } if cause == vec![CauseItem::Interrupt { fiber_id: None }]
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures/rpc-wire")
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send WebSocket message");
}

async fn next_server_message<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> ServerMessage
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = message else {
        panic!("expected text WebSocket message, got {message:?}");
    };
    serde_json::from_str(&text).expect("valid server RPC message")
}
