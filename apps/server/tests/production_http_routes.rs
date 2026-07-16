use std::{collections::BTreeMap, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
};
use serde_json::{Value, json};
use t4code_server::production::http_routes::{
    AssetHttpResponse, DiagnosticLogsHttpResponse, HttpRouteError, HttpRoutesState, JsonOperation,
    JsonRouteResponse, MAX_DIAGNOSTIC_BODY_BYTES, MAX_JSON_BODY_BYTES, McpHttpResponse,
    RouteContext, add_routes,
};
use tokio::sync::{Mutex, oneshot};
use tower::ServiceExt;

#[derive(Clone)]
struct TestState(HttpRoutesState);

impl axum::extract::FromRef<TestState> for HttpRoutesState {
    fn from_ref(state: &TestState) -> Self {
        state.0.clone()
    }
}

#[tokio::test]
async fn routes_apply_exact_scopes_and_preserve_json_wire_shapes() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = state_with_json_recorder(Arc::clone(&calls));
    let app = add_routes(Router::new()).with_state(TestState(state));
    let cases = [
        (
            "GET",
            "/api/orchestration/snapshot",
            JsonOperation::OrchestrationSnapshot,
            Some("orchestration:read"),
            None,
        ),
        (
            "POST",
            "/api/orchestration/dispatch",
            JsonOperation::OrchestrationDispatch,
            Some("orchestration:operate"),
            Some(json!({"_tag":"project.create","commandId":"c1"})),
        ),
        (
            "POST",
            "/api/connect/link-proof",
            JsonOperation::ConnectLinkProof,
            Some("relay:write"),
            Some(json!({"cloudOrigin":"https://cloud.example"})),
        ),
        (
            "POST",
            "/api/connect/relay-config",
            JsonOperation::ConnectRelayConfig,
            Some("relay:write"),
            Some(json!({"relayUrl":"https://relay.example"})),
        ),
        (
            "GET",
            "/api/connect/link-state",
            JsonOperation::ConnectLinkState,
            Some("relay:read"),
            None,
        ),
        (
            "POST",
            "/api/connect/unlink",
            JsonOperation::ConnectUnlink,
            Some("relay:write"),
            None,
        ),
        (
            "POST",
            "/api/t4code-connect/health",
            JsonOperation::ConnectHealth,
            None,
            Some(json!({"environmentId":"env-1"})),
        ),
        (
            "POST",
            "/api/connect/mint-credential",
            JsonOperation::ConnectMintCredential,
            None,
            Some(json!({"environmentId":"env-1"})),
        ),
        (
            "POST",
            "/api/t4code-connect/mint-credential",
            JsonOperation::ConnectMintCredential,
            None,
            Some(json!({"environmentId":"env-1"})),
        ),
        (
            "POST",
            "/api/observability/v1/traces",
            JsonOperation::ObservabilityTraces,
            Some("orchestration:operate"),
            Some(json!({"resourceSpans":[]})),
        ),
    ];

    for (method, uri, operation, scope, payload) in &cases {
        let mut request = Request::builder().method(*method).uri(*uri);
        if scope.is_some() {
            request = request.header(header::AUTHORIZATION, "Bearer test-token");
        }
        let body = payload
            .as_ref()
            .map_or_else(Body::empty, |value| Body::from(value.to_string()));
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{method} {uri}");
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(
            value,
            json!({"operation": operation.as_str(), "wire": "unchanged"})
        );
    }

    let calls = calls.lock().await;
    assert_eq!(calls.len(), cases.len());
    for (
        (operation, scope, payload),
        (_, _, expected_operation, expected_scope, expected_payload),
    ) in calls.iter().zip(cases)
    {
        assert_eq!(*operation, Some(expected_operation));
        assert_eq!(scope.as_deref(), expected_scope);
        assert_eq!(payload, &expected_payload);
    }
}

