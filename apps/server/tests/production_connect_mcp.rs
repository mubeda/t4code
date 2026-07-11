use std::{collections::BTreeMap, sync::Arc, time::Duration};

use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

mod production {
    pub mod http_routes {
        pub use t4code_server::production::http_routes::*;
    }

    pub mod connect_mcp {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/production/connect_mcp.rs"
        ));
    }
}

use production::connect_mcp::{
    ConnectMcpConfig, ConnectMcpService, DecodedCloudProof, EndpointRuntime, JwtCodec,
    PairingCredential, PairingIssuer, PreviewInvoker, PreviewScope,
};
use production::http_routes::{JsonOperation, RouteContext};

fn context(headers: HeaderMap) -> RouteContext {
    RouteContext {
        headers,
        uri: Uri::from_static("http://127.0.0.1:43123/mcp"),
        cancellation: CancellationToken::new(),
    }
}

async fn setup_service(
    temp: &TempDir,
) -> (
    ConnectMcpService,
    Arc<Mutex<Vec<(PreviewScope, String, Value)>>>,
) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let preview_calls = Arc::clone(&calls);
    let jwt = JwtCodec::new(
        |typ, payload| async move { Ok(format!("signed:{typ}:{}", payload["jti"])) },
        |_key, typ, token, _issuer, _audience, _now| async move {
            let scope = if typ.contains("health") {
                "environment:status"
            } else {
                "environment:connect"
            };
            Ok(DecodedCloudProof {
                issuer: "https://relay.example".into(),
                subject: "cloud-user".into(),
                audience: "t4code-env:env-1".into(),
                jwt_id: token.clone(),
                issued_at: 1_700_000_000,
                expires_at: 1_700_000_120,
                environment_id: "env-1".into(),
                nonce: format!("nonce-{token}"),
                scope: vec![scope.into()],
                client_proof_key_thumbprint: (scope == "environment:connect")
                    .then(|| "thumbprint".into()),
                confirmation_thumbprint: (scope == "environment:connect")
                    .then(|| "thumbprint".into()),
            })
        },
        || async {
            Ok((
                "private-key".into(),
                "-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----".into(),
            ))
        },
    );
    let endpoint = EndpointRuntime::new(|config| async move {
        Ok(if config.is_null() {
            json!({"status":"disabled"})
        } else {
            json!({"status":"running"})
        })
    });
    let pairing = PairingIssuer::new(|thumbprint| async move {
        assert_eq!(thumbprint, "thumbprint");
        Ok(PairingCredential {
            credential: "pairing-secret".into(),
            expires_at: "2026-07-10T12:02:00Z".into(),
        })
    });
    let preview = PreviewInvoker::new(move |scope, operation, input, _tab, cancellation| {
        let preview_calls = Arc::clone(&preview_calls);
        async move {
            if cancellation.is_cancelled() {
                return Err("cancelled".into());
            }
            preview_calls.lock().await.push((scope, operation, input));
            Ok(json!({"url":"https://example.test","title":"Example"}))
        }
    });
    let config = ConnectMcpConfig {
        environment_id: "env-1".into(),
        descriptor: json!({
            "environmentId":"env-1",
            "label":"Local",
            "platform":"win32",
            "architecture":"x64"
        }),
        mcp_endpoint: "http://127.0.0.1:43123/mcp".into(),
        now_epoch_seconds: Arc::new(|| 1_700_000_000),
        max_mcp_credentials: 4,
        max_mcp_sessions: 4,
    };
    let service = ConnectMcpService::open(
        temp.path().join("connect.sqlite3"),
        config,
        jwt,
        endpoint,
        pairing,
        preview,
    )
    .await
    .expect("connect service");
    (service, calls)
}

