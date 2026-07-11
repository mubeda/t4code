use serde::Serialize;
use serde_json::json;
use t4code_server::persistence::{
    AuthPairingLink, AuthSessionClient, CheckpointDiffBlob, CommandReceipt, Database,
    NewAuthSession, NewOrchestrationEvent, ProjectionCheckpoint, ProjectionPendingApproval,
    ProjectionPendingTurnStart, ProjectionProject, ProjectionState, ProjectionThread,
    ProjectionThreadActivity, ProjectionThreadMessage, ProjectionThreadProposedPlan,
    ProjectionThreadSession, ProjectionTurnById, ProviderSessionRuntime, Repositories,
    run_migrations,
};

const T0: &str = "2026-07-10T10:00:00.000Z";
const T1: &str = "2026-07-10T10:01:00.000Z";
const T2: &str = "2026-07-10T10:02:00.000Z";
const TIME_3: &str = "2026-07-10T10:03:00.000Z";
const FUTURE: &str = "2027-07-10T10:00:00.000Z";

async fn migrated_repositories() -> Repositories {
    let database = Database::open_in_memory()
        .await
        .expect("temporary SQLite database opens");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("all migrations apply");
    database.quick_check().await.expect("database is healthy");
    Repositories::new(database)
}

fn assert_row_eq<T: Serialize>(actual: &T, expected: &T) {
    assert_eq!(
        serde_json::to_value(actual).expect("actual row serializes"),
        serde_json::to_value(expected).expect("expected row serializes")
    );
}

fn project(id: &str, created_at: &str) -> ProjectionProject {
    ProjectionProject {
        project_id: id.to_owned(),
        title: format!("Project {id}"),
        workspace_root: format!("C:/work/{id}"),
        default_model_selection: Some(json!({
            "provider": "codex",
            "model": "gpt-5",
            "nested": { "reasoning": "high" }
        })),
        scripts: json!({"verify": "vp check\nvp run typecheck"}),
        created_at: created_at.to_owned(),
        updated_at: created_at.to_owned(),
        deleted_at: None,
    }
}

fn thread(id: &str, project_id: &str, created_at: &str) -> ProjectionThread {
    ProjectionThread {
        thread_id: id.to_owned(),
        project_id: project_id.to_owned(),
        title: format!("Thread {id}"),
        kind: "coding".to_owned(),
        model_selection: json!({"provider": "codex", "options": ["fast", "safe"]}),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        branch: Some(format!("codex/{id}")),
        worktree_path: Some(format!("C:/worktrees/{id}")),
        latest_turn_id: None,
        created_at: created_at.to_owned(),
        updated_at: created_at.to_owned(),
        archived_at: None,
        latest_user_message_at: None,
        pending_approval_count: 0,
        pending_user_input_count: 0,
        has_actionable_proposed_plan: 0,
        deleted_at: None,
    }
}

fn turn(id: &str, checkpoint_turn_count: Option<i64>) -> ProjectionTurnById {
    ProjectionTurnById {
        thread_id: "thread-turns".to_owned(),
        turn_id: id.to_owned(),
        pending_message_id: Some(format!("message-{id}")),
        source_proposed_plan_thread_id: None,
        source_proposed_plan_id: None,
        assistant_message_id: Some(format!("assistant-{id}")),
        state: "completed".to_owned(),
        requested_at: T1.to_owned(),
        started_at: Some(T2.to_owned()),
        completed_at: Some(TIME_3.to_owned()),
        checkpoint_turn_count,
        checkpoint_ref: checkpoint_turn_count.map(|count| format!("checkpoint-{count}")),
        checkpoint_status: checkpoint_turn_count.map(|_| "ready".to_owned()),
        checkpoint_files: json!([{"path": "src/main.rs", "status": "modified"}]),
    }
}

fn auth_client(label: &str) -> AuthSessionClient {
    AuthSessionClient {
        label: Some(label.to_owned()),
        ip_address: Some("127.0.0.1".to_owned()),
        user_agent: Some("repository-test/1.0".to_owned()),
        device_type: "desktop".to_owned(),
        os: Some("windows".to_owned()),
        browser: Some("webview2".to_owned()),
    }
}

