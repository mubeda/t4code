use std::{path::PathBuf, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::{Signature, SigningKey, signature::hazmat::PrehashSigner};
use reqwest::{Client, Response, StatusCode, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use t4code_server::{ROUTE_INVENTORY, RpcRegistry, ServerConfig, ServerHandle, ServerRuntime};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite};

const DESKTOP_BOOTSTRAP: &str = "desktop-bootstrap-fixture";
const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:t4code:params:oauth:token-type:environment-bootstrap";

#[test]
fn language_neutral_auth_fixtures_match_the_rust_http_inventory() {
    let fixture_directory = auth_fixture_directory();
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_directory.join("manifest.json"))
            .expect("auth manifest fixture"),
    )
    .expect("valid auth manifest");
    let mut fixture_routes = manifest["routes"]
        .as_array()
        .expect("fixture routes")
        .iter()
        .map(|route| {
            (
                route["method"].as_str().expect("fixture method").to_owned(),
                route["path"].as_str().expect("fixture path").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    fixture_routes.sort();
    let mut rust_routes = ROUTE_INVENTORY
        .iter()
        .filter(|route| route.path.starts_with("/api/auth/") || route.path == "/oauth/token")
        .map(|route| (route.method.to_owned(), route.path.to_owned()))
        .collect::<Vec<_>>();
    rust_routes.sort();

    assert_eq!(rust_routes, fixture_routes);
    assert_eq!(
        manifest["scopes"]["all"],
        json!([
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "access:read",
            "access:write",
            "relay:read",
            "relay:write"
        ])
    );
    for fixture in manifest["fixtures"].as_array().expect("auth fixture list") {
        let path = fixture_directory.join(fixture.as_str().expect("auth fixture path"));
        assert!(path.is_file(), "missing auth fixture: {}", path.display());
    }
}

#[tokio::test]
async fn desktop_bootstrap_creates_cookie_and_bearer_sessions() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();

    let unauthenticated = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .send()
            .await
            .expect("session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(unauthenticated["authenticated"], false);
    assert_eq!(unauthenticated["auth"]["policy"], "desktop-managed-local");
    assert_eq!(
        unauthenticated["auth"]["bootstrapMethods"],
        json!(["desktop-bootstrap"])
    );
    assert_eq!(
        unauthenticated["auth"]["sessionCookieName"],
        "t4code_session_0"
    );

    let browser_response = client
        .post(http_url(&handle, "/api/auth/browser-session"))
        .json(&json!({ "credential": DESKTOP_BOOTSTRAP }))
        .send()
        .await
        .expect("browser bootstrap request");
    assert_credential_headers(&browser_response);
    let cookie = browser_response
        .headers()
        .get(header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .expect("ASCII session cookie")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_owned();
    assert!(cookie.starts_with("t4code_session_0="));
    let browser_session = get_json(browser_response, StatusCode::OK).await;
    assert_eq!(browser_session["authenticated"], true);
    assert_eq!(browser_session["sessionMethod"], "browser-session-cookie");

    let authenticated = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .header(header::COOKIE, cookie)
            .send()
            .await
            .expect("cookie session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(authenticated["authenticated"], true);

    let access = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    assert_eq!(access["token_type"], "Bearer");
    assert_eq!(access["issued_token_type"], ACCESS_TOKEN_TYPE);
    assert!(access["expires_in"].as_u64().is_some_and(|ttl| ttl > 0));
    assert!(
        access["scope"]
            .as_str()
            .is_some_and(|scope| scope.contains("access:write"))
    );

    shutdown(handle).await;
}

#[tokio::test]
async fn web_mode_exposes_a_one_time_administrative_startup_pairing_url() {
    let temp = TempDir::new().expect("temporary base directory");
    let config = ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0);
    let handle = ServerRuntime::start_with_registry(config, RpcRegistry::empty())
        .await
        .expect("web server starts");
    let startup = handle
        .startup_access()
        .expect("web mode startup pairing access");
    assert_eq!(
        startup.connection_string,
        format!("http://{}", handle.local_addr())
    );
    assert!(
        startup
            .pairing_url
            .starts_with(&format!("http://{}/pair#token=", handle.local_addr()))
    );
    assert!(startup.pairing_url.ends_with(&startup.credential));

    let client = Client::new();
    let session = exchange_token(&client, &handle, &startup.credential, None).await;
    assert!(
        session["scope"]
            .as_str()
            .is_some_and(|scopes| scopes.contains("access:write"))
    );
    let replay = client
        .post(http_url(&handle, "/oauth/token"))
        .form(&token_form(&startup.credential, None))
        .send()
        .await
        .expect("startup pairing replay request");
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    shutdown(handle).await;
}

#[tokio::test]
async fn one_time_pairing_credentials_are_atomic_and_scope_constrained() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({
                "label": "Read-only client",
                "scopes": ["orchestration:read"]
            }))
            .send()
            .await
            .expect("pairing token request"),
        StatusCode::OK,
    )
    .await;
    let credential = pairing["credential"].as_str().expect("pairing credential");
    assert_eq!(credential.len(), 12);
    assert!(
        credential
            .bytes()
            .all(|byte| b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(&byte))
    );

    let paired = exchange_token(&client, &handle, credential, None).await;
    assert_eq!(paired["scope"], "orchestration:read");

    let replay = client
        .post(http_url(&handle, "/oauth/token"))
        .form(&token_form(credential, None))
        .send()
        .await
        .expect("replayed exchange request");
    assert_credential_headers(&replay);
    let replay_error = get_json(replay, StatusCode::UNAUTHORIZED).await;
    assert_eq!(replay_error["_tag"], "EnvironmentAuthInvalidError");
    assert_eq!(replay_error["code"], "auth_invalid");
    assert_eq!(replay_error["reason"], "invalid_credential");
    assert!(
        replay_error["traceId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );

    let overbroad_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&paired))
            .json(&json!({ "scopes": ["access:read"] }))
            .send()
            .await
            .expect("overbroad pairing request"),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_eq!(overbroad_pairing["_tag"], "EnvironmentScopeRequiredError");
    assert_eq!(overbroad_pairing["requiredScope"], "access:write");

    shutdown(handle).await;
}

