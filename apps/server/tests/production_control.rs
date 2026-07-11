use std::time::Duration;

use serde_json::{Value, json};
use t4code_server::{
    ServerConfig,
    production::{control::NativeServerControl, server_terminal::ProductionServerControl},
};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

fn auth_descriptor() -> Value {
    json!({
        "policy": "loopback-browser",
        "bootstrapMethods": ["one-time-token"],
        "sessionMethods": ["browser-session-cookie", "bearer-access-token"],
        "sessionCookieName": "t4code_session",
    })
}

async fn fixture() -> (TempDir, NativeServerControl) {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let mut config = ServerConfig::new(directory.path());
    config.environment_id = "test-environment".into();
    config.environment_label = "Test Environment".into();
    let control = NativeServerControl::new(config, auth_descriptor()).await;
    (directory, control)
}

async fn call(control: &NativeServerControl, method: &'static str, payload: Value) -> Value {
    control
        .call(method, payload, CancellationToken::new())
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error}"))
}

async fn next_event(stream: &mut t4code_server::production::server_terminal::JsonStream) -> Value {
    timeout(Duration::from_secs(2), stream.recv())
        .await
        .expect("stream event timeout")
        .expect("stream remains open")
        .expect("stream event succeeds")
        .into_iter()
        .next()
        .expect("non-empty event batch")
}