#[test]
fn public_repository_api_inventory_is_explicit() {
    let source = include_str!("../src/persistence/repositories.rs");
    let mut methods = source
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            line.strip_prefix("pub async fn ")
                .or_else(|| line.strip_prefix("pub fn "))
                .or_else(|| line.strip_prefix("pub const fn "))
                .and_then(|suffix| suffix.split('(').next())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    methods.sort();

    let mut expected = vec![
        "append_event",
        "clear_checkpoint_turn_conflict",
        "consume_auth_pairing_link",
        "create_auth_pairing_link",
        "create_auth_session",
        "database",
        "delete_activities_by_thread",
        "delete_checkpoints_by_thread",
        "delete_messages_by_thread",
        "delete_pending_approval",
        "delete_pending_turn_start",
        "delete_project",
        "delete_proposed_plans_by_thread",
        "delete_provider_session_runtime",
        "delete_thread",
        "delete_thread_session",
        "delete_turns_by_thread",
        "get_auth_pairing_link_by_credential",
        "get_auth_session",
        "get_checkpoint",
        "get_command_receipt",
        "get_message",
        "get_pending_approval",
        "get_pending_turn_start",
        "get_project",
        "get_projection_state",
        "get_provider_session_runtime",
        "get_thread",
        "get_thread_session",
        "get_turn_by_id",
        "list_active_auth_pairing_links",
        "list_active_auth_sessions",
        "list_activities_by_thread",
        "list_checkpoint_diff_blobs_by_thread",
        "list_checkpoints_by_thread",
        "list_messages_by_thread",
        "list_pending_approvals_by_thread",
        "list_projects",
        "list_projection_states",
        "list_proposed_plans_by_thread",
        "list_provider_session_runtimes",
        "list_threads_by_project",
        "list_turns_by_thread",
        "min_last_applied_sequence",
        "new",
        "read_events_from_sequence",
        "replace_pending_turn_start",
        "revoke_auth_pairing_link",
        "revoke_auth_session",
        "revoke_other_auth_sessions",
        "set_auth_session_last_connected_at",
        "upsert_activity",
        "upsert_checkpoint",
        "upsert_checkpoint_diff_blob",
        "upsert_command_receipt",
        "upsert_message",
        "upsert_pending_approval",
        "upsert_project",
        "upsert_projection_state",
        "upsert_proposed_plan",
        "upsert_provider_session_runtime",
        "upsert_thread",
        "upsert_thread_session",
        "upsert_turn_by_id",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    expected.sort();

    assert_eq!(methods, expected, "update repository execution coverage");
}

#[tokio::test]
async fn orchestration_event_writer_round_trips_json() {
    let repositories = migrated_repositories().await;
    repositories
        .database()
        .quick_check()
        .await
        .expect("database accessor returns the live database");

    let first = NewOrchestrationEvent {
        event_id: "event-1".to_owned(),
        event_type: "thread.created".to_owned(),
        aggregate_kind: "thread".to_owned(),
        aggregate_id: "thread-1".to_owned(),
        occurred_at: T0.to_owned(),
        command_id: Some("client:create".to_owned()),
        causation_event_id: None,
        correlation_id: Some("correlation-1".to_owned()),
        payload: json!({"text": "line one\nline two", "items": [1, true, null]}),
        metadata: json!({"nested": {"source": "test"}}),
    };
    let inserted_first = repositories
        .append_event(first.clone())
        .await
        .expect("event 1");
    assert!(inserted_first.sequence > 0);
    assert_row_eq(&inserted_first.event, &first);
}

#[tokio::test]
async fn orchestration_event_reader_pages_seeded_json_rows_in_sequence_order() {
    let repositories = migrated_repositories().await;
    repositories
        .database()
        .call(|connection| {
            let rows = [
                (
                    "event-1",
                    "thread.created",
                    "thread",
                    "thread-1",
                    0_i64,
                    T0,
                    Some("client:create"),
                    None,
                    Some("correlation-1"),
                    "client",
                    json!({"text": "line one\nline two", "items": [1, true, null]}),
                    json!({"nested": {"source": "test"}}),
                ),
                (
                    "event-2",
                    "thread.updated",
                    "thread",
                    "thread-1",
                    1_i64,
                    T1,
                    Some("provider:resume"),
                    Some("event-1"),
                    Some("correlation-1"),
                    "provider",
                    json!({"state": "running"}),
                    json!({"adapterKey": "codex"}),
                ),
                (
                    "event-3",
                    "project.created",
                    "project",
                    "project-1",
                    0_i64,
                    T2,
                    None,
                    None,
                    None,
                    "server",
                    json!({"object": {"b": 2, "a": 1}}),
                    json!({}),
                ),
            ];
            for row in rows {
                connection.execute(
                    "INSERT INTO orchestration_events (event_id, event_type, aggregate_kind, stream_id, stream_version, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        row.0,
                        row.1,
                        row.2,
                        row.3,
                        row.4,
                        row.5,
                        row.6,
                        row.7,
                        row.8,
                        row.9,
                        serde_json::to_string(&row.10).expect("payload JSON"),
                        serde_json::to_string(&row.11).expect("metadata JSON"),
                    ],
                )?;
            }
            Ok(())
        })
        .await
        .expect("seed orchestration events");

    let first_page = repositories
        .read_events_from_sequence(0, 2)
        .await
        .expect("first page");
    assert_eq!(
        first_page
            .iter()
            .map(|event| event.event.event_id.as_str())
            .collect::<Vec<_>>(),
        ["event-1", "event-2"]
    );
    let second_page = repositories
        .read_events_from_sequence(first_page[1].sequence, 10)
        .await
        .expect("second page");
    assert_eq!(second_page.len(), 1);
    assert_eq!(second_page[0].event.event_id, "event-3");
    assert_eq!(
        second_page[0].event.payload,
        json!({"object": {"b": 2, "a": 1}})
    );
    assert!(
        repositories
            .read_events_from_sequence(-100, 0)
            .await
            .expect("zero limit")
            .is_empty()
    );

    let storage_types = repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT typeof(payload_json), typeof(metadata_json) FROM orchestration_events WHERE event_id = 'event-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?)
        })
        .await
        .expect("JSON storage types");
    assert_eq!(storage_types, ("text".to_owned(), "text".to_owned()));
}