#[tokio::test]
async fn pairing_links_and_client_sessions_can_be_listed_and_revoked() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Revocable client" }))
            .send()
            .await
            .expect("pairing token request"),
        StatusCode::OK,
    )
    .await;
    let pairing_id = pairing["id"].as_str().expect("pairing id");
    let pairing_credential = pairing["credential"].as_str().expect("pairing credential");

    let links = get_json(
        client
            .get(http_url(&handle, "/api/auth/pairing-links"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("list pairing links"),
        StatusCode::OK,
    )
    .await;
    assert!(
        links
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == pairing_id))
    );

    let revoked = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-links/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "id": pairing_id }))
            .send()
            .await
            .expect("revoke pairing link"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);

    let unavailable = client
        .post(http_url(&handle, "/oauth/token"))
        .form(&token_form(pairing_credential, None))
        .send()
        .await
        .expect("revoked pairing exchange");
    assert_eq!(unavailable.status(), StatusCode::UNAUTHORIZED);

    let second_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Paired client" }))
            .send()
            .await
            .expect("second pairing token request"),
        StatusCode::OK,
    )
    .await;
    let paired = exchange_token(
        &client,
        &handle,
        second_pairing["credential"]
            .as_str()
            .expect("second credential"),
        None,
    )
    .await;
    let paired_token = access_token(&paired);
    let clients = get_json(
        client
            .get(http_url(&handle, "/api/auth/clients"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("list clients"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["client"]["label"] == "Paired client")
        })
        .and_then(|item| item["sessionId"].as_str())
        .expect("paired session id");

    let current_session_id = clients
        .as_array()
        .and_then(|items| items.iter().find(|item| item["current"] == true))
        .and_then(|item| item["sessionId"].as_str())
        .expect("current administrator session");
    let self_revoke = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": current_session_id }))
            .send()
            .await
            .expect("self revoke request"),
        StatusCode::FORBIDDEN,
    )
    .await;
    assert_eq!(self_revoke["reason"], "current_session_revoke_not_allowed");

    let revoke = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("revoke client request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoke["revoked"], true);

    let revoked_state = get_json(
        client
            .get(http_url(&handle, "/api/auth/session"))
            .bearer_auth(paired_token)
            .send()
            .await
            .expect("revoked session state"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_state["authenticated"], false);

    let third_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Revoke other client" }))
            .send()
            .await
            .expect("third pairing token request"),
        StatusCode::OK,
    )
    .await;
    let _third = exchange_token(
        &client,
        &handle,
        third_pairing["credential"]
            .as_str()
            .expect("third credential"),
        None,
    )
    .await;
    let revoked_others = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke-others"))
            .bearer_auth(administrator_token)
            .json(&json!({}))
            .send()
            .await
            .expect("revoke other clients request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_others["revokedCount"], 1);

    shutdown(handle).await;
}

#[tokio::test]
async fn websocket_requires_a_short_lived_ticket_or_request_credential() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);

    let ticket_response = client
        .post(http_url(&handle, "/api/auth/websocket-ticket"))
        .bearer_auth(administrator_token)
        .send()
        .await
        .expect("WebSocket ticket request");
    assert_credential_headers(&ticket_response);
    let ticket = get_json(ticket_response, StatusCode::OK).await;
    let ticket = ticket["ticket"].as_str().expect("WebSocket ticket");

    let (mut socket, _) =
        connect_async(format!("ws://{}/ws?wsTicket={ticket}", handle.local_addr()))
            .await
            .expect("ticket-authenticated WebSocket");
    socket
        .send(tungstenite::Message::Text(
            json!({ "_tag": "Ping" }).to_string().into(),
        ))
        .await
        .expect("send protocol ping");
    let pong = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("Pong timeout")
        .expect("WebSocket open")
        .expect("valid WebSocket frame");
    assert_eq!(pong.into_text().expect("text Pong"), r#"{"_tag":"Pong"}"#);
    socket.close(None).await.expect("close WebSocket");

    for query in [
        format!("wsTicket={administrator_token}"),
        format!("token={administrator_token}"),
    ] {
        let error = connect_async(format!("ws://{}/ws?{query}", handle.local_addr()))
            .await
            .expect_err("raw session query token must be rejected");
        assert!(matches!(
            error,
            tungstenite::Error::Http(response)
                if response.status() == StatusCode::UNAUTHORIZED
        ));
    }

    shutdown(handle).await;
}