#[tokio::test]
async fn config_and_settings_match_the_typescript_contract_without_faking_provider_authentication()
{
    let (_directory, control) = fixture().await;
    let settings = call(&control, "server.getSettings", json!({})).await;

    assert_eq!(settings["enableAssistantStreaming"], false);
    assert_eq!(settings["enableProviderUpdateChecks"], true);
    assert_eq!(settings["automaticGitFetchInterval"], 30_000);
    assert_eq!(
        settings["textGenerationModelSelection"]["model"],
        "gpt-5.4-mini"
    );
    assert_eq!(settings["providers"]["codex"]["binaryPath"], "codex");
    assert_eq!(settings["providers"]["cursor"]["enabled"], false);

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["auth"], auth_descriptor());
    assert!(
        config["cwd"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(
        config["keybindingsConfigPath"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(config["keybindings"].is_array());
    assert!(config["issues"].is_array());
    assert!(config["availableEditors"].is_array());
    assert_eq!(config["settings"], settings);
    for provider in config["providers"].as_array().expect("provider snapshots") {
        if provider["status"] == "ready" {
            assert_eq!(provider["installed"], true);
            assert_eq!(provider["auth"]["status"], "unknown");
        }
        if provider["installed"] == false {
            assert!(matches!(
                provider["status"].as_str(),
                Some("error" | "disabled")
            ));
        }
    }
}

#[tokio::test]
async fn settings_update_persists_atomically_redacts_secrets_and_emits_stream_event() {
    let (directory, control) = fixture().await;
    let cancellation = CancellationToken::new();
    let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
    assert_eq!(next_event(&mut stream).await["type"], "snapshot");

    let updated = call(
        &control,
        "server.updateSettings",
        json!({ "patch": {
            "enableAssistantStreaming": true,
            "providerInstances": {
                "work": {
                    "driver": "codex",
                    "displayName": "Work",
                    "environment": [{
                        "name": "TOKEN",
                        "value": "top-secret",
                        "sensitive": true
                    }]
                }
            }
        }}),
    )
    .await;
    assert_eq!(updated["enableAssistantStreaming"], true);
    assert_eq!(
        updated["providerInstances"]["work"]["environment"][0]["value"],
        ""
    );
    assert_eq!(
        updated["providerInstances"]["work"]["environment"][0]["valueRedacted"],
        true
    );

    let event = next_event(&mut stream).await;
    assert_eq!(event["type"], "settingsUpdated");
    assert_eq!(event["payload"]["settings"], updated);

    let persisted: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join("userdata/settings.json"))
            .await
            .expect("persisted settings"),
    )
    .expect("valid settings JSON");
    assert!(!persisted.to_string().contains("top-secret"));
    assert_eq!(
        tokio::fs::read_to_string(
            directory
                .path()
                .join("userdata/secrets/provider-env-d29yaw-VE9LRU4"),
        )
        .await
        .expect("separate secret"),
        "top-secret"
    );
    cancellation.cancel();
}

#[tokio::test]
async fn keybinding_upsert_replace_and_remove_are_resolved_persisted_and_streamed() {
    let (directory, control) = fixture().await;
    let cancellation = CancellationToken::new();
    let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
    let _snapshot = next_event(&mut stream).await;

    let added = call(
        &control,
        "server.upsertKeybinding",
        json!({ "key": "ctrl+shift+k", "command": "terminal.toggle" }),
    )
    .await;
    assert_eq!(added["issues"], json!([]));
    let binding = added["keybindings"].as_array().unwrap().last().unwrap();
    assert_eq!(binding["command"], "terminal.toggle");
    assert_eq!(binding["shortcut"]["key"], "k");
    assert_eq!(binding["shortcut"]["ctrlKey"], true);
    assert_eq!(binding["shortcut"]["shiftKey"], true);
    assert_eq!(binding["shortcut"]["modKey"], true);
    assert_eq!(next_event(&mut stream).await["type"], "keybindingsUpdated");

    let replaced = call(
        &control,
        "server.upsertKeybinding",
        json!({
            "key": "alt+j",
            "command": "terminal.toggle",
            "replace": { "key": "ctrl+shift+k", "command": "terminal.toggle" }
        }),
    )
    .await;
    assert!(
        replaced["keybindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["command"] == "terminal.toggle" && row["shortcut"]["key"] == "j" })
    );
    let _replace_event = next_event(&mut stream).await;

    let removed = call(
        &control,
        "server.removeKeybinding",
        json!({ "key": "alt+j", "command": "terminal.toggle" }),
    )
    .await;
    assert!(
        !removed["keybindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| { row["command"] == "terminal.toggle" && row["shortcut"]["key"] == "j" })
    );
    let persisted: Value = serde_json::from_slice(
        &tokio::fs::read(directory.path().join("userdata/keybindings.json"))
            .await
            .expect("persisted keybindings"),
    )
    .expect("valid keybindings JSON");
    assert_eq!(persisted, json!([]));
    cancellation.cancel();
}

#[tokio::test]
async fn trace_and_auxiliary_streams_use_exact_contract_shapes() {
    let (_directory, control) = fixture().await;
    let diagnostics = call(&control, "server.getTraceDiagnostics", json!({})).await;
    assert!(
        diagnostics["traceFilePath"]
            .as_str()
            .is_some_and(|path| !path.is_empty())
    );
    assert!(diagnostics["scannedFilePaths"].is_array());
    assert!(diagnostics["readAt"].is_string());
    for field in [
        "recordCount",
        "parseErrorCount",
        "failureCount",
        "interruptionCount",
        "slowSpanThresholdMs",
        "slowSpanCount",
    ] {
        assert!(
            diagnostics[field].is_number(),
            "missing numeric field {field}"
        );
    }
    for field in ["firstSpanAt", "lastSpanAt", "partialFailure"] {
        assert_eq!(
            diagnostics[field],
            json!({ "_id": "Option", "_tag": "None" })
        );
    }
    assert_eq!(diagnostics["error"]["_tag"], "Some");
    assert_eq!(
        diagnostics["error"]["value"]["kind"],
        "trace-file-not-found"
    );

    let lifecycle_cancel = CancellationToken::new();
    let mut lifecycle = control.subscribe("subscribeServerLifecycle", lifecycle_cancel.clone());
    assert_eq!(next_event(&mut lifecycle).await["type"], "welcome");
    assert_eq!(next_event(&mut lifecycle).await["type"], "ready");
    lifecycle_cancel.cancel();

    let discovery_cancel = CancellationToken::new();
    let mut discovery =
        control.subscribe("subscribeDiscoveredLocalServers", discovery_cancel.clone());
    let discovered = next_event(&mut discovery).await;
    assert_eq!(discovered["servers"], json!([]));
    assert!(discovered["scannedAt"].is_string());
    discovery_cancel.cancel();
}

#[tokio::test]
async fn provider_update_reports_the_contract_error_when_native_update_is_unavailable() {
    let (_directory, control) = fixture().await;
    let error = control
        .call(
            "server.updateProvider",
            json!({ "provider": "grok" }),
            CancellationToken::new(),
        )
        .await
        .expect_err("manual-only provider update must fail");
    assert_eq!(error["_tag"], "ServerProviderUpdateError");
    assert_eq!(error["provider"], "grok");
    assert!(
        error["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty())
    );
}
