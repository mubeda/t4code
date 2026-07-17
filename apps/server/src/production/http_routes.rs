use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{FromRef, Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_DIAGNOSTIC_BODY_BYTES: usize = 512 * 1024;
pub const MAX_TRACE_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MCP_BODY_BYTES: usize = 4 * 1024 * 1024;

const NO_STORE: &str = "no-store";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub type AuthorizeHandler = Arc<
    dyn Fn(
            HeaderMap,
            Method,
            Uri,
            Option<&'static str>,
            CancellationToken,
        ) -> BoxFuture<Result<(), Response>>
        + Send
        + Sync,
>;
pub type JsonHandler = Arc<
    dyn Fn(
            JsonOperation,
            Option<Value>,
            RouteContext,
        ) -> BoxFuture<Result<JsonRouteResponse, HttpRouteError>>
        + Send
        + Sync,
>;
pub type AssetHandler = Arc<
    dyn Fn(String, String, RouteContext) -> BoxFuture<Result<AssetHttpResponse, HttpRouteError>>
        + Send
        + Sync,
>;
pub type DiagnosticLogsHandler = Arc<
    dyn Fn(String, RouteContext) -> BoxFuture<Result<DiagnosticLogsHttpResponse, HttpRouteError>>
        + Send
        + Sync,
>;
pub type McpHandler = Arc<
    dyn Fn(Method, Vec<u8>, RouteContext) -> BoxFuture<Result<McpHttpResponse, HttpRouteError>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct HttpRoutesState {
    pub authorize: AuthorizeHandler,
    pub json: JsonHandler,
    pub diagnostic_logs: DiagnosticLogsHandler,
    pub assets: AssetHandler,
    pub mcp: McpHandler,
}

impl HttpRoutesState {
    #[must_use]
    pub fn new(
        authorize: AuthorizeHandler,
        json: JsonHandler,
        diagnostic_logs: DiagnosticLogsHandler,
        assets: AssetHandler,
        mcp: McpHandler,
    ) -> Self {
        Self {
            authorize,
            json,
            diagnostic_logs,
            assets,
            mcp,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JsonOperation {
    OrchestrationSnapshot,
    OrchestrationDispatch,
    ConnectLinkProof,
    ConnectRelayConfig,
    ConnectLinkState,
    ConnectUnlink,
    ConnectHealth,
    ConnectMintCredential,
    ObservabilityTraces,
}

impl JsonOperation {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OrchestrationSnapshot => "orchestration.snapshot",
            Self::OrchestrationDispatch => "orchestration.dispatch",
            Self::ConnectLinkProof => "connect.linkProof",
            Self::ConnectRelayConfig => "connect.relayConfig",
            Self::ConnectLinkState => "connect.linkState",
            Self::ConnectUnlink => "connect.unlink",
            Self::ConnectHealth => "connect.health",
            Self::ConnectMintCredential => "connect.mintCredential",
            Self::ObservabilityTraces => "observability.traces",
        }
    }
}

#[derive(Clone)]
pub struct RouteContext {
    pub headers: HeaderMap,
    pub uri: Uri,
    pub cancellation: CancellationToken,
}

pub struct JsonRouteResponse {
    pub status: StatusCode,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
}

impl JsonRouteResponse {
    #[must_use]
    pub fn ok(body: Value) -> Self {
        Self {
            status: StatusCode::OK,
            headers: BTreeMap::new(),
            body,
        }
    }
}

pub struct AssetHttpResponse {
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub cache_control: String,
}

pub struct DiagnosticLogsHttpResponse {
    pub filename: String,
    pub bytes: Vec<u8>,
}

pub struct McpHttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub struct HttpRouteError {
    status: StatusCode,
    body: Value,
    headers: BTreeMap<String, String>,
}

impl HttpRouteError {
    #[must_use]
    pub fn new(status: StatusCode, body: Value) -> Self {
        Self {
            status,
            body,
            headers: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    fn into_response(self) -> Response {
        json_response(self.status, self.headers, self.body)
    }
}

pub fn add_routes<S>(router: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    HttpRoutesState: FromRef<S>,
{
    router
        .route("/api/orchestration/snapshot", get(orchestration_snapshot))
        .route("/api/orchestration/dispatch", post(orchestration_dispatch))
        .route("/api/connect/link-proof", post(connect_link_proof))
        .route("/api/connect/relay-config", post(connect_relay_config))
        .route("/api/connect/link-state", get(connect_link_state))
        .route("/api/connect/unlink", post(connect_unlink))
        .route("/api/t4code-connect/health", post(connect_health))
        .route(
            "/api/connect/mint-credential",
            post(connect_mint_credential),
        )
        .route(
            "/api/t4code-connect/mint-credential",
            post(connect_mint_credential),
        )
        .route("/api/observability/v1/traces", post(observability_traces))
        .route("/api/diagnostics/logs.zip", post(diagnostic_logs))
        .route("/api/assets/{token}/{*path}", get(asset))
        .route("/mcp", post(mcp_post).delete(mcp_delete))
}

async fn orchestration_snapshot(
    State(state): State<HttpRoutesState>,
    request: Request,
) -> Response {
    json_request(
        state,
        request,
        JsonOperation::OrchestrationSnapshot,
        Some("orchestration:read"),
        BodyKind::None,
    )
    .await
}

async fn orchestration_dispatch(
    State(state): State<HttpRoutesState>,
    request: Request,
) -> Response {
    json_request(
        state,
        request,
        JsonOperation::OrchestrationDispatch,
        Some("orchestration:operate"),
        BodyKind::Json(MAX_JSON_BODY_BYTES),
    )
    .await
}

async fn connect_link_proof(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectLinkProof,
        Some("relay:write"),
        BodyKind::Json(MAX_JSON_BODY_BYTES),
    )
    .await
}

async fn connect_relay_config(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectRelayConfig,
        Some("relay:write"),
        BodyKind::Json(MAX_JSON_BODY_BYTES),
    )
    .await
}

async fn connect_link_state(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectLinkState,
        Some("relay:read"),
        BodyKind::None,
    )
    .await
}

async fn connect_unlink(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectUnlink,
        Some("relay:write"),
        BodyKind::None,
    )
    .await
}

async fn connect_health(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectHealth,
        None,
        BodyKind::Json(MAX_JSON_BODY_BYTES),
    )
    .await
}

