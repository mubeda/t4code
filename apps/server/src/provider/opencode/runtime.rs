use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use url::Url;
use uuid::Uuid;

use super::model::{merge_assistant_text, parse_model_slug};

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
    #[error("Unknown pending permission id {0}")]
    UnknownPermission(String),
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
    model: Mutex<Option<(String, String)>>,
    agent: Option<String>,
    runtime_mode: Mutex<String>,
    session_id: Mutex<Option<String>>,
    active_turn_id: Mutex<Option<String>>,
    active_user_message_id: Mutex<Option<String>>,
    assistant_message_ids: Mutex<HashSet<String>>,
    assistant_text: Mutex<HashMap<String, String>>,
    events_tx: mpsc::UnboundedSender<OpenCodeRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<OpenCodeRuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    pending_permissions: Mutex<HashMap<String, Option<String>>>,
    event_pump: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Clone)]
struct PendingQuestion {
    turn_id: Option<String>,
    questions: Vec<Value>,
}

impl OpenCodeSessionRuntime {
    pub fn new(base_url: &str, thread_id: &str, directory: &str, model: Option<&str>) -> Self {
        Self::new_with_password(base_url, thread_id, directory, model, None)
            .expect("OpenCode client without credentials must be valid")
    }

    pub fn new_with_password(
        base_url: &str,
        thread_id: &str,
        directory: &str,
        model: Option<&str>,
        password: Option<&str>,
    ) -> Result<Self, OpenCodeRuntimeError> {
        Self::new_with_options(base_url, thread_id, directory, model, password, None)
    }

