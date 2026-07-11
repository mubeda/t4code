use std::time::{Duration, UNIX_EPOCH};

use axum::{
    Form, Json, Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use uuid::Uuid;

use super::{
    model::{
        ACCESS_TOKEN_TYPE, BOOTSTRAP_TOKEN_TYPE, BrowserSessionRequest, BrowserSessionResult,
        ClientMetadata, CreatePairingRequest, RevokeClientRequest, RevokePairingRequest,
        SCOPE_ACCESS_READ, SCOPE_ACCESS_WRITE, TOKEN_GRANT_TYPE, TokenExchangeRequest,
        WebSocketTicketResult,
    },
    service::{AuthError, AuthService, default_standard_scopes, format_iso, now_ms, parse_scopes},
};
use crate::http::AppState;

const CREDENTIAL_HEADERS: [(&str, &str); 2] =
    [("cache-control", "no-store"), ("pragma", "no-cache")];

pub(crate) fn add_routes(router: Router<AppState>) -> Router<AppState> {
    router
        .route("/api/auth/session", get(session))
        .route("/api/auth/browser-session", post(browser_session))
        .route("/oauth/token", post(token))
        .route("/api/auth/websocket-ticket", post(websocket_ticket))
        .route("/api/auth/pairing-token", post(pairing_token))
        .route("/api/auth/pairing-links", get(pairing_links))
        .route("/api/auth/pairing-links/revoke", post(revoke_pairing_link))
        .route("/api/auth/clients", get(clients))
        .route("/api/auth/clients/revoke", post(revoke_client))
        .route(
            "/api/auth/clients/revoke-others",
            post(revoke_other_clients),
        )
}

async fn session(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let auth = &state.auth;
    let descriptor = auth.descriptor();
    match authenticate_request(auth, &headers, &uri).await {
        Ok(principal) => Json(json!({
            "authenticated": true,
            "auth": descriptor,
            "scopes": principal.scopes,
            "sessionMethod": principal.method,
            "expiresAt": format_iso(principal.expires_at_ms),
        }))
        .into_response(),
        Err(AuthError::MissingCredential | AuthError::InvalidCredential) => Json(json!({
            "authenticated": false,
            "auth": descriptor,
        }))
        .into_response(),
        Err(error) => HttpAuthError::new(error, "internal_error").into_response(),
    }
}

async fn browser_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BrowserSessionRequest>,
) -> Response {
    let response = match state
        .auth
        .create_browser_session(payload.credential.trim(), client_metadata(&headers, None))
        .await
    {
        Ok(issued) => {
            let expires = UNIX_EPOCH
                + Duration::from_millis(
                    u64::try_from(issued.principal.expires_at_ms).unwrap_or_default(),
                );
            let cookie = format!(
                "{}={}; Path=/; Expires={}; HttpOnly; SameSite=Lax",
                state.auth.cookie_name(),
                issued.token,
                httpdate::fmt_http_date(expires)
            );
            let result = BrowserSessionResult {
                authenticated: true,
                scopes: issued.principal.scopes,
                session_method: issued.principal.method,
                expires_at: format_iso(issued.principal.expires_at_ms),
            };
            let mut response = Json(result).into_response();
            if let Ok(value) = header::HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        Err(error) => HttpAuthError::new(error, "browser_session_issuance_failed").into_response(),
    };
    credential_response(response)
}

async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Form(payload): Form<TokenExchangeRequest>,
) -> Response {
    let uses_dpop = headers.contains_key("dpop");
    let response = token_inner(&state.auth, &headers, &uri, payload)
        .await
        .unwrap_or_else(|error| {
            HttpAuthError::new(error, "access_token_issuance_failed").into_response()
        });
    let response = credential_response(response);
    if uses_dpop {
        dpop_challenge_on_unauthorized(response)
    } else {
        response
    }
}

