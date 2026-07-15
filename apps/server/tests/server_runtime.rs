use std::{io::ErrorKind, net::SocketAddr, path::PathBuf, time::Duration};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode, redirect::Policy};
use serde_json::Value;
use t4code_server::{
    ConfigError, DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ROUTE_INVENTORY,
    RpcRegistry, ServerConfig, ServerError, ServerMode, ServerRuntime,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;
use uuid::Uuid;

const PROVIDER_DRIVERS: [&str; 5] = ["codex", "claudeAgent", "cursor", "grok", "opencode"];

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0)
}

fn endpoint(address: SocketAddr, path: &str) -> String {
    format!("http://{address}{path}")
}

fn proxy_free_client() -> Client {
    Client::builder()
        .no_proxy()
        .build()
        .expect("proxy-free HTTP client")
}

async fn assert_json_wire(response: reqwest::Response, status: StatusCode, body: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.text().await.expect("JSON response body"), body);
}

async fn assert_missing_credential_wire(response: reqwest::Response) {
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["content-type"], "application/json");
    let mut body = response.json::<Value>().await.expect("authentication JSON");
    let trace_id = body
        .as_object_mut()
        .expect("authentication error object")
        .remove("traceId")
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("authentication trace id");
    Uuid::parse_str(&trace_id).expect("UUID authentication trace id");
    assert_eq!(
        body,
        serde_json::json!({
            "_tag": "EnvironmentAuthInvalidError",
            "code": "auth_invalid",
            "reason": "missing_credential"
        })
    );
}

async fn exchange_startup_credential(
    client: &Client,
    address: SocketAddr,
    credential: &str,
) -> String {
    let response = client
        .post(endpoint(address, "/oauth/token"))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential),
            (
                "subject_token_type",
                "urn:t4code:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
        ])
        .send()
        .await
        .expect("startup credential exchange");
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.expect("token exchange JSON")["access_token"]
        .as_str()
        .expect("bearer access token")
        .to_owned()
}

fn write_disabled_provider_settings(temp: &TempDir) -> PathBuf {
    let settings_path = temp.path().join("userdata").join("settings.json");
    std::fs::create_dir_all(settings_path.parent().expect("settings parent"))
        .expect("create settings directory");
    std::fs::write(
        &settings_path,
        serde_json::to_vec(&serde_json::json!({
            "providers": {
                "codex": { "enabled": false },
                "claudeAgent": { "enabled": false },
                "cursor": { "enabled": false },
                "grok": { "enabled": false },
                "opencode": { "enabled": false }
            }
        }))
        .expect("encode provider settings"),
    )
    .expect("write provider settings");
    settings_path
}

