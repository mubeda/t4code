use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{FromRef, State, WebSocketUpgrade},
    http::{
        HeaderMap, Method, StatusCode, Uri,
        header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HOST, LOCATION},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::fs::File;
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{
    auth,
    config::{ServerConfig, ServerMode},
    production::http_routes::{self, HttpRoutesState},
    rpc::{RpcRegistry, RpcSessionContext, run_session},
};

pub const DESKTOP_SHUTDOWN_PATH: &str = "/.well-known/t4code/desktop/shutdown";
pub const DESKTOP_SHUTDOWN_TOKEN_HEADER: &str = "x-t4code-desktop-bootstrap-token";

const CONTENT_SECURITY_POLICY_VALUE: &str = "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const HTML_CACHE_CONTROL: &str = "no-cache";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteMethod {
    Delete,
    Get,
    Post,
}

impl RouteMethod {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RouteSpec {
    pub method: &'static str,
    pub path: &'static str,
}

const fn route(method: RouteMethod, path: &'static str) -> RouteSpec {
    RouteSpec {
        method: method.as_str(),
        path,
    }
}

pub const ROUTE_INVENTORY: &[RouteSpec] = &[
    route(RouteMethod::Get, "/.well-known/t4code/environment"),
    route(RouteMethod::Get, "/api/auth/session"),
    route(RouteMethod::Post, "/api/auth/browser-session"),
    route(RouteMethod::Post, "/oauth/token"),
    route(RouteMethod::Post, "/api/auth/websocket-ticket"),
    route(RouteMethod::Post, "/api/auth/pairing-token"),
    route(RouteMethod::Get, "/api/auth/pairing-links"),
    route(RouteMethod::Post, "/api/auth/pairing-links/revoke"),
    route(RouteMethod::Get, "/api/auth/clients"),
    route(RouteMethod::Post, "/api/auth/clients/revoke"),
    route(RouteMethod::Post, "/api/auth/clients/revoke-others"),
    route(RouteMethod::Get, "/api/orchestration/snapshot"),
    route(RouteMethod::Post, "/api/orchestration/dispatch"),
    route(RouteMethod::Post, "/api/connect/link-proof"),
    route(RouteMethod::Post, "/api/connect/relay-config"),
    route(RouteMethod::Get, "/api/connect/link-state"),
    route(RouteMethod::Post, "/api/connect/unlink"),
    route(RouteMethod::Post, "/api/t4code-connect/health"),
    route(RouteMethod::Post, "/api/connect/mint-credential"),
    route(RouteMethod::Post, "/api/t4code-connect/mint-credential"),
    route(RouteMethod::Get, "/ws"),
    route(RouteMethod::Post, "/api/observability/v1/traces"),
    route(RouteMethod::Post, "/api/diagnostics/logs.zip"),
    route(RouteMethod::Get, "/api/assets/*"),
    route(RouteMethod::Post, DESKTOP_SHUTDOWN_PATH),
    route(RouteMethod::Post, "/mcp"),
    route(RouteMethod::Delete, "/mcp"),
    route(RouteMethod::Get, "*"),
];

#[derive(Clone)]
pub(crate) struct AppState {
    pub config: Arc<ServerConfig>,
    pub shutdown: CancellationToken,
    pub rpc_registry: RpcRegistry,
    pub auth: auth::AuthService,
    pub http_routes: HttpRoutesState,
}

impl FromRef<AppState> for HttpRoutesState {
    fn from_ref(state: &AppState) -> Self {
        state.http_routes.clone()
    }
}

pub(crate) fn build_router(state: AppState) -> Router {
    let cors = cors_layer(&state.config);
    let router = http_routes::add_routes(auth::add_routes(Router::<AppState>::new()));
    router
        .route(
            "/.well-known/t4code/environment",
            get(environment_descriptor),
        )
        .route(DESKTOP_SHUTDOWN_PATH, post(desktop_shutdown))
        .route("/ws", get(websocket))
        .fallback(static_or_dev)
        .layer(cors)
        .with_state(state)
}

fn cors_layer(config: &ServerConfig) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static("b3"),
            axum::http::HeaderName::from_static("traceparent"),
            axum::http::HeaderName::from_static("dpop"),
        ])
        .max_age(std::time::Duration::from_secs(600));
    let Some(dev_url) = &config.dev_url else {
        return layer.allow_origin(Any);
    };
    let mut origins = Vec::new();
    if let Ok(origin) = dev_url.origin().ascii_serialization().parse() {
        origins.push(origin);
    }
    for origin in ["t4code://app", "t4code-dev://app"] {
        if let Ok(origin) = origin.parse() {
            origins.push(origin);
        }
    }
    layer
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    let session_shutdown = state.shutdown.child_token();
    if state.config.unsafe_no_auth {
        return upgrade
            .on_upgrade(move |socket| {
                run_session(
                    socket,
                    state.rpc_registry,
                    RpcSessionContext::unauthenticated(),
                    session_shutdown,
                )
            })
            .into_response();
    }
    match auth::authenticate_websocket(&state.auth, &headers, &uri).await {
        Ok(principal) => {
            let auth = state.auth.clone();
            let session_id = principal.session_id.clone();
            let expires_at_ms = principal.expires_at_ms;
            let rpc_context = RpcSessionContext::authenticated(principal, auth.clone());
            auth.mark_connected(&session_id).await;
            upgrade
                .on_upgrade(move |socket| async move {
                    let expiration_shutdown = session_shutdown.clone();
                    let expiration_guard = tokio::spawn(async move {
                        let remaining_ms = expires_at_ms.saturating_sub(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .ok()
                                .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                                .unwrap_or(i64::MAX),
                        );
                        tokio::select! {
                            () = expiration_shutdown.cancelled() => {}
                            () = tokio::time::sleep(std::time::Duration::from_millis(
                                u64::try_from(remaining_ms.max(0)).unwrap_or_default(),
                            )) => expiration_shutdown.cancel(),
                        }
                    });
                    run_session(
                        socket,
                        state.rpc_registry,
                        rpc_context,
                        session_shutdown.clone(),
                    )
                    .await;
                    session_shutdown.cancel();
                    let _ = expiration_guard.await;
                    auth.mark_disconnected(&session_id).await;
                })
                .into_response()
        }
        Err(error) => auth::auth_error_response(error),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentDescriptor {
    environment_id: String,
    label: String,
    platform: PlatformDescriptor,
    server_version: String,
    capabilities: EnvironmentCapabilities,
}

#[derive(Serialize)]
struct PlatformDescriptor {
    os: &'static str,
    arch: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentCapabilities {
    repository_identity: bool,
}

async fn environment_descriptor(State(state): State<AppState>) -> Json<EnvironmentDescriptor> {
    let config = state.config;
    Json(EnvironmentDescriptor {
        environment_id: config.environment_id.clone(),
        label: config.environment_label.clone(),
        platform: PlatformDescriptor {
            os: platform_os(),
            arch: platform_arch(),
        },
        server_version: config.server_version.clone(),
        capabilities: EnvironmentCapabilities {
            repository_identity: true,
        },
    })
}

async fn desktop_shutdown(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if state.config.mode != ServerMode::Desktop || state.config.desktop_bootstrap_token.is_none() {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }
    let supplied_token = headers
        .get(DESKTOP_SHUTDOWN_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if !token_matches(
        state.config.desktop_bootstrap_token.as_deref(),
        supplied_token,
    ) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    state.shutdown.cancel();
    (
        StatusCode::ACCEPTED,
        [(CACHE_CONTROL, "no-store")],
        Json(json!({ "shuttingDown": true })),
    )
        .into_response()
}

fn token_matches(expected: Option<&str>, supplied: Option<&str>) -> bool {
    let (Some(expected), Some(supplied)) = (expected, supplied) else {
        return false;
    };
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

async fn static_or_dev(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    if let Some(dev_url) = &state.config.dev_url
        && request_is_loopback(&headers)
    {
        let mut redirect = dev_url.clone();
        redirect.set_path(uri.path());
        redirect.set_query(uri.query());
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(LOCATION, redirect.as_str())
            .body(Body::empty())
            .unwrap_or_else(|_| internal_server_error());
    }

    let Some(static_dir) = &state.config.static_dir else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "No static directory configured and no dev URL set.",
        )
            .into_response();
    };
    serve_static(static_dir, uri.path()).await
}

async fn serve_static(static_dir: &Path, request_path: &str) -> Response {
    let relative = match safe_relative_path(request_path) {
        Ok(path) => path,
        Err(()) => return (StatusCode::BAD_REQUEST, "Invalid static file path").into_response(),
    };
    let root = match tokio::fs::canonicalize(static_dir).await {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
    };

    let mut candidate = root.join(relative);
    if candidate.extension().is_none() {
        candidate.push("index.html");
    }
    let candidate = match canonical_file_within(&root, &candidate).await {
        Some(path) => path,
        None => match canonical_file_within(&root, &root.join("index.html")).await {
            Some(path) => path,
            None => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
        },
    };
    stream_file(candidate).await
}

fn safe_relative_path(request_path: &str) -> Result<PathBuf, ()> {
    let decoded = percent_decode_str(request_path)
        .decode_utf8()
        .map_err(|_| ())?;
    let normalized = decoded.replace('\\', "/");
    let relative = normalized.trim_start_matches('/');
    if relative.contains('\0') || relative.starts_with("..") {
        return Err(());
    }

    let path = if relative.is_empty() {
        Path::new("index.html")
    } else {
        Path::new(relative)
    };
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(());
    }
    Ok(path.to_path_buf())
}

async fn canonical_file_within(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let canonical = tokio::fs::canonicalize(candidate).await.ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let metadata = tokio::fs::metadata(&canonical).await.ok()?;
    metadata.is_file().then_some(canonical)
}

async fn stream_file(path: PathBuf) -> Response {
    let file = match File::open(&path).await {
        Ok(file) => file,
        Err(_) => return internal_server_error(),
    };
    let length = match file.metadata().await {
        Ok(metadata) => metadata.len(),
        Err(_) => return internal_server_error(),
    };
    let content_type = mime_guess::from_path(&path).first_or_octet_stream();
    let cache_control = if content_type.type_() == mime_guess::mime::TEXT
        && content_type.subtype() == mime_guess::mime::HTML
    {
        HTML_CACHE_CONTROL
    } else {
        IMMUTABLE_CACHE_CONTROL
    };
    let body = Body::from_stream(ReaderStream::new(file));

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type.as_ref())
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, cache_control)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", CONTENT_SECURITY_POLICY_VALUE)
        .body(body)
        .unwrap_or_else(|_| internal_server_error())
}

fn request_is_loopback(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    if host == "localhost" || host.starts_with("localhost:") {
        return true;
    }
    let without_port = host
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(address, _)| address))
        .or_else(|| host.split_once(':').map(|(address, _)| address))
        .unwrap_or(&host);
    without_port.parse::<IpAddr>().is_ok_and(|address| {
        address == IpAddr::V4(Ipv4Addr::LOCALHOST) || address == IpAddr::V6(Ipv6Addr::LOCALHOST)
    })
}

fn platform_os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        _ => "unknown",
    }
}

fn platform_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    }
}

fn internal_server_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}