#[tokio::test]
async fn command_receipt_and_checkpoint_diff_repositories_upsert_and_order() {
    let repositories = migrated_repositories().await;
    let mut receipt = CommandReceipt {
        command_id: "command-1".to_owned(),
        aggregate_kind: "thread".to_owned(),
        aggregate_id: "thread-1".to_owned(),
        accepted_at: T0.to_owned(),
        result_sequence: 1,
        status: "accepted".to_owned(),
        error: None,
    };
    repositories
        .upsert_command_receipt(receipt.clone())
        .await
        .expect("receipt insert");
    receipt.result_sequence = 3;
    receipt.status = "failed".to_owned();
    receipt.error = Some("first line\nsecond line".to_owned());
    repositories
        .upsert_command_receipt(receipt.clone())
        .await
        .expect("receipt upsert");
    assert_row_eq(
        &repositories
            .get_command_receipt(receipt.command_id.clone())
            .await
            .expect("receipt lookup")
            .expect("receipt exists"),
        &receipt,
    );
    assert!(
        repositories
            .get_command_receipt("missing".to_owned())
            .await
            .expect("missing receipt lookup")
            .is_none()
    );

    let early_diff = CheckpointDiffBlob {
        thread_id: "thread-1".to_owned(),
        from_turn_count: 0,
        to_turn_count: 1,
        diff: "@@ -1 +1 @@\n-old\n+new".to_owned(),
        created_at: T1.to_owned(),
    };
    let mut later_diff = CheckpointDiffBlob {
        thread_id: "thread-1".to_owned(),
        from_turn_count: 1,
        to_turn_count: 3,
        diff: "initial".to_owned(),
        created_at: T2.to_owned(),
    };
    repositories
        .upsert_checkpoint_diff_blob(later_diff.clone())
        .await
        .expect("later diff insert");
    repositories
        .upsert_checkpoint_diff_blob(early_diff.clone())
        .await
        .expect("early diff insert");
    later_diff.diff = "replacement\nwith multiple lines".to_owned();
    later_diff.created_at = TIME_3.to_owned();
    repositories
        .upsert_checkpoint_diff_blob(later_diff.clone())
        .await
        .expect("diff upsert");
    let diffs = repositories
        .list_checkpoint_diff_blobs_by_thread("thread-1".to_owned())
        .await
        .expect("diff listing");
    assert_eq!(
        diffs
            .iter()
            .map(|diff| diff.to_turn_count)
            .collect::<Vec<_>>(),
        [1, 3]
    );
    assert_row_eq(&diffs[0], &early_diff);
    assert_row_eq(&diffs[1], &later_diff);
}

