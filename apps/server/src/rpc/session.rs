use std::{
    any::Any, collections::HashMap, future::Future, panic::AssertUnwindSafe, pin::Pin, sync::Arc,
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;

use super::{
    message::{ClientMessage, RequestId, RpcRequest, ServerMessage},
    methods::{ACTIVE_RPC_METHODS, MethodMode},
};
use crate::{
    auth::{AuthService, Principal, authorization_error, required_scope},
    diagnostics::TraceDiagnosticsStore,
};

const OUTBOUND_CAPACITY: usize = 64;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

pub type RpcResult = Result<Value, Value>;
pub type RpcStreamChunk = Result<Vec<Value>, Value>;
type UnaryFuture = Pin<Box<dyn Future<Output = RpcResult> + Send + 'static>>;
type UnaryHandler =
    Arc<dyn Fn(RpcRequest, RpcSessionContext, CancellationToken) -> UnaryFuture + Send + Sync>;
type StreamHandler = Arc<
    dyn Fn(RpcRequest, RpcSessionContext, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
        + Send
        + Sync,
>;

#[derive(Clone, Default)]
pub(crate) struct RpcSessionContext {
    principal: Option<Principal>,
    auth: Option<AuthService>,
}

impl RpcSessionContext {
    #[must_use]
    pub(crate) fn unauthenticated() -> Self {
        Self::default()
    }

    #[must_use]
    pub(crate) fn authenticated(principal: Principal, auth: AuthService) -> Self {
        Self {
            principal: Some(principal),
            auth: Some(auth),
        }
    }

    #[must_use]
    pub(crate) fn current_session_id(&self) -> Option<&str> {
        self.principal
            .as_ref()
            .map(|principal| principal.session_id.as_str())
    }
}

#[derive(Clone)]
enum RpcMethod {
    Unary(UnaryHandler),
    Stream(StreamHandler),
}

#[derive(Clone, Default)]
pub struct RpcRegistry {
    methods: HashMap<String, RpcMethod>,
    trace_diagnostics: Option<TraceDiagnosticsStore>,
}

impl RpcRegistry {
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_trace_diagnostics(trace_diagnostics: TraceDiagnosticsStore) -> Self {
        Self {
            methods: HashMap::new(),
            trace_diagnostics: Some(trace_diagnostics),
        }
    }

    pub fn register_unary<F, Fut>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult> + Send + 'static,
    {
        let name = name.into();
        let trace_diagnostics = self.trace_diagnostics.clone();
        let diagnostic_name = name.clone();
        self.methods.insert(
            name,
            RpcMethod::Unary(Arc::new(move |request, _context, cancellation| {
                let future = handler(request, cancellation);
                let trace_diagnostics = trace_diagnostics.clone();
                let diagnostic_name = diagnostic_name.clone();
                Box::pin(async move {
                    let result = future.await;
                    if let (Some(trace_diagnostics), Err(error)) = (&trace_diagnostics, &result)
                        && let Err(write_error) =
                            trace_diagnostics.record_failure(&diagnostic_name, error)
                    {
                        tracing::warn!(
                            method = diagnostic_name,
                            error = %write_error,
                            "failed to persist RPC diagnostics"
                        );
                    }
                    result
                })
            })),
        );
    }

    pub fn register_stream<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
            + Send
            + Sync
            + 'static,
    {
        self.methods.insert(
            name.into(),
            RpcMethod::Stream(Arc::new(move |request, _context, cancellation| {
                handler(request, cancellation)
            })),
        );
    }

    pub(crate) fn register_stream_with_context<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, RpcSessionContext, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
            + Send
            + Sync
            + 'static,
    {
        self.methods
            .insert(name.into(), RpcMethod::Stream(Arc::new(handler)));
    }

    fn get(&self, name: &str) -> Option<RpcMethod> {
        self.methods.get(name).cloned()
    }

    pub fn validate_complete(&self) -> Result<(), String> {
        let mut issues = Vec::new();
        for spec in ACTIVE_RPC_METHODS {
            match (spec.mode, self.methods.get(spec.name)) {
                (MethodMode::Unary, Some(RpcMethod::Unary(_)))
                | (MethodMode::Stream, Some(RpcMethod::Stream(_))) => {}
                (_, None) => issues.push(format!("missing {}", spec.name)),
                (expected, Some(_)) => {
                    issues.push(format!(
                        "wrong mode for {}: expected {expected:?}",
                        spec.name
                    ));
                }
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues.join(", "))
        }
    }
}

struct InFlight {
    cancellation: CancellationToken,
    acknowledgements: Option<mpsc::Sender<()>>,
    task: JoinHandle<()>,
}

struct DispatchContext<'a> {
    registry: &'a RpcRegistry,
    session: &'a RpcSessionContext,
    outbound: &'a mpsc::Sender<ServerMessage>,
    completed: &'a mpsc::Sender<RequestId>,
    shutdown: &'a CancellationToken,
}

pub(crate) async fn run_session(
    socket: WebSocket,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
) {
    let (mut socket_writer, mut socket_reader) = socket.split();
    let (outbound_sender, mut outbound_receiver) =
        mpsc::channel::<ServerMessage>(OUTBOUND_CAPACITY);
    let writer_shutdown = session_shutdown.clone();
    let mut writer = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                () = writer_shutdown.cancelled() => break,
                message = outbound_receiver.recv() => {
                    let Some(message) = message else {
                        break;
                    };
                    message
                }
            };
            let Ok(encoded) = serde_json::to_string(&message) else {
                break;
            };
            if !matches!(
                timeout(
                    SOCKET_WRITE_TIMEOUT,
                    socket_writer.send(Message::Text(encoded.into())),
                )
                .await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        let _ = timeout(SOCKET_WRITE_TIMEOUT, socket_writer.close()).await;
    });
    let (completed_sender, mut completed_receiver) =
        mpsc::channel::<RequestId>(MAX_IN_FLIGHT_REQUESTS);
    let mut in_flight = HashMap::<RequestId, InFlight>::new();
    let mut received_eof = false;
    {
        let dispatch = DispatchContext {
            registry: &registry,
            session: &context,
            outbound: &outbound_sender,
            completed: &completed_sender,
            shutdown: &session_shutdown,
        };

        loop {
            if received_eof && in_flight.is_empty() {
                break;
            }

            tokio::select! {
                () = session_shutdown.cancelled() => break,
                completed = completed_receiver.recv(), if !in_flight.is_empty() => {
                    let Some(request_id) = completed else {
                        break;
                    };
                    if let Some(in_flight_request) = in_flight.remove(&request_id) {
                        let _ = in_flight_request.task.await;
                    }
                }
                frame = socket_reader.next() => {
                    let Some(frame) = frame else {
                        break;
                    };
                    let Ok(frame) = frame else {
                        break;
                    };
                    let decoded = match frame {
                        Message::Text(text) => decode_client_messages(text.as_bytes()),
                        Message::Binary(bytes) => decode_client_messages(&bytes),
                        Message::Close(_) => break,
                        Message::Ping(_) | Message::Pong(_) => continue,
                    };
                    let messages = match decoded {
                        Ok(messages) => messages,
                        Err(error) => {
                            if send_server_message(
                                &outbound_sender,
                                &session_shutdown,
                                client_protocol_error(error.to_string()),
                            )
                            .await
                            .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                    };
                    for message in messages {
                        if process_client_message(
                            message,
                            &dispatch,
                            &mut in_flight,
                            &mut received_eof,
                        )
                        .await
                        .is_err()
                        {
                            received_eof = true;
                            break;
                        }
                    }
                }
            }
        }
    }

    session_shutdown.cancel();
    for request in in_flight.values() {
        request.cancellation.cancel();
    }
    for (_, request) in in_flight {
        let _ = request.task.await;
    }
    drop(outbound_sender);
    drop(completed_sender);
    if timeout(WRITER_JOIN_TIMEOUT, &mut writer).await.is_err() {
        writer.abort();
        let _ = writer.await;
    }
}

