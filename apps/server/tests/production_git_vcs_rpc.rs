use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use t4code_server::{
    CauseItem, RequestId, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{WebSocketStream, connect_async, tungstenite::Message};

use t4code_server::production::git_vcs::{
    GIT_VCS_STREAM_METHODS, GIT_VCS_UNARY_METHODS, GitVcsRpcServices, register_git_vcs_rpc,
};

#[test]
fn registrar_owns_the_complete_git_vcs_rpc_surface() {
    assert_eq!(
        GIT_VCS_UNARY_METHODS,
        [
            "shell.openInEditor",
            "vcs.pull",
            "vcs.refreshStatus",
            "vcs.listRefs",
            "vcs.listCommits",
            "vcs.createWorktree",
            "vcs.removeWorktree",
            "vcs.clone",
            "vcs.createRef",
            "vcs.switchRef",
            "vcs.init",
            "vcs.stageFiles",
            "vcs.unstageFiles",
            "vcs.discardFiles",
            "vcs.generateCommitMessage",
            "git.resolvePullRequest",
            "git.preparePullRequestThread",
            "server.discoverSourceControl",
            "sourceControl.lookupRepository",
            "sourceControl.cloneRepository",
            "sourceControl.publishRepository",
        ]
    );
    assert_eq!(
        GIT_VCS_STREAM_METHODS,
        ["subscribeVcsStatus", "git.runStackedAction"]
    );
}

#[tokio::test]
async fn registers_native_vcs_handlers_with_unchanged_wire_shapes() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    let mut registry = RpcRegistry::empty();
    register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    let cwd = repository.path().to_string_lossy();
    request(&mut socket, "1", "vcs.init", json!({ "cwd": cwd })).await;
    assert_success_eq(&mut socket, "1", Value::Null).await;

    request(
        &mut socket,
        "2",
        "vcs.listRefs",
        json!({ "cwd": cwd, "limit": 25 }),
    )
    .await;
    let result = success_value(&mut socket, "2").await;
    assert_eq!(result["isRepo"], true);
    assert_eq!(result["refs"], json!([]));
    assert_eq!(result["nextCursor"], Value::Null);
    assert_eq!(result["totalCount"], 0);

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn vcs_status_stream_is_bounded_and_cancellable() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(repository.path())
        .status()
        .expect("git starts")
        .success()
        .then_some(())
        .expect("git init succeeds");

    let mut registry = RpcRegistry::empty();
    register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    request(
        &mut socket,
        "7",
        "subscribeVcsStatus",
        json!({ "cwd": repository.path().to_string_lossy() }),
    )
    .await;
    let snapshot = next_server_message(&mut socket).await;
    assert!(matches!(
        snapshot,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "7"
                && values.len() == 1
                && values[0]["_tag"] == "snapshot"
                && values[0]["local"]["isRepo"] == true
    ));

    send_json(
        &mut socket,
        json!({ "_tag": "Interrupt", "requestId": "7" }),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit { request_id, exit: RpcExit::Failure { cause } }
            if request_id.as_str() == "7"
                && cause == vec![CauseItem::Interrupt { fiber_id: None }]
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_commit_stream_finishes_with_a_decodable_success_event() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    for args in [
        vec!["init", "--quiet"],
        vec!["config", "user.name", "T4Code Test"],
        vec!["config", "user.email", "t4code@example.invalid"],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(repository.path())
                .status()
                .expect("git starts")
                .success()
        );
    }
    std::fs::write(repository.path().join("committed.txt"), "committed\n")
        .expect("write commit fixture");
    assert!(
        std::process::Command::new("git")
            .args(["add", "committed.txt"])
            .current_dir(repository.path())
            .status()
            .expect("git add starts")
            .success()
    );

    let mut registry = RpcRegistry::empty();
    register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    let cwd = repository.path().to_string_lossy();
    request(
        &mut socket,
        "8",
        "git.runStackedAction",
        json!({
            "actionId": "wire-action-1",
            "cwd": cwd,
            "action": "commit",
            "commitMessage": "test: commit over stream",
            "commitStagedIndexAsIs": true,
        }),
    )
    .await;

    let started = next_server_message(&mut socket).await;
    assert!(matches!(
        started,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "8"
                && values.len() == 1
                && values[0]["kind"] == "action_started"
                && values[0]["actionId"] == "wire-action-1"
                && values[0]["cwd"] == cwd.as_ref()
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "8" })).await;
    let finished = next_server_message(&mut socket).await;
    assert!(matches!(
        finished,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "8"
                && values.len() == 1
                && values[0]["kind"] == "action_finished"
                && values[0]["result"]["action"] == "commit"
                && values[0]["result"]["commit"]["status"] == "created"
                && values[0]["result"]["toast"]["cta"]["kind"] == "none"
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "8" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit { request_id, exit: RpcExit::Success { value: None } }
            if request_id.as_str() == "8"
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

async fn request<S>(socket: &mut WebSocketStream<S>, id: &str, tag: &str, payload: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] }),
    )
    .await;
}

async fn assert_success_eq<S>(socket: &mut WebSocketStream<S>, id: &str, expected: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    assert_eq!(success_value(socket, id).await, expected);
}

async fn success_value<S>(socket: &mut WebSocketStream<S>, id: &str) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match next_server_message(socket).await {
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Success { value },
        } if request_id == RequestId::try_from(id).expect("request id") => {
            value.unwrap_or(Value::Null)
        }
        message => panic!("expected successful response for {id}, got {message:?}"),
    }
}

async fn send_json<S>(socket: &mut WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send WebSocket message");
}

async fn next_server_message<S>(socket: &mut WebSocketStream<S>) -> ServerMessage
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = frame else {
        panic!("expected text WebSocket message, got {frame:?}");
    };
    serde_json::from_str(&text).expect("valid server RPC message")
}