#[tokio::test]
async fn runtime_project_and_thread_repositories_upsert_order_and_delete() {
    let repositories = migrated_repositories().await;

    let runtime_early = ProviderSessionRuntime {
        thread_id: "runtime-a".to_owned(),
        provider_name: "codex".to_owned(),
        provider_instance_id: Some("instance-a".to_owned()),
        adapter_key: "codex-app-server".to_owned(),
        runtime_mode: "full-access".to_owned(),
        status: "idle".to_owned(),
        last_seen_at: T1.to_owned(),
        resume_cursor: Some(json!({"sequence": 7, "tokens": ["a", "b"]})),
        runtime_payload: Some(json!({"pid": 1234, "state": {"healthy": true}})),
    };
    let mut runtime_late = ProviderSessionRuntime {
        thread_id: "runtime-b".to_owned(),
        last_seen_at: T2.to_owned(),
        ..runtime_early.clone()
    };
    repositories
        .upsert_provider_session_runtime(runtime_late.clone())
        .await
        .expect("late runtime insert");
    repositories
        .upsert_provider_session_runtime(runtime_early.clone())
        .await
        .expect("early runtime insert");
    runtime_late.status = "running".to_owned();
    runtime_late.resume_cursor = None;
    runtime_late.runtime_payload = Some(json!({"pid": 5678, "lines": "one\ntwo"}));
    repositories
        .upsert_provider_session_runtime(runtime_late.clone())
        .await
        .expect("runtime upsert");
    assert_row_eq(
        &repositories
            .get_provider_session_runtime("runtime-b".to_owned())
            .await
            .expect("runtime lookup")
            .expect("runtime exists"),
        &runtime_late,
    );
    assert_eq!(
        repositories
            .list_provider_session_runtimes()
            .await
            .expect("runtime listing")
            .iter()
            .map(|runtime| runtime.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["runtime-a", "runtime-b"]
    );
    repositories
        .delete_provider_session_runtime("runtime-a".to_owned())
        .await
        .expect("runtime deletion");
    assert!(
        repositories
            .get_provider_session_runtime("runtime-a".to_owned())
            .await
            .expect("deleted runtime lookup")
            .is_none()
    );

    let project_early = project("project-a", T0);
    let mut project_late = project("project-b", T1);
    repositories
        .upsert_project(project_late.clone())
        .await
        .expect("late project insert");
    repositories
        .upsert_project(project_early.clone())
        .await
        .expect("early project insert");
    project_late.title = "Updated title".to_owned();
    project_late.scripts = json!({"test": ["vp", "test"], "env": {"CI": true}});
    project_late.updated_at = TIME_3.to_owned();
    repositories
        .upsert_project(project_late.clone())
        .await
        .expect("project upsert");
    assert_row_eq(
        &repositories
            .get_project("project-b".to_owned())
            .await
            .expect("project lookup")
            .expect("project exists"),
        &project_late,
    );
    assert_eq!(
        repositories
            .list_projects()
            .await
            .expect("project listing")
            .iter()
            .map(|project| project.project_id.as_str())
            .collect::<Vec<_>>(),
        ["project-a", "project-b"]
    );

    let thread_early = thread("thread-a", "project-b", T1);
    let mut thread_late = thread("thread-b", "project-b", T2);
    repositories
        .upsert_thread(thread_late.clone())
        .await
        .expect("late thread insert");
    repositories
        .upsert_thread(thread_early.clone())
        .await
        .expect("early thread insert");
    thread_late.title = "Updated thread".to_owned();
    thread_late.pending_approval_count = 2;
    thread_late.has_actionable_proposed_plan = 1;
    thread_late.updated_at = TIME_3.to_owned();
    repositories
        .upsert_thread(thread_late.clone())
        .await
        .expect("thread upsert");
    assert_row_eq(
        &repositories
            .get_thread("thread-b".to_owned())
            .await
            .expect("thread lookup")
            .expect("thread exists"),
        &thread_late,
    );
    assert_eq!(
        repositories
            .list_threads_by_project("project-b".to_owned())
            .await
            .expect("thread listing")
            .iter()
            .map(|thread| thread.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["thread-a", "thread-b"]
    );

    repositories
        .delete_thread("thread-a".to_owned())
        .await
        .expect("thread deletion");
    assert!(
        repositories
            .get_thread("thread-a".to_owned())
            .await
            .expect("deleted thread lookup")
            .is_none()
    );
    repositories
        .delete_project("project-a".to_owned())
        .await
        .expect("project deletion");
    assert!(
        repositories
            .get_project("project-a".to_owned())
            .await
            .expect("deleted project lookup")
            .is_none()
    );
}

#[tokio::test]
async fn conversation_projection_repositories_round_trip_order_and_delete() {
    let repositories = migrated_repositories().await;

    let message_a = ProjectionThreadMessage {
        message_id: "message-a".to_owned(),
        thread_id: "thread-conversation".to_owned(),
        turn_id: Some("turn-a".to_owned()),
        role: "user".to_owned(),
        text: "first\nmessage".to_owned(),
        attachments: Some(json!([{
            "kind": "image",
            "path": "C:/tmp/screenshot.png",
            "metadata": {"width": 800, "height": 600}
        }])),
        is_streaming: false,
        created_at: T1.to_owned(),
        updated_at: T1.to_owned(),
    };
    let message_b = ProjectionThreadMessage {
        message_id: "message-b".to_owned(),
        created_at: T2.to_owned(),
        updated_at: T2.to_owned(),
        attachments: None,
        ..message_a.clone()
    };
    repositories
        .upsert_message(message_b.clone())
        .await
        .expect("later message insert");
    repositories
        .upsert_message(message_a.clone())
        .await
        .expect("earlier message insert");
    let mut message_update = message_a.clone();
    message_update.text = "updated while preserving attachments".to_owned();
    message_update.attachments = None;
    message_update.is_streaming = true;
    message_update.updated_at = TIME_3.to_owned();
    repositories
        .upsert_message(message_update.clone())
        .await
        .expect("message upsert");
    let stored_message = repositories
        .get_message("message-a".to_owned())
        .await
        .expect("message lookup")
        .expect("message exists");
    assert_eq!(stored_message.text, message_update.text);
    assert_eq!(stored_message.is_streaming, message_update.is_streaming);
    assert_eq!(stored_message.attachments, message_a.attachments);
    assert_eq!(
        repositories
            .list_messages_by_thread("thread-conversation".to_owned())
            .await
            .expect("message listing")
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<Vec<_>>(),
        ["message-a", "message-b"]
    );
    repositories
        .delete_messages_by_thread("thread-conversation".to_owned())
        .await
        .expect("message deletion");
    assert!(
        repositories
            .list_messages_by_thread("thread-conversation".to_owned())
            .await
            .expect("empty message listing")
            .is_empty()
    );

    let activity_none = ProjectionThreadActivity {
        activity_id: "activity-none".to_owned(),
        thread_id: "thread-conversation".to_owned(),
        turn_id: None,
        tone: "neutral".to_owned(),
        kind: "status".to_owned(),
        summary: "No provider sequence".to_owned(),
        payload: json!({"details": ["a", {"b": true}]}),
        sequence: None,
        created_at: TIME_3.to_owned(),
    };
    let activity_one = ProjectionThreadActivity {
        activity_id: "activity-one".to_owned(),
        sequence: Some(1),
        created_at: T2.to_owned(),
        ..activity_none.clone()
    };
    let activity_two = ProjectionThreadActivity {
        activity_id: "activity-two".to_owned(),
        sequence: Some(2),
        created_at: T1.to_owned(),
        ..activity_none.clone()
    };
    for activity in [&activity_two, &activity_none, &activity_one] {
        repositories
            .upsert_activity(activity.clone())
            .await
            .expect("activity upsert");
    }
    let mut activity_one_update = activity_one.clone();
    activity_one_update.summary = "Updated".to_owned();
    activity_one_update.payload = json!({"multiline": "one\ntwo"});
    repositories
        .upsert_activity(activity_one_update.clone())
        .await
        .expect("activity idempotent update");
    let activities = repositories
        .list_activities_by_thread("thread-conversation".to_owned())
        .await
        .expect("activity listing");
    assert_eq!(
        activities
            .iter()
            .map(|activity| activity.activity_id.as_str())
            .collect::<Vec<_>>(),
        ["activity-none", "activity-one", "activity-two"]
    );
    assert_row_eq(&activities[1], &activity_one_update);
    repositories
        .delete_activities_by_thread("thread-conversation".to_owned())
        .await
        .expect("activity deletion");

    let mut session = ProjectionThreadSession {
        thread_id: "thread-conversation".to_owned(),
        status: "idle".to_owned(),
        provider_name: Some("codex".to_owned()),
        provider_instance_id: Some("instance-1".to_owned()),
        runtime_mode: "full-access".to_owned(),
        active_turn_id: None,
        last_error: None,
        updated_at: T1.to_owned(),
    };
    repositories
        .upsert_thread_session(session.clone())
        .await
        .expect("session insert");
    session.status = "failed".to_owned();
    session.last_error = Some("provider exited\nwith code 1".to_owned());
    session.updated_at = T2.to_owned();
    repositories
        .upsert_thread_session(session.clone())
        .await
        .expect("session upsert");
    assert_row_eq(
        &repositories
            .get_thread_session("thread-conversation".to_owned())
            .await
            .expect("session lookup")
            .expect("session exists"),
        &session,
    );
    repositories
        .delete_thread_session("thread-conversation".to_owned())
        .await
        .expect("session deletion");
    assert!(
        repositories
            .get_thread_session("thread-conversation".to_owned())
            .await
            .expect("deleted session lookup")
            .is_none()
    );

    let approval_a = ProjectionPendingApproval {
        request_id: "approval-a".to_owned(),
        thread_id: "thread-conversation".to_owned(),
        turn_id: Some("turn-a".to_owned()),
        status: "pending".to_owned(),
        decision: None,
        created_at: T1.to_owned(),
        resolved_at: None,
    };
    let mut approval_b = ProjectionPendingApproval {
        request_id: "approval-b".to_owned(),
        created_at: T2.to_owned(),
        ..approval_a.clone()
    };
    repositories
        .upsert_pending_approval(approval_b.clone())
        .await
        .expect("later approval insert");
    repositories
        .upsert_pending_approval(approval_a.clone())
        .await
        .expect("earlier approval insert");
    approval_b.status = "resolved".to_owned();
    approval_b.decision = Some("approved".to_owned());
    approval_b.resolved_at = Some(TIME_3.to_owned());
    repositories
        .upsert_pending_approval(approval_b.clone())
        .await
        .expect("approval upsert");
    assert_row_eq(
        &repositories
            .get_pending_approval("approval-b".to_owned())
            .await
            .expect("approval lookup")
            .expect("approval exists"),
        &approval_b,
    );
    assert_eq!(
        repositories
            .list_pending_approvals_by_thread("thread-conversation".to_owned())
            .await
            .expect("approval listing")
            .iter()
            .map(|approval| approval.request_id.as_str())
            .collect::<Vec<_>>(),
        ["approval-a", "approval-b"]
    );
    repositories
        .delete_pending_approval("approval-a".to_owned())
        .await
        .expect("approval deletion");
    assert!(
        repositories
            .get_pending_approval("approval-a".to_owned())
            .await
            .expect("deleted approval lookup")
            .is_none()
    );

    let plan_a = ProjectionThreadProposedPlan {
        plan_id: "plan-a".to_owned(),
        thread_id: "thread-conversation".to_owned(),
        turn_id: Some("turn-a".to_owned()),
        plan_markdown: "# Plan\n\n1. First".to_owned(),
        implemented_at: None,
        implementation_thread_id: None,
        created_at: T1.to_owned(),
        updated_at: T1.to_owned(),
    };
    let mut plan_b = ProjectionThreadProposedPlan {
        plan_id: "plan-b".to_owned(),
        created_at: T2.to_owned(),
        updated_at: T2.to_owned(),
        ..plan_a.clone()
    };
    repositories
        .upsert_proposed_plan(plan_b.clone())
        .await
        .expect("later plan insert");
    repositories
        .upsert_proposed_plan(plan_a.clone())
        .await
        .expect("earlier plan insert");
    plan_b.implemented_at = Some(TIME_3.to_owned());
    plan_b.implementation_thread_id = Some("thread-implementation".to_owned());
    repositories
        .upsert_proposed_plan(plan_b.clone())
        .await
        .expect("plan upsert");
    let plans = repositories
        .list_proposed_plans_by_thread("thread-conversation".to_owned())
        .await
        .expect("plan listing");
    assert_eq!(
        plans
            .iter()
            .map(|plan| plan.plan_id.as_str())
            .collect::<Vec<_>>(),
        ["plan-a", "plan-b"]
    );
    assert_row_eq(&plans[1], &plan_b);
    repositories
        .delete_proposed_plans_by_thread("thread-conversation".to_owned())
        .await
        .expect("plan deletion");
    assert!(
        repositories
            .list_proposed_plans_by_thread("thread-conversation".to_owned())
            .await
            .expect("empty plan listing")
            .is_empty()
    );

    let state_b = ProjectionState {
        projector: "threads".to_owned(),
        last_applied_sequence: 12,
        updated_at: T2.to_owned(),
    };
    let mut state_a = ProjectionState {
        projector: "messages".to_owned(),
        last_applied_sequence: 7,
        updated_at: T1.to_owned(),
    };
    repositories
        .upsert_projection_state(state_b.clone())
        .await
        .expect("state b insert");
    repositories
        .upsert_projection_state(state_a.clone())
        .await
        .expect("state a insert");
    state_a.last_applied_sequence = 9;
    state_a.updated_at = TIME_3.to_owned();
    repositories
        .upsert_projection_state(state_a.clone())
        .await
        .expect("state upsert");
    assert_row_eq(
        &repositories
            .get_projection_state("messages".to_owned())
            .await
            .expect("state lookup")
            .expect("state exists"),
        &state_a,
    );
    assert_eq!(
        repositories
            .list_projection_states()
            .await
            .expect("state listing")
            .iter()
            .map(|state| state.projector.as_str())
            .collect::<Vec<_>>(),
        ["messages", "threads"]
    );
    assert_eq!(
        repositories
            .min_last_applied_sequence()
            .await
            .expect("minimum state sequence"),
        Some(9)
    );
}

#[tokio::test]
async fn turn_and_checkpoint_repositories_preserve_conflicts_and_roll_back_transactions() {
    let repositories = migrated_repositories().await;

    let pending_a = ProjectionPendingTurnStart {
        thread_id: "thread-turns".to_owned(),
        message_id: "pending-a".to_owned(),
        source_proposed_plan_thread_id: Some("source-thread".to_owned()),
        source_proposed_plan_id: Some("source-plan".to_owned()),
        requested_at: T1.to_owned(),
    };
    let pending_b = ProjectionPendingTurnStart {
        message_id: "pending-b".to_owned(),
        requested_at: T2.to_owned(),
        ..pending_a.clone()
    };
    repositories
        .replace_pending_turn_start(pending_a.clone())
        .await
        .expect("first pending turn");
    repositories
        .replace_pending_turn_start(pending_b.clone())
        .await
        .expect("pending turn replacement");
    assert_row_eq(
        &repositories
            .get_pending_turn_start("thread-turns".to_owned())
            .await
            .expect("pending turn lookup")
            .expect("pending turn exists"),
        &pending_b,
    );

    repositories
        .database()
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER reject_pending_turn BEFORE INSERT ON projection_turns \
                 WHEN NEW.pending_message_id = 'reject-pending' \
                 BEGIN SELECT RAISE(ABORT, 'reject pending turn'); END;",
            )?;
            Ok(())
        })
        .await
        .expect("pending rollback trigger");
    let rejected_pending = ProjectionPendingTurnStart {
        message_id: "reject-pending".to_owned(),
        requested_at: TIME_3.to_owned(),
        ..pending_b.clone()
    };
    assert!(
        repositories
            .replace_pending_turn_start(rejected_pending)
            .await
            .is_err()
    );
    assert_row_eq(
        &repositories
            .get_pending_turn_start("thread-turns".to_owned())
            .await
            .expect("pending turn after rollback")
            .expect("original pending turn survives"),
        &pending_b,
    );
    repositories
        .delete_pending_turn_start("thread-turns".to_owned())
        .await
        .expect("pending turn deletion");
    assert!(
        repositories
            .get_pending_turn_start("thread-turns".to_owned())
            .await
            .expect("deleted pending turn lookup")
            .is_none()
    );

    let mut turn_a = turn("turn-a", Some(5));
    let turn_b = turn("turn-b", None);
    repositories
        .upsert_turn_by_id(turn_a.clone())
        .await
        .expect("turn a insert");
    repositories
        .upsert_turn_by_id(turn_b.clone())
        .await
        .expect("turn b insert");
    turn_a.state = "error".to_owned();
    turn_a.checkpoint_files = json!(["a.rs", "b.rs"]);
    repositories
        .upsert_turn_by_id(turn_a.clone())
        .await
        .expect("turn upsert");
    assert_row_eq(
        &repositories
            .get_turn_by_id("thread-turns".to_owned(), "turn-a".to_owned())
            .await
            .expect("turn lookup")
            .expect("turn exists"),
        &turn_a,
    );
    assert!(
        repositories
            .get_turn_by_id("thread-turns".to_owned(), "missing".to_owned())
            .await
            .expect("missing turn lookup")
            .is_none()
    );
    assert_eq!(
        repositories
            .list_turns_by_thread("thread-turns".to_owned())
            .await
            .expect("turn listing")
            .len(),
        2
    );

    repositories
        .clear_checkpoint_turn_conflict("thread-turns".to_owned(), "turn-b".to_owned(), 5)
        .await
        .expect("checkpoint conflict clear");
    let cleared_turn = repositories
        .get_turn_by_id("thread-turns".to_owned(), "turn-a".to_owned())
        .await
        .expect("cleared turn lookup")
        .expect("turn remains");
    assert_eq!(cleared_turn.checkpoint_turn_count, None);
    assert_eq!(cleared_turn.checkpoint_files, json!([]));

    let old_checkpoint_turn = turn("old-checkpoint", Some(8));
    repositories
        .upsert_turn_by_id(old_checkpoint_turn)
        .await
        .expect("old checkpoint turn");
    let checkpoint = ProjectionCheckpoint {
        thread_id: "thread-turns".to_owned(),
        turn_id: "new-checkpoint".to_owned(),
        checkpoint_turn_count: 8,
        checkpoint_ref: "checkpoint-new".to_owned(),
        status: "ready".to_owned(),
        files: json!([{"path": "src/lib.rs", "sha": "abc123"}]),
        assistant_message_id: Some("assistant-checkpoint".to_owned()),
        completed_at: TIME_3.to_owned(),
    };
    repositories
        .upsert_checkpoint(checkpoint.clone())
        .await
        .expect("checkpoint conflict replacement");
    assert_row_eq(
        &repositories
            .get_checkpoint("thread-turns".to_owned(), 8)
            .await
            .expect("checkpoint lookup")
            .expect("checkpoint exists"),
        &checkpoint,
    );
    assert_eq!(
        repositories
            .list_checkpoints_by_thread("thread-turns".to_owned())
            .await
            .expect("checkpoint listing")
            .iter()
            .map(|checkpoint| checkpoint.checkpoint_turn_count)
            .collect::<Vec<_>>(),
        [8]
    );

    repositories
        .database()
        .call(|connection| {
            connection.execute_batch(
                "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON projection_turns \
                 WHEN NEW.turn_id = 'reject-checkpoint' \
                 BEGIN SELECT RAISE(ABORT, 'reject checkpoint'); END;",
            )?;
            Ok(())
        })
        .await
        .expect("checkpoint rollback trigger");
    let rejected_checkpoint = ProjectionCheckpoint {
        turn_id: "reject-checkpoint".to_owned(),
        checkpoint_ref: "must-not-replace".to_owned(),
        ..checkpoint.clone()
    };
    assert!(
        repositories
            .upsert_checkpoint(rejected_checkpoint)
            .await
            .is_err()
    );
    assert_row_eq(
        &repositories
            .get_checkpoint("thread-turns".to_owned(), 8)
            .await
            .expect("checkpoint after rollback")
            .expect("original checkpoint survives"),
        &checkpoint,
    );

    repositories
        .delete_checkpoints_by_thread("thread-turns".to_owned())
        .await
        .expect("checkpoint deletion");
    assert!(
        repositories
            .list_checkpoints_by_thread("thread-turns".to_owned())
            .await
            .expect("empty checkpoint listing")
            .is_empty()
    );
    assert!(
        !repositories
            .list_turns_by_thread("thread-turns".to_owned())
            .await
            .expect("turns survive checkpoint clearing")
            .is_empty()
    );
    repositories
        .delete_turns_by_thread("thread-turns".to_owned())
        .await
        .expect("turn deletion");
    assert!(
        repositories
            .list_turns_by_thread("thread-turns".to_owned())
            .await
            .expect("empty turn listing")
            .is_empty()
    );
}