#[tokio::test]
async fn websocket_authorizes_rpc_scopes_and_streams_auth_access_changes() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator);
    let administrator_ticket = websocket_ticket(&client, &handle, administrator_token).await;
    let (mut administrator_socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={administrator_ticket}",
        handle.local_addr()
    ))
    .await
    .expect("administrator WebSocket");

    send_ws_json(
        &mut administrator_socket,
        json!({
            "_tag": "Request",
            "id": "101",
            "tag": "subscribeAuthAccess",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    let snapshot = next_ws_json(&mut administrator_socket).await;
    assert_eq!(snapshot["_tag"], "Chunk");
    assert_eq!(snapshot["requestId"], "101");
    assert_eq!(snapshot["values"][0]["type"], "snapshot");
    assert_eq!(snapshot["values"][0]["version"], 1);
    assert!(
        snapshot["values"][0]["payload"]["clientSessions"]
            .as_array()
            .is_some_and(|sessions| sessions
                .iter()
                .any(|session| { session["current"] == true && session["connected"] == true }))
    );
    send_ws_json(
        &mut administrator_socket,
        json!({ "_tag": "Ack", "requestId": "101" }),
    )
    .await;

    let live_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "label": "Live stream fixture" }))
            .send()
            .await
            .expect("live pairing request"),
        StatusCode::OK,
    )
    .await;
    let upsert = next_ws_json(&mut administrator_socket).await;
    assert_eq!(upsert["_tag"], "Chunk");
    assert_eq!(upsert["values"][0]["type"], "pairingLinkUpserted");
    assert_eq!(upsert["values"][0]["payload"]["id"], live_pairing["id"]);
    administrator_socket
        .close(None)
        .await
        .expect("close administrator WebSocket");

    let restricted_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "scopes": ["orchestration:read"] }))
            .send()
            .await
            .expect("restricted pairing request"),
        StatusCode::OK,
    )
    .await;
    let restricted = exchange_token(
        &client,
        &handle,
        restricted_pairing["credential"]
            .as_str()
            .expect("restricted credential"),
        None,
    )
    .await;
    let restricted_ticket = websocket_ticket(&client, &handle, access_token(&restricted)).await;
    let (mut restricted_socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={restricted_ticket}",
        handle.local_addr()
    ))
    .await
    .expect("restricted WebSocket");
    send_ws_json(
        &mut restricted_socket,
        json!({
            "_tag": "Request",
            "id": "102",
            "tag": "subscribeAuthAccess",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    let denied = next_ws_json(&mut restricted_socket).await;
    assert_eq!(denied["_tag"], "Exit");
    assert_eq!(denied["exit"]["_tag"], "Failure");
    assert_eq!(
        denied["exit"]["cause"][0]["error"]["_tag"],
        "EnvironmentAuthorizationError"
    );
    assert_eq!(
        denied["exit"]["cause"][0]["error"]["requiredScope"],
        "access:read"
    );

    send_ws_json(
        &mut restricted_socket,
        json!({
            "_tag": "Request",
            "id": "103",
            "tag": "server.consumeCodexRateLimitReset",
            "payload": { "requestId": "request-123" },
            "headers": []
        }),
    )
    .await;
    let reset_denied = next_ws_json(&mut restricted_socket).await;
    assert_eq!(reset_denied["_tag"], "Exit");
    assert_eq!(reset_denied["exit"]["_tag"], "Failure");
    assert_eq!(
        reset_denied["exit"]["cause"][0]["error"]["_tag"],
        "EnvironmentAuthorizationError"
    );
    assert_eq!(
        reset_denied["exit"]["cause"][0]["error"]["requiredScope"],
        "orchestration:operate"
    );

    let operate_pairing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(administrator_token)
            .json(&json!({ "scopes": ["orchestration:operate"] }))
            .send()
            .await
            .expect("operate pairing request"),
        StatusCode::OK,
    )
    .await;
    let operate = exchange_token(
        &client,
        &handle,
        operate_pairing["credential"]
            .as_str()
            .expect("operate credential"),
        None,
    )
    .await;
    let operate_ticket = websocket_ticket(&client, &handle, access_token(&operate)).await;
    let (mut operate_socket, _) = connect_async(format!(
        "ws://{}/ws?wsTicket={operate_ticket}",
        handle.local_addr()
    ))
    .await
    .expect("operate WebSocket");
    send_ws_json(
        &mut operate_socket,
        json!({
            "_tag": "Request",
            "id": "104",
            "tag": "server.consumeCodexRateLimitReset",
            "payload": { "requestId": "  " },
            "headers": []
        }),
    )
    .await;
    let reset_authorized = next_ws_json(&mut operate_socket).await;
    assert_eq!(reset_authorized["_tag"], "Exit");
    assert_eq!(reset_authorized["exit"]["_tag"], "Failure");
    assert_eq!(
        reset_authorized["exit"]["cause"][0]["error"]["_tag"],
        "ServerProviderUsageResetError"
    );
    operate_socket
        .close(None)
        .await
        .expect("close operate WebSocket");

    let clients = get_json(
        client
            .get(http_url(&handle, "/api/auth/clients"))
            .bearer_auth(administrator_token)
            .send()
            .await
            .expect("client list request"),
        StatusCode::OK,
    )
    .await;
    let restricted_session_id = clients
        .as_array()
        .expect("client list")
        .iter()
        .find(|session| session["scopes"] == json!(["orchestration:read"]))
        .and_then(|session| session["sessionId"].as_str())
        .expect("restricted session id");
    let revoked = get_json(
        client
            .post(http_url(&handle, "/api/auth/clients/revoke"))
            .bearer_auth(administrator_token)
            .json(&json!({ "sessionId": restricted_session_id }))
            .send()
            .await
            .expect("revoke restricted session"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);
    send_ws_json(
        &mut restricted_socket,
        json!({
            "_tag": "Request",
            "id": "103",
            "tag": "server.getConfig",
            "payload": {},
            "headers": []
        }),
    )
    .await;
    let revoked_session = next_ws_json(&mut restricted_socket).await;
    assert_eq!(revoked_session["_tag"], "Defect");
    assert_eq!(
        revoked_session["defect"],
        "Authenticated session is no longer valid"
    );

    restricted_socket
        .close(None)
        .await
        .expect("close restricted WebSocket");
    shutdown(handle).await;
}

#[tokio::test]
async fn invalid_scope_and_missing_credentials_use_stable_error_shapes() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();

    let missing = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .json(&json!({}))
            .send()
            .await
            .expect("unauthenticated pairing request"),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(missing["_tag"], "EnvironmentAuthInvalidError");
    assert_eq!(missing["reason"], "missing_credential");

    let administrator = exchange_token(&client, &handle, DESKTOP_BOOTSTRAP, None).await;
    let invalid_scope = get_json(
        client
            .post(http_url(&handle, "/oauth/token"))
            .form(&token_form(
                DESKTOP_BOOTSTRAP,
                Some("orchestration:read unknown:scope"),
            ))
            .send()
            .await
            .expect("invalid scope request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(invalid_scope["_tag"], "EnvironmentRequestInvalidError");
    assert_eq!(invalid_scope["reason"], "invalid_scope");

    let empty_scope = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "scopes": [] }))
            .send()
            .await
            .expect("empty delegated scope request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(empty_scope["reason"], "invalid_scope");

    let unknown_delegated_scope = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "scopes": ["unknown:scope"] }))
            .send()
            .await
            .expect("unknown delegated scope request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(unknown_delegated_scope["reason"], "invalid_scope");

    let invalid_device = get_json(
        client
            .post(http_url(&handle, "/oauth/token"))
            .form(
                &token_form(DESKTOP_BOOTSTRAP, None)
                    .into_iter()
                    .chain([("client_device_type", "game-console")])
                    .collect::<Vec<_>>(),
            )
            .send()
            .await
            .expect("invalid client device request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(invalid_device["_tag"], "EnvironmentRequestInvalidError");

    let empty_label = get_json(
        client
            .post(http_url(&handle, "/api/auth/pairing-token"))
            .bearer_auth(access_token(&administrator))
            .json(&json!({ "label": "   " }))
            .send()
            .await
            .expect("empty pairing label request"),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(empty_label["_tag"], "EnvironmentRequestInvalidError");

    let malformed_token = get_json(
        client
            .post(http_url(&handle, "/api/auth/websocket-ticket"))
            .bearer_auth("malformed.session.token")
            .send()
            .await
            .expect("malformed token request"),
        StatusCode::UNAUTHORIZED,
    )
    .await;
    assert_eq!(malformed_token["_tag"], "EnvironmentAuthInvalidError");
    assert_eq!(malformed_token["reason"], "invalid_credential");

    shutdown(handle).await;
}

#[tokio::test]
async fn dpop_tokens_validate_proof_binding_time_and_replay() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let signing_key = SigningKey::from_bytes((&[7_u8; 32]).into()).expect("fixture signing key");
    let token_url = http_url(&handle, "/oauth/token");
    let issued_at = unix_seconds();
    let proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "token-proof-1",
        issued_at,
        None,
    );
    let response = client
        .post(&token_url)
        .header("dpop", &proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("DPoP token exchange");
    assert_credential_headers(&response);
    let issued = get_json(response, StatusCode::OK).await;
    assert_eq!(issued["token_type"], "DPoP");
    let access_token = access_token(&issued);

    let proxied_proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url.replacen("http://", "https://", 1),
        "proxied-token-proof",
        unix_seconds(),
        None,
    );
    let proxied = client
        .post(&token_url)
        .header("x-forwarded-proto", "https")
        .header("dpop", proxied_proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("reverse-proxied DPoP token exchange");
    assert_eq!(proxied.status(), StatusCode::OK);

    let ticket_url = http_url(&handle, "/api/auth/websocket-ticket");
    let request_proof = dpop_proof(
        &signing_key,
        "POST",
        &ticket_url,
        "request-proof-1",
        unix_seconds(),
        Some(access_token),
    );
    let ticket_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", &request_proof)
        .send()
        .await
        .expect("proof-bound ticket request");
    assert_eq!(ticket_response.status(), StatusCode::OK);

    let replay = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", &request_proof)
        .send()
        .await
        .expect("replayed DPoP request");
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        replay.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );

    let bearer_misuse = client
        .post(&ticket_url)
        .bearer_auth(access_token)
        .send()
        .await
        .expect("Bearer misuse request");
    assert_eq!(bearer_misuse.status(), StatusCode::UNAUTHORIZED);

    let wrong_method = dpop_proof(
        &signing_key,
        "GET",
        &ticket_url,
        "wrong-method-proof",
        unix_seconds(),
        Some(access_token),
    );
    let wrong_method_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", wrong_method)
        .send()
        .await
        .expect("wrong-method DPoP request");
    assert_eq!(wrong_method_response.status(), StatusCode::UNAUTHORIZED);

    let wrong_hash = dpop_proof(
        &signing_key,
        "POST",
        &ticket_url,
        "wrong-hash-proof",
        unix_seconds(),
        Some("a-different-access-token"),
    );
    let wrong_hash_response = client
        .post(&ticket_url)
        .header(header::AUTHORIZATION, format!("DPoP {access_token}"))
        .header("dpop", wrong_hash)
        .send()
        .await
        .expect("wrong-hash DPoP request");
    assert_eq!(wrong_hash_response.status(), StatusCode::UNAUTHORIZED);

    let future = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "future-proof",
        unix_seconds() + 60,
        None,
    );
    let future_response = client
        .post(&token_url)
        .header("dpop", future)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("future DPoP request");
    assert_eq!(future_response.status(), StatusCode::UNAUTHORIZED);

    let stale = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "stale-proof",
        unix_seconds() - 301,
        None,
    );
    let stale_response = client
        .post(&token_url)
        .header("dpop", stale)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("stale DPoP request");
    assert_eq!(stale_response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        stale_response.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );

    shutdown(handle).await;
}

