use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

use super::{
    model::{
        BuildTurnStartInput, CodexProviderSnapshot, CodexRuntimeMode, CodexThreadSnapshot,
        build_initialize_params, build_turn_start_params, is_recoverable_thread_resume_error,
        parse_model_list_response, parse_skills_list_response, parse_thread_snapshot,
    },
    protocol::{IncomingEvent, JsonRpcConnection, ProtocolError},
};

const PROVIDER: &str = "codex";
const FIXED_EVENT_TIME: &str = "2026-07-10T00:00:00.000Z";
const FATAL_STDERR_SNIPPETS: &[&str] = &["failed to connect to websocket"];

#[derive(Clone, Debug)]
pub struct CodexSessionOptions {
    pub version: String,
    pub thread_id: String,
    pub cwd: String,
    pub runtime_mode: CodexRuntimeMode,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub resume_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingRequestKind {
    CommandApproval,
    FileChangeApproval,
    UserInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub provider: String,
    pub status: String,
    pub runtime_mode: CodexRuntimeMode,
    pub thread_id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub resume_cursor: Option<String>,
    pub active_turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub thread_id: String,
    pub turn_id: String,
    pub resume_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
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
pub struct RuntimeEventStableView {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

impl RuntimeEvent {
    #[must_use]
    pub fn stable_view(&self) -> RuntimeEventStableView {
        RuntimeEventStableView {
            event_type: self.event_type.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            request_id: self.request_id.clone(),
            payload: self.payload.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("Codex session is missing a provider thread id")]
    MissingProviderThreadId,
    #[error("Unknown pending request id {request_id}")]
    PendingRequestNotFound { request_id: String },
    #[error("Invalid Codex payload: {message}")]
    InvalidPayload { message: String },
}

#[derive(Clone)]
pub struct CodexSessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    options: CodexSessionOptions,
    connection: Mutex<JsonRpcConnection>,
    session: Mutex<ProviderSession>,
    events_tx: mpsc::UnboundedSender<RuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<RuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_requests: Mutex<HashMap<String, PendingRequest>>,
    task: Mutex<Option<JoinHandle<()>>>,
    explicit_close: Mutex<bool>,
}

#[derive(Clone)]
struct PendingRequest {
    kind: PendingRequestKind,
    wire_id: Value,
    turn_id: Option<String>,
}

pub async fn probe_provider(
    connection: &JsonRpcConnection,
    version: &str,
    cwd: &str,
    custom_models: &[String],
) -> Result<CodexProviderSnapshot, RuntimeError> {
    connection
        .request("initialize", build_initialize_params(version))
        .await?;
    connection.notify_without_params("initialized").await?;
    let account = connection.request("account/read", json!({})).await?;

    let mut raw_models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let request_payload = cursor
            .as_ref()
            .map_or_else(|| json!({}), |value| json!({ "cursor": value }));
        let response = connection.request("model/list", request_payload).await?;
        raw_models.extend(
            response
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| RuntimeError::InvalidPayload {
                    message: "model/list response missing data array".to_owned(),
                })?,
        );
        cursor = response
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    let models = parse_model_list_response(&json!({ "data": raw_models }), custom_models)
        .map_err(|message| RuntimeError::InvalidPayload { message })?;

    let skills_response = connection
        .request("skills/list", json!({ "cwds": [cwd] }))
        .await?;
    let skills = parse_skills_list_response(&skills_response, cwd)
        .map_err(|message| RuntimeError::InvalidPayload { message })?;

    Ok(CodexProviderSnapshot {
        account,
        version: Some(version.to_owned()),
        models,
        skills,
    })
}

impl CodexSessionRuntime {
    pub fn new(
        options: CodexSessionOptions,
        connection: JsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let session = ProviderSession {
            provider: PROVIDER.to_owned(),
            status: "connecting".to_owned(),
            runtime_mode: options.runtime_mode,
            thread_id: options.thread_id.clone(),
            cwd: options.cwd.clone(),
            model: options.model.clone(),
            resume_cursor: options.resume_cursor.clone(),
            active_turn_id: None,
        };
        let inner = Arc::new(RuntimeInner {
            options,
            connection: Mutex::new(connection.clone()),
            session: Mutex::new(session),
            events_tx,
            events_rx: Mutex::new(events_rx),
            event_counter: Mutex::new(0),
            pending_requests: Mutex::new(HashMap::new()),
            task: Mutex::new(None),
            explicit_close: Mutex::new(false),
        });
        let runtime = Self { inner };
        runtime.attach_incoming(connection, incoming);
        runtime
    }

    pub async fn start(&self) -> Result<ProviderSession, RuntimeError> {
        self.emit("session.connecting", None, None, json!({})).await;
        let connection = self.inner.connection.lock().await.clone();
        connection
            .request(
                "initialize",
                build_initialize_params(&self.inner.options.version),
            )
            .await?;
        connection.notify_without_params("initialized").await?;

        let open_payload = json!({
            "cwd": self.inner.options.cwd,
            "approvalPolicy": match self.inner.options.runtime_mode {
                CodexRuntimeMode::ApprovalRequired => "untrusted",
                CodexRuntimeMode::AutoAcceptEdits => "on-request",
                CodexRuntimeMode::FullAccess => "never",
            },
            "sandbox": match self.inner.options.runtime_mode {
                CodexRuntimeMode::ApprovalRequired => "read-only",
                CodexRuntimeMode::AutoAcceptEdits => "workspace-write",
                CodexRuntimeMode::FullAccess => "danger-full-access",
            },
            "model": self.inner.options.model,
            "serviceTier": self.inner.options.service_tier,
        });

        let resume_thread_id = self
            .inner
            .session
            .lock()
            .await
            .resume_cursor
            .clone()
            .or_else(|| self.inner.options.resume_cursor.clone());

        let opened = if let Some(resume_thread_id) = resume_thread_id {
            match connection
                .request(
                    "thread/resume",
                    json!({
                        "threadId": resume_thread_id,
                        "cwd": self.inner.options.cwd,
                        "approvalPolicy": match self.inner.options.runtime_mode {
                            CodexRuntimeMode::ApprovalRequired => "untrusted",
                            CodexRuntimeMode::AutoAcceptEdits => "on-request",
                            CodexRuntimeMode::FullAccess => "never",
                        },
                        "sandbox": match self.inner.options.runtime_mode {
                            CodexRuntimeMode::ApprovalRequired => "read-only",
                            CodexRuntimeMode::AutoAcceptEdits => "workspace-write",
                            CodexRuntimeMode::FullAccess => "danger-full-access",
                        },
                        "model": self.inner.options.model,
                        "serviceTier": self.inner.options.service_tier,
                    }),
                )
                .await
            {
                Ok(response) => response,
                Err(ProtocolError::RemoteRequest { message, .. })
                    if is_recoverable_thread_resume_error(&message) =>
                {
                    connection.request("thread/start", open_payload).await?
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            connection.request("thread/start", open_payload).await?
        };

        let provider_thread_id = opened
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPayload {
                message: "thread/start response missing thread.id".to_owned(),
            })?
            .to_owned();

        let mut session = self.inner.session.lock().await;
        session.status = "ready".to_owned();
        session.cwd = opened
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(&self.inner.options.cwd)
            .to_owned();
        session.model = opened
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.inner.options.model.clone());
        session.resume_cursor = Some(provider_thread_id);
        drop(session);

        self.emit("session.ready", None, None, json!({})).await;
        Ok(self.inner.session.lock().await.clone())
    }

    pub async fn reconnect(
        &self,
        connection: JsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Result<ProviderSession, RuntimeError> {
        *self.inner.explicit_close.lock().await = false;
        self.attach_incoming(connection.clone(), incoming);
        *self.inner.connection.lock().await = connection;
        let resume_cursor = self.inner.session.lock().await.resume_cursor.clone();
        self.inner.options_resume_cursor_set(resume_cursor).await;
        self.start().await
    }

    pub async fn send_turn(
        &self,
        input: Option<String>,
        attachments: Vec<Value>,
        interaction_mode: Option<String>,
    ) -> Result<TurnStartResult, RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let session = self.inner.session.lock().await.clone();
        let payload = build_turn_start_params(&BuildTurnStartInput {
            thread_id: provider_thread_id.clone(),
            runtime_mode: self.inner.options.runtime_mode,
            prompt: input,
            attachments,
            model: session.model.clone(),
            service_tier: self.inner.options.service_tier.clone(),
            effort: self.inner.options.effort.clone(),
            interaction_mode,
        });
        let response = self
            .inner
            .connection
            .lock()
            .await
            .clone()
            .request("turn/start", payload)
            .await?;
        let turn_id = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPayload {
                message: "turn/start response missing turn.id".to_owned(),
            })?
            .to_owned();
        let mut session = self.inner.session.lock().await;
        session.status = "running".to_owned();
        session.active_turn_id = Some(turn_id.clone());
        Ok(TurnStartResult {
            thread_id: session.thread_id.clone(),
            turn_id,
            resume_cursor: session.resume_cursor.clone(),
        })
    }

    pub async fn interrupt_turn(&self, turn_id: Option<String>) -> Result<(), RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let active_turn_id = if let Some(turn_id) = turn_id {
            Some(turn_id)
        } else {
            self.inner.session.lock().await.active_turn_id.clone()
        };
        let Some(active_turn_id) = active_turn_id else {
            return Ok(());
        };
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .request(
                "turn/interrupt",
                json!({
                    "threadId": provider_thread_id,
                    "turnId": active_turn_id,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn rollback_thread(
        &self,
        num_turns: u64,
    ) -> Result<CodexThreadSnapshot, RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let response = self
            .inner
            .connection
            .lock()
            .await
            .clone()
            .request(
                "thread/rollback",
                json!({
                    "threadId": provider_thread_id,
                    "numTurns": num_turns,
                }),
            )
            .await?;
        let snapshot = parse_thread_snapshot(&response)
            .map_err(|message| RuntimeError::InvalidPayload { message })?;
        let mut session = self.inner.session.lock().await;
        session.status = "ready".to_owned();
        session.active_turn_id = None;
        Ok(snapshot)
    }

    pub async fn shutdown(&self) -> Result<(), RuntimeError> {
        *self.inner.explicit_close.lock().await = true;
        let connection = self.inner.connection.lock().await.clone();
        let _ = connection.request("shutdown", Value::Null).await;
        connection.close().await;
        Ok(())
    }

    pub async fn respond_to_request(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| RuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        self.emit(
            "request.resolved",
            pending.turn_id.clone(),
            Some(request_id.to_owned()),
            json!({
                "requestType": request_type(pending.kind),
                "decision": decision,
            }),
        )
        .await;
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(
                pending.wire_id,
                json!({
                    "decision": decision,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: Value,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| RuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        let wire_answers = answers
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|(question_id, value)| {
                let answers = match value {
                    Value::String(answer) => vec![Value::String(answer)],
                    Value::Array(array) => array,
                    _ => Vec::new(),
                };
                (
                    question_id,
                    json!({
                        "answers": answers,
                    }),
                )
            })
            .collect::<serde_json::Map<String, Value>>();
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(
                pending.wire_id,
                json!({
                    "answers": Value::Object(wire_answers.clone()),
                }),
            )
            .await?;
        self.emit(
            "user-input.resolved",
            pending.turn_id,
            Some(request_id.to_owned()),
            json!({
                "answers": normalize_user_input_answers(Value::Object(wire_answers)),
            }),
        )
        .await;
        Ok(())
    }

    pub async fn next_event(&self) -> Option<RuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    pub async fn collect_events(&self, expected: usize) -> Vec<RuntimeEventStableView> {
        let mut events = Vec::with_capacity(expected);
        while events.len() < expected {
            let Some(event) = self.next_event().await else {
                break;
            };
            events.push(event.stable_view());
        }
        events
    }

    fn attach_incoming(
        &self,
        connection: JsonRpcConnection,
        mut incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) {
        let runtime = self.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                runtime.handle_incoming(connection.clone(), event).await;
            }
        });
        tokio::spawn({
            let inner = self.inner.clone();
            async move {
                if let Some(previous) = inner.task.lock().await.replace(task) {
                    previous.abort();
                }
            }
        });
    }

    async fn handle_incoming(&self, connection: JsonRpcConnection, event: IncomingEvent) {
        match event {
            IncomingEvent::Notification { method, params } => {
                self.handle_notification(method, params).await;
            }
            IncomingEvent::Request {
                correlation_id,
                wire_id,
                method,
                params,
            } => {
                if let Err(error) = self
                    .handle_request(connection, correlation_id, wire_id, method, params)
                    .await
                {
                    self.emit(
                        "runtime.error",
                        None,
                        None,
                        json!({ "message": error.to_string() }),
                    )
                    .await;
                }
            }
            IncomingEvent::Stderr { message } => {
                let event_type = if FATAL_STDERR_SNIPPETS
                    .iter()
                    .any(|snippet| message.to_ascii_lowercase().contains(snippet))
                {
                    "runtime.error"
                } else {
                    "runtime.warning"
                };
                let payload = if event_type == "runtime.error" {
                    json!({
                        "message": message,
                        "class": "provider_error",
                    })
                } else {
                    json!({
                        "message": message,
                    })
                };
                self.emit(event_type, None, None, payload).await;
            }
            IncomingEvent::Closed { reason } => {
                if *self.inner.explicit_close.lock().await {
                    return;
                }
                let mut session = self.inner.session.lock().await;
                session.status = "closed".to_owned();
                session.active_turn_id = None;
                drop(session);
                self.emit("session.exited", None, None, json!({ "reason": reason }))
                    .await;
            }
        }
    }

    async fn handle_notification(&self, method: String, params: Value) {
        match method.as_str() {
            "thread/started" => {
                if let Some(thread_id) = params
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                {
                    self.inner.session.lock().await.resume_cursor = Some(thread_id.to_owned());
                }
            }
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(turn_id) = turn_id.clone() {
                    let mut session = self.inner.session.lock().await;
                    session.status = "running".to_owned();
                    session.active_turn_id = Some(turn_id.clone());
                    drop(session);
                    self.emit("turn.started", Some(turn_id), None, json!({}))
                        .await;
                }
            }
            "turn/completed" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let state = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let error = params
                    .get("turn")
                    .and_then(|turn| turn.get("error"))
                    .cloned();
                let mut session = self.inner.session.lock().await;
                session.status = if state == "failed" { "error" } else { "ready" }.to_owned();
                session.active_turn_id = None;
                drop(session);
                let mut payload = json!({ "state": state });
                if let Some(error) = error {
                    payload["error"] = error;
                }
                self.emit("turn.completed", turn_id, None, payload).await;
            }
            "item/agentMessage/delta" => {
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.emit(
                    "content.delta",
                    turn_id,
                    None,
                    json!({
                        "streamKind": "assistant_text",
                        "delta": delta,
                    }),
                )
                .await;
            }
            "item/started" => {
                if let Some((turn_id, payload)) = command_item_event_payload(&params, false) {
                    self.emit("item.started", Some(turn_id), None, payload)
                        .await;
                }
            }
            "item/completed" => {
                if let Some((turn_id, payload)) = command_item_event_payload(&params, true) {
                    self.emit("item.completed", Some(turn_id), None, payload)
                        .await;
                }
            }
            _ => {}
        }
    }

