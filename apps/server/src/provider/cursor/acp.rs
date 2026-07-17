use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};

#[derive(Clone, Copy, Debug)]
pub struct AcpConnectionConfig {
    pub max_stdout_line_bytes: usize,
    pub max_stderr_line_bytes: usize,
}

impl Default for AcpConnectionConfig {
    fn default() -> Self {
        Self {
            max_stdout_line_bytes: 128 * 1024,
            max_stderr_line_bytes: 64 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcErrorShape {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug)]
pub enum IncomingEvent {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        correlation_id: String,
        wire_id: Value,
        method: String,
        params: Value,
    },
    Stderr {
        message: String,
    },
    Closed {
        reason: String,
    },
}

#[derive(Debug, Error)]
pub enum AcpProtocolError {
    #[error("ACP JSON-RPC connection is closed: {reason}")]
    Closed { reason: String },
    #[error("ACP JSON-RPC read line exceeded {maximum} bytes on {stream}")]
    LineTooLong {
        stream: &'static str,
        maximum: usize,
    },
    #[error("ACP JSON-RPC read failed on {stream}: {message}")]
    ReadFailure {
        stream: &'static str,
        message: String,
    },
    #[error("ACP JSON-RPC write failed: {message}")]
    WriteFailure { message: String },
    #[error("ACP JSON-RPC message was invalid: {message}")]
    InvalidMessage { message: String },
    #[error("ACP JSON-RPC response for id {request_id} was not correlated")]
    UnknownResponse { request_id: String },
    #[error("ACP JSON-RPC request {method} failed ({code}): {message}")]
    RemoteRequest {
        method: String,
        request_id: String,
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

#[derive(Clone)]
pub struct AcpJsonRpcConnection {
    inner: Arc<Inner>,
}

struct Inner {
    writer: mpsc::UnboundedSender<WriterMessage>,
    pending: Mutex<HashMap<String, PendingRequest>>,
    closed: AtomicBool,
    close_reason: Mutex<Option<String>>,
    next_request_id: AtomicU64,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

struct PendingRequest {
    method: String,
    responder: oneshot::Sender<Result<Value, AcpProtocolError>>,
}

enum WriterMessage {
    Json(Value),
}

impl AcpJsonRpcConnection {
    pub fn spawn<R, W, E>(
        stdout: R,
        stdin: W,
        stderr: E,
        config: AcpConnectionConfig,
    ) -> (Self, mpsc::UnboundedReceiver<IncomingEvent>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
        E: AsyncRead + Unpin + Send + 'static,
    {
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            writer: writer_tx,
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
            next_request_id: AtomicU64::new(1),
            tasks: Mutex::new(Vec::new()),
        });
        let connection = Self {
            inner: inner.clone(),
        };

        let writer_inner = inner.clone();
        let writer_incoming = incoming_tx.clone();
        let writer_task = tokio::spawn(async move {
            let mut sink = stdin;
            while let Some(message) = writer_rx.recv().await {
                match message {
                    WriterMessage::Json(payload) => {
                        let encoded = match serde_json::to_vec(&payload) {
                            Ok(mut bytes) => {
                                bytes.push(b'\n');
                                bytes
                            }
                            Err(error) => {
                                fail_connection(
                                    &writer_inner,
                                    &writer_incoming,
                                    AcpProtocolError::InvalidMessage {
                                        message: error.to_string(),
                                    },
                                )
                                .await;
                                break;
                            }
                        };
                        if let Err(error) = sink.write_all(&encoded).await {
                            fail_connection(
                                &writer_inner,
                                &writer_incoming,
                                AcpProtocolError::WriteFailure {
                                    message: error.to_string(),
                                },
                            )
                            .await;
                            break;
                        }
                        if let Err(error) = sink.flush().await {
                            fail_connection(
                                &writer_inner,
                                &writer_incoming,
                                AcpProtocolError::WriteFailure {
                                    message: error.to_string(),
                                },
                            )
                            .await;
                            break;
                        }
                    }
                }
            }
        });

        let reader_inner = inner.clone();
        let reader_incoming = incoming_tx.clone();
        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            match read_stdout_loop(
                &mut reader,
                config.max_stdout_line_bytes,
                &reader_inner,
                &reader_incoming,
            )
            .await
            {
                Ok(()) => {}
                Err(error) => fail_connection(&reader_inner, &reader_incoming, error).await,
            }
        });

        let stderr_inner = inner.clone();
        let stderr_incoming = incoming_tx.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            match read_stderr_loop(&mut reader, config.max_stderr_line_bytes, &stderr_incoming)
                .await
            {
                Ok(()) => {}
                Err(error) => fail_connection(&stderr_inner, &stderr_incoming, error).await,
            }
        });