async fn fetch_server_config(client: &Client, address: SocketAddr, access_token: &str) -> Value {
    let ticket_response = client
        .post(endpoint(address, "/api/auth/websocket-ticket"))
        .bearer_auth(access_token)
        .send()
        .await
        .expect("WebSocket ticket response");
    assert_eq!(ticket_response.status(), StatusCode::OK);
    let ticket_body = ticket_response
        .json::<Value>()
        .await
        .expect("WebSocket ticket JSON");
    let ticket = ticket_body["ticket"].as_str().expect("WebSocket ticket");
    let (mut socket, _) = connect_async(format!("ws://{address}/ws?wsTicket={ticket}"))
        .await
        .expect("configuration WebSocket");
    socket
        .send(Message::Text(
            serde_json::json!({
                "_tag": "Request",
                "id": "1",
                "tag": "server.getConfig",
                "payload": {},
                "headers": []
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send server configuration request");
    let frame = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("server configuration timeout")
        .expect("configuration WebSocket remains open")
        .expect("server configuration frame");
    let wire: Value = serde_json::from_str(frame.to_text().expect("configuration text frame"))
        .expect("server configuration JSON");
    assert_eq!(wire["_tag"], "Exit");
    assert_eq!(wire["requestId"], "1");
    assert_eq!(wire["exit"]["_tag"], "Success");
    socket
        .close(None)
        .await
        .expect("close configuration WebSocket");
    wire["exit"]["value"].clone()
}

#[tokio::test]
async fn binds_an_ephemeral_port_and_serves_the_environment_descriptor() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start(test_config(&temp))
        .await
        .expect("server starts");

    assert_ne!(handle.local_addr().port(), 0);
    let response = reqwest::get(endpoint(
        handle.local_addr(),
        "/.well-known/t4code/environment",
    ))
    .await
    .expect("environment response");
    assert_eq!(response.status(), StatusCode::OK);
    let descriptor: Value = response.json().await.expect("environment JSON");
    assert_eq!(descriptor["environmentId"], "local");
    assert_eq!(descriptor["capabilities"]["repositoryIdentity"], true);

    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("shutdown timeout")
        .expect("server joins");
}

#[tokio::test]
async fn validates_the_desktop_shutdown_token_and_joins_gracefully() {
    let temp = TempDir::new().expect("temporary base directory");
    let config = test_config(&temp)
        .with_desktop("desktop-secret")
        .expect("valid desktop token");
    let handle = ServerRuntime::start(config).await.expect("server starts");
    let url = endpoint(handle.local_addr(), DESKTOP_SHUTDOWN_PATH);
    let client = Client::new();

    let forbidden = client
        .post(&url)
        .header(DESKTOP_SHUTDOWN_TOKEN_HEADER, "wrong")
        .send()
        .await
        .expect("forbidden response");
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let accepted = client
        .post(&url)
        .header(DESKTOP_SHUTDOWN_TOKEN_HEADER, "desktop-secret")
        .send()
        .await
        .expect("accepted response");
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    assert_eq!(accepted.headers()["cache-control"], "no-store");

    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("shutdown timeout")
        .expect("server joins");
}

#[test]
fn rejects_empty_programmatic_desktop_tokens() {
    let temp = TempDir::new().expect("temporary base directory");
    let error = test_config(&temp)
        .with_desktop("  ")
        .expect_err("empty desktop token must fail");
    assert!(matches!(error, ConfigError::EmptyDesktopBootstrapToken));
}

#[tokio::test]
async fn hides_the_desktop_shutdown_route_outside_desktop_mode() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start(test_config(&temp))
        .await
        .expect("server starts");
    let response = Client::new()
        .post(endpoint(handle.local_addr(), DESKTOP_SHUTDOWN_PATH))
        .send()
        .await
        .expect("shutdown response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn native_mcp_routes_are_live_and_enforce_authentication() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start(test_config(&temp))
        .await
        .expect("server starts");
    let client = Client::new();

    for request in [
        client.post(endpoint(handle.local_addr(), "/mcp")),
        client.delete(endpoint(handle.local_addr(), "/mcp")),
    ] {
        let response = request.send().await.expect("MCP response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }

    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn custom_registry_uses_exact_fallback_http_responses() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(test_config(&temp), RpcRegistry::empty())
        .await
        .expect("custom-registry server starts");
    let client = proxy_free_client();
    let startup = handle
        .startup_access()
        .expect("authenticated web startup access");
    assert!(handle.local_addr().ip().is_loopback());
    assert_eq!(
        startup.connection_string,
        format!("http://{}", handle.local_addr())
    );
    assert!(!startup.credential.is_empty());
    let pairing_url = Url::parse(&startup.pairing_url).expect("valid pairing URL");
    assert_eq!(pairing_url.scheme(), "http");
    assert_eq!(pairing_url.host_str(), Some("127.0.0.1"));
    assert_eq!(pairing_url.port(), Some(handle.local_addr().port()));
    assert_eq!(pairing_url.path(), "/pair");
    assert_eq!(pairing_url.query(), None);
    let expected_fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &startup.credential)
        .finish();
    assert_eq!(pairing_url.fragment(), Some(expected_fragment.as_str()));
    let decoded_fragment = url::form_urlencoded::parse(expected_fragment.as_bytes())
        .into_owned()
        .collect::<Vec<_>>();
    assert_eq!(
        decoded_fragment,
        vec![("token".to_owned(), startup.credential.clone())]
    );
    assert_missing_credential_wire(
        client
            .get(endpoint(handle.local_addr(), "/api/orchestration/snapshot"))
            .send()
            .await
            .expect("unauthenticated fallback JSON response"),
    )
    .await;
    let access_token =
        exchange_startup_credential(&client, handle.local_addr(), startup.credential.as_str())
            .await;

    assert_json_wire(
        client
            .get(endpoint(
                handle.local_addr(),
                "/api/orchestration/snapshot",
            ))
            .bearer_auth(&access_token)
            .send()
            .await
            .expect("fallback JSON response"),
        StatusCode::SERVICE_UNAVAILABLE,
        r#"{"_tag":"NativeRuntimeUnavailableError","message":"The native production runtime is unavailable."}"#,
    )
    .await;

    assert_json_wire(
        client
            .get(endpoint(
                handle.local_addr(),
                "/api/assets/missing-token/missing.txt",
            ))
            .send()
            .await
            .expect("fallback asset response"),
        StatusCode::NOT_FOUND,
        r#"{"_tag":"AssetNotFoundError"}"#,
    )
    .await;

    for request in [
        client.post(endpoint(handle.local_addr(), "/mcp")),
        client.delete(endpoint(handle.local_addr(), "/mcp")),
    ] {
        assert_json_wire(
            request.send().await.expect("fallback MCP response"),
            StatusCode::SERVICE_UNAVAILABLE,
            r#"{"_tag":"McpUnavailableError"}"#,
        )
        .await;
    }

    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("shutdown timeout")
        .expect("custom-registry server joins");
}

#[tokio::test]
async fn unspecified_bind_uses_localhost_startup_access_and_waits_for_shutdown() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path()).with_bind("0.0.0.0", 0),
        RpcRegistry::empty(),
    )
    .await
    .expect("unspecified-address server starts");
    assert!(handle.local_addr().ip().is_unspecified());
    let startup = handle
        .startup_access()
        .expect("authenticated web startup access");
    assert!(!startup.credential.is_empty());
    assert_eq!(
        startup.connection_string,
        format!("http://localhost:{}", handle.local_addr().port())
    );
    let pairing_url = Url::parse(&startup.pairing_url).expect("valid pairing URL");
    assert_eq!(pairing_url.host_str(), Some("localhost"));
    assert_eq!(pairing_url.port(), Some(handle.local_addr().port()));
    assert_eq!(pairing_url.path(), "/pair");
    assert_eq!(pairing_url.query(), None);
    let fragment = pairing_url.fragment().expect("pairing URL fragment");
    assert_eq!(
        url::form_urlencoded::parse(fragment.as_bytes())
            .into_owned()
            .collect::<Vec<_>>(),
        vec![("token".to_owned(), startup.credential.clone())]
    );

    handle.shutdown();
    timeout(Duration::from_secs(2), handle.wait_for_shutdown())
        .await
        .expect("shutdown notification timeout");
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("shutdown join timeout")
        .expect("unspecified-address server joins");
}

#[tokio::test]
async fn existing_file_as_base_directory_returns_typed_creation_error() {
    let temp = TempDir::new().expect("temporary parent directory");
    let base_file = temp.path().join("base-file");
    std::fs::write(&base_file, "not a directory").expect("base path fixture");

    let error = match ServerRuntime::start_with_registry(
        ServerConfig::new(&base_file).with_bind("127.0.0.1", 0),
        RpcRegistry::empty(),
    )
    .await
    {
        Ok(handle) => {
            drop(handle);
            panic!("file base path must fail startup");
        }
        Err(error) => error,
    };
    assert_eq!(
        error.to_string(),
        "failed to create the server base directory"
    );
    match error {
        ServerError::CreateBaseDirectory(source) => {
            assert_eq!(source.kind(), ErrorKind::AlreadyExists);
            assert!(!source.to_string().trim().is_empty());
        }
        other => panic!("expected CreateBaseDirectory, got {other:?}"),
    }
}

#[tokio::test]
async fn occupied_listener_address_returns_typed_bind_error() {
    let occupied = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("occupy ephemeral listener");
    let occupied_addr = occupied.local_addr().expect("occupied listener address");
    let temp = TempDir::new().expect("temporary base directory");

    let error = match ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path()).with_bind("127.0.0.1", occupied_addr.port()),
        RpcRegistry::empty(),
    )
    .await
    {
        Ok(handle) => {
            drop(handle);
            panic!("occupied listener must fail startup");
        }
        Err(error) => error,
    };
    assert_eq!(error.to_string(), "failed to bind the server listener");
    match error {
        ServerError::Bind(source) => {
            assert_eq!(source.kind(), ErrorKind::AddrInUse);
            assert!(!source.to_string().trim().is_empty());
        }
        other => panic!("expected Bind, got {other:?}"),
    }
}