#[tokio::test]
async fn dpop_replay_state_survives_a_server_restart() {
    let temp = TempDir::new().expect("temporary base directory");
    let first_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop config");
    let first = ServerRuntime::start_with_registry(first_config, RpcRegistry::empty())
        .await
        .expect("first server starts");
    let port = first.local_addr().port();
    let token_url = http_url(&first, "/oauth/token");
    let signing_key = SigningKey::from_bytes((&[11_u8; 32]).into()).expect("fixture signing key");
    let proof = dpop_proof(
        &signing_key,
        "POST",
        &token_url,
        "restart-replay-proof",
        unix_seconds(),
        None,
    );
    let client = Client::new();
    let accepted = client
        .post(&token_url)
        .header("dpop", &proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("first DPoP request");
    assert_eq!(accepted.status(), StatusCode::OK);
    shutdown(first).await;

    let second_config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", port)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop config");
    let second = ServerRuntime::start_with_registry(second_config, RpcRegistry::empty())
        .await
        .expect("second server starts");
    let replayed = client
        .post(http_url(&second, "/oauth/token"))
        .header("dpop", proof)
        .form(&token_form(DESKTOP_BOOTSTRAP, None))
        .send()
        .await
        .expect("replayed DPoP request after restart");
    assert_eq!(replayed.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        replayed.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("DPoP"))
    );
    shutdown(second).await;
}