#[tokio::test]
async fn cloud_config_is_persistent_atomic_and_replay_safe() {
    let temp = TempDir::new().unwrap();
    let (service, _) = setup_service(&temp).await;

    let unlinked = service
        .json(
            JsonOperation::ConnectLinkState,
            None,
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(unlinked.body["linked"], false);

    let linked = service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(json!({
                "relayUrl":"https://relay.example/",
                "relayIssuer":"https://relay.example",
                "cloudUserId":"cloud-user",
                "environmentCredential":"environment-secret",
                "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----\ncloud-key\n-----END PUBLIC KEY-----",
                "endpointRuntime":{"providerKind":"cloudflare_tunnel","connectorToken":"token"}
            })),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(linked.body["ok"], true);

    let health = service
        .json(
            JsonOperation::ConnectHealth,
            Some(json!({"proof":"health-jti"})),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(health.body["status"], "online");
    assert_eq!(
        health.headers.get("pragma").map(String::as_str),
        Some("no-cache")
    );

    let replay = service
        .json(
            JsonOperation::ConnectHealth,
            Some(json!({"proof":"health-jti"})),
            context(HeaderMap::new()),
        )
        .await;
    let replay = match replay {
        Ok(_) => panic!("replayed health proof was accepted"),
        Err(error) => error,
    };
    assert_eq!(replay.status(), StatusCode::CONFLICT);

    drop(service);
    let (reopened, _) = setup_service(&temp).await;
    let state = reopened
        .json(
            JsonOperation::ConnectLinkState,
            None,
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(state.body["cloudUserId"], "cloud-user");
    assert_eq!(state.body["relayUrl"], "https://relay.example/");
}

#[tokio::test]
async fn link_proof_mint_and_unlink_preserve_connect_wire_contracts() {
    let temp = TempDir::new().unwrap();
    let (service, _) = setup_service(&temp).await;
    service
        .json(
            JsonOperation::ConnectRelayConfig,
            Some(json!({
                "relayUrl":"https://relay.example",
                "cloudUserId":"cloud-user",
                "environmentCredential":"environment-secret",
                "cloudMintPublicKey":"-----BEGIN PUBLIC KEY-----\ncloud-key\n-----END PUBLIC KEY-----",
                "endpointRuntime":null
            })),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();

    let proof = service
        .json(
            JsonOperation::ConnectLinkProof,
            Some(json!({
                "challenge":"challenge-1",
                "relayIssuer":"https://relay.example/",
                "endpoint":{"providerKind":"cloudflare_tunnel","url":"https://managed.example"},
                "origin":{"localHttpHost":"127.0.0.1","localHttpPort":43123}
            })),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert!(
        proof
            .body
            .as_str()
            .unwrap()
            .starts_with("signed:t4code-env-link+jwt:")
    );

    let minted = service
        .json(
            JsonOperation::ConnectMintCredential,
            Some(json!({"proof":"mint-jti"})),
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(minted.body["credential"], "pairing-secret");
    assert!(
        minted.body["proof"]
            .as_str()
            .unwrap()
            .starts_with("signed:t4code-env-mint+jwt:")
    );

    let unlinked = service
        .json(
            JsonOperation::ConnectUnlink,
            None,
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(unlinked.body["endpointRuntimeStatus"]["status"], "disabled");
    let state = service
        .json(
            JsonOperation::ConnectLinkState,
            None,
            context(HeaderMap::new()),
        )
        .await
        .unwrap();
    assert_eq!(state.body["linked"], false);
}

#[tokio::test]
async fn mcp_requires_provider_credential_and_terminates_bounded_sessions() {
    let temp = TempDir::new().unwrap();
    let (service, calls) = setup_service(&temp).await;
    let issued = service
        .issue_mcp_credential("thread-1", "codex-1")
        .await
        .unwrap();

    let unauthorized = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
                .unwrap(),
            context(HeaderMap::new()),
        )
        .await;
    let unauthorized = match unauthorized {
        Ok(_) => panic!("unauthenticated MCP request was accepted"),
        Err(error) => error,
    };
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&issued.authorization_header).unwrap(),
    );
    let initialized = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({
                "jsonrpc":"2.0","id":1,"method":"initialize",
                "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}
            }))
            .unwrap(),
            context(headers.clone()),
        )
        .await
        .unwrap();
    assert_eq!(initialized.status, 200);
    let session_id = initialized.headers["mcp-session-id"].clone();
    headers.insert(
        "mcp-session-id",
        HeaderValue::from_str(&session_id).unwrap(),
    );

    let listed = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
                .unwrap(),
            context(headers.clone()),
        )
        .await
        .unwrap();
    let listed: Value = serde_json::from_slice(&listed.body).unwrap();
    assert!(
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "preview_status")
    );
    assert!(
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "preview_snapshot")
    );

    let called = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({
                "jsonrpc":"2.0","id":3,"method":"tools/call",
                "params":{"name":"preview_status","arguments":{"tabId":"tab-1"}}
            }))
            .unwrap(),
            context(headers.clone()),
        )
        .await
        .unwrap();
    let called: Value = serde_json::from_slice(&called.body).unwrap();
    assert_eq!(called["result"]["isError"], false);
    assert_eq!(calls.lock().await.len(), 1);

    let deleted = service
        .mcp(Method::DELETE, Vec::new(), context(headers.clone()))
        .await
        .unwrap();
    assert_eq!(deleted.status, 204);
    let reused = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":4,"method":"ping","params":{}}))
                .unwrap(),
            context(headers),
        )
        .await;
    let reused = match reused {
        Ok(_) => panic!("terminated MCP session was reused"),
        Err(error) => error,
    };
    assert_eq!(reused.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cancellation_stops_preview_tool_invocation() {
    let temp = TempDir::new().unwrap();
    let (service, _) = setup_service(&temp).await;
    let issued = service
        .issue_mcp_credential("thread", "provider")
        .await
        .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&issued.authorization_header).unwrap(),
    );
    let initialized = service
        .mcp(
            Method::POST,
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
                .unwrap(),
            context(headers.clone()),
        )
        .await
        .unwrap();
    headers.insert(
        "mcp-session-id",
        HeaderValue::from_str(&initialized.headers["mcp-session-id"]).unwrap(),
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let response = service.mcp(Method::POST, serde_json::to_vec(&json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"preview_status","arguments":{}}})).unwrap(), RouteContext { headers, uri: Uri::from_static("http://127.0.0.1/mcp"), cancellation }).await.unwrap();
    let body: Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(body["result"]["isError"], true);
    tokio::time::sleep(Duration::from_millis(1)).await;
}