#[tokio::test]
async fn file_at_state_directory_returns_typed_state_files_error() {
    let temp = TempDir::new().expect("temporary base directory");
    let state_directory = temp.path().join("userdata");
    std::fs::write(&state_directory, "not a directory").expect("state path fixture");

    let error =
        match ServerRuntime::start_with_registry(test_config(&temp), RpcRegistry::empty()).await {
            Ok(handle) => {
                drop(handle);
                panic!("file state path must fail startup");
            }
            Err(error) => error,
        };
    match error {
        ServerError::StateFiles(message) => {
            assert!(message.contains("failed to create state directory"));
            assert!(message.contains("userdata"));
        }
        other => panic!("expected StateFiles, got {other:?}"),
    }
}

#[tokio::test]
async fn directory_at_database_path_returns_typed_persistence_error() {
    let temp = TempDir::new().expect("temporary base directory");
    let database_path = temp.path().join("userdata").join("state.sqlite");
    std::fs::create_dir_all(&database_path).expect("database path fixture");

    let error =
        match ServerRuntime::start_with_registry(test_config(&temp), RpcRegistry::empty()).await {
            Ok(handle) => {
                drop(handle);
                panic!("directory database path must fail startup");
            }
            Err(error) => error,
        };
    match error {
        ServerError::PersistenceInitialize(message) => {
            assert!(database_path.is_dir(), "deliberate database fixture");
            assert_eq!(
                message,
                format!("failed to open SQLite database {}", database_path.display())
            );
        }
        other => panic!("expected PersistenceInitialize, got {other:?}"),
    }
}

