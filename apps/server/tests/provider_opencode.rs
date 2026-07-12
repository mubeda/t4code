use t4code_server::provider::opencode;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    routing::{delete, get, post},
};
use futures_util::{Stream, StreamExt, stream};
use opencode::{
    OpenCodeSessionRuntime, build_inventory_snapshot, merge_assistant_text, parse_model_slug,
};
use serde_json::{Value, json};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Notify},
    time::{sleep, timeout},
};

#[test]
fn opencode_helper_outputs_match_fixtures() {
    let inventory_fixture = fixture("inventory-snapshot.json");
    assert_eq!(
        serde_json::to_value(build_inventory_snapshot(
            &inventory_fixture["providerList"],
            inventory_fixture["agents"]
                .get("data")
                .unwrap_or(&inventory_fixture["agents"]),
            &inventory_fixture["customModels"]
                .as_array()
                .expect("custom models")
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        ))
        .expect("inventory json"),
        inventory_fixture["expected"]
    );
    assert_eq!(
        parse_model_slug("openai/gpt-5.4"),
        Some(("openai".to_owned(), "gpt-5.4".to_owned()))
    );
    assert_eq!(
        merge_assistant_text(Some("Hello"), "Hello world"),
        ("Hello world".to_owned(), " world".to_owned())
    );
}

#[tokio::test]
async fn opencode_runtime_matches_session_and_rollback_traces() {
    let state = Arc::new(TestServerState::default());
    let app = Router::new()
        .route("/session", post(create_session))
        .route("/event", get(subscribe_events))
        .route("/question/{request_id}/reply", post(reply_question))
        .route("/session/{session_id}/prompt_async", post(prompt_async))
        .route("/session/{session_id}/abort", post(abort_session))
        .route("/session/{session_id}/message", get(list_messages))
        .route("/session/{session_id}/revert", post(revert_session))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    let runtime = OpenCodeSessionRuntime::new(
        &format!("http://{}", address),
        "opencode-thread-1",
        "/tmp/project",
        Some("openai/gpt-5"),
    );
    runtime.start().await.expect("start");
    let send_runtime = runtime.clone();
    let send_turn = tokio::spawn(async move { send_runtime.send_turn("hello").await });
    let mut session_events = timeout(Duration::from_secs(2), runtime.collect_events(5))
        .await
        .expect("initial OpenCode events");
    let turn_id = session_events
        .iter()
        .find(|event| event.event_type == "turn.started")
        .and_then(|event| event.turn_id.clone())
        .expect("turn id");

    runtime
        .respond_to_user_input("question-1", json!({ "Scope": "Workspace" }))
        .await
        .expect("reply");
    let mut question_events = runtime.collect_events(1).await;
    normalize_turn_ids(&mut question_events, &turn_id);
    assert_eq!(
        question_events,
        stable_fixture("trace-question-resolved.json")
    );
    send_turn.await.expect("turn join").expect("turn");
    assert_eq!(
        state.prompt_body.lock().await.as_ref(),
        Some(&json!({
            "sessionID": "session-1",
            "model": { "providerID": "openai", "modelID": "gpt-5" },
            "parts": [{ "type": "text", "text": "hello" }],
        }))
    );
    session_events.extend(
        timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("completed OpenCode events"),
    );
    normalize_turn_ids(&mut session_events, &turn_id);
    assert_eq!(session_events, stable_fixture("trace-session.json"));

    {
        let mut messages = state.messages.lock().await;
        *messages = vec![
            json!({ "info": { "id": "assistant-1", "role": "assistant" }, "parts": [] }),
            json!({ "info": { "id": "assistant-2", "role": "assistant" }, "parts": [] }),
        ];
    }
    let rollback = runtime.rollback_thread(2).await.expect("rollback");
    assert_eq!(
        serde_json::to_value(rollback).expect("rollback json"),
        fixture("rollback.json")
    );
    runtime.interrupt_turn().await.expect("interrupt");
    assert_eq!(*state.abort_count.lock().await, 1);

    runtime.stop().await.expect("stop");
    server.abort();
}

