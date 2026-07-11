use std::{net::SocketAddr, time::Duration};

use reqwest::{Client, StatusCode, redirect::Policy};
use serde_json::Value;
use t4code_server::{
    ConfigError, DESKTOP_SHUTDOWN_PATH, DESKTOP_SHUTDOWN_TOKEN_HEADER, ROUTE_INVENTORY,
    ServerConfig, ServerMode, ServerRuntime,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use url::Url;

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0)
}

fn endpoint(address: SocketAddr, path: &str) -> String {
    format!("http://{address}{path}")
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