#[tokio::test]
async fn production_runtime_adapters_serve_snapshot_and_asset_errors() {
    let temp = TempDir::new().expect("temporary base directory");
    let settings_path = write_disabled_provider_settings(&temp);
    assert_eq!(
        settings_path,
        temp.path().join("userdata").join("settings.json")
    );
    let handle = ServerRuntime::start(test_config(&temp))
        .await
        .expect("production server starts");
    let client = proxy_free_client();
    let credential = handle
        .startup_access()
        .expect("authenticated web startup access")
        .credential
        .clone();
    let access_token = exchange_startup_credential(&client, handle.local_addr(), &credential).await;
    let config = fetch_server_config(&client, handle.local_addr(), &access_token).await;
    let providers = config["providers"].as_array().expect("provider snapshots");
    assert_eq!(providers.len(), PROVIDER_DRIVERS.len());
    for driver in PROVIDER_DRIVERS {
        assert_eq!(config["settings"]["providers"][driver]["enabled"], false);
        let provider = providers
            .iter()
            .find(|provider| provider["instanceId"] == driver)
            .unwrap_or_else(|| panic!("missing disabled provider snapshot for {driver}"));
        assert_eq!(provider["driver"], driver);
        assert_eq!(provider["enabled"], false);
        assert_eq!(provider["installed"], false);
        assert_eq!(provider["status"], "disabled");
    }

    let snapshot_response = client
        .get(endpoint(handle.local_addr(), "/api/orchestration/snapshot"))
        .bearer_auth(&access_token)
        .send()
        .await
        .expect("production snapshot response");
    assert_eq!(snapshot_response.status(), StatusCode::OK);
    assert_eq!(snapshot_response.headers()["cache-control"], "no-store");
    let snapshot: Value = snapshot_response.json().await.expect("snapshot JSON");
    for collection in [
        "projects",
        "threads",
        "messages",
        "activities",
        "sessions",
        "approvals",
        "proposed_plans",
        "turns",
        "checkpoints",
        "states",
        "receipts",
        "diffs",
    ] {
        assert_eq!(snapshot[collection], serde_json::json!([]), "{collection}");
    }

    assert_json_wire(
        client
            .get(endpoint(
                handle.local_addr(),
                "/api/assets/missing-token/missing.txt",
            ))
            .send()
            .await
            .expect("production asset response"),
        StatusCode::NOT_FOUND,
        r#"{"_tag":"AssetNotFoundError","message":"Asset was not found or its access token expired."}"#,
    )
    .await;

    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("production shutdown timeout")
        .expect("production server joins");
}

#[tokio::test]
async fn dropping_server_handle_aborts_the_task_and_releases_the_listener() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(
        test_config(&temp).with_unsafe_no_auth(),
        RpcRegistry::empty(),
    )
    .await
    .expect("custom-registry server starts");
    assert!(handle.startup_access().is_none());
    let address = handle.local_addr();

    drop(handle);

    let replacement = timeout(Duration::from_secs(2), async {
        loop {
            match TcpListener::bind(address).await {
                Ok(listener) => break listener,
                Err(error) if error.kind() == ErrorKind::AddrInUse => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("unexpected listener rebind error: {error}"),
            }
        }
    })
    .await
    .expect("dropped server releases listener before timeout");
    assert_eq!(
        replacement.local_addr().expect("replacement address"),
        address
    );
}

