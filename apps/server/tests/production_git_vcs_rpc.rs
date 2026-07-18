use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use t4code_server::{
    CauseItem, RequestId, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

use t4code_server::production::git_vcs::{
    GIT_VCS_STREAM_METHODS, GIT_VCS_UNARY_METHODS, GitVcsRpcServices, register_git_vcs_rpc,
};

const ISOLATED_GIT_TEST: &str = "T4CODE_PRODUCTION_GIT_VCS_RPC_ISOLATED";
static ISOLATED_GIT_TEST_LOCK: Mutex<()> = Mutex::new(());

type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct GitServerHarness {
    handle: Option<t4code_server::ServerHandle>,
    socket: Option<TestSocket>,
}

impl GitServerHarness {
    async fn start(temp: &TempDir) -> Self {
        let mut registry = RpcRegistry::empty();
        register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
        let handle = ServerRuntime::start_with_registry(test_config(temp), registry)
            .await
            .expect("server starts");
        let (socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket connects");
        Self {
            handle: Some(handle),
            socket: Some(socket),
        }
    }

    fn socket(&mut self) -> &mut TestSocket {
        self.socket.as_mut().expect("active test socket")
    }

    async fn shutdown(mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None).await;
        }
        if let Some(handle) = self.handle.take() {
            handle.shutdown();
            let _ = handle.join().await;
        }
    }
}

impl Drop for GitServerHarness {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.as_ref() {
            handle.shutdown();
        }
    }
}

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
async fn generate_commit_message_is_empty_when_there_are_no_changes() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    let (handle, mut socket) = start_git_server(&temp).await;

    request(
        &mut socket,
        "6",
        "vcs.generateCommitMessage",
        json!({ "cwd": repository.path().to_string_lossy() }),
    )
    .await;
    assert_success_eq(&mut socket, "6", json!({ "message": "" })).await;

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
        vec!["config", "core.autocrlf", "false"],
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