#[tokio::test]
async fn opencode_runtime_surfaces_session_errors_and_removes_the_unanswered_prompt() {
    let state = Arc::new(TestServerState::default());
    let app = Router::new()
        .route("/session", post(create_session))
        .route("/event", get(subscribe_error_events))
        .route(
            "/session/{session_id}/prompt_async",
            post(error_prompt_async),
        )
        .route(
            "/session/{session_id}/message/{message_id}",
            delete(delete_message),
        )
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    let runtime = OpenCodeSessionRuntime::new(
        &format!("http://{}", address),
        "opencode-error-thread",
        "/tmp/project",
        Some("openai/gpt-5"),
    );
    runtime.start().await.expect("start");
    runtime.send_turn("hello").await.expect("send turn");
    let events = timeout(Duration::from_secs(2), runtime.collect_events(4))
        .await
        .expect("failed OpenCode turn events");

    assert_eq!(events[3].event_type, "turn.completed");
    assert!(
        events[3]
            .turn_id
            .as_deref()
            .is_some_and(|turn_id| turn_id.starts_with("turn-"))
    );
    assert_eq!(
        events[3].payload,
        json!({
            "state": "failed",
            "stopReason": "error",
            "error": { "message": "Model not found: openai/gpt-5" },
        })
    );
    assert_eq!(
        state.deleted_messages.lock().await.as_slice(),
        ["user-error-1"]
    );
    assert!(
        timeout(Duration::from_millis(100), runtime.next_event())
            .await
            .is_err(),
        "idle after an error must not emit a second successful completion"
    );

    runtime.stop().await.expect("stop");
    server.abort();
}

#[tokio::test]
async fn opencode_turn_ids_remain_unique_across_runtime_restarts() {
    let state = Arc::new(TestServerState::default());
    let app = Router::new()
        .route("/session", post(create_session))
        .route("/event", get(subscribe_pending_events))
        .route(
            "/session/{session_id}/prompt_async",
            post(prompt_async_immediate),
        )
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    let endpoint = format!("http://{}", address);

    let first =
        OpenCodeSessionRuntime::new(&endpoint, "opencode-restart-thread", "/tmp/project", None);
    first.start().await.expect("first start");
    let first_turn_id = first.send_turn("first").await.expect("first turn");
    first.stop().await.expect("first stop");

    let second =
        OpenCodeSessionRuntime::new(&endpoint, "opencode-restart-thread", "/tmp/project", None);
    second.start().await.expect("second start");
    let second_turn_id = second.send_turn("second").await.expect("second turn");
    second.stop().await.expect("second stop");

    assert_ne!(first_turn_id, second_turn_id);
    server.abort();
}

#[derive(Default)]
struct TestServerState {
    prompt_received: Notify,
    question_replied: Notify,
    prompt_body: Mutex<Option<Value>>,
    deleted_messages: Mutex<Vec<String>>,
    abort_count: Mutex<usize>,
    messages: Mutex<Vec<Value>>,
}

async fn create_session(State(_state): State<Arc<TestServerState>>) -> Json<Value> {
    Json(json!({ "id": "session-1" }))
}

