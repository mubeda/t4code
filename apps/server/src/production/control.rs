use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    diagnostics::TraceDiagnosticsStore,
    persistence::{read_json, write_bytes_atomically, write_json_atomically},
    production::{
        keybindings, local_servers, provider_inventory,
        server_terminal::{JsonFuture, JsonStream, ProductionServerControl},
    },
};

const MAX_KEYBINDINGS: usize = 256;

#[derive(Clone, Debug)]
pub struct NativeServerControl {
    config: ServerConfig,
    auth_descriptor: Value,
    state_directory: PathBuf,
    settings_path: PathBuf,
    keybindings_path: PathBuf,
    settings: Arc<RwLock<Value>>,
    keybinding_rules: Arc<RwLock<Vec<Value>>>,
    keybinding_issues: Arc<RwLock<Vec<Value>>>,
    providers: Arc<RwLock<Vec<Value>>>,
    config_events: broadcast::Sender<Value>,
    trace_diagnostics: TraceDiagnosticsStore,
}

impl NativeServerControl {
    pub async fn new(config: ServerConfig, auth_descriptor: Value) -> Self {
        let trace_diagnostics =
            TraceDiagnosticsStore::new(config.state_dir().join("logs/server.trace.ndjson"));
        Self::with_trace_diagnostics(config, auth_descriptor, trace_diagnostics).await
    }

    pub async fn with_trace_diagnostics(
        config: ServerConfig,
        auth_descriptor: Value,
        trace_diagnostics: TraceDiagnosticsStore,
    ) -> Self {
        let state_directory = config.state_dir();
        let settings_path = state_directory.join("settings.json");
        let keybindings_path = state_directory.join("keybindings.json");
        let mut settings = read_json::<Value>(&settings_path)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| json!({}));
        apply_settings_defaults(&mut settings);
        redact_sensitive_environment(&mut settings);
        let loaded_keybindings = keybindings::load(&keybindings_path).await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| config.base_dir.clone());
        let providers = provider_inventory::probe(&settings, None, &cwd).await;
        let (config_events, _) = broadcast::channel(32);
        Self {
            config,
            auth_descriptor,
            state_directory,
            settings_path,
            keybindings_path,
            settings: Arc::new(RwLock::new(settings)),
            keybinding_rules: Arc::new(RwLock::new(loaded_keybindings.rules)),
            keybinding_issues: Arc::new(RwLock::new(loaded_keybindings.issues)),
            providers: Arc::new(RwLock::new(providers)),
            config_events,
            trace_diagnostics,
        }
    }

    pub async fn config_snapshot(&self) -> Value {
        let settings = self.settings.read().await.clone();
        let rules = self.keybinding_rules.read().await.clone();
        let issues = self.keybinding_issues.read().await.clone();
        let providers = self.providers.read().await.clone();
        let cwd = current_directory(&self.config);
        json!({
            "environment": environment_descriptor(&self.config),
            "auth": self.auth_descriptor,
            "cwd": cwd,
            "keybindingsConfigPath": self.keybindings_path.to_string_lossy(),
            "keybindings": keybindings::resolve(&rules),
            "issues": issues,
            "providers": providers,
            "availableEditors": available_editors(),
            "observability": observability_snapshot(&settings, &self.state_directory),
            "settings": settings,
        })
    }

    async fn update_settings(&self, payload: Value) -> Result<Value, Value> {
        let patch = payload.get("patch").cloned().ok_or_else(|| {
            settings_error(&self.settings_path, "normalize", "missing settings patch")
        })?;
        if !patch.is_object() {
            return Err(settings_error(
                &self.settings_path,
                "normalize",
                "settings patch must be an object",
            ));
        }

        let current = self.settings.read().await.clone();
        let mut next = current;
        apply_settings_patch(&mut next, patch);
        apply_settings_defaults(&mut next);
        persist_sensitive_environment(&self.state_directory, &mut next)
            .await
            .map_err(|message| settings_error(&self.settings_path, "write-secret", &message))?;
        write_json_atomically(&self.settings_path, &next)
            .await
            .map_err(|error| {
                settings_error(&self.settings_path, "write-file", &error.to_string())
            })?;
        redact_sensitive_environment(&mut next);
        *self.settings.write().await = next.clone();

        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let providers = provider_inventory::probe(&next, None, &cwd).await;
        *self.providers.write().await = providers;
        self.publish(json!({
            "version": 1,
            "type": "settingsUpdated",
            "payload": { "settings": next.clone() },
        }));
        Ok(next)
    }

    async fn refresh_providers(&self, payload: &Value) -> Value {
        let instance_id = payload.get("instanceId").and_then(Value::as_str);
        let settings = self.settings.read().await.clone();
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let providers = provider_inventory::probe(&settings, instance_id, &cwd).await;
        if instance_id.is_some() {
            let mut current = self.providers.write().await;
            for refreshed in providers {
                if let Some(id) = refreshed.get("instanceId").and_then(Value::as_str)
                    && let Some(position) = current.iter().position(|row| row["instanceId"] == id)
                {
                    current[position] = refreshed;
                }
            }
        } else {
            *self.providers.write().await = providers;
        }
        let providers = self.providers.read().await.clone();
        self.publish(json!({
            "version": 1,
            "type": "providerStatuses",
            "payload": { "providers": providers.clone() },
        }));
        json!({ "providers": providers })
    }

    async fn update_keybinding(&self, method: &str, payload: Value) -> Result<Value, Value> {
        keybindings::validate(&payload, method == "server.upsertKeybinding")
            .map_err(|detail| keybindings_error(&self.keybindings_path, &detail))?;
        let mut rules = self.keybinding_rules.write().await;
        if method == "server.removeKeybinding" {
            rules.retain(|rule| !keybindings::same_rule(rule, &payload));
        } else {
            let target = payload.get("replace").unwrap_or(&payload);
            rules.retain(|rule| !keybindings::same_rule(rule, target));
            let mut rule = payload;
            rule.as_object_mut()
                .expect("validated object")
                .remove("replace");
            rules.push(rule);
            if rules.len() > MAX_KEYBINDINGS {
                let excess = rules.len() - MAX_KEYBINDINGS;
                rules.drain(..excess);
            }
        }
        write_json_atomically(&self.keybindings_path, &*rules)
            .await
            .map_err(|error| keybindings_error(&self.keybindings_path, &error.to_string()))?;
        self.keybinding_issues.write().await.clear();
        let result = json!({ "keybindings": keybindings::resolve(&rules), "issues": [] });
        self.publish(json!({
            "version": 1,
            "type": "keybindingsUpdated",
            "payload": result.clone(),
        }));
        Ok(result)
    }

    fn publish(&self, event: Value) {
        let _ = self.config_events.send(event);
    }

    fn trace_diagnostics(&self) -> Value {
        self.trace_diagnostics.read()
    }
}