async fn token_inner(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
    payload: TokenExchangeRequest,
) -> Result<Response, AuthError> {
    if payload.grant_type != TOKEN_GRANT_TYPE
        || payload.subject_token_type != BOOTSTRAP_TOKEN_TYPE
        || payload.requested_token_type != ACCESS_TOKEN_TYPE
        || payload.subject_token.trim().is_empty()
    {
        return Err(AuthError::InvalidCredential);
    }
    let requested_scopes = payload.scope.as_deref().map(parse_scopes).transpose()?;
    if payload
        .client_device_type
        .as_deref()
        .is_some_and(|value| !is_device_type(value))
        || payload
            .client_label
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        || payload
            .client_os
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(AuthError::InvalidScope);
    }
    let presented = ClientMetadata {
        label: non_empty(payload.client_label),
        device_type: payload
            .client_device_type
            .filter(|value| is_device_type(value))
            .unwrap_or_else(|| infer_device_type(headers).to_owned()),
        os: non_empty(payload.client_os).or_else(|| infer_os(headers).map(str::to_owned)),
        ..client_metadata(headers, None)
    };
    let proof_key_thumbprint = match headers.get("dpop") {
        Some(proof) => {
            let proof = proof.to_str().map_err(|_| AuthError::InvalidCredential)?;
            Some(
                auth.verify_dpop(proof, "POST", &request_url(headers, uri)?, None, None)
                    .await?,
            )
        }
        None => None,
    };
    let issued = auth
        .exchange_bootstrap(
            payload.subject_token.trim(),
            requested_scopes,
            presented,
            proof_key_thumbprint,
        )
        .await?;
    let expires_in = ((issued.principal.expires_at_ms - now_ms()) / 1_000).max(0);
    Ok(Json(super::model::AccessTokenResult {
        access_token: issued.token,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: if issued.principal.proof_key_thumbprint.is_some() {
            "DPoP"
        } else {
            "Bearer"
        },
        expires_in,
        scope: issued.principal.scopes.join(" "),
    })
    .into_response())
}

async fn websocket_ticket(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let response = match authenticate_request(&state.auth, &headers, &uri).await {
        Ok(principal) => match state.auth.issue_websocket_ticket(&principal) {
            Ok((ticket, expires_at)) => Json(WebSocketTicketResult {
                ticket,
                expires_at: format_iso(expires_at),
            })
            .into_response(),
            Err(error) => {
                HttpAuthError::new(error, "websocket_ticket_issuance_failed").into_response()
            }
        },
        Err(error) => {
            let response =
                HttpAuthError::new(error, "websocket_ticket_issuance_failed").into_response();
            if request_uses_dpop(&headers) {
                dpop_challenge_on_unauthorized(response)
            } else {
                response
            }
        }
    };
    credential_response(response)
}

async fn pairing_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<CreatePairingRequest>,
) -> Response {
    let result = async {
        let principal = authenticate_request(&state.auth, &headers, &uri).await?;
        require_scope(&principal, SCOPE_ACCESS_WRITE)?;
        if payload
            .label
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(AuthError::InvalidScope);
        }
        let scopes = payload.scopes.unwrap_or_else(default_standard_scopes);
        if scopes.is_empty()
            || scopes
                .iter()
                .any(|scope| !super::model::ALL_SCOPES.contains(&scope.as_str()))
            || scopes
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != scopes.len()
        {
            return Err(AuthError::InvalidScope);
        }
        for scope in &scopes {
            if !principal.has_scope(scope) {
                return Err(AuthError::ScopeRequired(scope.clone()));
            }
        }
        state
            .auth
            .issue_pairing(scopes, non_empty(payload.label))
            .await
    }
    .await;
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "pairing_credential_issuance_failed"),
    }
}

async fn pairing_links(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_READ).await {
        Ok(_) => Json(state.auth.list_pairings().await).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "pairing_links_load_failed"),
    }
}

async fn revoke_pairing_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<RevokePairingRequest>,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(_) => match state.auth.revoke_pairing(&payload.id).await {
            Ok(revoked) => Json(json!({ "revoked": revoked })).into_response(),
            Err(error) => auth_error_for_request(error, &headers, "pairing_link_revoke_failed"),
        },
        Err(error) => auth_error_for_request(error, &headers, "pairing_link_revoke_failed"),
    }
}

async fn clients(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_READ).await {
        Ok(principal) => Json(state.auth.list_clients(&principal.session_id).await).into_response(),
        Err(error) => auth_error_for_request(error, &headers, "client_sessions_load_failed"),
    }
}

async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(payload): Json<RevokeClientRequest>,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(principal) => match state
            .auth
            .revoke_client(&principal.session_id, &payload.session_id)
            .await
        {
            Ok(revoked) => Json(json!({ "revoked": revoked })).into_response(),
            Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
        },
        Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
    }
}

async fn revoke_other_clients(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    match authenticated_with_scope(&state.auth, &headers, &uri, SCOPE_ACCESS_WRITE).await {
        Ok(principal) => match state.auth.revoke_other_clients(&principal.session_id).await {
            Ok(revoked_count) => Json(json!({ "revokedCount": revoked_count })).into_response(),
            Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
        },
        Err(error) => auth_error_for_request(error, &headers, "client_session_revoke_failed"),
    }
}

