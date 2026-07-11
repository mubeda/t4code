use t4code_server::provider::opencode;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
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
    );
    runtime.start().await.expect("start");
    let send_runtime = runtime.clone();
    let send_turn = tokio::spawn(async move { send_runtime.send_turn("hello").await });
    let mut session_events = runtime.collect_events(5).await;

    runtime
        .respond_to_user_input("question-1", json!({ "Scope": "Workspace" }))
        .await
        .expect("reply");
    let question_events = runtime.collect_events(1).await;
    assert_eq!(
        question_events,
        stable_fixture("trace-question-resolved.json")
    );
    send_turn.await.expect("turn join").expect("turn");
    session_events.extend(runtime.collect_events(2).await);
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

#[derive(Default)]
struct TestServerState {
    question_replied: Notify,
    abort_count: Mutex<usize>,
    messages: Mutex<Vec<Value>>,
}

async fn create_session(State(_state): State<Arc<TestServerState>>) -> Json<Value> {
    Json(json!({ "data": { "id": "session-1" } }))
}

async fn subscribe_events(
    State(state): State<Arc<TestServerState>>,
    Query(_query): Query<std::collections::HashMap<String, String>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let initial_events = vec![
        json!({
            "type": "message.part.updated",
            "properties": {
                "sessionID": "session-1",
                "messageID": "msg-1",
                "text": "Hello"
            }
        }),
        json!({
            "type": "question.asked",
            "properties": {
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
    let tail_state = state.clone();
    let tail = stream::once(async move {
        tail_state.question_replied.notified().await;
        Ok(Event::default().data(
            json!({
                "type": "message.part.updated",
                "properties": {
                    "sessionID": "session-1",
                    "messageID": "msg-1",
                    "text": "Hello world"
                }
            })
            .to_string(),
        ))
    });
    let stream = stream::iter(
        initial_events
            .into_iter()
            .map(|value| Ok(Event::default().data(value.to_string()))),
    )
    .chain(tail);
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
    Json(_body): Json<Value>,
) -> Json<Value> {
    timeout(Duration::from_secs(2), state.question_replied.notified())
        .await
        .expect("question reply");
    sleep(Duration::from_millis(20)).await;
    Json(json!({ "ok": true }))
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

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/opencode-provider")
}