#[tokio::test]
async fn auth_pairing_links_consume_and_revoke_atomically() {
    let repositories = migrated_repositories().await;
    let pairing = AuthPairingLink {
        id: "pairing-a".to_owned(),
        credential: "credential-a".to_owned(),
        method: "pairing".to_owned(),
        scopes: json!(["rpc:read", {"delegated": ["rpc:write"]}]),
        subject: "user-a".to_owned(),
        label: Some("Laptop".to_owned()),
        proof_key_thumbprint: Some("thumbprint-a".to_owned()),
        created_at: T1.to_owned(),
        expires_at: FUTURE.to_owned(),
        consumed_at: None,
        revoked_at: None,
    };
    let later_pairing = AuthPairingLink {
        id: "pairing-b".to_owned(),
        credential: "credential-b".to_owned(),
        proof_key_thumbprint: None,
        created_at: T2.to_owned(),
        ..pairing.clone()
    };
    repositories
        .create_auth_pairing_link(pairing.clone())
        .await
        .expect("pairing insert");
    repositories
        .create_auth_pairing_link(later_pairing.clone())
        .await
        .expect("later pairing insert");
    assert_row_eq(
        &repositories
            .get_auth_pairing_link_by_credential("credential-a".to_owned())
            .await
            .expect("pairing lookup")
            .expect("pairing exists"),
        &pairing,
    );
    assert_eq!(
        repositories
            .list_active_auth_pairing_links(T0.to_owned())
            .await
            .expect("active pairing listing")
            .iter()
            .map(|pairing| pairing.id.as_str())
            .collect::<Vec<_>>(),
        ["pairing-b", "pairing-a"]
    );
    assert!(
        repositories
            .consume_auth_pairing_link(
                "credential-a".to_owned(),
                Some("wrong-thumbprint".to_owned()),
                T2.to_owned(),
                T2.to_owned(),
            )
            .await
            .expect("wrong proof is handled")
            .is_none()
    );

    let first_consumer = repositories.clone();
    let second_consumer = repositories.clone();
    let (first_result, second_result) = tokio::join!(
        first_consumer.consume_auth_pairing_link(
            "credential-a".to_owned(),
            Some("thumbprint-a".to_owned()),
            T2.to_owned(),
            T2.to_owned(),
        ),
        second_consumer.consume_auth_pairing_link(
            "credential-a".to_owned(),
            Some("thumbprint-a".to_owned()),
            TIME_3.to_owned(),
            T2.to_owned(),
        )
    );
    let consumed = [
        first_result.expect("first atomic consume"),
        second_result.expect("second atomic consume"),
    ];
    assert_eq!(consumed.iter().filter(|row| row.is_some()).count(), 1);
    let consumed_row = consumed
        .into_iter()
        .flatten()
        .next()
        .expect("one consumer wins");
    assert_eq!(consumed_row.id, "pairing-a");
    assert!(consumed_row.consumed_at.is_some());
    assert!(
        !repositories
            .revoke_auth_pairing_link("pairing-a".to_owned(), TIME_3.to_owned())
            .await
            .expect("consumed pairing cannot be revoked")
    );
    assert!(
        repositories
            .revoke_auth_pairing_link("pairing-b".to_owned(), TIME_3.to_owned())
            .await
            .expect("active pairing revoked")
    );
    assert!(
        !repositories
            .revoke_auth_pairing_link("pairing-b".to_owned(), TIME_3.to_owned())
            .await
            .expect("pairing revocation is idempotent")
    );
    assert!(
        repositories
            .list_active_auth_pairing_links(T0.to_owned())
            .await
            .expect("no active pairings remain")
            .is_empty()
    );
}