        tokio::spawn({
            let inner = inner.clone();
            async move {
                let mut tasks = inner.tasks.lock().await;
                tasks.push(writer_task);
                tasks.push(stdout_task);
                tasks.push(stderr_task);
            }
        });

        (connection, incoming_rx)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpProtocolError> {
        self.ensure_open().await?;
        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::SeqCst);
        let correlation_id = request_id.to_string();
        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        let (responder, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(
            correlation_id.clone(),
            PendingRequest {
                method: method.to_owned(),
                responder,
            },
        );
        if self
            .inner
            .writer
            .send(WriterMessage::Json(payload))
            .is_err()
        {
            self.inner.pending.lock().await.remove(&correlation_id);
            return Err(AcpProtocolError::Closed {
                reason: self.close_reason().await,
            });
        }
        receiver.await.unwrap_or_else(|_| {
            Err(AcpProtocolError::Closed {
                reason: "response waiter dropped".to_owned(),
            })
        })
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), AcpProtocolError> {
        self.ensure_open().await?;
        self.inner
            .writer
            .send(WriterMessage::Json(json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            })))
            .map_err(|_| AcpProtocolError::Closed {
                reason: "writer dropped".to_owned(),
            })
    }

    pub async fn respond(&self, wire_id: Value, result: Value) -> Result<(), AcpProtocolError> {
        self.ensure_open().await?;
        self.inner
            .writer
            .send(WriterMessage::Json(json!({
                "jsonrpc": "2.0",
                "id": wire_id,
                "result": result,
            })))
            .map_err(|_| AcpProtocolError::Closed {
                reason: "writer dropped".to_owned(),
            })
    }

    pub async fn respond_error(
        &self,
        wire_id: Value,
        error: JsonRpcErrorShape,
    ) -> Result<(), AcpProtocolError> {
        self.ensure_open().await?;
        self.inner
            .writer
            .send(WriterMessage::Json(json!({
                "jsonrpc": "2.0",
                "id": wire_id,
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "data": error.data,
                },
            })))
            .map_err(|_| AcpProtocolError::Closed {
                reason: "writer dropped".to_owned(),
            })
    }
    async fn ensure_open(&self) -> Result<(), AcpProtocolError> {
        if self.inner.closed.load(Ordering::SeqCst) {
            Err(AcpProtocolError::Closed {
                reason: self.close_reason().await,
            })
        } else {
            Ok(())
        }
    }

    async fn close_reason(&self) -> String {
        self.inner
            .close_reason
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "closed".to_owned())
    }
}

async fn read_stdout_loop<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
    inner: &Arc<Inner>,
    incoming: &mpsc::UnboundedSender<IncomingEvent>,
) -> Result<(), AcpProtocolError> {
    loop {
        let Some(line) = read_bounded_line(reader, max_bytes, "stdout").await? else {
            return Err(AcpProtocolError::Closed {
                reason: "stdout ended".to_owned(),
            });
        };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value =
            serde_json::from_str(&line).map_err(|error| AcpProtocolError::InvalidMessage {
                message: error.to_string(),
            })?;
        route_stdout_message(message, inner, incoming).await?;
    }
}