pub(crate) async fn authenticate_websocket(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    if let Some(ticket) = query_value(uri, "wsTicket").filter(|value| !value.trim().is_empty()) {
        return auth.verify_websocket_ticket(&ticket).await;
    }
    authenticate_request(auth, headers, uri).await
}

pub(crate) fn auth_error_response(error: AuthError) -> Response {
    HttpAuthError::new(error, "internal_error").into_response()
}

async fn authenticated_with_scope(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
    scope: &str,
) -> Result<super::model::Principal, AuthError> {
    let principal = authenticate_request(auth, headers, uri).await?;
    require_scope(&principal, scope)?;
    Ok(principal)
}

async fn authenticate_request(
    auth: &AuthService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    authenticate_request_for_method(auth, headers, request_method(uri), uri).await
}

pub(crate) async fn authorize_http_request(
    auth: &AuthService,
    headers: &HeaderMap,
    method: &Method,
    uri: &Uri,
    scope: Option<&str>,
) -> Result<super::model::Principal, AuthError> {
    let principal = authenticate_request_for_method(auth, headers, method.as_str(), uri).await?;
    if let Some(scope) = scope {
        require_scope(&principal, scope)?;
    }
    Ok(principal)
}

async fn authenticate_request_for_method(
    auth: &AuthService,
    headers: &HeaderMap,
    method: &str,
    uri: &Uri,
) -> Result<super::model::Principal, AuthError> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| cookie_value(cookies, auth.cookie_name()));
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let bearer = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);
    let dpop = authorization
        .and_then(|value| value.strip_prefix("DPoP "))
        .map(str::trim);
    let token = cookie.or(bearer).or(dpop).filter(|value| !value.is_empty());
    let token = token.ok_or(AuthError::MissingCredential)?;
    let principal = auth.authenticate_token(token).await?;
    if let Some(expected_thumbprint) = principal.proof_key_thumbprint.as_deref() {
        let dpop_token = dpop.filter(|candidate| *candidate == token);
        let dpop_token = dpop_token.ok_or(AuthError::InvalidCredential)?;
        let proof = headers
            .get("dpop")
            .and_then(|value| value.to_str().ok())
            .ok_or(AuthError::InvalidCredential)?;
        auth.verify_dpop(
            proof,
            method,
            &request_url(headers, uri)?,
            Some(expected_thumbprint),
            Some(dpop_token),
        )
        .await?;
    } else if dpop.is_some() {
        return Err(AuthError::InvalidCredential);
    }
    Ok(principal)
}

fn require_scope(principal: &super::model::Principal, scope: &str) -> Result<(), AuthError> {
    if principal.has_scope(scope) {
        Ok(())
    } else {
        Err(AuthError::ScopeRequired(scope.to_owned()))
    }
}

fn credential_response(mut response: Response) -> Response {
    for (name, value) in CREDENTIAL_HEADERS {
        response.headers_mut().insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }
    response
}

fn dpop_challenge_on_unauthorized(mut response: Response) -> Response {
    if response.status() == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            header::HeaderValue::from_static("DPoP"),
        );
    }
    response
}

fn auth_error_for_request(
    error: AuthError,
    headers: &HeaderMap,
    internal_reason: &'static str,
) -> Response {
    let response = HttpAuthError::new(error, internal_reason).into_response();
    if request_uses_dpop(headers) {
        dpop_challenge_on_unauthorized(response)
    } else {
        response
    }
}

fn request_uses_dpop(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("DPoP "))
}

struct HttpAuthError {
    error: AuthError,
    internal_reason: &'static str,
}

impl HttpAuthError {
    fn new(error: AuthError, internal_reason: &'static str) -> Self {
        Self {
            error,
            internal_reason,
        }
    }
}