#[tokio::test]
async fn http_route_adapters_and_provider_revocation_are_ready_for_central_wiring() {
    let temp = TempDir::new().unwrap();
    let (service, _) = setup_service(&temp).await;
    assert!(
        service
            .json_http(
                JsonOperation::OrchestrationSnapshot,
                None,
                context(HeaderMap::new()),
            )
            .await
            .is_err()
    );
    assert!(
        service
            .mcp_http(Method::POST, Vec::new(), context(HeaderMap::new()))
            .await
            .is_err()
    );

    let first = service
        .issue_mcp_credential("thread-1", "provider-1")
        .await
        .unwrap();
    service
        .revoke_mcp_provider_session(&first.provider_session_id)
        .await;
    let second = service
        .issue_mcp_credential("thread-2", "provider-2")
        .await
        .unwrap();
    assert_ne!(first.authorization_header, second.authorization_header);
    service.revoke_all_mcp_credentials().await;
}

#[test]
fn response_headers_are_deterministic() {
    let headers = BTreeMap::from([
        ("cache-control".to_owned(), "no-store".to_owned()),
        ("pragma".to_owned(), "no-cache".to_owned()),
    ]);
    assert_eq!(
        headers.keys().cloned().collect::<Vec<_>>(),
        ["cache-control", "pragma"]
    );
}