#[tokio::test]
async fn auth_sessions_round_trip_order_connect_and_revoke() {
    let repositories = migrated_repositories().await;
    let session_a = NewAuthSession {
        session_id: "session-a".to_owned(),
        subject: "user-a".to_owned(),
        scopes: json!(["rpc:read", "rpc:write", {"admin": true}]),
        method: "pairing".to_owned(),
        client: auth_client("Laptop"),
        issued_at: T1.to_owned(),
        expires_at: FUTURE.to_owned(),
    };
    let session_b = NewAuthSession {
        session_id: "session-b".to_owned(),
        client: auth_client("Desktop"),
        issued_at: T2.to_owned(),
        ..session_a.clone()
    };
    let session_c = NewAuthSession {
        session_id: "session-c".to_owned(),
        client: auth_client("Browser"),
        issued_at: TIME_3.to_owned(),
        ..session_a.clone()
    };
    for session in [&session_a, &session_b, &session_c] {
        repositories
            .create_auth_session(session.clone())
            .await
            .expect("session insert");
    }
    let stored_a = repositories
        .get_auth_session("session-a".to_owned())
        .await
        .expect("session lookup")
        .expect("session exists");
    assert_eq!(stored_a.session_id, session_a.session_id);
    assert_eq!(stored_a.subject, session_a.subject);
    assert_eq!(stored_a.scopes, session_a.scopes);
    assert_row_eq(&stored_a.client, &session_a.client);
    assert_eq!(stored_a.last_connected_at, None);
    assert_eq!(stored_a.revoked_at, None);
    assert_eq!(
        repositories
            .list_active_auth_sessions(T0.to_owned())
            .await
            .expect("active session listing")
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["session-c", "session-b", "session-a"]
    );

    repositories
        .set_auth_session_last_connected_at("session-a".to_owned(), TIME_3.to_owned())
        .await
        .expect("last connected update");
    assert_eq!(
        repositories
            .get_auth_session("session-a".to_owned())
            .await
            .expect("connected session lookup")
            .expect("connected session exists")
            .last_connected_at
            .as_deref(),
        Some(TIME_3)
    );
    assert!(
        repositories
            .revoke_auth_session("session-b".to_owned(), TIME_3.to_owned())
            .await
            .expect("session revocation")
    );
    assert!(
        !repositories
            .revoke_auth_session("session-b".to_owned(), TIME_3.to_owned())
            .await
            .expect("session revocation is idempotent")
    );
    repositories
        .set_auth_session_last_connected_at("session-b".to_owned(), FUTURE.to_owned())
        .await
        .expect("revoked session connection update is ignored");
    let revoked_b = repositories
        .get_auth_session("session-b".to_owned())
        .await
        .expect("revoked session lookup")
        .expect("revoked session exists");
    assert_eq!(revoked_b.last_connected_at, None);
    assert_eq!(revoked_b.revoked_at.as_deref(), Some(TIME_3));

    let mut revoked_others = repositories
        .revoke_other_auth_sessions("session-a".to_owned(), FUTURE.to_owned())
        .await
        .expect("other sessions revoked");
    revoked_others.sort();
    assert_eq!(revoked_others, ["session-c"]);
    assert_eq!(
        repositories
            .list_active_auth_sessions(T0.to_owned())
            .await
            .expect("only current session active")
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["session-a"]
    );
    assert!(
        repositories
            .revoke_other_auth_sessions("session-a".to_owned(), FUTURE.to_owned())
            .await
            .expect("revoke others is idempotent")
            .is_empty()
    );
    assert!(
        repositories
            .get_auth_session("missing".to_owned())
            .await
            .expect("missing session lookup")
            .is_none()
    );

    let storage_type = repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT typeof(scopes) FROM auth_sessions WHERE session_id = 'session-a'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .expect("auth scope storage type");
    assert_eq!(storage_type, "text");
}
