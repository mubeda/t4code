use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    orchestration::{OrchestrationCommand, OrchestrationEngine, load_snapshot},
    persistence::{OrchestrationEvent, ProjectionThread},
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
};

use super::orchestration_effects::normalize_project_create_command;
use super::provider_runtime::{ProviderRuntimeSupervisor, route_orchestration_command};

const STREAM_CAPACITY: usize = 16;

pub fn register_orchestration_rpc(registry: &mut RpcRegistry, engine: OrchestrationEngine) {
    register_orchestration_rpc_inner(registry, engine, None);
}

pub fn register_orchestration_rpc_with_provider(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
) {
    register_orchestration_rpc_inner(registry, engine, Some((provider, settings_root)));
}

fn register_orchestration_rpc_inner(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Option<(Arc<ProviderRuntimeSupervisor>, PathBuf)>,
) {
    let dispatch = engine.clone();
    registry.register_unary("orchestration.dispatchCommand", move |request, _| {
        let dispatch = dispatch.clone();
        let provider = provider.clone();
        async move {
            let mut command = serde_json::from_value::<OrchestrationCommand>(request.payload)
                .map_err(|error| invalid_request(&request.tag, error.to_string()))?;
            normalize_project_create_command(&mut command)
                .await
                .map_err(|error| invalid_request(&request.tag, error.to_string()))?;
            let result = dispatch
                .dispatch(command.clone())
                .await
                .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
            if let Some((provider, settings_root)) = provider {
                route_orchestration_command(&provider, &dispatch, &settings_root, command)
                    .await
                    .map_err(|error| {
                        json!({
                            "_tag": "ProviderRuntimeCommandError",
                            "message": error.to_string(),
                        })
                    })?;
            }
            Ok(json!({ "sequence": result.sequence }))
        }
    });

    let replay = engine.clone();
    registry.register_unary("orchestration.replayEvents", move |request, _| {
        let replay = replay.clone();
        async move {
            let input = decode::<ReplayInput>(request)?;
            replay
                .read_events(input.from_sequence_exclusive.max(0))
                .await
                .map(|events| Value::Array(events.iter().map(wire_event).collect()))
                .map_err(|error| orchestration_error("OrchestrationReplayEventsError", error))
        }
    });

    for method in [
        "orchestration.getArchivedShellSnapshot",
        "orchestration.getTurnDiff",
        "orchestration.getFullThreadDiff",
    ] {
        let engine = engine.clone();
        registry.register_unary(method, move |request, _| {
            let engine = engine.clone();
            async move { handle_query(&engine, request).await }
        });
    }

    let shell = engine.clone();
    registry.register_stream(
        "orchestration.subscribeShell",
        move |_request, cancellation| shell_stream(shell.clone(), cancellation),
    );
    registry.register_stream(
        "orchestration.subscribeThread",
        move |request, cancellation| thread_stream(engine.clone(), request, cancellation),
    );
}

async fn handle_query(engine: &OrchestrationEngine, request: RpcRequest) -> RpcResult {
    match request.tag.as_str() {
        "orchestration.getArchivedShellSnapshot" => shell_snapshot(engine, true).await,
        "orchestration.getTurnDiff" => {
            let input = decode::<TurnDiffInput>(request)?;
            diff(
                engine,
                input.thread_id,
                input.from_turn_count,
                input.to_turn_count,
            )
            .await
        }
        "orchestration.getFullThreadDiff" => {
            let input = decode::<FullDiffInput>(request)?;
            diff(engine, input.thread_id, 0, input.to_turn_count).await
        }
        _ => Err(invalid_request(
            &request.tag,
            "unsupported orchestration query",
        )),
    }
}

async fn diff(
    engine: &OrchestrationEngine,
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
) -> RpcResult {
    if from_turn_count < 0 || to_turn_count < from_turn_count {
        return Err(invalid_request(
            "orchestration.diff",
            "turn counts must be non-negative and ordered",
        ));
    }
    let blobs = engine
        .repositories()
        .list_checkpoint_diff_blobs_by_thread(thread_id.clone())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetTurnDiffError", error))?;
    let diff = blobs
        .into_iter()
        .find(|blob| blob.from_turn_count == from_turn_count && blob.to_turn_count == to_turn_count)
        .map(|blob| blob.diff)
        .unwrap_or_default();
    Ok(json!({
        "threadId": thread_id,
        "fromTurnCount": from_turn_count,
        "toTurnCount": to_turn_count,
        "diff": diff,
    }))
}

