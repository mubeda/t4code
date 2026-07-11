use t4code_server::production::orchestration_effects;

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

use orchestration_effects::{
    BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
    normalize_project_workspace_root,
};
use serde_json::json;
use t4code_server::{
    orchestration::engine::{EngineOptions, OrchestrationCommand, OrchestrationEngine},
    persistence::{Database, run_migrations},
};
use tempfile::TempDir;

const NOW: &str = "2026-07-10T10:00:00.000Z";

#[derive(Default)]
struct CallbackState {
    cwd: Mutex<Option<PathBuf>>,
    rollbacks: Mutex<Vec<(String, i64)>>,
    stopped: Mutex<Vec<String>>,
    terminals: Mutex<Vec<String>>,
    refreshed: Mutex<Vec<PathBuf>>,
}

impl OrchestrationEffectCallbacks for CallbackState {
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move { Ok(self.cwd.lock().unwrap().clone()) })
    }

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.rollbacks
                .lock()
                .unwrap()
                .push((thread_id.to_owned(), turns));
            Ok(())
        })
    }

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.stopped.lock().unwrap().push(thread_id.to_owned());
            Ok(())
        })
    }

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.terminals.lock().unwrap().push(thread_id.to_owned());
            Ok(())
        })
    }

    fn refresh_workspace<'a>(&'a self, cwd: &'a Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.refreshed.lock().unwrap().push(cwd.to_path_buf());
            Ok(())
        })
    }
}

async fn engine(workspace: &Path) -> OrchestrationEngine {
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
    dispatch(
        &engine,
        json!({
            "type":"project.create", "commandId":"project", "projectId":"p1",
            "title":"Project", "workspaceRoot":workspace, "createdAt":NOW
        }),
    )
    .await;
    dispatch(
        &engine,
        json!({
            "type":"thread.create", "commandId":"thread", "threadId":"t1", "projectId":"p1",
            "title":"Thread", "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "branch":null, "worktreePath":null, "createdAt":NOW
        }),
    )
    .await;
    engine
}