#[tokio::test]
async fn sessions_pairings_consumption_and_revocation_survive_restarts() {
    let temp = TempDir::new().expect("temporary base directory");
    let client = Client::new();
    let first = start_desktop_server(&temp).await;
    let administrator = exchange_token(&client, &first, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator).to_owned();
    let pairing = get_json(
        client
            .post(http_url(&first, "/api/auth/pairing-token"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "label": "Restarted client" }))
            .send()
            .await
            .expect("persistent pairing request"),
        StatusCode::OK,
    )
    .await;
    let pairing_id = pairing["id"].as_str().expect("pairing id").to_owned();
    let pairing_credential = pairing["credential"]
        .as_str()
        .expect("pairing credential")
        .to_owned();
    shutdown(first).await;

    let second = start_desktop_server(&temp).await;
    let restored_administrator = get_json(
        client
            .get(http_url(&second, "/api/auth/session"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("restored administrator request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(restored_administrator["authenticated"], true);
    let restored_pairings = get_json(
        client
            .get(http_url(&second, "/api/auth/pairing-links"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("restored pairing list"),
        StatusCode::OK,
    )
    .await;
    assert!(
        restored_pairings
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == pairing_id))
    );

    let paired = exchange_token(&client, &second, &pairing_credential, None).await;
    let paired_token = access_token(&paired).to_owned();
    let clients = get_json(
        client
            .get(http_url(&second, "/api/auth/clients"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("client list after restored pairing exchange"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .expect("client list")
        .iter()
        .find(|session| session["client"]["label"] == "Restarted client")
        .and_then(|session| session["sessionId"].as_str())
        .expect("paired session id");
    let revoked = get_json(
        client
            .post(http_url(&second, "/api/auth/clients/revoke"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("persistent client revocation"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);
    shutdown(second).await;

    let third = start_desktop_server(&temp).await;
    let revoked_session = get_json(
        client
            .get(http_url(&third, "/api/auth/session"))
            .bearer_auth(&paired_token)
            .send()
            .await
            .expect("revoked session after second restart"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked_session["authenticated"], false);
    let consumed_pairing = client
        .post(http_url(&third, "/oauth/token"))
        .form(&token_form(&pairing_credential, None))
        .send()
        .await
        .expect("consumed pairing after second restart");
    assert_eq!(consumed_pairing.status(), StatusCode::UNAUTHORIZED);
    shutdown(third).await;
}

#[tokio::test]
async fn session_revocation_is_immediate_across_live_server_processes() {
    let temp = TempDir::new().expect("temporary base directory");
    let client = Client::new();
    let first = start_desktop_server(&temp).await;
    let administrator = exchange_token(&client, &first, DESKTOP_BOOTSTRAP, None).await;
    let administrator_token = access_token(&administrator).to_owned();
    let pairing = get_json(
        client
            .post(http_url(&first, "/api/auth/pairing-token"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "label": "Cross-process client" }))
            .send()
            .await
            .expect("cross-process pairing request"),
        StatusCode::OK,
    )
    .await;
    let paired = exchange_token(
        &client,
        &first,
        pairing["credential"].as_str().expect("pairing credential"),
        None,
    )
    .await;
    let paired_token = access_token(&paired).to_owned();

    let second = start_desktop_server(&temp).await;
    let accepted_by_second = get_json(
        client
            .get(http_url(&second, "/api/auth/session"))
            .bearer_auth(&paired_token)
            .send()
            .await
            .expect("second server session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(accepted_by_second["authenticated"], true);

    let clients = get_json(
        client
            .get(http_url(&first, "/api/auth/clients"))
            .bearer_auth(&administrator_token)
            .send()
            .await
            .expect("first server client list"),
        StatusCode::OK,
    )
    .await;
    let paired_session_id = clients
        .as_array()
        .expect("client list")
        .iter()
        .find(|session| session["client"]["label"] == "Cross-process client")
        .and_then(|session| session["sessionId"].as_str())
        .expect("paired session id");
    let revoked = get_json(
        client
            .post(http_url(&first, "/api/auth/clients/revoke"))
            .bearer_auth(&administrator_token)
            .json(&json!({ "sessionId": paired_session_id }))
            .send()
            .await
            .expect("first server revocation"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revoked["revoked"], true);

    let rejected_by_second = get_json(
        client
            .get(http_url(&second, "/api/auth/session"))
            .bearer_auth(&paired_token)
            .send()
            .await
            .expect("second server revoked-session request"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(rejected_by_second["authenticated"], false);

    shutdown(second).await;
    shutdown(first).await;
}

#[tokio::test]
async fn auth_routes_include_browser_cors_and_preflight_headers() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_desktop_server(&temp).await;
    let client = Client::new();
    let origin = "https://client.example.test";

    let session = client
        .get(http_url(&handle, "/api/auth/session"))
        .header(header::ORIGIN, origin)
        .send()
        .await
        .expect("CORS session request");
    assert_eq!(
        session.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&header::HeaderValue::from_static("*"))
    );

    let preflight = client
        .request(
            reqwest::Method::OPTIONS,
            http_url(&handle, "/api/auth/websocket-ticket"),
        )
        .header(header::ORIGIN, origin)
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, content-type, dpop",
        )
        .send()
        .await
        .expect("CORS preflight request");
    assert_eq!(preflight.status(), StatusCode::OK);
    assert_eq!(
        preflight.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&header::HeaderValue::from_static("*"))
    );
    let allowed_headers = preflight
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .and_then(|value| value.to_str().ok())
        .expect("allowed headers");
    for expected in ["authorization", "content-type", "dpop"] {
        assert!(allowed_headers.contains(expected));
    }

    shutdown(handle).await;
}

async fn start_desktop_server(temp: &TempDir) -> ServerHandle {
    let config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("valid desktop configuration");
    let mut registry = RpcRegistry::empty();
    registry.register_unary("server.getConfig", |_request, _cancellation| async {
        Ok(json!({}))
    });
    registry.register_unary(
        "server.consumeCodexRateLimitReset",
        |_request, _cancellation| async {
            Err(json!({
                "_tag": "ServerProviderUsageResetError",
                "message": "Codex reset request ID is required.",
            }))
        },
    );
    ServerRuntime::start_with_registry(config, registry)
        .await
        .expect("server starts")
}

fn http_url(handle: &ServerHandle, path: &str) -> String {
    format!("http://{}{}", handle.local_addr(), path)
}

fn token_form<'a>(credential: &'a str, scope: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    let mut form = vec![
        ("grant_type", TOKEN_GRANT_TYPE),
        ("subject_token", credential),
        ("subject_token_type", BOOTSTRAP_TOKEN_TYPE),
        ("requested_token_type", ACCESS_TOKEN_TYPE),
    ];
    if let Some(scope) = scope {
        form.push(("scope", scope));
    }
    form
}

async fn exchange_token(
    client: &Client,
    handle: &ServerHandle,
    credential: &str,
    scope: Option<&str>,
) -> Value {
    let response = client
        .post(http_url(handle, "/oauth/token"))
        .form(&token_form(credential, scope))
        .send()
        .await
        .expect("token exchange request");
    assert_credential_headers(&response);
    get_json(response, StatusCode::OK).await
}

async fn websocket_ticket(client: &Client, handle: &ServerHandle, token: &str) -> String {
    let response = client
        .post(http_url(handle, "/api/auth/websocket-ticket"))
        .bearer_auth(token)
        .send()
        .await
        .expect("WebSocket ticket request");
    get_json(response, StatusCode::OK).await["ticket"]
        .as_str()
        .expect("WebSocket ticket")
        .to_owned()
}

async fn send_ws_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(tungstenite::Message::Text(value.to_string().into()))
        .await
        .expect("send WebSocket JSON");
}

async fn next_ws_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    serde_json::from_str(frame.to_text().expect("text WebSocket frame"))
        .expect("valid WebSocket JSON")
}

fn access_token(response: &Value) -> &str {
    response["access_token"].as_str().expect("access token")
}

fn assert_credential_headers(response: &Response) {
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL),
        Some(&header::HeaderValue::from_static("no-store"))
    );
    assert_eq!(
        response.headers().get(header::PRAGMA),
        Some(&header::HeaderValue::from_static("no-cache"))
    );
}

async fn get_json(response: Response, expected_status: StatusCode) -> Value {
    let actual_status = response.status();
    let body = response.text().await.expect("HTTP response body");
    assert_eq!(
        actual_status, expected_status,
        "unexpected HTTP response body: {body}"
    );
    serde_json::from_str(&body).expect("JSON response")
}

async fn shutdown(handle: ServerHandle) {
    handle.shutdown();
    timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("server shutdown timeout")
        .expect("server joins");
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_secs()
        .try_into()
        .expect("fixture timestamp fits i64")
}

fn dpop_proof(
    signing_key: &SigningKey,
    method: &str,
    url: &str,
    jti: &str,
    issued_at: i64,
    access_token: Option<&str>,
) -> String {
    let point = signing_key.verifying_key().to_sec1_point(false);
    let header = json!({
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": {
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(point.x().expect("P-256 x coordinate")),
            "y": URL_SAFE_NO_PAD.encode(point.y().expect("P-256 y coordinate")),
        }
    });
    let mut payload = json!({
        "htm": method,
        "htu": normalize_dpop_url(url),
        "jti": jti,
        "iat": issued_at,
    });
    if let Some(access_token) = access_token {
        payload["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes())));
    }
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("DPoP header JSON"));
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("DPoP payload JSON"));
    let signing_input = format!("{header}.{payload}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let signature: Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign DPoP fixture");
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    )
}

fn normalize_dpop_url(url: &str) -> String {
    let mut url = url::Url::parse(url).expect("fixture URL");
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn auth_fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures/auth-http")
}
