use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

use super::model::merge_assistant_text;

const PROVIDER: &str = "opencode";
const FIXED_EVENT_TIME: &str = "2026-07-10T00:00:00.000Z";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeSessionSnapshot {
    pub thread_id: String,
    pub turns: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeRuntimeEvent {
    pub event_id: String,
    pub provider: String,
    pub created_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeRuntimeEventStableView {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

impl OpenCodeRuntimeEvent {
    #[must_use]
    pub fn stable_view(&self) -> OpenCodeRuntimeEventStableView {
        OpenCodeRuntimeEventStableView {
            event_type: self.event_type.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            request_id: self.request_id.clone(),
            payload: self.payload.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum OpenCodeRuntimeError {
    #[error("OpenCode HTTP request failed: {0}")]
    Http(String),
    #[error("OpenCode response was invalid: {0}")]
    InvalidResponse(String),
    #[error("Unknown pending question id {0}")]
    UnknownQuestion(String),
    #[error("Session is not started")]
    MissingSession,
}

#[derive(Clone)]
pub struct OpenCodeSessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    client: reqwest::Client,
    base_url: String,
    thread_id: String,
    directory: String,
    session_id: Mutex<Option<String>>,
    active_turn_id: Mutex<Option<String>>,
    assistant_text: Mutex<HashMap<String, String>>,
    events_tx: mpsc::UnboundedSender<OpenCodeRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<OpenCodeRuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    event_pump: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
struct PendingQuestion {
    turn_id: Option<String>,
    questions: Vec<Value>,
}

impl OpenCodeSessionRuntime {
    pub fn new(base_url: &str, thread_id: &str, directory: &str) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(RuntimeInner {
                client: reqwest::Client::new(),
                base_url: base_url.trim_end_matches('/').to_owned(),
                thread_id: thread_id.to_owned(),
                directory: directory.to_owned(),
                session_id: Mutex::new(None),
                active_turn_id: Mutex::new(None),
                assistant_text: Mutex::new(HashMap::new()),
                events_tx,
                events_rx: Mutex::new(events_rx),
                event_counter: Mutex::new(0),
                pending_questions: Mutex::new(HashMap::new()),
                event_pump: Mutex::new(None),
            }),
        }
    }

    pub async fn start(&self) -> Result<String, OpenCodeRuntimeError> {
        let response = self
            .inner
            .client
            .post(self.request_url("/session")?)
            .json(&json!({ "title": format!("T4Code {}", self.inner.thread_id) }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let session_id = value
            .get("data")
            .and_then(|data| data.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                OpenCodeRuntimeError::InvalidResponse("session.create missing data.id".to_owned())
            })?
            .to_owned();
        *self.inner.session_id.lock().await = Some(session_id.clone());
        self.start_event_pump().await?;
        self.emit("session.started", None, None, json!({})).await;
        self.emit("thread.started", None, None, json!({})).await;
        Ok(session_id)
    }

    pub async fn resume(&self, session_id: &str) -> Result<String, OpenCodeRuntimeError> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(OpenCodeRuntimeError::MissingSession);
        }
        let response = self
            .inner
            .client
            .get(self.request_url(&format!("/session/{session_id}"))?)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        if !response.status().is_success() {
            return Err(OpenCodeRuntimeError::Http(format!(
                "session resume returned HTTP {}",
                response.status()
            )));
        }
        *self.inner.session_id.lock().await = Some(session_id.to_owned());
        self.start_event_pump().await?;
        self.emit("session.started", None, None, json!({ "resumed": true }))
            .await;
        self.emit("thread.started", None, None, json!({})).await;
        Ok(session_id.to_owned())
    }

    pub async fn send_turn(&self, text: &str) -> Result<String, OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        let turn_id = format!("turn-{}", {
            let counter = self.inner.event_counter.lock().await;
            *counter + 1
        });
        *self.inner.active_turn_id.lock().await = Some(turn_id.clone());
        self.emit("turn.started", Some(turn_id.clone()), None, json!({}))
            .await;
        self.inner
            .client
            .post(self.request_url(&format!("/session/{session_id}/prompt_async"))?)
            .json(&json!({
                "sessionID": session_id,
                "parts": [{ "type": "text", "text": text }],
            }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        *self.inner.active_turn_id.lock().await = None;
        self.emit(
            "turn.completed",
            Some(turn_id.clone()),
            None,
            json!({ "state": "completed", "stopReason": "completed" }),
        )
        .await;
        Ok(turn_id)
    }

    pub async fn interrupt_turn(&self) -> Result<(), OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        self.inner
            .client
            .post(self.request_url(&format!("/session/{session_id}/abort"))?)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        Ok(())
    }

    pub async fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: Value,
    ) -> Result<(), OpenCodeRuntimeError> {
        let pending = self
            .inner
            .pending_questions
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| OpenCodeRuntimeError::UnknownQuestion(request_id.to_owned()))?;
        let normalized = pending
            .questions
            .iter()
            .map(|question| {
                let key = question
                    .get("header")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let value = answers
                    .get(key)
                    .cloned()
                    .unwrap_or(Value::Array(Vec::new()));
                let values = match value {
                    Value::String(string) => vec![Value::String(string)],
                    Value::Array(array) => array,
                    _ => Vec::new(),
                };
                Value::Array(values)
            })
            .collect::<Vec<_>>();
        self.inner
            .client
            .post(self.request_url(&format!("/question/{request_id}/reply"))?)
            .json(&json!({ "answers": normalized }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        self.emit(
            "user-input.resolved",
            pending.turn_id,
            Some(request_id.to_owned()),
            json!({ "answers": answers }),
        )
        .await;
        Ok(())
    }

    pub async fn rollback_thread(
        &self,
        num_turns: usize,
    ) -> Result<OpenCodeSessionSnapshot, OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        let messages = self
            .inner
            .client
            .get(self.request_url(&format!("/session/{session_id}/message"))?)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?
            .json::<Value>()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let assistant_messages = messages
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| {
                entry
                    .get("info")
                    .and_then(|info| info.get("role"))
                    .and_then(Value::as_str)
                    == Some("assistant")
            })
            .collect::<Vec<_>>();
        let target_message_id = if assistant_messages.len() > num_turns {
            assistant_messages
                .get(assistant_messages.len() - num_turns - 1)
                .and_then(|entry| entry.get("info"))
                .and_then(|info| info.get("id"))
                .and_then(Value::as_str)
        } else {
            None
        };
        self.inner
            .client
            .post(self.request_url(&format!("/session/{session_id}/revert"))?)
            .json(&match target_message_id {
                Some(message_id) => json!({ "messageID": message_id }),
                None => json!({}),
            })
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let refreshed = self
            .inner
            .client
            .get(self.request_url(&format!("/session/{session_id}/message"))?)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?
            .json::<Value>()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        Ok(OpenCodeSessionSnapshot {
            thread_id: self.inner.thread_id.clone(),
            turns: refreshed
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        })
    }

    pub async fn stop(&self) -> Result<(), OpenCodeRuntimeError> {
        if let Some(task) = self.inner.event_pump.lock().await.take() {
            task.abort();
        }
        self.emit(
            "session.exited",
            None,
            None,
            json!({ "reason": "Session stopped." }),
        )
        .await;
        Ok(())
    }

    pub async fn next_event(&self) -> Option<OpenCodeRuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    pub async fn collect_events(&self, expected: usize) -> Vec<OpenCodeRuntimeEventStableView> {
        let mut events = Vec::with_capacity(expected);
        while events.len() < expected {
            let Some(event) = self.next_event().await else {
                break;
            };
            events.push(event.stable_view());
        }
        events
    }

    async fn start_event_pump(&self) -> Result<(), OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        let runtime = self.clone();
        let client = self.inner.client.clone();
        let url = self.request_url("/event")?;
        let task = tokio::spawn(async move {
            let response = match client.get(url).send().await {
                Ok(response) => response,
                Err(error) => {
                    runtime
                        .emit(
                            "runtime.error",
                            None,
                            None,
                            json!({ "message": error.to_string() }),
                        )
                        .await;
                    return;
                }
            };
            let mut buffer = String::new();
            let mut response = response;
            loop {
                match response.chunk().await {
                    Ok(Some(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(bytes.as_ref()));
                        while let Some(index) = buffer.find("\n\n") {
                            let frame = buffer[..index].to_owned();
                            buffer.drain(..index + 2);
                            if let Some(payload) = frame.strip_prefix("data: ")
                                && let Ok(event) = serde_json::from_str::<Value>(payload)
                            {
                                runtime.handle_sse_event(&session_id, event).await;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        runtime
                            .emit(
                                "runtime.error",
                                None,
                                None,
                                json!({ "message": error.to_string() }),
                            )
                            .await;
                        break;
                    }
                }
            }
        });
        *self.inner.event_pump.lock().await = Some(task);
        Ok(())
    }

    async fn handle_sse_event(&self, session_id: &str, event: Value) {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let properties = event.get("properties").cloned().unwrap_or(Value::Null);
        let payload_session_id = properties.get("sessionID").and_then(Value::as_str);
        if let Some(payload_session_id) = payload_session_id
            && payload_session_id != session_id
        {
            return;
        }
        let turn_id = self.inner.active_turn_id.lock().await.clone();
        match event_type {
            "message.part.updated" => {
                let message_id = properties
                    .get("messageID")
                    .and_then(Value::as_str)
                    .or_else(|| properties.get("messageId").and_then(Value::as_str))
                    .unwrap_or("assistant");
                let next_text = properties
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut assistant_text = self.inner.assistant_text.lock().await;
                let previous = assistant_text.get(message_id).cloned();
                let (latest, delta) = merge_assistant_text(previous.as_deref(), next_text);
                assistant_text.insert(message_id.to_owned(), latest);
                drop(assistant_text);
                if !delta.is_empty() {
                    self.emit(
                        "content.delta",
                        turn_id,
                        None,
                        json!({ "streamKind": "assistant_text", "delta": delta }),
                    )
                    .await;
                }
            }
            "question.asked" => {
                let request_id = properties
                    .get("requestID")
                    .and_then(Value::as_str)
                    .unwrap_or("question-1")
                    .to_owned();
                let questions = properties
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|question| {
                        json!({
                            "id": question.get("header").cloned().unwrap_or(Value::String(String::new())),
                            "header": question.get("header").cloned().unwrap_or(Value::String(String::new())),
                            "question": question.get("question").cloned().unwrap_or(Value::String(String::new())),
                            "options": question.get("options").cloned().unwrap_or(Value::Array(Vec::new())),
                        })
                    })
                    .collect::<Vec<_>>();
                self.inner.pending_questions.lock().await.insert(
                    request_id.clone(),
                    PendingQuestion {
                        turn_id: turn_id.clone(),
                        questions: questions.clone(),
                    },
                );
                self.emit(
                    "user-input.requested",
                    turn_id,
                    Some(request_id),
                    json!({ "questions": questions }),
                )
                .await;
            }
            _ => {}
        }
    }

    async fn emit(
        &self,
        event_type: &str,
        turn_id: Option<String>,
        request_id: Option<String>,
        payload: Value,
    ) {
        let mut counter = self.inner.event_counter.lock().await;
        *counter += 1;
        let _ = self.inner.events_tx.send(OpenCodeRuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: event_type.to_owned(),
            thread_id: self.inner.thread_id.clone(),
            turn_id,
            request_id,
            payload,
        });
    }

    async fn session_id(&self) -> Result<String, OpenCodeRuntimeError> {
        self.inner
            .session_id
            .lock()
            .await
            .clone()
            .ok_or(OpenCodeRuntimeError::MissingSession)
    }

    fn request_url(&self, path: &str) -> Result<String, OpenCodeRuntimeError> {
        let mut url =
            url::Url::parse(&format!("{}{}", self.inner.base_url, path)).map_err(|error| {
                OpenCodeRuntimeError::InvalidResponse(format!("invalid base URL: {error}"))
            })?;
        url.query_pairs_mut()
            .append_pair("directory", &self.inner.directory);
        Ok(url.to_string())
    }
}