fn shell_stream(
    engine: OrchestrationEngine,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        if send_snapshot(&sender, shell_snapshot(&engine, false).await)
            .await
            .is_err()
        {
            return;
        }
        let mut events = engine.subscribe_events();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                event = events.recv() => match event {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_snapshot(&sender, shell_snapshot(&engine, false).await).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    receiver
}

fn thread_stream(
    engine: OrchestrationEngine,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        let input = match decode::<SubscribeThreadInput>(request) {
            Ok(input) => input,
            Err(error) => {
                let _ = sender.send(Err(error)).await;
                return;
            }
        };
        if send_snapshot(&sender, thread_snapshot(&engine, &input.thread_id).await)
            .await
            .is_err()
        {
            return;
        }
        let mut events = engine.subscribe_events();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                event = events.recv() => match event {
                    Ok(event) if event.event.aggregate_kind == "thread" && event.event.aggregate_id == input.thread_id => {
                        if send_snapshot(&sender, thread_snapshot(&engine, &input.thread_id).await).await.is_err() {
                            return;
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    receiver
}

async fn send_snapshot(
    sender: &mpsc::Sender<RpcStreamChunk>,
    snapshot: RpcResult,
) -> Result<(), ()> {
    sender
        .send(snapshot.map(|snapshot| vec![json!({ "kind": "snapshot", "snapshot": snapshot })]))
        .await
        .map_err(|_| ())
}

pub async fn shell_snapshot(engine: &OrchestrationEngine, archived: bool) -> RpcResult {
    let snapshot = load_snapshot(&engine.repositories())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    let sequence = snapshot
        .states
        .iter()
        .map(|state| state.last_applied_sequence)
        .max()
        .unwrap_or(0);
    let projects = snapshot
        .projects
        .iter()
        .filter(|project| project.deleted_at.is_none())
        .map(|project| {
            json!({
                "id": project.project_id,
                "title": project.title,
                "workspaceRoot": project.workspace_root,
                "defaultModelSelection": project.default_model_selection,
                "scripts": project.scripts,
                "createdAt": project.created_at,
                "updatedAt": project.updated_at,
            })
        })
        .collect::<Vec<_>>();
    let threads = snapshot
        .threads
        .iter()
        .filter(|thread| thread.deleted_at.is_none() && (thread.archived_at.is_some()) == archived)
        .map(|thread| thread_shell(thread, &snapshot))
        .collect::<Vec<_>>();
    Ok(json!({
        "snapshotSequence": sequence,
        "projects": projects,
        "threads": threads,
        "updatedAt": now_iso(),
    }))
}

async fn thread_snapshot(engine: &OrchestrationEngine, thread_id: &str) -> RpcResult {
    let snapshot = load_snapshot(&engine.repositories())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    let thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == thread_id && thread.deleted_at.is_none())
        .ok_or_else(|| {
            json!({
                "_tag": "OrchestrationGetSnapshotError",
                "message": format!("Thread {thread_id} was not found"),
            })
        })?;
    let sequence = snapshot
        .states
        .iter()
        .map(|state| state.last_applied_sequence)
        .max()
        .unwrap_or(0);
    let mut detail = thread_shell(thread, &snapshot);
    let object = detail.as_object_mut().expect("thread shell is an object");
    object.insert(
        "messages".to_owned(),
        Value::Array(
            snapshot
                .messages
                .iter()
                .filter(|row| row.thread_id == thread_id)
                .map(|row| {
                    json!({
                        "id": row.message_id,
                        "turnId": row.turn_id,
                        "role": row.role,
                        "text": row.text,
                        "attachments": row.attachments.clone().unwrap_or_else(|| json!([])),
                        "isStreaming": row.is_streaming,
                        "createdAt": row.created_at,
                        "updatedAt": row.updated_at,
                    })
                })
                .collect(),
        ),
    );
    object.insert(
        "activities".to_owned(),
        Value::Array(
            snapshot
                .activities
                .iter()
                .filter(|row| row.thread_id == thread_id)
                .map(|row| {
                    json!({
                        "id": row.activity_id,
                        "turnId": row.turn_id,
                        "tone": row.tone,
                        "kind": row.kind,
                        "summary": row.summary,
                        "payload": row.payload,
                        "sequence": row.sequence,
                        "createdAt": row.created_at,
                    })
                })
                .collect(),
        ),
    );
    object.insert(
        "proposedPlans".to_owned(),
        Value::Array(
            snapshot
                .proposed_plans
                .iter()
                .filter(|row| row.thread_id == thread_id)
                .map(|row| {
                    json!({
                        "id": row.plan_id,
                        "turnId": row.turn_id,
                        "planMarkdown": row.plan_markdown,
                        "implementedAt": row.implemented_at,
                        "implementationThreadId": row.implementation_thread_id,
                        "createdAt": row.created_at,
                        "updatedAt": row.updated_at,
                    })
                })
                .collect(),
        ),
    );
    object.insert(
        "checkpoints".to_owned(),
        Value::Array(
            snapshot
                .checkpoints
                .iter()
                .filter(|row| row.thread_id == thread_id)
                .map(|row| {
                    json!({
                        "turnId": row.turn_id,
                        "checkpointTurnCount": row.checkpoint_turn_count,
                        "checkpointRef": row.checkpoint_ref,
                        "status": row.status,
                        "files": row.files,
                        "assistantMessageId": row.assistant_message_id,
                        "completedAt": row.completed_at,
                    })
                })
                .collect(),
        ),
    );
    Ok(json!({ "snapshotSequence": sequence, "thread": detail }))
}

fn thread_shell(thread: &ProjectionThread, snapshot: &crate::orchestration::Snapshot) -> Value {
    let latest_turn = thread.latest_turn_id.as_ref().and_then(|latest_id| {
        snapshot
            .turns
            .iter()
            .find(|turn| turn.thread_id == thread.thread_id && turn.turn_id.as_ref() == Some(latest_id))
            .map(|turn| json!({
                "turnId": turn.turn_id,
                "state": turn.state,
                "requestedAt": turn.requested_at,
                "startedAt": turn.started_at,
                "completedAt": turn.completed_at,
                "assistantMessageId": turn.assistant_message_id,
                "sourceProposedPlan": match (&turn.source_proposed_plan_thread_id, &turn.source_proposed_plan_id) {
                    (Some(thread_id), Some(plan_id)) => Some(json!({ "threadId": thread_id, "planId": plan_id })),
                    _ => None,
                },
            }))
    });
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == thread.thread_id)
        .map(|session| {
            json!({
                "threadId": session.thread_id,
                "status": session.status,
                "providerName": session.provider_name,
                "providerInstanceId": session.provider_instance_id,
                "runtimeMode": session.runtime_mode,
                "activeTurnId": session.active_turn_id,
                "lastError": session.last_error,
                "updatedAt": session.updated_at,
            })
        });
    json!({
        "id": thread.thread_id,
        "projectId": thread.project_id,
        "title": thread.title,
        "modelSelection": thread.model_selection,
        "runtimeMode": thread.runtime_mode,
        "interactionMode": thread.interaction_mode,
        "kind": thread.kind,
        "branch": thread.branch,
        "worktreePath": thread.worktree_path,
        "latestTurn": latest_turn,
        "createdAt": thread.created_at,
        "updatedAt": thread.updated_at,
        "archivedAt": thread.archived_at,
        "session": session,
        "latestUserMessageAt": thread.latest_user_message_at,
        "hasPendingApprovals": thread.pending_approval_count > 0,
        "hasPendingUserInput": thread.pending_user_input_count > 0,
        "hasActionableProposedPlan": thread.has_actionable_proposed_plan != 0,
    })
}

pub fn wire_event(row: &OrchestrationEvent) -> Value {
    json!({
        "sequence": row.sequence,
        "eventId": row.event.event_id,
        "type": row.event.event_type,
        "aggregateKind": row.event.aggregate_kind,
        "aggregateId": row.event.aggregate_id,
        "occurredAt": row.event.occurred_at,
        "commandId": row.event.command_id,
        "causationEventId": row.event.causation_event_id,
        "correlationId": row.event.correlation_id,
        "payload": row.event.payload,
        "metadata": row.event.metadata,
    })
}

fn decode<T: for<'de> Deserialize<'de>>(request: RpcRequest) -> Result<T, Value> {
    serde_json::from_value(request.payload)
        .map_err(|error| invalid_request(&request.tag, error.to_string()))
}

fn invalid_request(method: &str, message: impl Into<String>) -> Value {
    json!({ "_tag": "InvalidRequest", "method": method, "message": message.into() })
}

fn orchestration_error(tag: &str, error: impl std::fmt::Display) -> Value {
    json!({ "_tag": tag, "message": error.to_string() })
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayInput {
    from_sequence_exclusive: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeThreadInput {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDiffInput {
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullDiffInput {
    thread_id: String,
    to_turn_count: i64,
}
use std::{path::PathBuf, sync::Arc};