#[tokio::test]
async fn json_routes_reject_oversized_and_malformed_bodies_before_service_dispatch() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = state_with_json_recorder(Arc::clone(&calls));
    let app = add_routes(Router::new()).with_state(TestState(state));

    let oversized = app
        .clone()
        .oneshot(
            Request::post("/api/orchestration/dispatch")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(vec![b'x'; MAX_JSON_BODY_BYTES + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let malformed = app
        .oneshot(
            Request::post("/api/orchestration/dispatch")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert!(
        calls
            .lock()
            .await
            .iter()
            .all(|(operation, _, _)| operation.is_none())
    );
}

#[tokio::test]
async fn diagnostic_logs_route_is_bounded_authorized_and_returns_zip_headers() {
    let authorization_calls = Arc::new(Mutex::new(Vec::new()));
    let dispatched_logs = Arc::new(Mutex::new(Vec::new()));
    let mut state = state_with_json_recorder(Arc::clone(&authorization_calls));
    let handler_calls = Arc::clone(&dispatched_logs);
    state.diagnostic_logs = Arc::new(move |frontend_log, context| {
        let calls = Arc::clone(&handler_calls);
        Box::pin(async move {
            assert!(!context.cancellation.is_cancelled());
            calls.lock().await.push(frontend_log);
            Ok(DiagnosticLogsHttpResponse {
                filename: "t4code-diagnostics-20260715T123456Z.zip".to_owned(),
                bytes: b"PK-test-archive".to_vec(),
            })
        })
    });
    let app = add_routes(Router::new()).with_state(TestState(state));

    let response = app
        .clone()
        .oneshot(
            Request::post("/api/diagnostics/logs.zip")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"frontendLog":"client warning"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/zip");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION],
        "attachment; filename=\"t4code-diagnostics-20260715T123456Z.zip\""
    );
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"PK-test-archive"
    );
    assert_eq!(dispatched_logs.lock().await.as_slice(), ["client warning"]);
    assert!(
        authorization_calls
            .lock()
            .await
            .iter()
            .any(|(_, scope, _)| { scope.as_deref() == Some("orchestration:read") })
    );

    let malformed = app
        .clone()
        .oneshot(
            Request::post("/api/diagnostics/logs.zip")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

    let oversized = app
        .oneshot(
            Request::post("/api/diagnostics/logs.zip")
                .header(header::AUTHORIZATION, "Bearer test-token")
                .body(Body::from(vec![b'x'; MAX_DIAGNOSTIC_BODY_BYTES + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(dispatched_logs.lock().await.len(), 1);
}

#[tokio::test]
async fn assets_and_mcp_use_native_handlers_with_protocol_headers() {
    let mut state = state_with_json_recorder(Arc::new(Mutex::new(Vec::new())));
    state.assets = Arc::new(|token, path, _context| {
        Box::pin(async move {
            assert_eq!(token, "signed-token");
            assert_eq!(path, "nested/icon.svg");
            Ok(AssetHttpResponse {
                content_type: "image/svg+xml".to_owned(),
                bytes: b"<svg/>".to_vec(),
                cache_control: "private, max-age=3600".to_owned(),
            })
        })
    });
    state.mcp = Arc::new(|method, body, _context| {
        Box::pin(async move {
            assert_eq!(body.as_slice(), b"{}");
            Ok(McpHttpResponse {
                status: if method == Method::POST { 200 } else { 204 },
                headers: BTreeMap::from([("mcp-session-id".to_owned(), "session-1".to_owned())]),
                body: Vec::new(),
            })
        })
    });
    let app = add_routes(Router::new()).with_state(TestState(state));

    let asset = app
        .clone()
        .oneshot(
            Request::get("/api/assets/signed-token/nested/icon.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()[header::CONTENT_TYPE], "image/svg+xml");
    assert_eq!(
        asset.headers()[header::CACHE_CONTROL],
        "private, max-age=3600"
    );
    assert_eq!(asset.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        to_bytes(asset.into_body(), 1024).await.unwrap().as_ref(),
        b"<svg/>"
    );

    let post = app
        .clone()
        .oneshot(Request::post("/mcp").body(Body::from("{}")).unwrap())
        .await
        .unwrap();
    assert_eq!(post.status(), StatusCode::ACCEPTED);
    assert_eq!(post.headers()["mcp-session-id"], "session-1");

    let delete = app
        .oneshot(Request::delete("/mcp").body(Body::from("{}")).unwrap())
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn dropping_a_request_cancels_the_native_operation() {
    let (started_tx, started_rx) = oneshot::channel();
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    let started_tx = Arc::new(Mutex::new(Some(started_tx)));
    let cancelled_tx = Arc::new(Mutex::new(Some(cancelled_tx)));
    let mut state = state_with_json_recorder(Arc::new(Mutex::new(Vec::new())));
    state.json = Arc::new(move |_operation, _payload, context| {
        let started_tx = Arc::clone(&started_tx);
        let cancelled_tx = Arc::clone(&cancelled_tx);
        Box::pin(async move {
            if let Some(sender) = started_tx.lock().await.take() {
                let _ = sender.send(());
            }
            tokio::spawn(async move {
                context.cancellation.cancelled().await;
                if let Some(sender) = cancelled_tx.lock().await.take() {
                    let _ = sender.send(());
                }
            });
            std::future::pending::<Result<JsonRouteResponse, HttpRouteError>>().await
        })
    });
    let app = add_routes(Router::new()).with_state(TestState(state));
    let request = Request::get("/api/orchestration/snapshot")
        .header(header::AUTHORIZATION, "Bearer test-token")
        .body(Body::empty())
        .unwrap();
    let task = tokio::spawn(app.oneshot(request));
    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("handler start")
        .expect("start notification");
    task.abort();
    tokio::time::timeout(Duration::from_secs(1), cancelled_rx)
        .await
        .expect("handler cancellation")
        .expect("cancellation notification");
}

type JsonRecorderCall = (Option<JsonOperation>, Option<String>, Option<Value>);

fn state_with_json_recorder(calls: Arc<Mutex<Vec<JsonRecorderCall>>>) -> HttpRoutesState {
    let authorization_calls = Arc::clone(&calls);
    let json_calls = Arc::clone(&calls);
    HttpRoutesState::new(
        Arc::new(move |_headers, _method, _uri, scope, _cancellation| {
            let calls = Arc::clone(&authorization_calls);
            Box::pin(async move {
                calls
                    .lock()
                    .await
                    .push((None, scope.map(str::to_owned), None));
                Ok(())
            })
        }),
        Arc::new(move |operation, payload, context: RouteContext| {
            let calls = Arc::clone(&json_calls);
            Box::pin(async move {
                let mut calls = calls.lock().await;
                if let Some((probe, scope, _)) = calls.last() {
                    if probe.is_none() {
                        let scope = scope.clone();
                        calls.pop();
                        calls.push((Some(operation), scope, payload));
                    } else {
                        calls.push((Some(operation), None, payload));
                    }
                } else {
                    calls.push((Some(operation), None, payload));
                }
                assert!(!context.cancellation.is_cancelled());
                Ok(JsonRouteResponse::ok(json!({
                    "operation": operation.as_str(),
                    "wire": "unchanged"
                })))
            })
        }),
        Arc::new(|_frontend_log, _context| {
            Box::pin(async {
                Err(HttpRouteError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"message": "Unavailable"}),
                ))
            })
        }),
        Arc::new(|_token, _path, _context| {
            Box::pin(async {
                Err(HttpRouteError::new(
                    StatusCode::NOT_FOUND,
                    json!({"message": "Not Found"}),
                ))
            })
        }),
        Arc::new(|_method, _body, _context| {
            Box::pin(async {
                Err(HttpRouteError::new(
                    StatusCode::UNAUTHORIZED,
                    json!({
                        "error": "invalid_mcp_credential",
                        "message": "A valid provider-scoped MCP bearer credential is required."
                    }),
                )
                .with_header("www-authenticate", "Bearer"))
            })
        }),
    )
}