async fn subscribe_events(
    State(state): State<Arc<TestServerState>>,
    Query(_query): Query<std::collections::HashMap<String, String>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let initial_events = vec![
        json!({
            "type": "message.updated",
            "properties": {
                "info": {
                    "id": "user-1",
                    "role": "user",
                    "sessionID": "session-1"
                }
            }
        }),
        json!({
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "id": "part-user-1",
                    "messageID": "user-1",
                    "sessionID": "session-1",
                    "type": "text",
                    "text": "hello"
                }
            }
        }),
        json!({
            "type": "message.updated",
            "properties": {
                "info": {
                    "id": "assistant-1",
                    "role": "assistant",
                    "sessionID": "session-1"
                }
            }
        }),
        json!({
            "type": "message.part.updated",
            "properties": {
                "part": {
                    "id": "part-assistant-1",
                    "messageID": "assistant-1",
                    "sessionID": "session-1",
                    "type": "text",
                    "text": "Hello"
                }
            }
        }),
        json!({
            "type": "question.asked",
            "properties": {
                "sessionID": "session-1",
                "requestID": "question-1",
                "questions": [
                    {
                        "header": "Scope",
                        "question": "Scope",
                        "options": [{ "label": "Workspace" }, { "label": "Session" }]
                    }
                ]
            }
        }),
    ];
    let initial_state = state.clone();
    let initial = stream::once(async move {
        initial_state.prompt_received.notified().await;
        initial_events
    })
    .flat_map(|events| {
        stream::iter(
            events
                .into_iter()
                .map(|event| Ok(Event::default().data(event.to_string()))),
        )
    });
    let tail_state = state.clone();
    let tail = stream::once(async move {
        tail_state.question_replied.notified().await;
        let events = [
            json!({
                "type": "message.part.updated",
                "properties": {
                    "part": {
                        "id": "part-assistant-1",
                        "messageID": "assistant-1",
                        "sessionID": "session-1",
                        "type": "text",
                        "text": "Hello world"
                    }
                }
            }),
            json!({
                "type": "session.status",
                "properties": {
                    "sessionID": "session-1",
                    "status": { "type": "idle" }
                }
            }),
        ];
        events
    })
    .flat_map(|events| {
        stream::iter(
            events
                .into_iter()
                .map(|event| Ok(Event::default().data(event.to_string()))),
        )
    });
    let stream = initial.chain(tail);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn reply_question(
    Path(_request_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
    Json(_body): Json<Value>,
) -> Json<Value> {
    let notify_state = state.clone();
    tokio::spawn(async move {
        sleep(Duration::from_millis(10)).await;
        notify_state.question_replied.notify_waiters();
    });
    Json(json!({ "ok": true }))
}

async fn prompt_async(
    Path(_session_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
    Json(body): Json<Value>,
) -> StatusCode {
    *state.prompt_body.lock().await = Some(body);
    state.prompt_received.notify_one();
    StatusCode::NO_CONTENT
}

async fn subscribe_error_events(
    State(state): State<Arc<TestServerState>>,
    Query(_query): Query<std::collections::HashMap<String, String>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let events = vec![
        json!({
            "type": "message.updated",
            "properties": {
                "sessionID": "session-1",
                "info": {
                    "id": "user-error-1",
                    "role": "user",
                    "sessionID": "session-1"
                }
            }
        }),
        json!({
            "type": "message.part.updated",
            "properties": {
                "sessionID": "session-1",
                "part": {
                    "id": "part-user-error-1",
                    "messageID": "user-error-1",
                    "sessionID": "session-1",
                    "type": "text",
                    "text": "hello"
                }
            }
        }),
        json!({
            "type": "session.status",
            "properties": {
                "sessionID": "session-1",
                "status": { "type": "busy" }
            }
        }),
        json!({
            "type": "session.error",
            "properties": {
                "sessionID": "session-1",
                "error": {
                    "name": "UnknownError",
                    "data": { "message": "Model not found: openai/gpt-5" }
                }
            }
        }),
        json!({
            "type": "session.status",
            "properties": {
                "sessionID": "session-1",
                "status": { "type": "idle" }
            }
        }),
    ];
    let stream = stream::once(async move {
        state.prompt_received.notified().await;
        events
    })
    .flat_map(|events| {
        stream::iter(
            events
                .into_iter()
                .map(|event| Ok(Event::default().data(event.to_string()))),
        )
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn error_prompt_async(
    Path(_session_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
    Json(body): Json<Value>,
) -> StatusCode {
    *state.prompt_body.lock().await = Some(body);
    state.prompt_received.notify_one();
    StatusCode::NO_CONTENT
}

async fn subscribe_pending_events(
    State(_state): State<Arc<TestServerState>>,
    Query(_query): Query<std::collections::HashMap<String, String>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    Sse::new(stream::pending())
}

async fn prompt_async_immediate(
    Path(_session_id): Path<String>,
    State(_state): State<Arc<TestServerState>>,
    Json(_body): Json<Value>,
) -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn delete_message(
    Path((_session_id, message_id)): Path<(String, String)>,
    State(state): State<Arc<TestServerState>>,
) -> StatusCode {
    state.deleted_messages.lock().await.push(message_id);
    StatusCode::NO_CONTENT
}

async fn abort_session(
    Path(_session_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
) -> Json<Value> {
    *state.abort_count.lock().await += 1;
    Json(json!({ "ok": true }))
}

async fn list_messages(
    Path(_session_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
) -> Json<Value> {
    Json(json!({ "data": state.messages.lock().await.clone() }))
}

async fn revert_session(
    Path(_session_id): Path<String>,
    State(state): State<Arc<TestServerState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let message_id = body
        .get("messageID")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut messages = state.messages.lock().await;
    if let Some(message_id) = message_id {
        let target_index = messages.iter().position(|entry| {
            entry
                .get("info")
                .and_then(|info| info.get("id"))
                .and_then(Value::as_str)
                == Some(message_id.as_str())
        });
        if let Some(target_index) = target_index {
            messages.truncate(target_index + 1);
        }
    } else {
        messages.clear();
    }
    Json(json!({ "ok": true }))
}

fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(fixture_directory().join(name)).expect("fixture file"),
    )
    .expect("valid fixture")
}

fn stable_fixture(name: &str) -> Vec<opencode::OpenCodeRuntimeEventStableView> {
    serde_json::from_value(fixture(name)).expect("stable fixture")
}

fn normalize_turn_ids(
    events: &mut [opencode::OpenCodeRuntimeEventStableView],
    actual_turn_id: &str,
) {
    for event in events {
        if event.turn_id.as_deref() == Some(actual_turn_id) {
            event.turn_id = Some("turn-3".to_owned());
        }
    }
}

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/opencode-provider")
}