impl IntoResponse for HttpAuthError {
    fn into_response(self) -> Response {
        let trace_id = Uuid::new_v4().to_string();
        match self.error {
            AuthError::MissingCredential => error_response(
                StatusCode::UNAUTHORIZED,
                "EnvironmentAuthInvalidError",
                json!({ "code": "auth_invalid", "reason": "missing_credential", "traceId": trace_id }),
            ),
            AuthError::InvalidCredential => error_response(
                StatusCode::UNAUTHORIZED,
                "EnvironmentAuthInvalidError",
                json!({ "code": "auth_invalid", "reason": "invalid_credential", "traceId": trace_id }),
            ),
            AuthError::InvalidScope => error_response(
                StatusCode::BAD_REQUEST,
                "EnvironmentRequestInvalidError",
                json!({ "code": "invalid_request", "reason": "invalid_scope", "traceId": trace_id }),
            ),
            AuthError::ScopeNotGranted => error_response(
                StatusCode::BAD_REQUEST,
                "EnvironmentRequestInvalidError",
                json!({ "code": "invalid_request", "reason": "scope_not_granted", "traceId": trace_id }),
            ),
            AuthError::ScopeRequired(required_scope) => error_response(
                StatusCode::FORBIDDEN,
                "EnvironmentScopeRequiredError",
                json!({ "code": "insufficient_scope", "requiredScope": required_scope, "traceId": trace_id }),
            ),
            AuthError::CurrentSessionRevokeNotAllowed => error_response(
                StatusCode::FORBIDDEN,
                "EnvironmentOperationForbiddenError",
                json!({ "code": "operation_forbidden", "reason": "current_session_revoke_not_allowed", "traceId": trace_id }),
            ),
            AuthError::Internal(diagnostic) => {
                tracing::error!(%trace_id, %diagnostic, "environment authentication failed");
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "EnvironmentInternalError",
                    json!({ "code": "internal_error", "reason": self.internal_reason, "traceId": trace_id }),
                )
            }
        }
    }
}

fn error_response(status: StatusCode, tag: &str, fields: serde_json::Value) -> Response {
    let mut object = fields.as_object().cloned().unwrap_or_default();
    object.insert("_tag".to_owned(), json!(tag));
    (status, Json(object)).into_response()
}

fn cookie_value<'a>(cookies: &'a str, name: &str) -> Option<&'a str> {
    cookies.split(';').find_map(|cookie| {
        let (candidate, value) = cookie.trim().split_once('=')?;
        (candidate == name).then_some(value)
    })
}

fn query_value(uri: &Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query()?.as_bytes())
        .find_map(|(candidate, value)| (candidate == key).then(|| value.into_owned()))
}

fn request_url(headers: &HeaderMap, uri: &Uri) -> Result<String, AuthError> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("localhost");
    let protocol = if headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        == Some("https")
    {
        "https"
    } else {
        "http"
    };
    Ok(format!("{protocol}://{host}{uri}"))
}

fn request_method(uri: &Uri) -> &'static str {
    match uri.path() {
        "/api/auth/session" | "/api/auth/pairing-links" | "/api/auth/clients" | "/ws" => "GET",
        _ => "POST",
    }
}

fn client_metadata(headers: &HeaderMap, label: Option<String>) -> ClientMetadata {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    ClientMetadata {
        label,
        user_agent: user_agent.clone(),
        device_type: infer_device_type(headers).to_owned(),
        os: infer_os(headers).map(str::to_owned),
        browser: infer_browser(user_agent.as_deref()).map(str::to_owned),
        ip_address: None,
    }
}

fn infer_device_type(headers: &HeaderMap) -> &'static str {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["bot", "crawler", "spider", "slurp", "curl", "wget"]
        .iter()
        .any(|needle| user_agent.contains(needle))
    {
        "bot"
    } else if user_agent.contains("ipad") || user_agent.contains("tablet") {
        "tablet"
    } else if user_agent.contains("iphone") || user_agent.contains("mobile") {
        "mobile"
    } else {
        "desktop"
    }
}

fn infer_os(headers: &HeaderMap) -> Option<&'static str> {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())?
        .to_ascii_lowercase();
    if user_agent.contains("iphone") || user_agent.contains("ipad") {
        Some("iOS")
    } else if user_agent.contains("android") {
        Some("Android")
    } else if user_agent.contains("mac os x") || user_agent.contains("macintosh") {
        Some("macOS")
    } else if user_agent.contains("windows nt") {
        Some("Windows")
    } else if user_agent.contains("linux") {
        Some("Linux")
    } else {
        None
    }
}

fn infer_browser(user_agent: Option<&str>) -> Option<&'static str> {
    let user_agent = user_agent?.to_ascii_lowercase();
    if user_agent.contains("edg/") {
        Some("Edge")
    } else if user_agent.contains("opr/") {
        Some("Opera")
    } else if user_agent.contains("firefox/") {
        Some("Firefox")
    } else if user_agent.contains("chrome/") || user_agent.contains("crios/") {
        Some("Chrome")
    } else if user_agent.contains("safari/") {
        Some("Safari")
    } else {
        None
    }
}

fn is_device_type(value: &str) -> bool {
    ["desktop", "mobile", "tablet", "bot", "unknown"].contains(&value)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}