async fn process_client_message(
    message: ClientMessage,
    dispatch: &DispatchContext<'_>,
    in_flight: &mut HashMap<RequestId, InFlight>,
    received_eof: &mut bool,
) -> Result<(), ()> {
    if *received_eof && matches!(message, ClientMessage::Request { .. }) {
        return Ok(());
    }

    match message {
        ClientMessage::Ping => {
            send_server_message(dispatch.outbound, dispatch.shutdown, ServerMessage::Pong).await
        }
        ClientMessage::Eof => {
            *received_eof = true;
            Ok(())
        }
        ClientMessage::Ack { request_id } => {
            if let Some(sender) = in_flight
                .get(&request_id)
                .and_then(|request| request.acknowledgements.as_ref())
            {
                let _ = sender.try_send(());
            }
            Ok(())
        }
        ClientMessage::Interrupt { request_id } => {
            if let Some(request) = in_flight.get(&request_id) {
                request.cancellation.cancel();
                return Ok(());
            }
            send_server_message(
                dispatch.outbound,
                dispatch.shutdown,
                ServerMessage::interrupt(request_id),
            )
            .await
        }
        ClientMessage::Request {
            id,
            tag,
            payload,
            headers,
            trace_id,
            span_id,
            sampled,
        } => {
            let request = RpcRequest {
                id,
                tag,
                payload,
                headers,
                trace_id,
                span_id,
                sampled,
            };
            if in_flight.contains_key(&request.id) {
                return Ok(());
            }
            if in_flight.len() >= MAX_IN_FLIGHT_REQUESTS {
                return send_server_message(
                    dispatch.outbound,
                    dispatch.shutdown,
                    ServerMessage::connection_defect("RPC in-flight request limit exceeded"),
                )
                .await;
            }
            let Some(method) = dispatch.registry.get(&request.tag) else {
                return send_server_message(
                    dispatch.outbound,
                    dispatch.shutdown,
                    ServerMessage::connection_defect(format!(
                        "Unknown request tag: {}",
                        request.tag
                    )),
                )
                .await;
            };
            if let Some(principal) = dispatch.session.principal.as_ref() {
                let Some(scope) = required_scope(&request.tag) else {
                    return send_server_message(
                        dispatch.outbound,
                        dispatch.shutdown,
                        ServerMessage::connection_defect(format!(
                            "RPC method {} has no declared authorization scope",
                            request.tag
                        )),
                    )
                    .await;
                };
                if let Some(auth) = dispatch.session.auth.as_ref() {
                    match auth.authorize_session(&principal.session_id, scope).await {
                        Ok(()) => {}
                        Err(crate::auth::AuthError::ScopeRequired(_)) => {
                            return send_server_message(
                                dispatch.outbound,
                                dispatch.shutdown,
                                ServerMessage::failure(
                                    request.id.clone(),
                                    authorization_error(scope),
                                ),
                            )
                            .await;
                        }
                        Err(_) => {
                            return send_server_message(
                                dispatch.outbound,
                                dispatch.shutdown,
                                ServerMessage::connection_defect(
                                    "Authenticated session is no longer valid",
                                ),
                            )
                            .await;
                        }
                    }
                }
            }
            spawn_request(
                request,
                method,
                dispatch.session.clone(),
                dispatch.outbound,
                dispatch.completed,
                in_flight,
                dispatch.shutdown,
            );
            Ok(())
        }
    }
}

