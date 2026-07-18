use t4code_server::production::orchestration_effects;

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

use orchestration_effects::{
    BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
    SetupScriptLaunch, normalize_project_workspace_root,
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
    refresh_error: Mutex<Option<String>>,
    setup_scripts: Mutex<Vec<SetupScriptLaunch>>,
    setup_error: Mutex<Option<String>>,
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
            if let Some(error) = self.refresh_error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(())
        })
    }

    fn launch_setup_script<'a>(&'a self, input: SetupScriptLaunch) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.setup_scripts.lock().unwrap().push(input);
            if let Some(error) = self.setup_error.lock().unwrap().clone() {
                return Err(error);
            }
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
    #[cfg(windows)]
    assert!(
        !normalized.to_string_lossy().starts_with(r"\\?\"),
        "persisted workspace paths must be accepted by Git and terminal processes"
    );

    let file = parent.path().join("not-a-directory");
    std::fs::write(&file, "x").unwrap();
    let error = normalize_project_workspace_root(&file, false)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not a directory"));
}

#[tokio::test]
async fn bootstrap_creates_worktree_updates_thread_runs_setup_then_dispatches_turn() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    dispatch(
        &engine,
        json!({
            "type":"project.meta.update", "commandId":"scripts", "projectId":"p1",
            "scripts":[{
                "id":"setup", "name":"Install dependencies", "command":"vp install",
                "runOnWorktreeCreate":true
            }]
        }),
    )
    .await;
    let callbacks = Arc::new(CallbackState::default());
    let effects =
        OrchestrationEffects::start(engine.clone(), callbacks.clone(), EffectsOptions::default())
            .await
            .unwrap();

    dispatch(
        &engine,
        json!({
            "type":"thread.turn.start", "commandId":"bootstrap", "threadId":"worktree-thread",
            "message":{"messageId":"message","role":"user","text":"change it","attachments":[]},
            "bootstrap":{
                "createThread":{
                    "projectId":"p1", "title":"Worktree thread",
                    "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access", "interactionMode":"default",
                    "branch":null, "worktreePath":null, "createdAt":NOW
                },
                "prepareWorktree":{
                    "projectCwd":repository.path(), "baseBranch":"HEAD",
                    "branch":"t4code/bootstrap-test"
                },
                "runSetupScript":true
            },
            "createdAt":NOW
        }),
    )
    .await;

    let thread = engine
        .repositories()
        .get_thread("worktree-thread".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thread.branch.as_deref(), Some("t4code/bootstrap-test"));
    let worktree_path = PathBuf::from(thread.worktree_path.expect("worktree path"));
    assert!(worktree_path.is_dir());

    {
        let setup_scripts = callbacks.setup_scripts.lock().unwrap();
        assert_eq!(setup_scripts.len(), 1);
        assert_eq!(setup_scripts[0].thread_id, "worktree-thread");
        assert_eq!(setup_scripts[0].script_id, "setup");
        assert_eq!(setup_scripts[0].command, "vp install");
        assert_eq!(setup_scripts[0].cwd, worktree_path);
    }

    let events = engine.read_events(0).await.unwrap();
    let thread_events: Vec<_> = events
        .iter()
        .filter(|event| event.event.aggregate_id == "worktree-thread")
        .map(|event| event.event.event_type.as_str())
        .collect();
    assert_eq!(
        thread_events,
        vec![
            "thread.created",
            "thread.meta-updated",
            "thread.activity-appended",
            "thread.activity-appended",
            "thread.message-sent",
            "thread.turn-start-requested"
        ]
    );

    effects.shutdown().await;
    engine.shutdown().await;
    git(
        repository.path(),
        &[
            "worktree",
            "remove",
            "--force",
            worktree_path.to_string_lossy().as_ref(),
        ],
    );
}