async fn connect_mint_credential(
    State(state): State<HttpRoutesState>,
    request: Request,
) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ConnectMintCredential,
        None,
        BodyKind::Json(MAX_JSON_BODY_BYTES),
    )
    .await
}

async fn observability_traces(State(state): State<HttpRoutesState>, request: Request) -> Response {
    json_request(
        state,
        request,
        JsonOperation::ObservabilityTraces,
        Some("orchestration:operate"),
        BodyKind::Json(MAX_TRACE_BODY_BYTES),
    )
    .await
}

async fn diagnostic_logs(State(state): State<HttpRoutesState>, request: Request) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, body) = request.into_parts();
    if let Err(response) = (state.authorize)(
        parts.headers.clone(),
        parts.method.clone(),
        parts.uri.clone(),
        Some("orchestration:read"),
        cancellation.clone(),
    )
    .await
    {
        return response;
    }
    let payload = match bounded_json(body, MAX_DIAGNOSTIC_BODY_BYTES).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let Some(frontend_log) = payload.get("frontendLog").and_then(Value::as_str) else {
        return bad_request("Request body must contain a frontendLog string.");
    };
    let context = RouteContext {
        headers: parts.headers,
        uri: parts.uri,
        cancellation,
    };
    match (state.diagnostic_logs)(frontend_log.to_owned(), context).await {
        Ok(response) => diagnostic_logs_response(response),
        Err(error) => error.into_response(),
    }
}

enum BodyKind {
    None,
    Json(usize),
}

async fn json_request(
    state: HttpRoutesState,
    request: Request,
    operation: JsonOperation,
    required_scope: Option<&'static str>,
    body_kind: BodyKind,
) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, body) = request.into_parts();
    if let Err(response) = (state.authorize)(
        parts.headers.clone(),
        parts.method.clone(),
        parts.uri.clone(),
        required_scope,
        cancellation.clone(),
    )
    .await
    {
        return response;
    }
    let payload = match body_kind {
        BodyKind::None => None,
        BodyKind::Json(limit) => match bounded_json(body, limit).await {
            Ok(payload) => Some(payload),
            Err(response) => return response,
        },
    };
    let context = RouteContext {
        headers: parts.headers,
        uri: parts.uri,
        cancellation,
    };
    match (state.json)(operation, payload, context).await {
        Ok(response) => json_response(response.status, response.headers, response.body),
        Err(error) => error.into_response(),
    }
}