async fn dispatch(engine: &OrchestrationEngine, value: serde_json::Value) {
    let command: OrchestrationCommand = serde_json::from_value(value).unwrap();
    engine.dispatch(command).await.unwrap();
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn git_succeeds(cwd: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap()
        .success()
}

fn initialize_repository() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
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

async fn wait_until(mut predicate: impl FnMut() -> bool) {
    for _ in 0..100 {
        if predicate() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition was not met");
}

async fn wait_for_event(engine: &OrchestrationEngine, event_type: &str) {
    for _ in 0..100 {
        if engine
            .read_events(0)
            .await
            .unwrap()
            .iter()
            .any(|event| event.event.event_type == event_type)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("event {event_type} was not emitted");
}

#[tokio::test]
async fn normalizes_and_optionally_creates_project_workspace_roots() {
    let parent = tempfile::tempdir().unwrap();
    let missing = parent.path().join("nested").join("project");

    let error = normalize_project_workspace_root(&missing, false)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not exist"));

    let normalized = normalize_project_workspace_root(&missing, true)
        .await
        .unwrap();
    assert!(normalized.is_absolute());
    assert!(normalized.is_dir());

    let file = parent.path().join("not-a-directory");
    std::fs::write(&file, "x").unwrap();
    let error = normalize_project_workspace_root(&file, false)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not a directory"));
}

#[tokio::test]
async fn captures_baseline_and_replaces_missing_turn_checkpoint_with_real_diff() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    let callbacks = Arc::new(CallbackState::default());
    *callbacks.cwd.lock().unwrap() = Some(repository.path().to_path_buf());
    let effects = OrchestrationEffects::start(engine.clone(), callbacks, EffectsOptions::default())
        .await
        .unwrap();

    dispatch(
        &engine,
        json!({
            "type":"thread.turn.start", "commandId":"turn-start", "threadId":"t1",
            "message":{"messageId":"m1","role":"user","text":"change it","attachments":[]},
            "createdAt":NOW
        }),
    )
    .await;
    let baseline_ref = orchestration_effects::checkpoint_ref("t1", 0);
    wait_until(|| {
        git_succeeds(
            repository.path(),
            &["rev-parse", "--verify", "--quiet", &baseline_ref],
        )
    })
    .await;

    std::fs::write(repository.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repository.path().join("new.txt"), "new\n").unwrap();
    dispatch(
        &engine,
        json!({
            "type":"thread.turn.diff.complete", "commandId":"placeholder", "threadId":"t1",
            "turnId":"turn-1", "checkpointTurnCount":1,
            "checkpointRef":"missing", "status":"missing", "files":[],
            "assistantMessageId":"assistant-1", "completedAt":NOW, "createdAt":NOW
        }),
    )
    .await;

    let checkpoint_ref = orchestration_effects::checkpoint_ref("t1", 1);
    for _ in 0..100 {
        let checkpoint = engine
            .repositories()
            .get_checkpoint("t1".to_owned(), 1)
            .await
            .unwrap();
        if checkpoint
            .as_ref()
            .is_some_and(|entry| entry.status == "ready" && entry.checkpoint_ref == checkpoint_ref)
        {
            let files = checkpoint.unwrap().files;
            assert!(
                files
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|file| file["path"] == "tracked.txt")
            );
            assert!(
                files
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|file| file["path"] == "new.txt")
            );
            effects.shutdown().await;
            engine.shutdown().await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("real checkpoint was not projected");
}

#[tokio::test]
async fn reverts_workspace_provider_history_and_stale_checkpoint_refs() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    let callbacks = Arc::new(CallbackState::default());
    *callbacks.cwd.lock().unwrap() = Some(repository.path().to_path_buf());
    let effects =
        OrchestrationEffects::start(engine.clone(), callbacks.clone(), EffectsOptions::default())
            .await
            .unwrap();

    orchestration_effects::capture_checkpoint(repository.path(), "t1", 0)
        .await
        .unwrap();
    std::fs::write(repository.path().join("tracked.txt"), "one\n").unwrap();
    orchestration_effects::capture_checkpoint(repository.path(), "t1", 1)
        .await
        .unwrap();
    std::fs::write(repository.path().join("tracked.txt"), "two\n").unwrap();
    orchestration_effects::capture_checkpoint(repository.path(), "t1", 2)
        .await
        .unwrap();
    for turn_count in 1..=2 {
        dispatch(
            &engine,
            json!({
                "type":"thread.turn.diff.complete", "commandId":format!("diff-{turn_count}"),
                "threadId":"t1", "turnId":format!("turn-{turn_count}"),
                "checkpointTurnCount":turn_count,
                "checkpointRef":orchestration_effects::checkpoint_ref("t1", turn_count),
                "status":"ready", "files":[], "assistantMessageId":format!("a-{turn_count}"),
                "completedAt":NOW, "createdAt":NOW
            }),
        )
        .await;
    }

    dispatch(
        &engine,
        json!({
            "type":"thread.checkpoint.revert", "commandId":"revert", "threadId":"t1",
            "turnCount":1, "createdAt":NOW
        }),
    )
    .await;
    wait_for_event(&engine, "thread.reverted").await;
    assert_eq!(
        std::fs::read_to_string(repository.path().join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );
    assert_eq!(
        callbacks.rollbacks.lock().unwrap().as_slice(),
        &[("t1".to_owned(), 1)]
    );
    assert!(!git_succeeds(
        repository.path(),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &orchestration_effects::checkpoint_ref("t1", 2)
        ],
    ));

    effects.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn thread_deletion_attempts_provider_and_terminal_cleanup_independently() {
    struct FailingProviderCallbacks(CallbackState);
    impl OrchestrationEffectCallbacks for FailingProviderCallbacks {
        fn workspace_for_thread<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, Option<PathBuf>> {
            Box::pin(async { Ok(None) })
        }
        fn rollback_provider<'a>(&'a self, _: &'a str, _: i64) -> BoxEffectFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
        fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
            Box::pin(async move {
                self.0.stopped.lock().unwrap().push(thread_id.to_owned());
                Err("provider already stopped".to_owned())
            })
        }
        fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
            Box::pin(async move {
                self.0.terminals.lock().unwrap().push(thread_id.to_owned());
                Ok(())
            })
        }
        fn refresh_workspace<'a>(&'a self, _: &'a Path) -> BoxEffectFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    let workspace = tempfile::tempdir().unwrap();
    let engine = engine(workspace.path()).await;
    let callbacks = Arc::new(FailingProviderCallbacks(CallbackState::default()));
    let effects = OrchestrationEffects::start(
        engine.clone(),
        callbacks.clone(),
        EffectsOptions { queue_capacity: 1 },
    )
    .await
    .unwrap();

    dispatch(
        &engine,
        json!({
            "type":"thread.delete", "commandId":"delete", "threadId":"t1"
        }),
    )
    .await;
    wait_until(|| !callbacks.0.terminals.lock().unwrap().is_empty()).await;
    assert_eq!(callbacks.0.stopped.lock().unwrap().as_slice(), &["t1"]);
    assert_eq!(callbacks.0.terminals.lock().unwrap().as_slice(), &["t1"]);

    effects.shutdown().await;
    engine.shutdown().await;
}