#[tokio::test]
async fn bootstrap_setup_launch_failure_rolls_back_worktree_branch_and_thread() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    dispatch(
        &engine,
        json!({
            "type":"project.meta.update", "commandId":"scripts", "projectId":"p1",
            "scripts":[{
                "id":"setup", "name":"Install dependencies", "command":"vp install",
                "runOnWorktreeCreate":true
            }]
        }),
    )
    .await;
    let callbacks = Arc::new(CallbackState::default());
    *callbacks.setup_error.lock().unwrap() = Some("terminal start failed".to_owned());
    let effects = OrchestrationEffects::start(engine.clone(), callbacks, EffectsOptions::default())
        .await
        .unwrap();

    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.turn.start", "commandId":"bootstrap", "threadId":"setup-failure",
        "message":{"messageId":"message","role":"user","text":"change it","attachments":[]},
        "bootstrap":{
            "createThread":{
                "projectId":"p1", "title":"Setup failure",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "interactionMode":"default",
                "branch":null, "worktreePath":null, "createdAt":NOW
            },
            "prepareWorktree":{
                "projectCwd":repository.path(), "baseBranch":"HEAD",
                "branch":"t4code/setup-failure-test"
            },
            "runSetupScript":true
        },
        "createdAt":NOW
    }))
    .unwrap();
    let error = engine
        .dispatch(command)
        .await
        .expect_err("setup launch failure aborts bootstrap");
    assert!(error.to_string().contains("setup script launch"));
    assert!(error.to_string().contains("terminal start failed"));

    let events = engine.read_events(0).await.unwrap();
    assert!(!events.iter().any(|event| {
        event.event.aggregate_id == "setup-failure"
            && event.event.event_type == "thread.turn-start-requested"
    }));
    let failure = events
        .iter()
        .find(|event| {
            event.event.aggregate_id == "setup-failure"
                && event.event.payload["activity"]["kind"] == "setup-script.failed"
        })
        .expect("setup failure activity");
    assert_eq!(
        failure.event.payload["activity"]["payload"]["detail"],
        "terminal start failed"
    );

    let thread = engine
        .repositories()
        .get_thread("setup-failure".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert!(thread.deleted_at.is_some());
    let worktrees = git(repository.path(), &["worktree", "list", "--porcelain"]);
    assert!(!worktrees.contains("t4code/setup-failure-test"));
    assert!(!git_succeeds(
        repository.path(),
        &[
            "show-ref",
            "--verify",
            "refs/heads/t4code/setup-failure-test"
        ]
    ));
    effects.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_workspace_refresh_failure_removes_the_just_created_worktree() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    let callbacks = Arc::new(CallbackState::default());
    *callbacks.refresh_error.lock().unwrap() = Some("index refresh failed".to_owned());
    let effects = OrchestrationEffects::start(engine.clone(), callbacks, EffectsOptions::default())
        .await
        .unwrap();
    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.turn.start", "commandId":"bootstrap", "threadId":"refresh-failure",
        "message":{"messageId":"message","role":"user","text":"change it","attachments":[]},
        "bootstrap":{
            "createThread":{
                "projectId":"p1", "title":"Refresh failure",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "interactionMode":"default",
                "branch":null, "worktreePath":null, "createdAt":NOW
            },
            "prepareWorktree":{
                "projectCwd":repository.path(), "baseBranch":"HEAD",
                "branch":"t4code/refresh-failure-test"
            }
        },
        "createdAt":NOW
    }))
    .unwrap();

    let error = engine
        .dispatch(command)
        .await
        .expect_err("refresh failure aborts bootstrap");
    assert!(error.to_string().contains("index refresh failed"));
    let worktrees = git(repository.path(), &["worktree", "list", "--porcelain"]);
    assert!(!worktrees.contains("t4code/refresh-failure-test"));
    assert!(!git_succeeds(
        repository.path(),
        &[
            "show-ref",
            "--verify",
            "refs/heads/t4code/refresh-failure-test"
        ]
    ));
    let thread = engine
        .repositories()
        .get_thread("refresh-failure".to_owned())
        .await
        .unwrap()
        .unwrap();
    assert!(thread.deleted_at.is_some());

    effects.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_git_failures_include_bounded_actionable_stderr() {
    let repository = initialize_repository();
    let engine = engine(repository.path()).await;
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(CallbackState::default()),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let command: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.turn.start", "commandId":"bootstrap", "threadId":"fetch-failure",
        "message":{"messageId":"message","role":"user","text":"change it","attachments":[]},
        "bootstrap":{
            "createThread":{
                "projectId":"p1", "title":"Fetch failure",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access", "interactionMode":"default",
                "branch":null, "worktreePath":null, "createdAt":NOW
            },
            "prepareWorktree":{
                "projectCwd":repository.path(), "baseBranch":"main",
                "branch":"t4code/fetch-failure-test", "startFromOrigin":true
            }
        },
        "createdAt":NOW
    }))
    .unwrap();

    let error = engine
        .dispatch(command)
        .await
        .expect_err("missing origin aborts bootstrap");
    let message = error.to_string();
    assert!(
        message.contains("bootstrap.git.fetch exited with code"),
        "{message}"
    );
    assert!(message.contains("fatal:"), "{message}");
    assert!(message.to_ascii_lowercase().contains("origin"), "{message}");

    effects.shutdown().await;
    engine.shutdown().await;
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
    let default_launch_error = callbacks
        .launch_setup_script(SetupScriptLaunch {
            thread_id: "t1".to_owned(),
            terminal_id: "setup-default".to_owned(),
            script_id: "default".to_owned(),
            script_name: "Default".to_owned(),
            command: "true".to_owned(),
            cwd: workspace.path().to_path_buf(),
            worktree_path: workspace.path().to_path_buf(),
            env: Default::default(),
        })
        .await
        .expect_err("default setup callback is unavailable");
    assert!(default_launch_error.contains("unavailable"));
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