    async fn handle_request(
        &self,
        connection: JsonRpcConnection,
        correlation_id: String,
        wire_id: Value,
        method: String,
        params: Value,
    ) -> Result<(), RuntimeError> {
        match method.as_str() {
            "item/commandExecution/requestApproval" => {
                let request_id = format!("approval:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::CommandApproval,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                let detail = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("command").and_then(Value::as_str))
                    .unwrap_or_default();
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": request_type(PendingRequestKind::CommandApproval),
                        "detail": detail,
                    }),
                )
                .await;
                Ok(())
            }
            "item/fileChange/requestApproval" => {
                let request_id = format!("approval:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::FileChangeApproval,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                let detail = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": request_type(PendingRequestKind::FileChangeApproval),
                        "detail": detail,
                    }),
                )
                .await;
                Ok(())
            }
            "item/tool/requestUserInput" => {
                let request_id = format!("user-input:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::UserInput,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                self.emit(
                    "user-input.requested",
                    turn_id,
                    Some(request_id),
                    json!({
                        "questions": normalize_questions(params.get("questions").cloned().unwrap_or(Value::Null)),
                    }),
                )
                .await;
                Ok(())
            }
            _ => {
                connection
                    .respond_error(
                        wire_id,
                        super::protocol::JsonRpcErrorShape {
                            code: -32601,
                            message: format!("Method not found: {method}"),
                            data: None,
                        },
                    )
                    .await?;
                Ok(())
            }
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
        let event = RuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: event_type.to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id,
            request_id,
            payload,
        };
        let _ = self.inner.events_tx.send(event);
    }

    async fn provider_thread_id(&self) -> Result<String, RuntimeError> {
        self.inner
            .session
            .lock()
            .await
            .resume_cursor
            .clone()
            .ok_or(RuntimeError::MissingProviderThreadId)
    }
}