async fn route_stdout_message(
    message: Value,
    inner: &Arc<Inner>,
    incoming: &mpsc::UnboundedSender<IncomingEvent>,
) -> Result<(), AcpProtocolError> {
    let object = message
        .as_object()
        .ok_or_else(|| AcpProtocolError::InvalidMessage {
            message: "JSON-RPC payload must be an object".to_owned(),
        })?;
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if let Some(wire_id) = object.get("id") {
            incoming
                .send(IncomingEvent::Request {
                    correlation_id: normalize_request_id(wire_id)?,
                    wire_id: wire_id.clone(),
                    method: method.to_owned(),
                    params: object.get("params").cloned().unwrap_or(Value::Null),
                })
                .map_err(|_| AcpProtocolError::Closed {
                    reason: "incoming receiver dropped".to_owned(),
                })?;
            return Ok(());
        }
        incoming
            .send(IncomingEvent::Notification {
                method: method.to_owned(),
                params: object.get("params").cloned().unwrap_or(Value::Null),
            })
            .map_err(|_| AcpProtocolError::Closed {
                reason: "incoming receiver dropped".to_owned(),
            })?;
        return Ok(());
    }

    if let Some(wire_id) = object.get("id") {
        let correlation_id = normalize_request_id(wire_id)?;
        let pending = inner.pending.lock().await.remove(&correlation_id);
        let Some(pending) = pending else {
            return Err(AcpProtocolError::UnknownResponse {
                request_id: correlation_id,
            });
        };
        if let Some(error) = object.get("error") {
            let shape: JsonRpcErrorShape =
                serde_json::from_value(error.clone()).map_err(|decode_error| {
                    AcpProtocolError::InvalidMessage {
                        message: decode_error.to_string(),
                    }
                })?;
            let _ = pending.responder.send(Err(AcpProtocolError::RemoteRequest {
                method: pending.method,
                request_id: correlation_id,
                code: shape.code,
                message: shape.message,
                data: shape.data,
            }));
            return Ok(());
        }
        let _ = pending
            .responder
            .send(Ok(object.get("result").cloned().unwrap_or(Value::Null)));
        return Ok(());
    }

    Err(AcpProtocolError::InvalidMessage {
        message: "message was neither request, notification, nor response".to_owned(),
    })
}

async fn read_stderr_loop<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
    incoming: &mpsc::UnboundedSender<IncomingEvent>,
) -> Result<(), AcpProtocolError> {
    while let Some(line) = read_bounded_or_truncated_line(reader, max_bytes).await? {
        if line.trim().is_empty() {
            continue;
        }
        incoming
            .send(IncomingEvent::Stderr { message: line })
            .map_err(|_| AcpProtocolError::Closed {
                reason: "incoming receiver dropped".to_owned(),
            })?;
    }
    Ok(())
}

async fn read_bounded_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
    stream: &'static str,
) -> Result<Option<String>, AcpProtocolError> {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        let read = reader
            .read(&mut byte)
            .await
            .map_err(|error| AcpProtocolError::ReadFailure {
                stream,
                message: error.to_string(),
            })?;
        if read == 0 {
            if bytes.is_empty() {
                return Ok(None);
            }
            return Ok(Some(trim_newline(bytes)));
        }
        if byte[0] == b'\n' {
            return Ok(Some(trim_newline(bytes)));
        }
        if bytes.len() >= max_bytes {
            return Err(AcpProtocolError::LineTooLong {
                stream,
                maximum: max_bytes,
            });
        }
        bytes.push(byte[0]);
    }
}

async fn read_bounded_or_truncated_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
) -> Result<Option<String>, AcpProtocolError> {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    let mut truncated = false;
    loop {
        let read = reader
            .read(&mut byte)
            .await
            .map_err(|error| AcpProtocolError::ReadFailure {
                stream: "stderr",
                message: error.to_string(),
            })?;
        if read == 0 {
            if bytes.is_empty() && !truncated {
                return Ok(None);
            }
            let mut message = trim_newline(bytes);
            if truncated {
                message.push_str(" [truncated]");
            }
            return Ok(Some(message));
        }
        if byte[0] == b'\n' {
            let mut message = trim_newline(bytes);
            if truncated {
                message.push_str(" [truncated]");
            }
            return Ok(Some(message));
        }
        if bytes.len() < max_bytes {
            bytes.push(byte[0]);
        } else {
            truncated = true;
        }
    }
}