async fn asset(
    State(state): State<HttpRoutesState>,
    Path((token, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, _) = request.into_parts();
    let context = RouteContext {
        headers: parts.headers,
        uri: parts.uri,
        cancellation,
    };
    match (state.assets)(token, path, context).await {
        Ok(asset) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, asset.content_type)
            .header(header::CACHE_CONTROL, asset.cache_control)
            .header("x-content-type-options", "nosniff")
            .body(Body::from(asset.bytes))
            .unwrap_or_else(|_| internal_error()),
        Err(error) => error.into_response(),
    }
}

async fn mcp_post(State(state): State<HttpRoutesState>, request: Request) -> Response {
    mcp_request(state, Method::POST, request).await
}

async fn mcp_delete(State(state): State<HttpRoutesState>, request: Request) -> Response {
    mcp_request(state, Method::DELETE, request).await
}

async fn mcp_request(state: HttpRoutesState, method: Method, request: Request) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_MCP_BODY_BYTES).await {
        Ok(body) => body.to_vec(),
        Err(_) => return payload_too_large(),
    };
    let context = RouteContext {
        headers: parts.headers,
        uri: parts.uri,
        cancellation,
    };
    match (state.mcp)(method, body, context).await {
        Ok(response) => mcp_response(response),
        Err(error) => error.into_response(),
    }
}

async fn bounded_json(body: Body, limit: usize) -> Result<Value, Response> {
    let body = to_bytes(body, limit)
        .await
        .map_err(|_| payload_too_large())?;
    serde_json::from_slice(&body).map_err(|_| {
        json_response(
            StatusCode::BAD_REQUEST,
            BTreeMap::new(),
            json!({
                "_tag": "EnvironmentHttpBadRequestError",
                "message": "Request body must be valid JSON."
            }),
        )
    })
}

fn json_response(status: StatusCode, headers: BTreeMap<String, String>, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_STORE));
    append_headers(&mut response, headers);
    response
}

fn mcp_response(response: McpHttpResponse) -> Response {
    let Ok(mut status) = StatusCode::from_u16(response.status) else {
        return internal_error();
    };
    if status == StatusCode::OK && response.body.is_empty() {
        status = StatusCode::ACCEPTED;
    }
    let mut output = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, NO_STORE)
        .body(Body::from(response.body))
        .unwrap_or_else(|_| internal_error());
    append_headers(&mut output, response.headers);
    output
}

fn diagnostic_logs_response(response: DiagnosticLogsHttpResponse) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", response.filename),
        )
        .header(header::CACHE_CONTROL, NO_STORE)
        .header("x-content-type-options", "nosniff")
        .body(Body::from(response.bytes))
        .unwrap_or_else(|_| internal_error())
}

fn append_headers(response: &mut Response, headers: BTreeMap<String, String>) {
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            response.headers_mut().insert(name, value);
        }
    }
}

fn payload_too_large() -> Response {
    json_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        BTreeMap::new(),
        json!({
            "_tag": "EnvironmentHttpBadRequestError",
            "message": "Request body exceeds the configured limit."
        }),
    )
}

fn bad_request(message: &str) -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        BTreeMap::new(),
        json!({
            "_tag": "EnvironmentHttpBadRequestError",
            "message": message,
        }),
    )
}

fn internal_error() -> Response {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        BTreeMap::new(),
        json!({
            "_tag": "EnvironmentHttpInternalServerError",
            "message": "Internal Server Error"
        }),
    )
}

struct CancellationGuard(CancellationToken);

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_error_helpers_preserve_bad_request_and_internal_statuses() {
        assert_eq!(bad_request("invalid").status(), StatusCode::BAD_REQUEST);
        assert_eq!(internal_error().status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(payload_too_large().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