impl RuntimeInner {
    async fn options_resume_cursor_set(&self, resume_cursor: Option<String>) {
        let mut session = self.session.lock().await;
        session.resume_cursor = resume_cursor;
    }
}

fn request_type(kind: PendingRequestKind) -> &'static str {
    match kind {
        PendingRequestKind::CommandApproval => "command_execution_approval",
        PendingRequestKind::FileChangeApproval => "file_change_approval",
        PendingRequestKind::UserInput => "tool_user_input",
    }
}

fn command_item_event_payload(params: &Value, completed: bool) -> Option<(String, Value)> {
    let turn_id = params.get("turnId").and_then(Value::as_str)?.to_owned();
    let item = params.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
        return None;
    }
    let detail = item
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = if completed {
        json!({
            "itemType": "command_execution",
            "status": "completed",
            "title": "Ran command",
            "detail": detail,
        })
    } else {
        json!({
            "itemType": "command_execution",
            "title": "Ran command",
            "detail": detail,
        })
    };
    Some((turn_id, payload))
}

fn normalize_questions(value: Value) -> Value {
    let questions = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        questions
            .into_iter()
            .filter_map(|question| {
                let id = question.get("id").and_then(Value::as_str)?;
                let header = question.get("header").and_then(Value::as_str)?;
                let prompt = question.get("question").and_then(Value::as_str)?;
                let options = question
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Some(json!({
                    "id": id,
                    "header": header,
                    "question": prompt,
                    "options": options,
                    "multiSelect": false,
                }))
            })
            .collect(),
    )
}

fn normalize_user_input_answers(value: Value) -> Value {
    let answers = value.as_object().cloned().unwrap_or_default();
    let mut normalized = serde_json::Map::new();
    for (question_id, answer_value) in answers {
        let answer_array = answer_value
            .get("answers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if answer_array.len() == 1 {
            normalized.insert(question_id, answer_array[0].clone());
        } else {
            normalized.insert(question_id, Value::Array(answer_array));
        }
    }
    Value::Object(normalized)
}