async fn fail_connection(
    inner: &Arc<Inner>,
    incoming: &mpsc::UnboundedSender<IncomingEvent>,
    error: AcpProtocolError,
) {
    let reason = error.to_string();
    if inner.closed.swap(true, Ordering::SeqCst) {
        return;
    }
    *inner.close_reason.lock().await = Some(reason.clone());
    let mut pending = inner.pending.lock().await;
    for (_, request) in pending.drain() {
        let _ = request.responder.send(Err(AcpProtocolError::Closed {
            reason: reason.clone(),
        }));
    }
    let _ = incoming.send(IncomingEvent::Closed { reason });
}

fn normalize_request_id(value: &Value) -> Result<String, AcpProtocolError> {
    match value {
        Value::String(string) => Ok(string.clone()),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(AcpProtocolError::InvalidMessage {
            message: "JSON-RPC id must be a string or number".to_owned(),
        }),
    }
}

fn trim_newline(bytes: Vec<u8>) -> String {
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if text.ends_with('\r') {
        text.pop();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadBuf, duplex};

    struct FailingReader;

    impl AsyncRead for FailingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            _buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::other("intentional read failure")))
        }
    }

    fn connection_with_writer(
        writer: mpsc::UnboundedSender<WriterMessage>,
    ) -> (AcpJsonRpcConnection, Arc<Inner>) {
        let inner = Arc::new(Inner {
            writer,
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
            next_request_id: AtomicU64::new(1),
            tasks: Mutex::new(Vec::new()),
        });
        (
            AcpJsonRpcConnection {
                inner: inner.clone(),
            },
            inner,
        )
    }

    #[tokio::test]
    async fn outbound_notifications_and_responses_use_acp_json_rpc_shapes() {
        let (stdout, stdout_peer) = duplex(4096);
        let (stdin_peer, stdin) = duplex(4096);
        let (stderr, _stderr_peer) = duplex(4096);
        let (connection, mut incoming) =
            AcpJsonRpcConnection::spawn(stdout, stdin, stderr, AcpConnectionConfig::default());
        let mut output = BufReader::new(stdin_peer).lines();

        connection
            .notify("session/update", json!({"status":"ready"}))
            .await
            .expect("notification should write");
        assert_eq!(
            serde_json::from_str::<Value>(
                &output
                    .next_line()
                    .await
                    .unwrap()
                    .expect("notification line"),
            )
            .unwrap(),
            json!({
                "jsonrpc":"2.0",
                "method":"session/update",
                "params":{"status":"ready"}
            }),
        );

        connection
            .respond(json!("request-1"), json!({"accepted":true}))
            .await
            .expect("response should write");
        assert_eq!(
            serde_json::from_str::<Value>(
                &output.next_line().await.unwrap().expect("response line"),
            )
            .unwrap(),
            json!({"jsonrpc":"2.0","id":"request-1","result":{"accepted":true}}),
        );

        connection
            .respond_error(
                json!(2),
                JsonRpcErrorShape {
                    code: -32000,
                    message: "denied".to_owned(),
                    data: Some(json!({"retry":false})),
                },
            )
            .await
            .expect("error response should write");
        assert_eq!(
            serde_json::from_str::<Value>(
                &output
                    .next_line()
                    .await
                    .unwrap()
                    .expect("error response line"),
            )
            .unwrap(),
            json!({
                "jsonrpc":"2.0",
                "id":2,
                "error":{"code":-32000,"message":"denied","data":{"retry":false}}
            }),
        );

        drop(stdout_peer);
        let closed = incoming.recv().await.expect("closed event");
        assert!(matches!(closed, IncomingEvent::Closed { .. }));
        assert!(matches!(
            connection.notify("after-close", Value::Null).await,
            Err(AcpProtocolError::Closed { reason }) if reason.contains("stdout ended")
        ));
    }

    #[tokio::test]
    async fn inbound_routing_and_stream_bounds_cover_acp_failure_contracts() {
        let (writer, _writer_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            writer,
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
            next_request_id: AtomicU64::new(1),
            tasks: Mutex::new(Vec::new()),
        });
        let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel();

        route_stdout_message(
            json!({"method":"session/update","params":{"ready":true}}),
            &inner,
            &incoming_tx,
        )
        .await
        .expect("notification should route");
        assert!(matches!(
            incoming_rx.recv().await,
            Some(IncomingEvent::Notification { method, params })
                if method == "session/update" && params == json!({"ready":true})
        ));

        route_stdout_message(
            json!({"id":"request-1","method":"approve"}),
            &inner,
            &incoming_tx,
        )
        .await
        .expect("request should route");
        assert!(matches!(
            incoming_rx.recv().await,
            Some(IncomingEvent::Request { correlation_id, wire_id, method, params })
                if correlation_id == "request-1"
                    && wire_id == json!("request-1")
                    && method == "approve"
                    && params == Value::Null
        ));

        let (success_tx, success_rx) = oneshot::channel();
        inner.pending.lock().await.insert(
            "2".to_owned(),
            PendingRequest {
                method: "success".to_owned(),
                responder: success_tx,
            },
        );
        route_stdout_message(json!({"id":2,"result":{"ok":true}}), &inner, &incoming_tx)
            .await
            .expect("success response should route");
        assert_eq!(success_rx.await.unwrap().unwrap(), json!({"ok":true}));

        let (error_tx, error_rx) = oneshot::channel();
        inner.pending.lock().await.insert(
            "3".to_owned(),
            PendingRequest {
                method: "failure".to_owned(),
                responder: error_tx,
            },
        );
        route_stdout_message(
            json!({"id":3,"error":{"code":-1,"message":"denied","data":{"retry":false}}}),
            &inner,
            &incoming_tx,
        )
        .await
        .expect("remote error should route");
        assert!(matches!(
            error_rx.await.unwrap(),
            Err(AcpProtocolError::RemoteRequest { method, request_id, code: -1, message, data })
                if method == "failure"
                    && request_id == "3"
                    && message == "denied"
                    && data == Some(json!({"retry":false}))
        ));

        assert!(matches!(
            route_stdout_message(json!({"id":404}), &inner, &incoming_tx).await,
            Err(AcpProtocolError::UnknownResponse { request_id }) if request_id == "404"
        ));
        assert!(matches!(
            route_stdout_message(json!({"id":true,"method":"invalid"}), &inner, &incoming_tx).await,
            Err(AcpProtocolError::InvalidMessage { .. })
        ));
        assert!(matches!(
            route_stdout_message(json!({"unexpected":true}), &inner, &incoming_tx).await,
            Err(AcpProtocolError::InvalidMessage { .. })
        ));
        assert!(matches!(
            route_stdout_message(json!(["not-an-object"]), &inner, &incoming_tx).await,
            Err(AcpProtocolError::InvalidMessage { .. })
        ));

        drop(incoming_rx);
        assert!(matches!(
            route_stdout_message(json!({"method":"dropped"}), &inner, &incoming_tx).await,
            Err(AcpProtocolError::Closed { reason }) if reason == "incoming receiver dropped"
        ));

        let (reader, mut peer) = duplex(64);
        peer.write_all(b"abcd\r\n").await.unwrap();
        peer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_bounded_line(&mut reader, 8, "stdout").await.unwrap(),
            Some("abcd".to_owned())
        );
        assert_eq!(
            read_bounded_line(&mut reader, 8, "stdout").await.unwrap(),
            None
        );

        let (reader, mut peer) = duplex(64);
        peer.write_all(b"abcdef\n").await.unwrap();
        peer.shutdown().await.unwrap();
        let mut reader = BufReader::new(reader);
        assert_eq!(
            read_bounded_or_truncated_line(&mut reader, 3)
                .await
                .unwrap(),
            Some("abc [truncated]".to_owned())
        );

        let (reader, mut peer) = duplex(64);
        peer.write_all(b"toolong\n").await.unwrap();
        let mut reader = BufReader::new(reader);
        assert!(matches!(
            read_bounded_line(&mut reader, 3, "stdout").await,
            Err(AcpProtocolError::LineTooLong {
                stream: "stdout",
                maximum: 3
            })
        ));
    }

    #[tokio::test]
    async fn dropped_writer_waiter_and_receivers_report_protocol_errors() {
        let (writer, writer_rx) = mpsc::unbounded_channel();
        drop(writer_rx);
        let (connection, _inner) = connection_with_writer(writer);
        for result in [
            connection.notify("notify", Value::Null).await,
            connection.respond(json!(1), Value::Null).await,
            connection
                .respond_error(
                    json!(2),
                    JsonRpcErrorShape {
                        code: -1,
                        message: "failure".to_owned(),
                        data: None,
                    },
                )
                .await,
        ] {
            assert!(matches!(result, Err(AcpProtocolError::Closed { .. })));
        }

        let (writer, mut writer_rx) = mpsc::unbounded_channel();
        let (connection, inner) = connection_with_writer(writer);
        let request = tokio::spawn(async move { connection.request("wait", Value::Null).await });
        assert!(matches!(
            writer_rx.recv().await,
            Some(WriterMessage::Json(_))
        ));
        drop(
            inner
                .pending
                .lock()
                .await
                .remove("1")
                .expect("pending request"),
        );
        assert!(matches!(
            request.await.expect("request task"),
            Err(AcpProtocolError::Closed { reason }) if reason == "response waiter dropped"
        ));

        let (writer, _writer_rx) = mpsc::unbounded_channel();
        let (connection, inner) = connection_with_writer(writer);
        inner.closed.store(true, Ordering::SeqCst);
        assert!(matches!(
            connection.notify("closed", Value::Null).await,
            Err(AcpProtocolError::Closed { reason }) if reason == "closed"
        ));

        let (incoming, incoming_rx) = mpsc::unbounded_channel();
        drop(incoming_rx);
        assert!(matches!(
            route_stdout_message(
                json!({"id":"request","method":"approval"}),
                &inner,
                &incoming,
            )
            .await,
            Err(AcpProtocolError::Closed { reason }) if reason == "incoming receiver dropped"
        ));

        let (error_tx, _error_rx) = oneshot::channel();
        inner.pending.lock().await.insert(
            "2".to_owned(),
            PendingRequest {
                method: "failure".to_owned(),
                responder: error_tx,
            },
        );
        assert!(matches!(
            route_stdout_message(
                json!({"id":2,"error":{"code":"invalid"}}),
                &inner,
                &incoming,
            )
            .await,
            Err(AcpProtocolError::InvalidMessage { .. })
        ));

        let (stderr, mut peer) = duplex(64);
        peer.write_all(b"warning\n").await.unwrap();
        let mut stderr = BufReader::new(stderr);
        assert!(matches!(
            read_stderr_loop(&mut stderr, 64, &incoming).await,
            Err(AcpProtocolError::Closed { reason }) if reason == "incoming receiver dropped"
        ));
    }

    #[tokio::test]
    async fn failing_readers_identify_acp_streams() {
        let mut stdout = BufReader::new(FailingReader);
        assert!(matches!(
            read_bounded_line(&mut stdout, 64, "stdout").await,
            Err(AcpProtocolError::ReadFailure {
                stream: "stdout",
                ..
            })
        ));

        let mut stderr = BufReader::new(FailingReader);
        assert!(matches!(
            read_bounded_or_truncated_line(&mut stderr, 64).await,
            Err(AcpProtocolError::ReadFailure {
                stream: "stderr",
                ..
            })
        ));
    }
}