    pub fn new_with_options(
        base_url: &str,
        thread_id: &str,
        directory: &str,
        model: Option<&str>,
        password: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Self, OpenCodeRuntimeError> {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let mut headers = HeaderMap::new();
        if let Some(password) = password.filter(|value| !value.is_empty()) {
            let credentials = STANDARD.encode(format!("opencode:{password}"));
            let header = HeaderValue::from_str(&format!("Basic {credentials}"))
                .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
            headers.insert(AUTHORIZATION, header);
        }
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                client,
                base_url: base_url.trim_end_matches('/').to_owned(),
                thread_id: thread_id.to_owned(),
                directory: directory.to_owned(),
                model: Mutex::new(model.and_then(parse_model_slug)),
                agent: agent
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
                runtime_mode: Mutex::new("approval-required".to_owned()),
                session_id: Mutex::new(None),
                active_turn_id: Mutex::new(None),
                active_user_message_id: Mutex::new(None),
                assistant_message_ids: Mutex::new(HashSet::new()),
                assistant_text: Mutex::new(HashMap::new()),
                events_tx,
                events_rx: Mutex::new(events_rx),
                event_counter: Mutex::new(0),
                pending_questions: Mutex::new(HashMap::new()),
                pending_permissions: Mutex::new(HashMap::new()),
                event_pump: Mutex::new(None),
            }),
        })
    }

    pub async fn start(&self) -> Result<String, OpenCodeRuntimeError> {
        let permission = build_permission_rules(&self.inner.runtime_mode.lock().await);
        let response = self
            .inner
            .client
            .post(self.request_url("/session")?)
            .json(&json!({
                "title": format!("T4Code {}", self.inner.thread_id),
                "permission": permission,
            }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        let session_id = value
            .get("id")
            .or_else(|| value.get("data").and_then(|data| data.get("id")))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                OpenCodeRuntimeError::InvalidResponse("session.create missing id".to_owned())
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

    pub async fn add_mcp_server(
        &self,
        name: &str,
        url: &str,
        authorization_header: &str,
    ) -> Result<(), OpenCodeRuntimeError> {
        let mut endpoint = Url::parse(&format!("{}/mcp", self.inner.base_url))
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        endpoint
            .query_pairs_mut()
            .append_pair("directory", &self.inner.directory);
        let response = self
            .inner
            .client
            .post(endpoint)
            .json(&json!({
                "name": name,
                "config": {
                    "type": "remote",
                    "url": url,
                    "headers": { "Authorization": authorization_header },
                    "oauth": false,
                }
            }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        if !response.status().is_success() {
            return Err(OpenCodeRuntimeError::Http(format!(
                "OpenCode MCP registration returned HTTP {}",
                response.status()
            )));
        }
        Ok(())
    }

    pub async fn send_turn(
        &self,
        text: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<String, OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        let turn_id = self.begin_turn().await;
        let mut body = json!({
            "sessionID": session_id,
            "parts": crate::provider::attachments::prompt_parts(text, attachments),
        });
        if let Some((provider_id, model_id)) = self.inner.model.lock().await.as_ref() {
            body["model"] = json!({
                "providerID": provider_id,
                "modelID": model_id,
            });
        }
        if let Some(agent) = self.inner.agent.as_ref() {
            body["agent"] = json!(agent);
        }
        let response = self
            .inner
            .client
            .post(self.request_url(&format!("/session/{session_id}/prompt_async"))?)
            .json(&body)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        if !response.status().is_success() {
            *self.inner.active_turn_id.lock().await = None;
            return Err(OpenCodeRuntimeError::Http(format!(
                "prompt_async returned HTTP {}",
                response.status()
            )));
        }
        Ok(turn_id)
    }

    pub async fn send_command(
        &self,
        command: &str,
        arguments: &str,
    ) -> Result<String, OpenCodeRuntimeError> {
        let session_id = self.session_id().await?;
        let command = command.trim().trim_start_matches('/');
        if command.is_empty() {
            return Err(OpenCodeRuntimeError::InvalidResponse(
                "command name cannot be empty".to_owned(),
            ));
        }
        let turn_id = self.begin_turn().await;
        let mut body = json!({
            "command": command,
            "arguments": arguments.trim(),
        });
        if let Some(agent) = self.inner.agent.as_ref() {
            body["agent"] = json!(agent);
        }
        if let Some((provider_id, model_id)) = self.inner.model.lock().await.as_ref() {
            body["model"] = json!(format!("{provider_id}/{model_id}"));
        }
        let response = self
            .inner
            .client
            .post(self.request_url(&format!("/session/{session_id}/command"))?)
            .json(&body)
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        if !response.status().is_success() {
            *self.inner.active_turn_id.lock().await = None;
            return Err(OpenCodeRuntimeError::Http(format!(
                "command returned HTTP {}",
                response.status()
            )));
        }
        Ok(turn_id)
    }

    pub async fn set_model(&self, model: &str) -> Result<(), OpenCodeRuntimeError> {
        let parsed = parse_model_slug(model).ok_or_else(|| {
            OpenCodeRuntimeError::InvalidResponse(
                "model selection must use the provider/model format".to_owned(),
            )
        })?;
        *self.inner.model.lock().await = Some(parsed);
        Ok(())
    }

    async fn begin_turn(&self) -> String {
        let turn_id = format!("turn-{}", Uuid::new_v4());
        *self.inner.active_user_message_id.lock().await = None;
        self.inner.assistant_message_ids.lock().await.clear();
        self.inner.assistant_text.lock().await.clear();
        *self.inner.active_turn_id.lock().await = Some(turn_id.clone());
        self.emit("turn.started", Some(turn_id.clone()), None, json!({}))
            .await;
        turn_id
    }

    pub async fn configure_runtime_mode(&self, mode: &str) {
        *self.inner.runtime_mode.lock().await = mode.to_owned();
    }

    pub async fn respond_to_permission(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), OpenCodeRuntimeError> {
        let turn_id = self
            .inner
            .pending_permissions
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| OpenCodeRuntimeError::UnknownPermission(request_id.to_owned()))?;
        let reply = match decision {
            "acceptForSession" => "always",
            "accept" => "once",
            _ => "reject",
        };
        let response = self
            .inner
            .client
            .post(self.request_url(&format!("/permission/{request_id}/reply"))?)
            .json(&json!({ "reply": reply }))
            .send()
            .await
            .map_err(|error| OpenCodeRuntimeError::Http(error.to_string()))?;
        if !response.status().is_success() {
            return Err(OpenCodeRuntimeError::Http(format!(
                "permission reply returned HTTP {}",
                response.status()
            )));
        }
        self.emit(
            "request.resolved",
            turn_id,
            Some(request_id.to_owned()),
            json!({
                "requestType": "exec_command_approval",
                "decision": decision,
            }),
        )
        .await;
        Ok(())
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
        let payload_session_id = properties
            .get("sessionID")
            .and_then(Value::as_str)
            .or_else(|| {
                properties
                    .get("info")
                    .and_then(|info| info.get("sessionID"))
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                properties
                    .get("part")
                    .and_then(|part| part.get("sessionID"))
                    .and_then(Value::as_str)
            });
        if let Some(payload_session_id) = payload_session_id
            && payload_session_id != session_id
        {
            return;
        }
        let turn_id = self.inner.active_turn_id.lock().await.clone();
        match event_type {
            "message.updated" => {
                let Some(info) = properties.get("info") else {
                    return;
                };
                match info.get("role").and_then(Value::as_str) {
                    Some("user") if turn_id.is_some() => {
                        if let Some(message_id) = info.get("id").and_then(Value::as_str) {
                            *self.inner.active_user_message_id.lock().await =
                                Some(message_id.to_owned());
                        }
                    }
                    Some("assistant") => {
                        if let Some(message_id) = info.get("id").and_then(Value::as_str) {
                            self.inner
                                .assistant_message_ids
                                .lock()
                                .await
                                .insert(message_id.to_owned());
                        }
                    }
                    _ => {}
                }
            }
            "message.part.updated" => {
                let nested_part = properties.get("part");
                let part = nested_part.unwrap_or(&properties);
                if part
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind != "text")
                {
                    return;
                }
                let message_id = part
                    .get("messageID")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("messageId").and_then(Value::as_str))
                    .unwrap_or("assistant");
                if nested_part.is_some()
                    && !self
                        .inner
                        .assistant_message_ids
                        .lock()
                        .await
                        .contains(message_id)
                {
                    return;
                }
                let next_text = part.get("text").and_then(Value::as_str).unwrap_or_default();
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
            "session.status"
                if properties
                    .get("status")
                    .and_then(|status| status.get("type"))
                    .and_then(Value::as_str)
                    == Some("idle") =>
            {
                if let Some(completed_turn_id) = self.inner.active_turn_id.lock().await.take() {
                    self.emit(
                        "turn.completed",
                        Some(completed_turn_id),
                        None,
                        json!({ "state": "completed", "stopReason": "completed" }),
                    )
                    .await;
                    self.inner.assistant_message_ids.lock().await.clear();
                    self.inner.assistant_text.lock().await.clear();
                    *self.inner.active_user_message_id.lock().await = None;
                }
            }
            "session.error" => {
                let Some(failed_turn_id) = self.inner.active_turn_id.lock().await.take() else {
                    return;
                };
                let message = properties
                    .pointer("/error/data/message")
                    .and_then(Value::as_str)
                    .or_else(|| properties.pointer("/error/message").and_then(Value::as_str))
                    .or_else(|| properties.get("error").and_then(Value::as_str))
                    .unwrap_or("OpenCode session failed.")
                    .to_owned();
                let has_assistant_message =
                    !self.inner.assistant_message_ids.lock().await.is_empty();
                let failed_user_message = self.inner.active_user_message_id.lock().await.take();
                if !has_assistant_message
                    && let Some(message_id) = failed_user_message
                    && let Ok(url) =
                        self.request_url(&format!("/session/{session_id}/message/{message_id}"))
                {
                    let _ = self.inner.client.delete(url).send().await;
                }
                self.emit(
                    "turn.completed",
                    Some(failed_turn_id),
                    None,
                    json!({
                        "state": "failed",
                        "stopReason": "error",
                        "error": { "message": message },
                    }),
                )
                .await;
                self.inner.assistant_message_ids.lock().await.clear();
                self.inner.assistant_text.lock().await.clear();
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
            "permission.asked" => {
                let request_id = properties
                    .get("requestID")
                    .or_else(|| properties.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("permission-1")
                    .to_owned();
                let permission = properties
                    .get("permission")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let patterns = properties
                    .get("patterns")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                let detail = if patterns.is_empty() {
                    permission.to_owned()
                } else {
                    format!("{permission}: {patterns}")
                };
                self.inner
                    .pending_permissions
                    .lock()
                    .await
                    .insert(request_id.clone(), turn_id.clone());
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": "exec_command_approval",
                        "detail": detail,
                    }),
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

fn build_permission_rules(runtime_mode: &str) -> Vec<Value> {
    if runtime_mode == "full-access" {
        return vec![json!({ "permission": "*", "pattern": "*", "action": "allow" })];
    }
    [
        "*",
        "bash",
        "edit",
        "webfetch",
        "websearch",
        "codesearch",
        "external_directory",
        "doom_loop",
    ]
    .into_iter()
    .map(|permission| json!({ "permission": permission, "pattern": "*", "action": "ask" }))
    .chain(std::iter::once(json!({
        "permission": "question",
        "pattern": "*",
        "action": "allow",
    })))
    .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn permission_rules_match_runtime_mode() {
        assert_eq!(
            super::build_permission_rules("full-access"),
            vec![json!({ "permission": "*", "pattern": "*", "action": "allow" })]
        );
        let approval = super::build_permission_rules("approval-required");
        assert!(approval.contains(&json!({
            "permission": "bash",
            "pattern": "*",
            "action": "ask"
        })));
        assert!(approval.contains(&json!({
            "permission": "question",
            "pattern": "*",
            "action": "allow"
        })));
    }
}
