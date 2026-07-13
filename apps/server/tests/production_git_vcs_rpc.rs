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

fn initialize_repository(repository: &TempDir) {
    run_git(repository, &["init", "--quiet"]);
    run_git(repository, &["config", "user.name", "T4Code Test"]);
    run_git(
        repository,
        &["config", "user.email", "t4code@example.invalid"],
    );
    run_git(repository, &["config", "core.autocrlf", "false"]);
}

fn run_git(repository: &TempDir, args: &[&str]) {
    assert!(
        std::process::Command::new("git")
            .args(args)
            .current_dir(repository.path())
            .status()
            .expect("git starts")
            .success(),
        "git {args:?} failed"
    );
}

fn git_stdout(repository: &TempDir, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(repository.path())
        .output()
        .expect("git starts");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).expect("git output is UTF-8")
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