#[tokio::test]
async fn streams_static_assets_with_security_and_cache_headers() {
    let temp = TempDir::new().expect("temporary base directory");
    let static_dir = temp.path().join("static");
    std::fs::create_dir_all(static_dir.join("docs")).expect("static directories");
    std::fs::write(static_dir.join("index.html"), "<main>spa</main>").expect("SPA index");
    std::fs::write(static_dir.join("app.js"), "console.log('ok')").expect("asset");
    std::fs::write(static_dir.join("docs/index.html"), "<main>docs</main>")
        .expect("extensionless index");

    let config = test_config(&temp).with_static_dir(&static_dir);
    let handle = ServerRuntime::start(config).await.expect("server starts");
    let client = Client::new();

    let asset = client
        .get(endpoint(handle.local_addr(), "/app.js"))
        .send()
        .await
        .expect("asset response");
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        asset.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert!(asset.headers().contains_key("content-security-policy"));
    let csp = asset.headers()["content-security-policy"]
        .to_str()
        .expect("CSP header");
    for directive in [
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ] {
        assert!(csp.contains(directive), "missing {directive} in {csp}");
    }
    assert_eq!(asset.text().await.expect("asset body"), "console.log('ok')");

    let docs = client
        .get(endpoint(handle.local_addr(), "/docs"))
        .send()
        .await
        .expect("docs response");
    assert_eq!(docs.text().await.expect("docs body"), "<main>docs</main>");

    let fallback = client
        .get(endpoint(handle.local_addr(), "/missing/route"))
        .send()
        .await
        .expect("fallback response");
    assert_eq!(fallback.headers()["cache-control"], "no-cache");
    assert_eq!(
        fallback.text().await.expect("fallback body"),
        "<main>spa</main>"
    );

    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn rejects_percent_encoded_static_path_traversal() {
    let temp = TempDir::new().expect("temporary base directory");
    let static_dir = temp.path().join("static");
    std::fs::create_dir_all(&static_dir).expect("static directory");
    std::fs::write(static_dir.join("index.html"), "index").expect("index");
    let handle = ServerRuntime::start(test_config(&temp).with_static_dir(&static_dir))
        .await
        .expect("server starts");

    let response = raw_get(handle.local_addr(), "/%2e%2e/secret").await;
    assert!(response.starts_with("HTTP/1.1 400"), "{response}");

    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn preserves_path_and_query_when_redirecting_loopback_dev_requests() {
    let temp = TempDir::new().expect("temporary base directory");
    let config = test_config(&temp)
        .with_dev_url(Url::parse("http://127.0.0.1:5173/base").expect("valid dev URL"));
    let handle = ServerRuntime::start(config).await.expect("server starts");
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .expect("HTTP client");

    let response = client
        .get(endpoint(handle.local_addr(), "/projects/one?tab=files"))
        .send()
        .await
        .expect("redirect response");
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers()["location"],
        "http://127.0.0.1:5173/projects/one?tab=files"
    );

    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[test]
fn route_inventory_covers_every_current_http_method_and_path() {
    let actual = ROUTE_INVENTORY
        .iter()
        .map(|route| (route.method, route.path))
        .collect::<Vec<_>>();
    assert_eq!(actual, expected_routes());
}

fn expected_routes() -> Vec<(&'static str, &'static str)> {
    vec![
        ("GET", "/.well-known/t4code/environment"),
        ("GET", "/api/auth/session"),
        ("POST", "/api/auth/browser-session"),
        ("POST", "/oauth/token"),
        ("POST", "/api/auth/websocket-ticket"),
        ("POST", "/api/auth/pairing-token"),
        ("GET", "/api/auth/pairing-links"),
        ("POST", "/api/auth/pairing-links/revoke"),
        ("GET", "/api/auth/clients"),
        ("POST", "/api/auth/clients/revoke"),
        ("POST", "/api/auth/clients/revoke-others"),
        ("GET", "/api/orchestration/snapshot"),
        ("POST", "/api/orchestration/dispatch"),
        ("POST", "/api/connect/link-proof"),
        ("POST", "/api/connect/relay-config"),
        ("GET", "/api/connect/link-state"),
        ("POST", "/api/connect/unlink"),
        ("POST", "/api/t4code-connect/health"),
        ("POST", "/api/connect/mint-credential"),
        ("POST", "/api/t4code-connect/mint-credential"),
        ("GET", "/ws"),
        ("POST", "/api/observability/v1/traces"),
        ("GET", "/api/assets/*"),
        ("POST", "/.well-known/t4code/desktop/shutdown"),
        ("POST", "/mcp"),
        ("DELETE", "/mcp"),
        ("GET", "*"),
    ]
}

async fn raw_get(address: SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(address)
        .await
        .expect("raw TCP connection");
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    String::from_utf8(response).expect("UTF-8 HTTP response")
}

#[test]
fn server_mode_remains_a_typed_configuration_value() {
    assert_eq!(ServerMode::Web.to_string(), "web");
}