impl ProductionServerControl for NativeServerControl {
    fn call(
        &self,
        method: &'static str,
        payload: Value,
        cancellation: CancellationToken,
    ) -> JsonFuture {
        let control = self.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(json!({ "_tag": "RequestCancelled", "method": method }));
            }
            match method {
                "server.getConfig" => Ok(control.config_snapshot().await),
                "server.getSettings" => Ok(control.settings.read().await.clone()),
                "server.updateSettings" => control.update_settings(payload).await,
                "server.refreshProviders" => Ok(control.refresh_providers(&payload).await),
                "server.updateProvider" => {
                    let provider = payload
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    Err(json!({
                        "_tag": "ServerProviderUpdateError",
                        "provider": provider,
                        "reason": "This provider does not expose a safe native self-update command.",
                    }))
                }
                "server.upsertKeybinding" | "server.removeKeybinding" => {
                    control.update_keybinding(method, payload).await
                }
                "server.getTraceDiagnostics" => Ok(control.trace_diagnostics()),
                _ => Err(json!({
                    "_tag": "InvalidRequest",
                    "method": method,
                    "message": "Unsupported native server-control request.",
                })),
            }
        })
    }

    fn subscribe(&self, method: &'static str, cancellation: CancellationToken) -> JsonStream {
        let (sender, receiver) = mpsc::channel(8);
        let control = self.clone();
        tokio::spawn(async move {
            match method {
                "subscribeServerConfig" => {
                    let mut updates = control.config_events.subscribe();
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "type": "snapshot",
                            "config": control.config_snapshot().await,
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    loop {
                        tokio::select! {
                            () = cancellation.cancelled() => return,
                            event = updates.recv() => match event {
                                Ok(event) => {
                                    if send_event(&sender, event).await.is_err() {
                                        return;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {}
                                Err(broadcast::error::RecvError::Closed) => return,
                            }
                        }
                    }
                }
                "subscribeDiscoveredLocalServers" => loop {
                    let servers = local_servers::discover(&cancellation).await;
                    if cancellation.is_cancelled()
                        || send_event(
                            &sender,
                            json!({ "servers": servers, "scannedAt": now_iso() }),
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::select! {
                        () = cancellation.cancelled() => return,
                        () = tokio::time::sleep(local_servers::SCAN_INTERVAL) => {}
                    }
                },
                "subscribeServerLifecycle" => {
                    let cwd = current_directory(&control.config);
                    let project_name = Path::new(&cwd)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or("T4Code");
                    let environment = environment_descriptor(&control.config);
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "sequence": 1,
                            "type": "welcome",
                            "payload": {
                                "environment": environment,
                                "cwd": cwd,
                                "projectName": project_name,
                            },
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    if send_event(
                        &sender,
                        json!({
                            "version": 1,
                            "sequence": 2,
                            "type": "ready",
                            "payload": {
                                "at": now_iso(),
                                "environment": environment_descriptor(&control.config),
                            },
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    cancellation.cancelled().await;
                }
                _ => {}
            }
        });
        receiver
    }
}

async fn send_event(
    sender: &mpsc::Sender<Result<Vec<Value>, Value>>,
    event: Value,
) -> Result<(), ()> {
    sender.send(Ok(vec![event])).await.map_err(|_| ())
}

fn apply_settings_defaults(settings: &mut Value) {
    if !settings.is_object() {
        *settings = json!({});
    }
    merge_missing(
        settings,
        &json!({
            "enableAssistantStreaming": false,
            "enableProviderUpdateChecks": true,
            "automaticGitFetchInterval": 30_000,
            "defaultThreadEnvMode": "local",
            "newWorktreesStartFromOrigin": false,
            "addProjectBaseDirectory": "",
            "textGenerationModelSelection": {
                "instanceId": "codex",
                "model": "gpt-5.4-mini",
            },
            "providers": {
                "codex": { "enabled": true, "binaryPath": "codex", "homePath": "", "shadowHomePath": "", "customModels": [] },
                "claudeAgent": { "enabled": true, "binaryPath": "claude", "homePath": "", "customModels": [], "launchArgs": "" },
                "cursor": { "enabled": false, "binaryPath": "agent", "apiEndpoint": "", "customModels": [] },
                "grok": { "enabled": true, "binaryPath": "grok", "customModels": [] },
                "opencode": { "enabled": true, "binaryPath": "opencode", "serverUrl": "", "serverPassword": "", "customModels": [] },
            },
            "providerInstances": {},
            "observability": { "otlpTracesUrl": "", "otlpMetricsUrl": "" },
        }),
    );
}

fn merge_missing(target: &mut Value, defaults: &Value) {
    if let (Some(target), Some(defaults)) = (target.as_object_mut(), defaults.as_object()) {
        for (key, default) in defaults {
            match target.get_mut(key) {
                Some(value) if value.is_object() && default.is_object() => {
                    merge_missing(value, default)
                }
                Some(_) => {}
                None => {
                    target.insert(key.clone(), default.clone());
                }
            }
        }
    }
}

fn apply_settings_patch(target: &mut Value, patch: Value) {
    let Some(patch) = patch.as_object() else {
        return;
    };
    let target = target.as_object_mut().expect("settings object");
    for (key, value) in patch {
        if key == "providerInstances" || key == "automaticGitFetchInterval" {
            target.insert(key.clone(), value.clone());
            continue;
        }
        if key == "textGenerationModelSelection"
            && value.as_object().is_some_and(|selection| {
                selection.contains_key("instanceId") || selection.contains_key("model")
            })
        {
            target.insert(key.clone(), value.clone());
            continue;
        }
        match target.get_mut(key) {
            Some(existing) if existing.is_object() && value.is_object() => {
                merge_patch(existing, value.clone());
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn merge_patch(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                match target.get_mut(&key) {
                    Some(existing) if existing.is_object() && value.is_object() => {
                        merge_patch(existing, value);
                    }
                    _ => {
                        target.insert(key, value);
                    }
                }
            }
        }
        (target, patch) => *target = patch,
    }
}

async fn persist_sensitive_environment(root: &Path, settings: &mut Value) -> Result<(), String> {
    let Some(instances) = settings
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };
    for (instance_id, instance) in instances {
        let Some(environment) = instance
            .get_mut("environment")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for variable in environment {
            if variable.get("sensitive").and_then(Value::as_bool) != Some(true) {
                variable
                    .as_object_mut()
                    .map(|object| object.remove("valueRedacted"));
                continue;
            }
            let name = variable
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = variable
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !value.is_empty() {
                let path = secret_path(root, instance_id, name);
                write_bytes_atomically(path, value.as_bytes())
                    .await
                    .map_err(|error| error.to_string())?;
            }
            let variable = variable
                .as_object_mut()
                .expect("environment variable object");
            variable.insert("value".into(), json!(""));
            variable.insert("valueRedacted".into(), json!(true));
        }
    }
    Ok(())
}

fn redact_sensitive_environment(settings: &mut Value) {
    let Some(instances) = settings
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for instance in instances.values_mut() {
        let Some(environment) = instance
            .get_mut("environment")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for variable in environment {
            if variable.get("sensitive").and_then(Value::as_bool) == Some(true) {
                let object = variable
                    .as_object_mut()
                    .expect("environment variable object");
                object.insert("value".into(), json!(""));
                object.insert("valueRedacted".into(), json!(true));
            } else if let Some(object) = variable.as_object_mut() {
                object.remove("valueRedacted");
            }
        }
    }
}

fn secret_path(root: &Path, instance_id: &str, name: &str) -> PathBuf {
    root.join("secrets").join(format!(
        "provider-env-{}-{}",
        URL_SAFE_NO_PAD.encode(instance_id),
        URL_SAFE_NO_PAD.encode(name),
    ))
}

fn observability_snapshot(settings: &Value, state_directory: &Path) -> Value {
    let observability = settings.get("observability").and_then(Value::as_object);
    let traces = observability
        .and_then(|value| value.get("otlpTracesUrl"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let metrics = observability
        .and_then(|value| value.get("otlpMetricsUrl"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut result = json!({
        "logsDirectoryPath": state_directory.join("logs").to_string_lossy(),
        "localTracingEnabled": true,
        "otlpTracesEnabled": !traces.is_empty(),
        "otlpMetricsEnabled": !metrics.is_empty(),
    });
    if !traces.is_empty() {
        result["otlpTracesUrl"] = json!(traces);
    }
    if !metrics.is_empty() {
        result["otlpMetricsUrl"] = json!(metrics);
    }
    result
}

fn settings_error(path: &Path, operation: &str, cause: &str) -> Value {
    json!({
        "_tag": "ServerSettingsError",
        "settingsPath": path.to_string_lossy(),
        "operation": operation,
        "cause": cause,
    })
}

fn keybindings_error(path: &Path, detail: &str) -> Value {
    json!({
        "_tag": "KeybindingsConfigParseError",
        "configPath": path.to_string_lossy(),
        "detail": detail,
    })
}

fn current_directory(config: &ServerConfig) -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| config.base_dir.clone())
        .to_string_lossy()
        .into_owned()
}

fn environment_descriptor(config: &ServerConfig) -> Value {
    json!({
        "environmentId": config.environment_id,
        "label": config.environment_label,
        "platform": { "os": platform_os(), "arch": platform_arch() },
        "serverVersion": config.server_version,
        "capabilities": { "repositoryIdentity": true },
    })
}

fn available_editors() -> Vec<&'static str> {
    [
        ("code", "vscode"),
        ("cursor", "cursor"),
        ("idea", "intellij"),
        ("zed", "zed"),
    ]
    .into_iter()
    .filter_map(|(binary, id)| command_exists(binary).then_some(id))
    .collect()
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            let direct = directory.join(command);
            direct.is_file()
                || (cfg!(windows)
                    && ["exe", "cmd", "bat"]
                        .into_iter()
                        .any(|extension| direct.with_extension(extension).is_file()))
        })
    })
}

const fn platform_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

const fn platform_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "other"
    }
}

pub(crate) fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
