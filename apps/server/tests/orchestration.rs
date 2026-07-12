use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use t4code_server::orchestration::engine::{
    BootstrapSetupInput, BootstrapSetupResult, BootstrapWorktree, BoxBootstrapFuture,
    EngineOptions, OrchestrationCommand, OrchestrationEngine, OrchestrationError, TestHooks,
    ThreadTurnBootstrapEffects, ThreadTurnStartBootstrapPrepareWorktree, load_snapshot,
};
use t4code_server::persistence::{Database, Repositories, run_migrations};

const CREATED_AT: &str = "2026-07-10T10:00:00.000Z";

async fn migrated_repositories() -> Repositories {
    let database = Database::open_in_memory().await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations");
    Repositories::new(database)
}

#[derive(Default)]
struct BootstrapRollbackProbe {
    calls: Mutex<Vec<&'static str>>,
    setup_terminal_active: Mutex<bool>,
}

impl ThreadTurnBootstrapEffects for BootstrapRollbackProbe {
    fn prepare_worktree<'a>(
        &'a self,
        input: ThreadTurnStartBootstrapPrepareWorktree,
    ) -> BoxBootstrapFuture<'a, BootstrapWorktree> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("prepare");
            Ok(BootstrapWorktree {
                repository_root: input.project_cwd,
                branch: input
                    .branch
                    .unwrap_or_else(|| "bootstrap-branch".to_owned()),
                path: "C:/virtual-worktree".to_owned(),
                remove_branch: true,
            })
        })
    }

    fn run_setup_script<'a>(
        &'a self,
        _input: BootstrapSetupInput,
    ) -> BoxBootstrapFuture<'a, BootstrapSetupResult> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("setup");
            *self.setup_terminal_active.lock().unwrap() = true;
            Ok(BootstrapSetupResult::Started {
                script_id: "setup".to_owned(),
                script_name: "Setup".to_owned(),
                terminal_id: "setup-terminal".to_owned(),
            })
        })
    }

    fn cleanup_thread_resources<'a>(&'a self, _thread_id: &'a str) -> BoxBootstrapFuture<'a, ()> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("cleanup");
            *self.setup_terminal_active.lock().unwrap() = false;
            Ok(())
        })
    }

    fn remove_worktree<'a>(&'a self, _worktree: BootstrapWorktree) -> BoxBootstrapFuture<'a, ()> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("remove");
            if *self.setup_terminal_active.lock().unwrap() {
                return Err("setup terminal still owns the worktree".to_owned());
            }
            Ok(())
        })
    }
}

