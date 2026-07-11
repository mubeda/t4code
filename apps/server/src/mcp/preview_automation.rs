use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PreviewAutomationOperation {
    Status,
    Open,
    Navigate,
    Snapshot,
    Click,
    Type,
    Press,
    Scroll,
    Evaluate,
    WaitFor,
    RecordingStart,
    RecordingStop,
    Resize,
}

impl PreviewAutomationOperation {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Open => "open",
            Self::Navigate => "navigate",
            Self::Snapshot => "snapshot",
            Self::Click => "click",
            Self::Type => "type",
            Self::Press => "press",
            Self::Scroll => "scroll",
            Self::Evaluate => "evaluate",
            Self::WaitFor => "waitFor",
            Self::RecordingStart => "recordingStart",
            Self::RecordingStop => "recordingStop",
            Self::Resize => "resize",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "status" => Self::Status,
            "open" => Self::Open,
            "navigate" => Self::Navigate,
            "snapshot" => Self::Snapshot,
            "click" => Self::Click,
            "type" => Self::Type,
            "press" => Self::Press,
            "scroll" => Self::Scroll,
            "evaluate" => Self::Evaluate,
            "waitFor" => Self::WaitFor,
            "recordingStart" => Self::RecordingStart,
            "recordingStop" => Self::RecordingStop,
            "resize" => Self::Resize,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewAutomationHost {
    pub client_id: String,
    pub environment_id: String,
    pub supported_operations: Vec<PreviewAutomationOperation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewAutomationRequest {
    pub request_id: String,
    pub thread_id: String,
    pub operation: PreviewAutomationOperation,
    pub input: Value,
    pub tab_id: Option<String>,
    pub tab_id_explicit: bool,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PreviewAutomationStreamEvent {
    Connected {
        connection_id: String,
    },
    Request {
        connection_id: String,
        request: PreviewAutomationRequest,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewAutomationResponse {
    pub client_id: String,
    pub connection_id: String,
    pub request_id: String,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewAutomationInvokeInput {
    pub environment_id: String,
    pub thread_id: String,
    pub provider_session_id: String,
    pub provider_instance_id: String,
    pub operation: PreviewAutomationOperation,
    pub input: Value,
    pub tab_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewAutomationError {
    tag: String,
    message: String,
}

impl PreviewAutomationError {
    fn new(tag: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            tag: tag.into(),
            message: message.into(),
        }
    }

    #[must_use]
    pub fn tag(&self) -> &str {
        &self.tag
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

struct PendingRequest {
    connection_id: String,
    assignment_key: String,
    request_tab_id: Option<String>,
    result: oneshot::Sender<Result<Value, PreviewAutomationError>>,
}

struct ConnectionState {
    connection_id: String,
    environment_id: String,
    supported_operations: Vec<PreviewAutomationOperation>,
    focus_order: u64,
    sender: mpsc::Sender<PreviewAutomationStreamEvent>,
}

#[derive(Default)]
struct BrokerState {
    request_sequence: u64,
    focus_sequence: u64,
    connections: BTreeMap<String, ConnectionState>,
    defaults: BTreeMap<String, String>,
    pending: BTreeMap<String, PendingRequest>,
}

#[derive(Clone)]
pub struct PreviewAutomationBroker {
    state: Arc<Mutex<BrokerState>>,
}

impl Default for PreviewAutomationBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewAutomationBroker {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
        }
    }

    pub fn connect(
        &self,
        host: PreviewAutomationHost,
    ) -> mpsc::Receiver<PreviewAutomationStreamEvent> {
        let (sender, receiver) = mpsc::channel(16);
        let mut state = self.state.lock().expect("preview automation broker");
        let removed = state.connections.remove(&host.client_id);
        let disconnected = removed
            .as_ref()
            .map(|connection| connection.connection_id.clone());
        state.focus_sequence = state.focus_sequence.saturating_add(1);
        let focus_order = state.focus_sequence;
        let connection_id = Uuid::new_v4().to_string();
        state.connections.insert(
            host.client_id.clone(),
            ConnectionState {
                connection_id: connection_id.clone(),
                environment_id: host.environment_id.clone(),
                supported_operations: host.supported_operations.clone(),
                focus_order,
                sender: sender.clone(),
            },
        );

        if let Some(connection_id) = disconnected {
            fail_pending_locked(
                &mut state,
                &connection_id,
                PreviewAutomationError::new(
                    "PreviewAutomationClientDisconnectedError",
                    "Preview automation client disconnected.",
                ),
            );
        }
        drop(state);
        let _ = sender.try_send(PreviewAutomationStreamEvent::Connected { connection_id });
        receiver
    }

    pub async fn focus_host(
        &self,
        client_id: &str,
        environment_id: &str,
    ) -> Result<(), PreviewAutomationError> {
        let mut state = self.state.lock().expect("preview automation broker");
        state.focus_sequence = state.focus_sequence.saturating_add(1);
        let focus_order = state.focus_sequence;
        let connection = state.connections.get_mut(client_id).ok_or_else(|| {
            PreviewAutomationError::new(
                "PreviewAutomationNoAvailableHostError",
                "No preview automation host is available.",
            )
        })?;
        if connection.environment_id != environment_id {
            return Err(PreviewAutomationError::new(
                "PreviewAutomationNoAvailableHostError",
                "No preview automation host is available.",
            ));
        }
        connection.focus_order = focus_order;
        Ok(())
    }

    pub fn disconnect(&self, client_id: &str, connection_id: &str) -> bool {
        let mut state = self.state.lock().expect("preview automation broker");
        let matches = state
            .connections
            .get(client_id)
            .is_some_and(|connection| connection.connection_id == connection_id);
        if !matches {
            return false;
        }
        state.connections.remove(client_id);
        fail_pending_locked(
            &mut state,
            connection_id,
            PreviewAutomationError::new(
                "PreviewAutomationClientDisconnectedError",
                "Preview automation client disconnected.",
            ),
        );
        true
    }

    pub async fn respond(
        &self,
        response: PreviewAutomationResponse,
    ) -> Result<(), PreviewAutomationError> {
        let mut state = self.state.lock().expect("preview automation broker");
        let Some(pending) = state.pending.remove(&response.request_id) else {
            return Ok(());
        };
        if response.ok
            && let Some(tab_id) = response
                .result
                .as_ref()
                .and_then(|result| result.get("tabId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(pending.request_tab_id.clone())
        {
            state.defaults.insert(pending.assignment_key, tab_id);
        }
        let _ = pending.result.send(if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(PreviewAutomationError::new(
                response
                    .error
                    .as_ref()
                    .and_then(|value| value.get("_tag"))
                    .and_then(Value::as_str)
                    .unwrap_or("PreviewAutomationExecutionError"),
                response
                    .error
                    .as_ref()
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Preview automation request failed."),
            ))
        });
        Ok(())
    }

    pub async fn invoke(
        &self,
        input: PreviewAutomationInvokeInput,
    ) -> Result<Value, PreviewAutomationError> {
        let timeout_ms = input.timeout_ms.unwrap_or(15_000);
        let assignment_key = format!("{}\u{0}{}", input.environment_id, input.provider_session_id);
        let (receiver, sender, connection_id, request) = {
            let mut state = self.state.lock().expect("preview automation broker");
            let (connection_id, connection_sender) = {
                let connection = state
                    .connections
                    .values()
                    .filter(|connection| {
                        connection.environment_id == input.environment_id
                            && connection
                                .supported_operations
                                .iter()
                                .any(|operation| operation == &input.operation)
                    })
                    .max_by_key(|connection| connection.focus_order)
                    .ok_or_else(|| {
                        PreviewAutomationError::new(
                            "PreviewAutomationNoAvailableHostError",
                            "No preview automation host is available.",
                        )
                    })?;
                (connection.connection_id.clone(), connection.sender.clone())
            };
            let request_id = format!("preview-{}", state.request_sequence);
            state.request_sequence = state.request_sequence.saturating_add(1);
            let tab_id = input
                .tab_id
                .clone()
                .or_else(|| state.defaults.get(&assignment_key).cloned());
            let request = PreviewAutomationRequest {
                request_id: request_id.clone(),
                thread_id: input.thread_id.clone(),
                operation: input.operation.clone(),
                input: input.input.clone(),
                tab_id: tab_id.clone(),
                tab_id_explicit: input.tab_id.is_some(),
                timeout_ms,
            };
            let (result_sender, result_receiver) = oneshot::channel();
            state.pending.insert(
                request_id,
                PendingRequest {
                    connection_id: connection_id.clone(),
                    assignment_key,
                    request_tab_id: tab_id,
                    result: result_sender,
                },
            );
            (result_receiver, connection_sender, connection_id, request)
        };

        if sender
            .send(PreviewAutomationStreamEvent::Request {
                connection_id,
                request,
            })
            .await
            .is_err()
        {
            return Err(PreviewAutomationError::new(
                "PreviewAutomationRequestQueueClosedError",
                "Preview automation request queue closed.",
            ));
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(PreviewAutomationError::new(
                "PreviewAutomationClientDisconnectedError",
                "Preview automation client disconnected.",
            )),
            Err(_) => Err(PreviewAutomationError::new(
                "PreviewAutomationTimeoutError",
                "Preview automation request timed out.",
            )),
        }
    }
}

fn fail_pending_locked(
    state: &mut BrokerState,
    connection_id: &str,
    error: PreviewAutomationError,
) {
    let request_ids = state
        .pending
        .iter()
        .filter(|(_, pending)| pending.connection_id == connection_id)
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    for request_id in request_ids {
        if let Some(pending) = state.pending.remove(&request_id) {
            let _ = pending.result.send(Err(error.clone()));
        }
    }
}