fn spawn_request(
    request: RpcRequest,
    method: RpcMethod,
    context: RpcSessionContext,
    outbound: &mpsc::Sender<ServerMessage>,
    completed: &mpsc::Sender<RequestId>,
    in_flight: &mut HashMap<RequestId, InFlight>,
    session_shutdown: &CancellationToken,
) {
    let request_id = request.id.clone();
    let cancellation = CancellationToken::new();
    let request_cancellation = cancellation.clone();
    let outbound = outbound.clone();
    let completed = completed.clone();
    let session_shutdown = session_shutdown.clone();
    let (acknowledgements, acknowledgement_receiver) = match method {
        RpcMethod::Unary(_) => (None, None),
        RpcMethod::Stream(_) => {
            let (sender, receiver) = mpsc::channel(1);
            (Some(sender), Some(receiver))
        }
    };
    let completion_id = request_id.clone();
    let panic_outbound = outbound.clone();
    let request_shutdown = session_shutdown.clone();
    let task = tokio::spawn(async move {
        let execution = AssertUnwindSafe(async move {
            match method {
                RpcMethod::Unary(handler) => {
                    run_unary(
                        request,
                        handler,
                        context,
                        request_cancellation,
                        request_shutdown.clone(),
                        outbound,
                    )
                    .await;
                }
                RpcMethod::Stream(handler) => {
                    let Some(acknowledgement_receiver) = acknowledgement_receiver else {
                        return;
                    };
                    run_stream(
                        request,
                        handler,
                        context,
                        request_cancellation,
                        request_shutdown.clone(),
                        acknowledgement_receiver,
                        outbound,
                    )
                    .await;
                }
            }
        })
        .catch_unwind()
        .await;
        if let Err(payload) = execution {
            let _ = send_server_message(
                &panic_outbound,
                &session_shutdown,
                ServerMessage::connection_defect(panic_payload_message(payload.as_ref())),
            )
            .await;
        }
        let _ = completed.send(completion_id).await;
    });
    in_flight.insert(
        request_id,
        InFlight {
            cancellation,
            acknowledgements,
            task,
        },
    );
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "RPC handler panicked with a non-string payload".to_owned()
}