fn command_values() -> Vec<Value> {
    vec![
        json!({"type":"project.create","commandId":"c01","projectId":"p1","title":"Project","workspaceRoot":"C:/repo","createWorkspaceRootIfMissing":true,"defaultModelSelection":null,"createdAt":CREATED_AT}),
        json!({"type":"project.meta.update","commandId":"c02","projectId":"p1","title":"Renamed","defaultModelSelection":{"instanceId":"codex","model":"gpt-5"},"scripts":[]}),
        json!({"type":"project.delete","commandId":"c23","projectId":"p1","force":true}),
        json!({"type":"thread.create","commandId":"c03","threadId":"t1","projectId":"p1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","branch":null,"worktreePath":null,"createdAt":CREATED_AT}),
        json!({"type":"thread.delete","commandId":"c22","threadId":"t1"}),
        json!({"type":"thread.archive","commandId":"c20","threadId":"t1"}),
        json!({"type":"thread.unarchive","commandId":"c21","threadId":"t1"}),
        json!({"type":"thread.meta.update","commandId":"c04","threadId":"t1","title":"Thread 2","branch":"main","worktreePath":null}),
        json!({"type":"thread.runtime-mode.set","commandId":"c05","threadId":"t1","runtimeMode":"approval-required","createdAt":CREATED_AT}),
        json!({"type":"thread.interaction-mode.set","commandId":"c06","threadId":"t1","interactionMode":"plan","createdAt":CREATED_AT}),
        json!({"type":"thread.turn.start","commandId":"c07","threadId":"t1","message":{"messageId":"m-user","role":"user","text":"hello","attachments":[]},"createdAt":CREATED_AT}),
        json!({"type":"thread.turn.interrupt","commandId":"c08","threadId":"t1","turnId":"turn-1","createdAt":CREATED_AT}),
        json!({"type":"thread.approval.respond","commandId":"c09","threadId":"t1","requestId":"r1","decision":"acceptForSession","createdAt":CREATED_AT}),
        json!({"type":"thread.user-input.respond","commandId":"c10","threadId":"t1","requestId":"r2","answers":{"question":"answer"},"createdAt":CREATED_AT}),
        json!({"type":"thread.checkpoint.revert","commandId":"c11","threadId":"t1","turnCount":0,"createdAt":CREATED_AT}),
        json!({"type":"thread.session.stop","commandId":"c12","threadId":"t1","createdAt":CREATED_AT}),
        json!({"type":"thread.session.set","commandId":"c13","threadId":"t1","session":{"threadId":"t1","status":"running","providerName":"Codex","activeTurnId":"turn-1","lastError":null,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
        json!({"type":"thread.message.assistant.delta","commandId":"c14","threadId":"t1","messageId":"m-assistant","delta":"hel","turnId":"turn-1","createdAt":CREATED_AT}),
        json!({"type":"thread.message.assistant.complete","commandId":"c15","threadId":"t1","messageId":"m-assistant","turnId":"turn-1","createdAt":CREATED_AT}),
        json!({"type":"thread.proposed-plan.upsert","commandId":"c16","threadId":"t1","proposedPlan":{"id":"plan-1","turnId":"turn-1","planMarkdown":"Do it","createdAt":CREATED_AT,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
        json!({"type":"thread.turn.diff.complete","commandId":"c17","threadId":"t1","turnId":"turn-1","completedAt":CREATED_AT,"checkpointRef":"ref-1","status":"ready","files":[{"path":"a.rs","kind":"modified","additions":2,"deletions":1}],"assistantMessageId":"m-assistant","checkpointTurnCount":1,"createdAt":CREATED_AT}),
        json!({"type":"thread.activity.append","commandId":"c18","threadId":"t1","activity":{"id":"activity-1","tone":"tool","kind":"command","summary":"ran","payload":{"requestId":"r3"},"turnId":"turn-1","createdAt":CREATED_AT},"createdAt":CREATED_AT}),
        json!({"type":"thread.revert.complete","commandId":"c19","threadId":"t1","turnCount":0,"createdAt":CREATED_AT}),
    ]
}

fn decode(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).expect("contract command decodes")
}

#[test]
fn all_contract_command_variants_round_trip_with_canonical_defaults() {
    let values = command_values();
    assert_eq!(values.len(), 23);
    for value in values {
        let expected_type = value["type"].clone();
        let encoded = serde_json::to_value(decode(value)).expect("command encodes");
        assert_eq!(encoded["type"], expected_type);
    }

    let thread_create = serde_json::to_value(decode(command_values()[3].clone())).unwrap();
    assert_eq!(thread_create["interactionMode"], "default");
    assert!(thread_create.get("kind").is_none());
    let turn_start = serde_json::to_value(decode(command_values()[10].clone())).unwrap();
    assert_eq!(turn_start["runtimeMode"], "full-access");
    assert_eq!(turn_start["interactionMode"], "default");
    let session_set = serde_json::to_value(decode(command_values()[16].clone())).unwrap();
    assert_eq!(session_set["session"]["runtimeMode"], "full-access");
    let plan = serde_json::to_value(decode(command_values()[19].clone())).unwrap();
    assert_eq!(plan["proposedPlan"]["implementedAt"], Value::Null);
    assert_eq!(plan["proposedPlan"]["implementationThreadId"], Value::Null);

    let project_create = serde_json::to_value(decode(command_values()[0].clone())).unwrap();
    assert_eq!(project_create["defaultModelSelection"], Value::Null);
    let missing_project_selection = serde_json::to_value(decode(json!({
        "type":"project.meta.update","commandId":"missing","projectId":"p1"
    })))
    .unwrap();
    assert!(
        missing_project_selection
            .get("defaultModelSelection")
            .is_none()
    );
    let null_project_selection = serde_json::to_value(decode(json!({
        "type":"project.meta.update","commandId":"null","projectId":"p1","defaultModelSelection":null
    }))).unwrap();
    assert_eq!(null_project_selection["defaultModelSelection"], Value::Null);
    let null_thread_paths = serde_json::to_value(decode(command_values()[7].clone())).unwrap();
    assert_eq!(null_thread_paths["worktreePath"], Value::Null);
    assert_eq!(null_thread_paths["branch"], "main");
}

#[tokio::test]
async fn all_contract_commands_persist_canonical_events_and_project_atomically() {
    let repositories = migrated_repositories().await;
    let engine =
        OrchestrationEngine::start(repositories.database().clone(), EngineOptions::default())
            .await
            .expect("engine starts");
    let values = command_values();
    let order = [
        0, 1, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 5, 6, 4, 2,
    ];
    for index in order {
        if index == 22 {
            let before_revert = load_snapshot(&engine.repositories()).await.unwrap();
            assert_eq!(
                before_revert
                    .messages
                    .iter()
                    .find(|message| message.message_id == "m-assistant")
                    .unwrap()
                    .text,
                "hel"
            );
            let turn = before_revert
                .turns
                .iter()
                .find(|turn| turn.turn_id.as_deref() == Some("turn-1"))
                .unwrap();
            assert_eq!(turn.state, "running");
            assert_eq!(turn.assistant_message_id.as_deref(), Some("m-assistant"));
        }
        engine
            .dispatch(decode(values[index].clone()))
            .await
            .expect("command succeeds");
    }

    let events = engine.read_events(0).await.expect("events");
    let event_types: Vec<_> = events
        .iter()
        .map(|event| event.event.event_type.as_str())
        .collect();
    assert_eq!(
        event_types,
        vec![
            "project.created",
            "thread.created",
            "project.meta-updated",
            "thread.created",
            "thread.meta-updated",
            "thread.runtime-mode-set",
            "thread.interaction-mode-set",
            "thread.message-sent",
            "thread.turn-start-requested",
            "thread.turn-interrupt-requested",
            "thread.approval-response-requested",
            "thread.user-input-response-requested",
            "thread.checkpoint-revert-requested",
            "thread.session-stop-requested",
            "thread.session-set",
            "thread.message-sent",
            "thread.message-sent",
            "thread.proposed-plan-upserted",
            "thread.turn-diff-completed",
            "thread.activity-appended",
            "thread.reverted",
            "thread.archived",
            "thread.unarchived",
            "thread.deleted",
            "thread.deleted",
            "project.deleted",
        ]
    );
    assert_eq!(events[7].event.payload["attachments"], json!([]));
    assert_eq!(
        events[14].event.payload["session"]["runtimeMode"],
        "full-access"
    );
    assert_eq!(events[19].event.payload["activity"]["id"], "activity-1");
    assert_eq!(events[19].event.metadata["requestId"], "r3");

    let snapshot = load_snapshot(&engine.repositories())
        .await
        .expect("snapshot");
    assert_eq!(snapshot.projects[0].title, "Renamed");
    assert!(snapshot.projects[0].deleted_at.is_some());
    let thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == "t1")
        .unwrap();
    assert_eq!(thread.title, "Thread 2");
    assert_eq!(thread.runtime_mode, "approval-required");
    assert_eq!(thread.interaction_mode, "plan");
    assert!(thread.deleted_at.is_some());
    assert!(
        snapshot
            .messages
            .iter()
            .all(|message| message.message_id != "m-assistant")
    );
    assert!(
        snapshot.checkpoints.is_empty(),
        "revert to zero removes checkpoint projections"
    );
    assert!(
        snapshot.activities.is_empty(),
        "revert removes turn-bound activity projections"
    );
    assert!(
        snapshot.proposed_plans.is_empty(),
        "revert removes turn-bound plan projections"
    );

    let duplicate = engine
        .dispatch(decode(values[17].clone()))
        .await
        .expect("idempotent retry");
    assert_eq!(duplicate.sequence, 16);
    engine.shutdown().await;

    repositories
        .database()
        .call(|connection| {
            connection.execute("DELETE FROM projection_projects", [])?;
            connection.execute("DELETE FROM projection_thread_messages", [])?;
            connection.execute(
                "UPDATE projection_state SET last_applied_sequence = 0 WHERE projector IN ('projection.projects', 'projection.thread-messages')",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("rewind selected projectors");

    let restarted =
        OrchestrationEngine::start(repositories.database().clone(), EngineOptions::default())
            .await
            .expect("restart");
    assert_eq!(restarted.read_events(0).await.unwrap().len(), 26);
    let replayed = load_snapshot(&restarted.repositories()).await.unwrap();
    assert_eq!(replayed.projects[0].title, "Renamed");
    assert!(replayed.projects[0].deleted_at.is_some());
    assert_eq!(replayed.messages.len(), 1);
    assert_eq!(replayed.messages[0].message_id, "m-user");
    restarted.shutdown().await;
}

#[tokio::test]
async fn default_thread_cannot_be_archived_or_deleted_directly() {
    let repositories = migrated_repositories().await;
    let engine =
        OrchestrationEngine::start(repositories.database().clone(), EngineOptions::default())
            .await
            .expect("engine starts");
    engine
        .dispatch(decode(json!({
            "type": "project.create",
            "commandId": "create-project",
            "projectId": "project-default-guard",
            "title": "Guarded Project",
            "workspaceRoot": "C:/guarded",
            "defaultModelSelection": null,
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("project created");

    let snapshot = load_snapshot(&engine.repositories())
        .await
        .expect("snapshot");
    let default_id = snapshot
        .threads
        .iter()
        .find(|thread| thread.project_id == "project-default-guard" && thread.kind == "default")
        .expect("default thread")
        .thread_id
        .clone();

    let duplicate_error = engine
        .dispatch(decode(json!({
            "type": "thread.create",
            "commandId": "replace-default",
            "threadId": "replacement-default",
            "projectId": "project-default-guard",
            "title": "Replacement",
            "kind": "default",
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "branch": null,
            "worktreePath": null,
            "createdAt": CREATED_AT,
        })))
        .await
        .expect_err("second default thread is rejected");
    assert!(duplicate_error.to_string().contains("default thread"));

    for (command_id, command_type) in [
        ("archive-default", "thread.archive"),
        ("delete-default", "thread.delete"),
    ] {
        let error = engine
            .dispatch(decode(json!({
                "type": command_type,
                "commandId": command_id,
                "threadId": default_id,
            })))
            .await
            .expect_err("default thread mutation is rejected");
        assert!(error.to_string().contains("Default thread"));
    }

    let snapshot = load_snapshot(&engine.repositories())
        .await
        .expect("snapshot");
    let default_thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == default_id)
        .expect("default thread remains");
    assert!(default_thread.archived_at.is_none());
    assert!(default_thread.deleted_at.is_none());
    assert_eq!(
        snapshot
            .threads
            .iter()
            .filter(|thread| {
                thread.project_id == "project-default-guard"
                    && thread.kind == "default"
                    && thread.deleted_at.is_none()
            })
            .count(),
        1
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_turn_creates_thread_before_dispatching_final_turn() {
    let repositories = migrated_repositories().await;
    let engine =
        OrchestrationEngine::start(repositories.database().clone(), EngineOptions::default())
            .await
            .expect("engine starts");
    engine
        .dispatch(decode(command_values()[0].clone()))
        .await
        .expect("project is created");

    engine
        .dispatch(decode(json!({
            "type":"thread.turn.start",
            "commandId":"bootstrap-turn",
            "threadId":"bootstrap-thread",
            "message":{"messageId":"bootstrap-message","role":"user","text":"build it","attachments":[]},
            "bootstrap":{"createThread":{
                "projectId":"p1",
                "title":"Bootstrap thread",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":null,
                "createdAt":CREATED_AT
            }},
            "createdAt":CREATED_AT
        })))
        .await
        .expect("bootstrap turn succeeds");

    let thread = engine
        .repositories()
        .get_thread("bootstrap-thread".to_owned())
        .await
        .expect("thread query")
        .expect("thread was created");
    assert_eq!(thread.title, "Bootstrap thread");

    let events = engine.read_events(0).await.expect("events");
    let bootstrap_events: Vec<_> = events
        .iter()
        .filter(|event| event.event.aggregate_id == "bootstrap-thread")
        .map(|event| event.event.event_type.as_str())
        .collect();
    assert_eq!(
        bootstrap_events,
        vec![
            "thread.created",
            "thread.message-sent",
            "thread.turn-start-requested"
        ]
    );

    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_worktree_failure_cleans_up_newly_created_thread() {
    let repositories = migrated_repositories().await;
    let engine =
        OrchestrationEngine::start(repositories.database().clone(), EngineOptions::default())
            .await
            .expect("engine starts");
    engine
        .dispatch(decode(command_values()[0].clone()))
        .await
        .expect("project is created");

    let error = engine
        .dispatch(decode(json!({
            "type":"thread.turn.start", "commandId":"bootstrap-fails", "threadId":"failed-thread",
            "message":{"messageId":"never-sent","role":"user","text":"build it","attachments":[]},
            "bootstrap":{
                "createThread":{
                    "projectId":"p1", "title":"Failed bootstrap",
                    "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access", "interactionMode":"default",
                    "branch":null, "worktreePath":null, "createdAt":CREATED_AT
                },
                "prepareWorktree":{"projectCwd":"C:/missing","baseBranch":"main"}
            },
            "createdAt":CREATED_AT
        })))
        .await
        .expect_err("bootstrap fails without production effects");
    assert!(error.to_string().contains("worktree preparation"));
    assert!(
        error
            .to_string()
            .contains("production bootstrap effects are not registered")
    );

    let thread = engine
        .repositories()
        .get_thread("failed-thread".to_owned())
        .await
        .unwrap()
        .expect("created thread remains as a tombstone");
    assert!(thread.deleted_at.is_some());
    assert!(
        engine
            .repositories()
            .list_messages_by_thread("failed-thread".to_owned())
            .await
            .unwrap()
            .is_empty()
    );

    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_metadata_failure_removes_the_prepared_worktree() {
    let repositories = migrated_repositories().await;
    let hooks = TestHooks::default();
    let engine = OrchestrationEngine::start(
        repositories.database().clone(),
        EngineOptions {
            queue_capacity: 1,
            test_hooks: hooks.clone(),
        },
    )
    .await
    .expect("engine starts");
    engine
        .dispatch(decode(command_values()[0].clone()))
        .await
        .expect("project is created");
    let effects = Arc::new(BootstrapRollbackProbe::default());
    engine.set_bootstrap_effects(effects.clone());
    hooks.fail_next_projector("projection.threads", Some("thread.meta-updated"));

    let error = engine
        .dispatch(decode(json!({
            "type":"thread.turn.start", "commandId":"bootstrap-meta-fails", "threadId":"meta-failed-thread",
            "message":{"messageId":"never-sent","role":"user","text":"build it","attachments":[]},
            "bootstrap":{
                "createThread":{
                    "projectId":"p1", "title":"Metadata failure",
                    "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access", "interactionMode":"default",
                    "branch":null, "worktreePath":null, "createdAt":CREATED_AT
                },
                "prepareWorktree":{
                    "projectCwd":"C:/repo", "baseBranch":"main", "branch":"bootstrap-branch"
                }
            },
            "createdAt":CREATED_AT
        })))
        .await
        .expect_err("metadata persistence fails");
    assert!(error.to_string().contains("projection.threads"));
    assert_eq!(*effects.calls.lock().unwrap(), vec!["prepare", "remove"]);

    engine.shutdown().await;
}

#[tokio::test]
async fn bootstrap_turn_failure_closes_setup_resources_before_removing_worktree() {
    let repositories = migrated_repositories().await;
    let hooks = TestHooks::default();
    let engine = OrchestrationEngine::start(
        repositories.database().clone(),
        EngineOptions {
            queue_capacity: 1,
            test_hooks: hooks.clone(),
        },
    )
    .await
    .expect("engine starts");
    engine
        .dispatch(decode(command_values()[0].clone()))
        .await
        .expect("project is created");
    let effects = Arc::new(BootstrapRollbackProbe::default());
    engine.set_bootstrap_effects(effects.clone());
    hooks.fail_next_projector("projection.thread-messages", Some("thread.message-sent"));

    let error = engine
        .dispatch(decode(json!({
            "type":"thread.turn.start", "commandId":"bootstrap-turn-fails", "threadId":"turn-failed-thread",
            "message":{"messageId":"never-sent","role":"user","text":"build it","attachments":[]},
            "bootstrap":{
                "createThread":{
                    "projectId":"p1", "title":"Turn failure",
                    "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access", "interactionMode":"default",
                    "branch":null, "worktreePath":null, "createdAt":CREATED_AT
                },
                "prepareWorktree":{
                    "projectCwd":"C:/repo", "baseBranch":"main", "branch":"bootstrap-branch"
                },
                "runSetupScript":true
            },
            "createdAt":CREATED_AT
        })))
        .await
        .expect_err("turn persistence fails");
    assert!(error.to_string().contains("projection.thread-messages"));
    assert!(!error.to_string().contains("worktree cleanup failed"));
    assert_eq!(
        *effects.calls.lock().unwrap(),
        vec!["prepare", "setup", "cleanup", "remove"]
    );

    engine.shutdown().await;
}

#[tokio::test]
async fn projector_failure_rolls_back_event_projection_and_receipt() {
    let repositories = migrated_repositories().await;
    let hooks = TestHooks::default();
    let engine = OrchestrationEngine::start(
        repositories.database().clone(),
        EngineOptions {
            queue_capacity: 1,
            test_hooks: hooks.clone(),
        },
    )
    .await
    .expect("engine starts");
    let values = command_values();
    for index in [0, 3] {
        engine
            .dispatch(decode(values[index].clone()))
            .await
            .expect("setup");
    }
    hooks.fail_next_projector(
        "projection.thread-activities",
        Some("thread.activity-appended"),
    );
    let failed = engine
        .dispatch(decode(values[21].clone()))
        .await
        .expect_err("injected failure");
    assert!(matches!(
        failed,
        OrchestrationError::InjectedProjectorFailure { .. }
    ));
    assert_eq!(engine.read_events(0).await.unwrap().len(), 3);
    assert!(
        repositories
            .get_command_receipt("c18".to_owned())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        load_snapshot(&repositories)
            .await
            .unwrap()
            .activities
            .is_empty()
    );
    engine
        .dispatch(decode(values[21].clone()))
        .await
        .expect("retry succeeds");
    assert_eq!(engine.read_events(0).await.unwrap().len(), 4);
    engine.shutdown().await;
}