#[tokio::test]
async fn stacked_commit_generates_a_message_when_the_ui_leaves_it_empty() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    for args in [
        vec!["init", "--quiet"],
        vec!["config", "user.name", "T4Code Test"],
        vec!["config", "user.email", "t4code@example.invalid"],
        vec!["config", "core.autocrlf", "false"],
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
    std::fs::write(repository.path().join("generated.txt"), "generated\n")
        .expect("write commit fixture");
    assert!(
        std::process::Command::new("git")
            .args(["add", "generated.txt"])
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
        "9",
        "git.runStackedAction",
        json!({
            "actionId": "wire-action-generated",
            "cwd": cwd,
            "action": "commit",
            "commitStagedIndexAsIs": true,
        }),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "9"
                && values.len() == 1
                && values[0]["kind"] == "action_started"
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "9" })).await;
    let finished = next_server_message(&mut socket).await;
    assert!(matches!(
        finished,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "9"
                && values.len() == 1
                && values[0]["kind"] == "action_finished"
                && values[0]["result"]["commit"]["status"] == "created"
                && values[0]["result"]["commit"]["subject"] == "Update generated.txt"
    ));

    let subject = std::process::Command::new("git")
        .args(["log", "-1", "--pretty=%s"])
        .current_dir(repository.path())
        .output()
        .expect("git log starts");
    assert!(subject.status.success());
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "Update generated.txt"
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_feature_branch_commit_creates_and_switches_the_branch_first() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    for args in [
        vec!["init", "--quiet"],
        vec!["config", "user.name", "T4Code Test"],
        vec!["config", "user.email", "t4code@example.invalid"],
        vec!["config", "core.autocrlf", "false"],
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
    std::fs::write(repository.path().join("base.txt"), "base\n").expect("write base fixture");
    for args in [
        vec!["add", "base.txt"],
        vec!["commit", "--quiet", "-m", "base"],
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
    let original_branch = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(repository.path())
        .output()
        .expect("read original branch");
    let original_branch = String::from_utf8_lossy(&original_branch.stdout)
        .trim()
        .to_owned();
    std::fs::write(repository.path().join("feature.txt"), "feature\n")
        .expect("write feature fixture");
    assert!(
        std::process::Command::new("git")
            .args(["add", "feature.txt"])
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
        "10",
        "git.runStackedAction",
        json!({
            "actionId": "wire-action-feature",
            "cwd": cwd,
            "action": "commit",
            "featureBranch": true,
            "commitStagedIndexAsIs": true,
        }),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "10"
                && values.len() == 1
                && values[0]["kind"] == "action_started"
                && values[0]["phases"] == json!(["branch", "commit"])
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "10" })).await;
    let finished = next_server_message(&mut socket).await;
    let ServerMessage::Chunk { request_id, values } = finished else {
        panic!("expected action_finished chunk");
    };
    assert_eq!(request_id.as_str(), "10");
    assert_eq!(values.len(), 1);
    assert_eq!(values[0]["kind"], "action_finished");
    assert_eq!(values[0]["result"]["branch"]["status"], "created");
    let created_branch = values[0]["result"]["branch"]["name"]
        .as_str()
        .expect("created branch name");
    assert_eq!(created_branch, "feature/update-feature-txt");
    assert_ne!(created_branch, original_branch);

    let current_branch = std::process::Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(repository.path())
        .output()
        .expect("read current branch");
    assert!(current_branch.status.success());
    assert_eq!(
        String::from_utf8_lossy(&current_branch.stdout).trim(),
        created_branch
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_commit_as_is_preserves_newer_unstaged_edits() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    for args in [
        vec!["init", "--quiet"],
        vec!["config", "user.name", "T4Code Test"],
        vec!["config", "user.email", "t4code@example.invalid"],
        vec!["config", "core.autocrlf", "false"],
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
    let tracked = repository.path().join("tracked.txt");
    std::fs::write(&tracked, "base\n").expect("write base fixture");
    for args in [
        vec!["add", "tracked.txt"],
        vec!["commit", "--quiet", "-m", "base"],
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
    std::fs::write(&tracked, "staged\n").expect("write staged fixture");
    assert!(
        std::process::Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(repository.path())
            .status()
            .expect("git add starts")
            .success()
    );
    std::fs::write(&tracked, "unstaged\n").expect("write unstaged fixture");

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
        "11",
        "git.runStackedAction",
        json!({
            "actionId": "wire-action-index-as-is",
            "cwd": cwd,
            "action": "commit",
            "commitMessage": "test: preserve the staged snapshot",
            "filePaths": ["tracked.txt"],
            "commitStagedIndexAsIs": true,
        }),
    )
    .await;

    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "11"
                && values.len() == 1
                && values[0]["kind"] == "action_started"
    ));
    send_json(&mut socket, json!({ "_tag": "Ack", "requestId": "11" })).await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Chunk { request_id, values }
            if request_id.as_str() == "11"
                && values.len() == 1
                && values[0]["kind"] == "action_finished"
    ));

    let committed = std::process::Command::new("git")
        .args(["show", "HEAD:tracked.txt"])
        .current_dir(repository.path())
        .output()
        .expect("git show starts");
    assert!(committed.status.success());
    assert_eq!(String::from_utf8_lossy(&committed.stdout), "staged\n");
    assert_eq!(
        std::fs::read_to_string(&tracked).expect("read worktree"),
        "unstaged\n"
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_selected_commit_excludes_unrelated_staged_files() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    std::fs::write(repository.path().join("a.txt"), "base a\n").expect("write base a");
    std::fs::write(repository.path().join("b.txt"), "base b\n").expect("write base b");
    run_git(&repository, &["add", "-A"]);
    run_git(&repository, &["commit", "--quiet", "-m", "base"]);

    std::fs::write(repository.path().join("a.txt"), "selected a\n").expect("write selected a");
    std::fs::write(repository.path().join("b.txt"), "unrelated b\n").expect("write unrelated b");
    run_git(&repository, &["add", "b.txt"]);

    let (handle, mut socket) = start_git_server(&temp).await;
    let result = run_stacked_action(
        &mut socket,
        "12",
        json!({
            "actionId": "wire-action-selected",
            "cwd": repository.path().to_string_lossy(),
            "action": "commit",
            "commitMessage": "test: commit only the selection",
            "filePaths": ["a.txt"],
        }),
    )
    .await;
    assert_eq!(result["kind"], "action_finished");
    assert_eq!(result["result"]["commit"]["status"], "created");

    assert_eq!(
        git_stdout(&repository, &["show", "HEAD:a.txt"]),
        "selected a\n"
    );
    assert_eq!(git_stdout(&repository, &["show", "HEAD:b.txt"]), "base b\n");
    assert_eq!(
        git_stdout(&repository, &["status", "--short"]),
        " M b.txt\n"
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_commit_without_paths_stages_all_changes() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
    run_git(&repository, &["add", "tracked.txt"]);
    run_git(&repository, &["commit", "--quiet", "-m", "base"]);
    std::fs::write(repository.path().join("tracked.txt"), "updated\n").expect("update tracked");
    std::fs::write(repository.path().join("untracked.txt"), "new\n").expect("write untracked");

    let (handle, mut socket) = start_git_server(&temp).await;
    let result = run_stacked_action(
        &mut socket,
        "13",
        json!({
            "actionId": "wire-action-all",
            "cwd": repository.path().to_string_lossy(),
            "action": "commit",
            "commitMessage": "test: commit all changes",
        }),
    )
    .await;
    assert_eq!(result["kind"], "action_finished");
    assert_eq!(result["result"]["commit"]["status"], "created");
    assert_eq!(
        git_stdout(&repository, &["show", "HEAD:tracked.txt"]),
        "updated\n"
    );
    assert_eq!(
        git_stdout(&repository, &["show", "HEAD:untracked.txt"]),
        "new\n"
    );
    assert_eq!(git_stdout(&repository, &["status", "--short"]), "");

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_clean_commit_is_a_successful_no_op() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
    run_git(&repository, &["add", "tracked.txt"]);
    run_git(&repository, &["commit", "--quiet", "-m", "base"]);

    let (handle, mut socket) = start_git_server(&temp).await;
    let result = run_stacked_action(
        &mut socket,
        "14",
        json!({
            "actionId": "wire-action-clean",
            "cwd": repository.path().to_string_lossy(),
            "action": "commit",
        }),
    )
    .await;
    assert_eq!(result["kind"], "action_finished");
    assert_eq!(result["result"]["commit"]["status"], "skipped_no_changes");
    assert_eq!(
        git_stdout(&repository, &["log", "--oneline"])
            .lines()
            .count(),
        1
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_feature_branch_rejects_a_clean_worktree_without_creating_a_branch() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
    run_git(&repository, &["add", "tracked.txt"]);
    run_git(&repository, &["commit", "--quiet", "-m", "base"]);
    let original_branch = git_stdout(&repository, &["branch", "--show-current"]);

    let (handle, mut socket) = start_git_server(&temp).await;
    let result = run_stacked_action(
        &mut socket,
        "15",
        json!({
            "actionId": "wire-action-clean-feature",
            "cwd": repository.path().to_string_lossy(),
            "action": "commit",
            "featureBranch": true,
        }),
    )
    .await;
    assert_eq!(result["kind"], "action_failed");
    assert!(
        result["message"]
            .as_str()
            .expect("failure message")
            .contains("no changes to commit")
    );
    assert_eq!(
        git_stdout(&repository, &["branch", "--show-current"]),
        original_branch
    );
    assert_eq!(
        git_stdout(&repository, &["branch", "--format=%(refname:short)"])
            .lines()
            .count(),
        1
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn stacked_create_pr_rejects_dirty_worktree_before_push() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
    run_git(&repository, &["add", "tracked.txt"]);
    run_git(&repository, &["commit", "--quiet", "-m", "base"]);
    std::fs::write(repository.path().join("tracked.txt"), "dirty\n").expect("dirty worktree");

    let (handle, mut socket) = start_git_server(&temp).await;
    let result = run_stacked_action(
        &mut socket,
        "16",
        json!({
            "actionId": "wire-action-dirty-pr",
            "cwd": repository.path().to_string_lossy(),
            "action": "create_pr",
        }),
    )
    .await;
    assert_eq!(result["kind"], "action_failed");
    assert_eq!(
        result["message"],
        "Commit local changes before creating a PR."
    );

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn list_refs_commits_and_ref_lifecycle_round_trip_over_rpc() {
    if relaunch_with_isolated_git_config("list_refs_commits_and_ref_lifecycle_round_trip_over_rpc")
    {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = root.path().join("refs-remote.git");
    fs::create_dir(&remote).expect("create bare remote directory");
    run_git_in(&remote, &["init", "--bare", "--initial-branch=main"]);

    let repository = root.path().join("refs-repository");
    fs::create_dir(&repository).expect("create repository directory");
    initialize_repository_in(&repository);
    commit_file(&repository, "first.txt", "one\n", "first");
    commit_file(&repository, "second.txt", "two\n", "second");
    commit_file(&repository, "third.txt", "three\n", "third");
    let remote_url = local_file_url(&remote);
    run_git_in(&repository, &["remote", "add", "origin", &remote_url]);
    run_git_in(&repository, &["push", "-u", "origin", "main"]);
    run_git_in(&repository, &["switch", "-c", "feature/one"]);
    commit_file(&repository, "feature.txt", "feature\n", "feature work");
    run_git_in(&repository, &["push", "-u", "origin", "feature/one"]);
    run_git_in(&repository, &["switch", "main"]);

    let worktree_parent = root.path().join("worktrees");
    fs::create_dir(&worktree_parent).expect("create worktree parent");
    let worktree_path = worktree_parent.join("feature-worktree");

    let mut server = GitServerHarness::start(&temp).await;
    let cwd = repository.to_string_lossy();

    request(
        server.socket(),
        "201",
        "vcs.listCommits",
        json!({ "cwd": cwd, "limit": 2 }),
    )
    .await;
    let first_page = success_value(server.socket(), "201").await;
    assert_eq!(
        first_page["commits"]
            .as_array()
            .expect("first history page")
            .len(),
        2
    );
    assert_eq!(first_page["commits"][0]["subject"], "third");
    assert_eq!(first_page["commits"][1]["subject"], "second");
    assert_eq!(first_page["nextCursor"], 2);

    request(
        server.socket(),
        "202",
        "vcs.listCommits",
        json!({ "cwd": cwd, "limit": 2, "cursor": 2 }),
    )
    .await;
    let second_page = success_value(server.socket(), "202").await;
    assert_eq!(
        second_page["commits"]
            .as_array()
            .expect("second page")
            .len(),
        1
    );
    assert_eq!(second_page["commits"][0]["subject"], "first");
    assert_eq!(second_page["nextCursor"], Value::Null);

    request(
        server.socket(),
        "203",
        "vcs.createRef",
        json!({ "cwd": cwd, "refName": "feature/rpc-created", "switchRef": true }),
    )
    .await;
    assert_success_eq(
        server.socket(),
        "203",
        json!({ "refName": "feature/rpc-created" }),
    )
    .await;
    assert_eq!(
        git_stdout_in(&repository, &["branch", "--show-current"]).trim(),
        "feature/rpc-created"
    );

    request(
        server.socket(),
        "204",
        "vcs.switchRef",
        json!({ "cwd": cwd, "refName": "main" }),
    )
    .await;
    assert_success_eq(server.socket(), "204", json!({ "refName": "main" })).await;
    assert_eq!(
        git_stdout_in(&repository, &["branch", "--show-current"]).trim(),
        "main"
    );

    request(
        server.socket(),
        "205",
        "vcs.createWorktree",
        json!({
            "cwd": cwd,
            "refName": "main",
            "newRefName": "feature/worktree",
            "baseRefName": "main",
            "path": worktree_path,
        }),
    )
    .await;
    let created_worktree = success_value(server.socket(), "205").await;
    assert_eq!(
        created_worktree["worktree"]["refName"],
        json!("feature/worktree")
    );
    assert_eq!(
        canonical_path(
            created_worktree["worktree"]["path"]
                .as_str()
                .expect("worktree path"),
        ),
        canonical_path(&worktree_path)
    );
    assert!(worktree_path.exists());

    request(
        server.socket(),
        "206",
        "vcs.listRefs",
        json!({ "cwd": cwd, "limit": 2 }),
    )
    .await;
    let paged_refs = success_value(server.socket(), "206").await;
    assert_eq!(paged_refs["isRepo"], true);
    assert_eq!(paged_refs["hasPrimaryRemote"], true);
    assert_eq!(paged_refs["nextCursor"], 2);
    assert_eq!(paged_refs["totalCount"], 4);
    let first_ref_names = paged_refs["refs"]
        .as_array()
        .expect("first ref page")
        .iter()
        .map(|reference| reference["name"].as_str().expect("first-page ref name"))
        .collect::<Vec<_>>();
    assert_eq!(first_ref_names, vec!["main", "feature/one"]);

    request(
        server.socket(),
        "207",
        "vcs.listRefs",
        json!({ "cwd": cwd, "cursor": 2, "limit": 2 }),
    )
    .await;
    let remaining_refs = success_value(server.socket(), "207").await;
    assert_eq!(remaining_refs["isRepo"], true);
    assert_eq!(remaining_refs["hasPrimaryRemote"], true);
    assert_eq!(remaining_refs["nextCursor"], Value::Null);
    assert_eq!(remaining_refs["totalCount"], paged_refs["totalCount"]);
    let remaining_ref_names = remaining_refs["refs"]
        .as_array()
        .expect("remaining ref page")
        .iter()
        .map(|reference| reference["name"].as_str().expect("remaining-page ref name"))
        .collect::<Vec<_>>();
    assert_eq!(
        remaining_ref_names,
        vec!["feature/rpc-created", "feature/worktree"]
    );
    assert!(
        first_ref_names
            .iter()
            .all(|name| !remaining_ref_names.contains(name))
    );

    request(
        server.socket(),
        "208",
        "vcs.listRefs",
        json!({ "cwd": cwd, "query": "feature/", "refKind": "local", "limit": 20 }),
    )
    .await;
    let local_feature_refs = success_value(server.socket(), "208").await;
    let local_names = local_feature_refs["refs"]
        .as_array()
        .expect("local feature refs")
        .iter()
        .map(|reference| reference["name"].as_str().expect("local ref name"))
        .collect::<Vec<_>>();
    assert!(local_names.contains(&"feature/one"));
    assert!(local_names.contains(&"feature/rpc-created"));
    assert!(local_names.contains(&"feature/worktree"));
    assert!(
        local_feature_refs["refs"]
            .as_array()
            .expect("local refs array")
            .iter()
            .all(|reference| reference["isRemote"] == false)
    );
    let worktree_ref = local_feature_refs["refs"]
        .as_array()
        .expect("local refs array")
        .iter()
        .find(|reference| reference["name"] == "feature/worktree")
        .expect("worktree ref listed");
    assert_eq!(
        canonical_path(
            worktree_ref["worktreePath"]
                .as_str()
                .expect("listed worktree path"),
        ),
        canonical_path(&worktree_path)
    );

    request(
        server.socket(),
        "209",
        "vcs.listRefs",
        json!({
            "cwd": cwd,
            "query": "feature/",
            "refKind": "remote",
            "includeMatchingRemoteRefs": true,
            "limit": 20
        }),
    )
    .await;
    let remote_feature_refs = success_value(server.socket(), "209").await;
    let remote_names = remote_feature_refs["refs"]
        .as_array()
        .expect("remote feature refs")
        .iter()
        .map(|reference| reference["name"].as_str().expect("remote ref name"))
        .collect::<Vec<_>>();
    assert_eq!(remote_names, vec!["origin/feature/one"]);
    assert_eq!(remote_feature_refs["refs"][0]["isRemote"], true);
    assert_eq!(remote_feature_refs["refs"][0]["remoteName"], "origin");

    server.shutdown().await;
}

#[tokio::test]
async fn stage_unstage_discard_and_invalid_pathspecs_round_trip_over_rpc() {
    if relaunch_with_isolated_git_config(
        "stage_unstage_discard_and_invalid_pathspecs_round_trip_over_rpc",
    ) {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let repository = root.path().join("stage-repository");
    fs::create_dir(&repository).expect("create repository directory");
    initialize_repository_in(&repository);
    commit_file(&repository, "tracked.txt", "base\n", "base");
    fs::write(repository.join("tracked.txt"), "staged\n").expect("write staged tracked file");
    fs::create_dir_all(repository.join("selected/nested")).expect("create selected fixture");
    fs::write(repository.join("selected/nested/file.txt"), "remove me\n")
        .expect("write selected fixture");
    fs::write(repository.join("keep.txt"), "keep\n").expect("write keep fixture");

    let mut server = GitServerHarness::start(&temp).await;
    let cwd = repository.to_string_lossy();

    request(
        server.socket(),
        "301",
        "vcs.stageFiles",
        json!({ "cwd": cwd, "filePaths": ["tracked.txt"] }),
    )
    .await;
    assert_success_eq(server.socket(), "301", Value::Null).await;

    request(
        server.socket(),
        "302",
        "vcs.refreshStatus",
        json!({ "cwd": cwd }),
    )
    .await;
    let staged_status = success_value(server.socket(), "302").await;
    let staged_files = staged_status["workingTree"]["files"]
        .as_array()
        .expect("staged file list");
    assert!(staged_files.iter().any(|file| {
        file["path"] == "tracked.txt" && file["area"] == "staged" && file["status"] == "modified"
    }));
    assert!(
        staged_files.iter().any(|file| {
            file["path"] == "selected/nested/file.txt" && file["area"] == "untracked"
        })
    );

    request(
        server.socket(),
        "303",
        "vcs.unstageFiles",
        json!({ "cwd": cwd, "filePaths": ["tracked.txt"] }),
    )
    .await;
    assert_success_eq(server.socket(), "303", Value::Null).await;

    request(
        server.socket(),
        "304",
        "vcs.refreshStatus",
        json!({ "cwd": cwd }),
    )
    .await;
    let unstaged_status = success_value(server.socket(), "304").await;
    let unstaged_files = unstaged_status["workingTree"]["files"]
        .as_array()
        .expect("unstaged file list");
    assert!(unstaged_files.iter().any(|file| {
        file["path"] == "tracked.txt" && file["area"] == "unstaged" && file["status"] == "modified"
    }));
    assert!(
        unstaged_files.iter().any(|file| {
            file["path"] == "selected/nested/file.txt" && file["area"] == "untracked"
        })
    );

    request(
        server.socket(),
        "305",
        "vcs.discardFiles",
        json!({ "cwd": cwd, "filePaths": ["tracked.txt", "selected/nested/file.txt"] }),
    )
    .await;
    assert_success_eq(server.socket(), "305", Value::Null).await;
    assert_eq!(
        fs::read_to_string(repository.join("tracked.txt")).expect("tracked contents"),
        "base\n"
    );
    assert!(!repository.join("selected/nested/file.txt").exists());
    assert!(repository.join("keep.txt").exists());

    request(
        server.socket(),
        "306",
        "vcs.refreshStatus",
        json!({ "cwd": cwd }),
    )
    .await;
    let discarded_status = success_value(server.socket(), "306").await;
    let discarded_files = discarded_status["workingTree"]["files"]
        .as_array()
        .expect("discarded file list");
    assert!(
        discarded_files
            .iter()
            .all(|file| file["path"] != "tracked.txt")
    );
    assert!(
        discarded_files
            .iter()
            .all(|file| file["path"] != "selected/nested/file.txt")
    );
    assert!(
        discarded_files
            .iter()
            .any(|file| file["path"] == "keep.txt" && file["area"] == "untracked")
    );

    request(
        server.socket(),
        "307",
        "vcs.stageFiles",
        json!({ "cwd": cwd, "filePaths": ["../escape.txt"] }),
    )
    .await;
    let invalid_pathspec = failure_value(server.socket(), "307").await;
    assert_eq!(invalid_pathspec["_tag"], "GitCommandError");
    assert_eq!(invalid_pathspec["operation"], "GitVcsDriver.stageFiles");
    assert!(
        invalid_pathspec["detail"]
            .as_str()
            .expect("invalid pathspec detail")
            .contains("repository-relative")
    );

    server.shutdown().await;
}

#[tokio::test]
async fn clone_pull_and_worktree_lifecycle_round_trip_over_rpc() {
    if relaunch_with_isolated_git_config("clone_pull_and_worktree_lifecycle_round_trip_over_rpc") {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = root.path().join("clone-remote.git");
    fs::create_dir(&remote).expect("create clone remote directory");
    run_git_in(&remote, &["init", "--bare", "--initial-branch=main"]);

    let publisher = root.path().join("publisher");
    fs::create_dir(&publisher).expect("create publisher directory");
    initialize_repository_in(&publisher);
    commit_file(&publisher, "tracked.txt", "base\n", "initial");
    let remote_url = local_file_url(&remote);
    run_git_in(&publisher, &["remote", "add", "origin", &remote_url]);
    run_git_in(&publisher, &["push", "-u", "origin", "main"]);

    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("create clone parent");
    let worktree_parent = root.path().join("worktrees");
    fs::create_dir(&worktree_parent).expect("create worktree parent");
    let worktree_path = worktree_parent.join("feature-pull-worktree");

    let mut server = GitServerHarness::start(&temp).await;

    request(
        server.socket(),
        "401",
        "vcs.clone",
        json!({
            "url": remote_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let clone_result = success_value(server.socket(), "401").await;
    let consumer = PathBuf::from(
        clone_result["path"]
            .as_str()
            .expect("clone destination path"),
    );
    assert!(consumer.exists());
    initialize_repository_identity(&consumer);

    let consumer_cwd = consumer.to_string_lossy();
    request(
        server.socket(),
        "402",
        "vcs.pull",
        json!({ "cwd": consumer_cwd }),
    )
    .await;
    let skipped_pull = success_value(server.socket(), "402").await;
    assert_eq!(skipped_pull["status"], "skipped_up_to_date");
    assert_eq!(skipped_pull["refName"], "main");
    assert_eq!(skipped_pull["upstreamRef"], "origin/main");

    commit_file(
        &publisher,
        "tracked.txt",
        "remote change\n",
        "remote update",
    );
    run_git_in(&publisher, &["push"]);

    request(
        server.socket(),
        "403",
        "vcs.pull",
        json!({ "cwd": consumer_cwd }),
    )
    .await;
    let pulled = success_value(server.socket(), "403").await;
    assert_eq!(pulled["status"], "pulled");
    assert_eq!(
        fs::read_to_string(consumer.join("tracked.txt"))
            .expect("pulled tracked contents")
            .replace("\r\n", "\n"),
        "remote change\n"
    );

    request(
        server.socket(),
        "404",
        "vcs.createWorktree",
        json!({
            "cwd": consumer_cwd,
            "refName": "main",
            "newRefName": "feature/pull-worktree",
            "baseRefName": "main",
            "path": worktree_path,
        }),
    )
    .await;
    let created_worktree = success_value(server.socket(), "404").await;
    assert_eq!(
        created_worktree["worktree"]["refName"],
        "feature/pull-worktree"
    );
    assert!(worktree_path.exists());
    fs::write(worktree_path.join("dirty.txt"), "dirty\n").expect("dirty worktree file");

    request(
        server.socket(),
        "405",
        "vcs.removeWorktree",
        json!({ "cwd": consumer_cwd, "path": worktree_path, "force": true }),
    )
    .await;
    assert_success_eq(server.socket(), "405", Value::Null).await;
    assert!(!worktree_path.exists());
    assert!(consumer.is_dir());
    assert_eq!(
        git_stdout_in(&consumer, &["rev-parse", "--is-inside-work-tree"]).trim(),
        "true"
    );
    let worktree_metadata = git_stdout_in(&consumer, &["worktree", "list", "--porcelain"]);
    let listed_worktrees = worktree_metadata
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .collect::<Vec<_>>();
    assert_eq!(listed_worktrees.len(), 1);
    assert_eq!(
        canonical_path(listed_worktrees[0]),
        canonical_path(&consumer)
    );

    server.shutdown().await;
}

#[tokio::test]
async fn clone_retry_reuses_an_existing_repository_with_the_same_origin() {
    if relaunch_with_isolated_git_config(
        "clone_retry_reuses_an_existing_repository_with_the_same_origin",
    ) {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = TempDir::new().expect("clone remote");
    initialize_repository(&remote);
    commit_file(remote.path(), "tracked.txt", "base\n", "initial");
    let remote_url = local_file_url(remote.path());
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");

    let mut server = GitServerHarness::start(&temp).await;
    request(
        server.socket(),
        "406",
        "vcs.clone",
        json!({
            "url": remote_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let first = success_value(server.socket(), "406").await;
    let destination = PathBuf::from(first["path"].as_str().expect("first clone path"));
    fs::write(destination.join("local-only.txt"), "preserve me\n").expect("write retry sentinel");

    request(
        server.socket(),
        "407",
        "vcs.clone",
        json!({
            "url": remote_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let retried = success_value(server.socket(), "407").await;

    assert_eq!(
        canonical_path(retried["path"].as_str().expect("retried clone path")),
        canonical_path(&destination)
    );
    assert_eq!(
        fs::read_to_string(destination.join("local-only.txt")).expect("retry sentinel"),
        "preserve me\n"
    );
    assert_eq!(
        git_stdout_in(&destination, &["remote", "get-url", "origin"]).trim(),
        remote_url
    );

    server.shutdown().await;
}

#[tokio::test]
async fn clone_retry_reuses_an_existing_repository_with_an_instead_of_alias_origin() {
    if relaunch_with_isolated_git_config(
        "clone_retry_reuses_an_existing_repository_with_an_instead_of_alias_origin",
    ) {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = TempDir::new().expect("clone remote");
    initialize_repository(&remote);
    commit_file(remote.path(), "tracked.txt", "base\n", "initial");
    let canonical_url = local_file_url(remote.path());
    let alias_url = "t4code-alias://clone-retry-origin";
    let instead_of_key = format!("url.{canonical_url}.insteadOf");
    run_git_in(
        remote.path(),
        &["config", "--global", "--add", &instead_of_key, alias_url],
    );
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");

    let mut server = GitServerHarness::start(&temp).await;
    request(
        server.socket(),
        "407",
        "vcs.clone",
        json!({
            "url": alias_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let first = success_value(server.socket(), "407").await;
    let destination = PathBuf::from(first["path"].as_str().expect("first clone path"));
    fs::write(destination.join("local-only.txt"), "preserve me\n").expect("write retry sentinel");

    assert_eq!(
        git_stdout_in(&destination, &["config", "--get", "remote.origin.url"]).trim(),
        alias_url
    );
    assert_eq!(
        git_stdout_in(&destination, &["remote", "get-url", "origin"]).trim(),
        canonical_url
    );

    request(
        server.socket(),
        "408",
        "vcs.clone",
        json!({
            "url": alias_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let retried = success_value(server.socket(), "408").await;

    assert_eq!(
        canonical_path(retried["path"].as_str().expect("retried clone path")),
        canonical_path(&destination)
    );
    assert_eq!(
        fs::read_to_string(destination.join("local-only.txt")).expect("retry sentinel"),
        "preserve me\n"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn clone_rejects_an_existing_non_repository_destination() {
    if relaunch_with_isolated_git_config("clone_rejects_an_existing_non_repository_destination") {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = TempDir::new().expect("clone remote");
    initialize_repository(&remote);
    commit_file(remote.path(), "tracked.txt", "base\n", "initial");
    let clone_parent = root.path().join("clones");
    let destination = clone_parent.join("consumer");
    fs::create_dir_all(&destination).expect("existing empty destination");

    let mut server = GitServerHarness::start(&temp).await;
    request(
        server.socket(),
        "408",
        "vcs.clone",
        json!({
            "url": local_file_url(remote.path()),
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let error = failure_value(server.socket(), "408").await;

    assert_eq!(error["_tag"], "GitCommandError");
    assert!(
        error["detail"]
            .as_str()
            .expect("clone rejection detail")
            .contains("not a Git repository")
    );
    assert!(!destination.join(".git").exists());

    server.shutdown().await;
}

#[tokio::test]
async fn clone_rejects_an_existing_repository_with_a_different_origin() {
    if relaunch_with_isolated_git_config(
        "clone_rejects_an_existing_repository_with_a_different_origin",
    ) {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let first_remote = TempDir::new().expect("first clone remote");
    initialize_repository(&first_remote);
    commit_file(first_remote.path(), "tracked.txt", "first\n", "first");
    let second_remote = TempDir::new().expect("second clone remote");
    initialize_repository(&second_remote);
    commit_file(second_remote.path(), "tracked.txt", "second\n", "second");
    let first_url = local_file_url(first_remote.path());
    let second_url = local_file_url(second_remote.path());
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");

    let mut server = GitServerHarness::start(&temp).await;
    request(
        server.socket(),
        "409",
        "vcs.clone",
        json!({
            "url": first_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let cloned = success_value(server.socket(), "409").await;
    let destination = PathBuf::from(cloned["path"].as_str().expect("clone path"));

    request(
        server.socket(),
        "410",
        "vcs.clone",
        json!({
            "url": second_url,
            "parentDir": clone_parent,
            "directoryName": "consumer"
        }),
    )
    .await;
    let error = failure_value(server.socket(), "410").await;

    assert_eq!(error["_tag"], "GitCommandError");
    assert!(
        error["detail"]
            .as_str()
            .expect("clone rejection detail")
            .contains("different origin")
    );
    assert_eq!(
        git_stdout_in(&destination, &["remote", "get-url", "origin"]).trim(),
        first_url
    );

    server.shutdown().await;
}

#[tokio::test]
async fn clone_resolves_a_home_relative_parent_before_running_git() {
    if relaunch_with_isolated_git_config("clone_resolves_a_home_relative_parent_before_running_git")
    {
        return;
    }

    let home = dirs::home_dir()
        .and_then(|path| fs::canonicalize(path).ok())
        .expect("canonical home directory");
    let home_temp = TempDir::new_in(&home).expect("temporary directory in home");
    let relative = home_temp
        .path()
        .strip_prefix(&home)
        .expect("temporary directory is inside home")
        .to_string_lossy()
        .replace('\\', "/");
    let clone_parent = home_temp.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");

    let server_temp = TempDir::new().expect("temporary server directory");
    let remote = TempDir::new().expect("clone remote");
    initialize_repository(&remote);
    commit_file(remote.path(), "tracked.txt", "base\n", "initial");

    let mut server = GitServerHarness::start(&server_temp).await;
    request(
        server.socket(),
        "411",
        "vcs.clone",
        json!({
            "url": local_file_url(remote.path()),
            "parentDir": format!("~/{relative}/clones"),
            "directoryName": "consumer"
        }),
    )
    .await;
    let clone_result = success_value(server.socket(), "411").await;
    let cloned = PathBuf::from(
        clone_result["path"]
            .as_str()
            .expect("clone destination path"),
    );
    assert_eq!(
        canonical_path(&cloned),
        canonical_path(clone_parent.join("consumer"))
    );
    assert!(cloned.join(".git").is_dir());

    request(
        server.socket(),
        "412",
        "vcs.clone",
        json!({
            "url": local_file_url(remote.path()),
            "parentDir": format!("~\\{}\\clones", relative.replace('/', "\\")),
            "directoryName": "consumer-backslash"
        }),
    )
    .await;
    let backslash_clone_result = success_value(server.socket(), "412").await;
    let backslash_cloned = PathBuf::from(
        backslash_clone_result["path"]
            .as_str()
            .expect("backslash clone destination path"),
    );
    assert_eq!(
        canonical_path(&backslash_cloned),
        canonical_path(clone_parent.join("consumer-backslash"))
    );
    assert!(backslash_cloned.join(".git").is_dir());

    server.shutdown().await;
}

#[tokio::test]
async fn source_control_discovery_and_typed_errors_are_deterministic() {
    if relaunch_with_isolated_git_config(
        "source_control_discovery_and_typed_errors_are_deterministic",
    ) {
        return;
    }

    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    let remote = root.path().join("source-control-remote.git");
    fs::create_dir(&remote).expect("create source-control remote directory");
    run_git_in(&remote, &["init", "--bare", "--initial-branch=main"]);

    let repository = root.path().join("publish-repository");
    fs::create_dir(&repository).expect("create publish repository directory");
    initialize_repository_in(&repository);
    commit_file(&repository, "tracked.txt", "base\n", "initial");

    let mut server = GitServerHarness::start(&temp).await;
    let cwd = repository.to_string_lossy();

    request(
        server.socket(),
        "501",
        "server.discoverSourceControl",
        json!({}),
    )
    .await;
    let discovery = success_value(server.socket(), "501").await;
    let git_vcs = discovery["versionControlSystems"]
        .as_array()
        .expect("discovered VCS entries")
        .iter()
        .find(|item| item["kind"] == "git")
        .expect("git VCS discovery item");
    assert_eq!(git_vcs["label"], "Git");
    assert_eq!(git_vcs["executable"], "git");
    assert_eq!(git_vcs["implemented"], true);
    assert_eq!(git_vcs["status"], "available");
    assert_eq!(git_vcs["version"]["_tag"], "Some");

    request(
        server.socket(),
        "502",
        "sourceControl.cloneRepository",
        json!({
            "remoteUrl": local_file_url(&remote),
            "destinationPath": root.path().join("source-control-clone"),
        }),
    )
    .await;
    let cloned = success_value(server.socket(), "502").await;
    let cloned_cwd = PathBuf::from(cloned["cwd"].as_str().expect("cloned cwd"));
    assert!(cloned_cwd.exists());
    assert_eq!(cloned["repository"], Value::Null);

    request(
        server.socket(),
        "503",
        "sourceControl.lookupRepository",
        json!({ "provider": "bitbucket", "repository": "acme/repo" }),
    )
    .await;
    let lookup_error = failure_value(server.socket(), "503").await;
    assert_eq!(lookup_error["_tag"], "SourceControlRepositoryError");
    assert_eq!(lookup_error["provider"], "bitbucket");
    assert_eq!(lookup_error["operation"], "lookupRepository");

    request(
        server.socket(),
        "504",
        "sourceControl.cloneRepository",
        json!({ "destinationPath": root.path().join("missing-remote") }),
    )
    .await;
    let clone_error = failure_value(server.socket(), "504").await;
    assert_eq!(clone_error["_tag"], "SourceControlRepositoryError");
    assert_eq!(clone_error["operation"], "cloneRepository");
    assert!(
        clone_error["detail"]
            .as_str()
            .expect("clone error detail")
            .contains("clone URL")
    );

    request(
        server.socket(),
        "505",
        "sourceControl.publishRepository",
        json!({
            "cwd": cwd,
            "provider": "github",
            "repository": "acme/repo",
            "visibility": "friends-only"
        }),
    )
    .await;
    let publish_error = failure_value(server.socket(), "505").await;
    assert_eq!(publish_error["_tag"], "SourceControlRepositoryError");
    assert_eq!(publish_error["provider"], "github");
    assert_eq!(publish_error["operation"], "publishRepository");
    assert!(
        publish_error["detail"]
            .as_str()
            .expect("publish error detail")
            .contains("private or public")
    );

    request(
        server.socket(),
        "506",
        "vcs.init",
        json!({ "cwd": root.path().join("jj-repository"), "kind": "jj" }),
    )
    .await;
    let invalid_kind = failure_value(server.socket(), "506").await;
    assert_eq!(invalid_kind["_tag"], "GitCommandError");
    assert_eq!(invalid_kind["operation"], "vcs.init");
    assert!(
        invalid_kind["detail"]
            .as_str()
            .expect("invalid VCS kind detail")
            .contains("Only the git VCS driver")
    );

    request(
        server.socket(),
        "507",
        "vcs.listRefs",
        json!({ "cursor": "bad" }),
    )
    .await;
    let malformed = failure_value(server.socket(), "507").await;
    assert_eq!(malformed["_tag"], "RpcRequestInvalid");
    assert_eq!(malformed["method"], "vcs.listRefs");

    request(
        server.socket(),
        "508",
        "shell.openInEditor",
        json!({ "cwd": cwd, "editor": "unknown-editor" }),
    )
    .await;
    let unknown_editor = failure_value(server.socket(), "508").await;
    assert_eq!(unknown_editor["_tag"], "ExternalLauncherUnknownEditorError");
    assert_eq!(unknown_editor["editor"], "unknown-editor");

    request(
        server.socket(),
        "509",
        "sourceControl.lookupRepository",
        json!({ "provider": "gitlab", "repository": "acme/repo" }),
    )
    .await;
    let missing_gitlab_cli = failure_value(server.socket(), "509").await;
    assert_eq!(missing_gitlab_cli["_tag"], "SourceControlRepositoryError");
    assert_eq!(missing_gitlab_cli["provider"], "gitlab");

    request(
        server.socket(),
        "510",
        "sourceControl.lookupRepository",
        json!({ "provider": "github", "repository": "://" }),
    )
    .await;
    let invalid_github_repository = failure_value(server.socket(), "510").await;
    assert_eq!(
        invalid_github_repository["_tag"],
        "SourceControlRepositoryError"
    );
    assert_eq!(invalid_github_repository["provider"], "github");

    request(
        server.socket(),
        "511",
        "sourceControl.cloneRepository",
        json!({
            "remoteUrl": local_file_url(&remote),
            "destinationPath": "/",
        }),
    )
    .await;
    let parentless_destination = failure_value(server.socket(), "511").await;
    assert_eq!(parentless_destination["_tag"], "RpcRequestInvalid");

    request(
        server.socket(),
        "512",
        "sourceControl.publishRepository",
        json!({
            "cwd": cwd,
            "provider": "gitlab",
            "repository": "acme/repo",
            "visibility": "private",
        }),
    )
    .await;
    let unsupported_publisher = failure_value(server.socket(), "512").await;
    assert_eq!(
        unsupported_publisher["_tag"],
        "SourceControlRepositoryError"
    );
    assert_eq!(unsupported_publisher["provider"], "gitlab");

    server.shutdown().await;
}

#[tokio::test]
async fn pull_request_rpc_adapters_execute_resolution_and_preparation_paths() {
    let temp = TempDir::new().expect("temporary server directory");
    let repository = TempDir::new().expect("temporary repository");
    initialize_repository(&repository);
    commit_file(repository.path(), "tracked.txt", "base\n", "initial");
    let cwd = repository.path().to_string_lossy();
    let mut server = GitServerHarness::start(&temp).await;

    request(
        server.socket(),
        "601",
        "git.resolvePullRequest",
        json!({"cwd":cwd,"reference":"current"}),
    )
    .await;
    let resolution = failure_value(server.socket(), "601").await;
    assert_eq!(resolution["_tag"], "SourceControlProviderError");

    request(
        server.socket(),
        "602",
        "git.preparePullRequestThread",
        json!({
            "cwd":cwd,
            "reference":"current",
            "mode":"switch",
            "threadId":"thread-1",
        }),
    )
    .await;
    let preparation = failure_value(server.socket(), "602").await;
    assert_eq!(preparation["_tag"], "SourceControlProviderError");

    server.shutdown().await;
}

fn initialize_repository(repository: &TempDir) {
    initialize_repository_in(repository.path());
}

fn run_git(repository: &TempDir, args: &[&str]) {
    run_git_in(repository.path(), args);
}

fn run_git_in(cwd: &Path, args: &[&str]) {
    assert!(
        git_command(cwd, args)
            .status()
            .expect("git starts")
            .success(),
        "git {args:?} failed"
    );
}

fn git_stdout(repository: &TempDir, args: &[&str]) -> String {
    git_stdout_in(repository.path(), args)
}

fn git_stdout_in(cwd: &Path, args: &[&str]) -> String {
    let output = git_command(cwd, args).output().expect("git starts");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("git output is UTF-8")
}

fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "T4Code Test")
        .env("GIT_AUTHOR_EMAIL", "t4code@example.invalid")
        .env("GIT_COMMITTER_NAME", "T4Code Test")
        .env("GIT_COMMITTER_EMAIL", "t4code@example.invalid");
    command
}

fn initialize_repository_in(cwd: &Path) {
    run_git_in(cwd, &["init", "--quiet", "-b", "main"]);
    initialize_repository_identity(cwd);
}

fn initialize_repository_identity(cwd: &Path) {
    run_git_in(cwd, &["config", "user.name", "T4Code Test"]);
    run_git_in(cwd, &["config", "user.email", "t4code@example.invalid"]);
    run_git_in(cwd, &["config", "core.autocrlf", "false"]);
}

fn commit_file(cwd: &Path, relative: &str, contents: &str, message: &str) {
    let path = cwd.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture parent directory");
    }
    fs::write(&path, contents).expect("write fixture file");
    run_git_in(cwd, &["add", "--", relative]);
    run_git_in(cwd, &["commit", "--quiet", "-m", message]);
}

fn local_file_url(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    format!("file:///{}", normalized.trim_start_matches("//?/"))
}

fn canonical_path(path: impl AsRef<Path>) -> PathBuf {
    fs::canonicalize(path).expect("canonical test path")
}

fn relaunch_with_isolated_git_config(test_name: &str) -> bool {
    if std::env::var_os(ISOLATED_GIT_TEST).is_some() {
        return false;
    }

    let _relaunch_guard = ISOLATED_GIT_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fixture = tempfile::tempdir().expect("isolated Git config fixture");
    let hooks = fixture.path().join("hooks");
    fs::create_dir(&hooks).expect("isolated hooks directory");
    let config = fixture.path().join("global.gitconfig");
    fs::write(
        &config,
        format!(
            "[commit]\n\tgpgSign = false\n[core]\n\thooksPath = {}\n",
            hooks.to_string_lossy().replace('\\', "/")
        ),
    )
    .expect("isolated global config");

    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("GIT_"))
        {
            command.env_remove(name);
        }
    }
    let output = command
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(ISOLATED_GIT_TEST, "1")
        .output()
        .expect("run test with isolated Git config");
    assert!(
        output.status.success(),
        "isolated test {test_name} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

async fn start_git_server(
    temp: &TempDir,
) -> (
    t4code_server::ServerHandle,
    WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    let mut registry = RpcRegistry::empty();
    register_git_vcs_rpc(&mut registry, GitVcsRpcServices::default());
    let handle = ServerRuntime::start_with_registry(test_config(temp), registry)
        .await
        .expect("server starts");
    let (socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    (handle, socket)
}

async fn run_stacked_action<S>(
    socket: &mut WebSocketStream<S>,
    request_id: &str,
    payload: Value,
) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    request(socket, request_id, "git.runStackedAction", payload).await;
    let started = next_server_message(socket).await;
    assert!(
        matches!(started, ServerMessage::Chunk { ref values, .. } if values[0]["kind"] == "action_started")
    );
    send_json(socket, json!({ "_tag": "Ack", "requestId": request_id })).await;
    let event = next_server_message(socket).await;
    let ServerMessage::Chunk { values, .. } = event else {
        panic!("expected stacked action event, got {event:?}");
    };
    values.into_iter().next().expect("stacked action event")
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

async fn failure_value<S>(socket: &mut WebSocketStream<S>, id: &str) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match next_server_message(socket).await {
        ServerMessage::Exit {
            request_id,
            exit: RpcExit::Failure { cause },
        } if request_id == RequestId::try_from(id).expect("request id") => {
            let [CauseItem::Fail { error }] = cause.as_slice() else {
                panic!("expected a single failure cause for {id}, got {cause:?}");
            };
            error.clone()
        }
        message => panic!("expected failed response for {id}, got {message:?}"),
    }
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
    let frame = timeout(Duration::from_secs(15), socket.next())
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = frame else {
        panic!("expected text WebSocket message, got {frame:?}");
    };
    serde_json::from_str(&text).expect("valid server RPC message")
}