async fn run_unary(
    request: RpcRequest,
    handler: UnaryHandler,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    session_shutdown: CancellationToken,
    outbound: mpsc::Sender<ServerMessage>,
) {
    let request_id = request.id.clone();
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            let _ = send_server_message(
                &outbound,
                &session_shutdown,
                ServerMessage::interrupt(request_id),
            ).await;
            return;
        }
        result = handler(request, context, cancellation.clone()) => result,
    };
    let response = match result {
        Ok(value) => ServerMessage::success(request_id, Some(value)),
        Err(error) => ServerMessage::failure(request_id, error),
    };
    let _ = send_server_message(&outbound, &session_shutdown, response).await;
}

async fn run_stream(
    request: RpcRequest,
    handler: StreamHandler,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    session_shutdown: CancellationToken,
    mut acknowledgements: mpsc::Receiver<()>,
    outbound: mpsc::Sender<ServerMessage>,
) {
    let request_id = request.id.clone();
    let mut stream = handler(request, context, cancellation.clone());
    loop {
        let item = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::interrupt(request_id),
                ).await;
                return;
            }
            item = stream.recv() => item,
        };
        let Some(item) = item else {
            let _ = send_server_message(
                &outbound,
                &session_shutdown,
                ServerMessage::success(request_id, None),
            )
            .await;
            return;
        };
        match item {
            Err(error) => {
                let _ = send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::failure(request_id, error),
                )
                .await;
                return;
            }
            Ok(values) => {
                if values.is_empty() {
                    let _ = send_server_message(
                        &outbound,
                        &session_shutdown,
                        ServerMessage::connection_defect("RPC stream produced an empty Chunk"),
                    )
                    .await;
                    return;
                }
                if send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::Chunk {
                        request_id: request_id.clone(),
                        values,
                    },
                )
                .await
                .is_err()
                {
                    return;
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        let _ = send_server_message(
                            &outbound,
                            &session_shutdown,
                            ServerMessage::interrupt(request_id),
                        ).await;
                        return;
                    }
                    acknowledgement = acknowledgements.recv() => {
                        if acknowledgement.is_none() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn send_server_message(
    outbound: &mpsc::Sender<ServerMessage>,
    session_shutdown: &CancellationToken,
    message: ServerMessage,
) -> Result<(), ()> {
    tokio::select! {
        () = session_shutdown.cancelled() => Err(()),
        result = timeout(OUTBOUND_SEND_TIMEOUT, outbound.send(message)) => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    }
}

fn decode_client_messages(bytes: &[u8]) -> Result<Vec<ClientMessage>, serde_json::Error> {
    let value: Value = serde_json::from_slice(bytes)?;
    match value {
        Value::Array(messages) => messages.into_iter().map(serde_json::from_value).collect(),
        message => serde_json::from_value(message).map(|message| vec![message]),
    }
}

fn client_protocol_error(message: String) -> ServerMessage {
    ServerMessage::ClientProtocolError {
        error: json!({
            "_tag": "RpcClientError",
            "reason": {
                "_tag": "RpcClientDefect",
                "message": message,
                "cause": message,
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_shutdown_unblocks_a_full_outbound_queue() {
        let (sender, _receiver) = mpsc::channel(1);
        sender.try_send(ServerMessage::Pong).expect("fill queue");
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        timeout(
            Duration::from_millis(100),
            send_server_message(&sender, &shutdown, ServerMessage::Pong),
        )
        .await
        .expect("send observes cancellation")
        .expect_err("cancelled session rejects outbound messages");
    }

    #[tokio::test]
    async fn unary_rpc_failures_are_persisted_for_restart_diagnostics() {
        let directory = tempfile::tempdir().expect("temporary diagnostics directory");
        let trace_path = directory.path().join("server.trace.ndjson");
        let diagnostics = TraceDiagnosticsStore::new(trace_path.clone());
        let mut registry = RpcRegistry::with_trace_diagnostics(diagnostics);
        registry.register_unary("git.createWorktree", |_request, _cancellation| async {
            Err(json!({
                "_tag": "GitCommandError",
                "detail": "fatal: bad config line 3 in .gitmodules"
            }))
        });
        let request = RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: "git.createWorktree".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let RpcMethod::Unary(handler) = registry.get("git.createWorktree").expect("handler") else {
            panic!("expected unary handler");
        };

        handler(
            request,
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
        )
        .await
        .expect_err("fixture RPC fails");

        let after_restart = TraceDiagnosticsStore::new(trace_path).read();
        assert_eq!(after_restart["failureCount"], 1);
        assert_eq!(
            after_restart["latestFailures"][0]["cause"],
            "fatal: bad config line 3 in .gitmodules"
        );
    }
}
