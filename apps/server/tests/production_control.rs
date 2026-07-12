use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};
use t4code_server::{
    ServerConfig,
    production::{control::NativeServerControl, server_terminal::ProductionServerControl},
};
use tempfile::TempDir;
use tokio::net::TcpListener;
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

async fn fixture_with_state_file(
    relative_path: &str,
    contents: &[u8],
) -> (TempDir, NativeServerControl) {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let path = directory.path().join("userdata").join(relative_path);
    tokio::fs::create_dir_all(path.parent().expect("state file parent"))
        .await
        .expect("create state directory");
    tokio::fs::write(path, contents)
        .await
        .expect("write state fixture");
    let mut config = ServerConfig::new(directory.path());
    config.environment_id = "test-environment".into();
    config.environment_label = "Test Environment".into();
    let control = NativeServerControl::new(config, auth_descriptor()).await;
    (directory, control)
}

async fn write_provider_fixture(directory: &TempDir) -> PathBuf {
    #[cfg(windows)]
    let (name, contents) = (
        "provider.cmd",
        "@echo off\r\nif \"%1\"==\"about\" (echo {\"cliVersion\":\"9.8.7\",\"userEmail\":\"dev@example.com\",\"subscriptionTier\":\"pro\"}& exit /b 0)\r\necho provider 1.0.0\r\n",
    );
    #[cfg(not(windows))]
    let (name, contents) = (
        "provider",
        "#!/bin/sh\nif [ \"$1\" = \"about\" ]; then\n  echo '{\"cliVersion\":\"9.8.7\",\"userEmail\":\"dev@example.com\",\"subscriptionTier\":\"pro\"}'\nelse\n  echo 'provider 1.0.0'\nfi\n",
    );
    let path = directory.path().join(name);
    tokio::fs::write(&path, contents)
        .await
        .expect("write provider fixture");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = tokio::fs::metadata(&path)
            .await
            .expect("provider fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&path, permissions)
            .await
            .expect("make provider fixture executable");
    }
    path
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
            assert!(matches!(
                provider["auth"]["status"].as_str(),
                Some("authenticated" | "unauthenticated" | "unknown")
            ));
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
async fn malformed_keybinding_config_is_reported_instead_of_silently_replaced() {
    let (_directory, control) = fixture_with_state_file("keybindings.json", b"{not-json").await;

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["keybindings"], json!([]));
    assert_eq!(config["issues"][0]["kind"], "keybindings.malformed-config");
    assert!(
        config["issues"][0]["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty())
    );
}

#[tokio::test]
async fn invalid_keybinding_entries_are_reported_by_original_index_while_valid_entries_survive() {
    let rules = json!([
        { "key": "ctrl+k", "command": "terminal.toggle" },
        { "key": "ctrl+shift", "command": "terminal.toggle" },
        "not-an-object"
    ]);
    let (_directory, control) = fixture_with_state_file(
        "keybindings.json",
        &serde_json::to_vec(&rules).expect("serialize keybindings fixture"),
    )
    .await;

    let config = call(&control, "server.getConfig", json!({})).await;
    assert_eq!(config["keybindings"].as_array().unwrap().len(), 1);
    assert_eq!(config["keybindings"][0]["command"], "terminal.toggle");
    assert_eq!(config["issues"].as_array().unwrap().len(), 2);
    assert_eq!(config["issues"][0]["kind"], "keybindings.invalid-entry");
    assert_eq!(config["issues"][0]["index"], 1);
    assert_eq!(config["issues"][1]["index"], 2);
}

#[tokio::test]
async fn provider_inventory_uses_provider_specific_status_and_configured_models() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let executable = write_provider_fixture(&directory).await;
    let settings = json!({
        "providers": {
            "cursor": {
                "enabled": true,
                "binaryPath": executable,
                "customModels": []
            }
        },
        "providerInstances": {
            "cursor-work": {
                "driver": "cursor",
                "enabled": true,
                "config": { "customModels": ["cursor/custom-test"] }
            }
        }
    });
    let settings_path = directory.path().join("userdata/settings.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .expect("create settings directory");
    tokio::fs::write(
        settings_path,
        serde_json::to_vec(&settings).expect("serialize settings fixture"),
    )
    .await
    .expect("write settings fixture");
    let control =
        NativeServerControl::new(ServerConfig::new(directory.path()), auth_descriptor()).await;

    let config = call(&control, "server.getConfig", json!({})).await;
    let provider = &config["providers"][0];
    assert_eq!(provider["instanceId"], "cursor-work");
    assert_eq!(provider["status"], "ready");
    assert_eq!(provider["version"], "9.8.7");
    assert_eq!(provider["auth"]["status"], "authenticated");
    assert_eq!(provider["auth"]["email"], "dev@example.com");
    assert!(
        provider["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| { model["slug"] == "cursor/custom-test" && model["isCustom"] == true })
    );
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

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local listener");
    let port = listener.local_addr().expect("listener address").port();
    let discovery_cancel = CancellationToken::new();
    let mut discovery =
        control.subscribe("subscribeDiscoveredLocalServers", discovery_cancel.clone());
    let discovered = next_event(&mut discovery).await;
    assert!(discovered["scannedAt"].is_string());
    assert!(
        discovered["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|server| {
                server["host"] == "127.0.0.1"
                    && server["port"] == port
                    && server["url"] == format!("http://127.0.0.1:{port}/")
            })
    );

    drop(listener);
    let rescanned = timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = next_event(&mut discovery).await;
            if snapshot["servers"]
                .as_array()
                .is_some_and(|servers| servers.iter().all(|server| server["port"] != port))
            {
                break snapshot;
            }
        }
    })
    .await
    .expect("periodic discovery removes closed listener");
    assert!(rescanned["scannedAt"].is_string());
    discovery_cancel.cancel();
    assert!(
        timeout(Duration::from_secs(2), discovery.recv())
            .await
            .expect("discovery cancellation timeout")
            .is_none()
    );
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
