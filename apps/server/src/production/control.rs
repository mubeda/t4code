use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
#[cfg(test)]
use tokio::sync::Barrier;
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};
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
    settings_update_lock: Arc<Mutex<()>>,
    settings_load_error: Option<Value>,
    #[cfg(test)]
    settings_update_barrier: Arc<RwLock<Option<Arc<Barrier>>>>,
    keybinding_rules: Arc<RwLock<Vec<Value>>>,
    keybinding_issues: Arc<RwLock<Vec<Value>>>,
    providers: Arc<RwLock<Vec<Value>>>,
    full_provider_refresh_running: Arc<AtomicBool>,
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
        let (mut settings, settings_load_error) = match read_json::<Value>(&settings_path).await {
            Ok(Some(settings)) => (settings, None),
            Ok(None) => (json!({}), None),
            Err(error) => (
                json!({}),
                Some(settings_error(
                    &settings_path,
                    "read-file",
                    &error.to_string(),
                )),
            ),
        };
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
            settings: Arc::new(RwLock::new(settings.clone())),
            settings_update_lock: Arc::new(Mutex::new(())),
            settings_load_error,
            #[cfg(test)]
            settings_update_barrier: Arc::new(RwLock::new(None)),
            keybinding_rules: Arc::new(RwLock::new(loaded_keybindings.rules)),
            keybinding_issues: Arc::new(RwLock::new(loaded_keybindings.issues)),
            providers: Arc::new(RwLock::new(providers)),
            full_provider_refresh_running: Arc::new(AtomicBool::new(false)),
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

        #[cfg(test)]
        if let Some(barrier) = self.settings_update_barrier.read().await.clone() {
            barrier.wait().await;
        }
        let _update_guard = self.settings_update_lock.lock().await;
        if let Some(error) = &self.settings_load_error {
            return Err(error.clone());
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
        drop(_update_guard);

        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let providers = provider_inventory::probe(&next, None, &cwd).await;
        self.publish(json!({
            "version": 1,
            "type": "settingsUpdated",
            "payload": { "settings": next.clone() },
        }));
        let providers = self.merge_provider_snapshots(providers, false).await;
        self.publish_provider_snapshots(&providers);
        self.spawn_full_provider_refresh(next.clone(), cwd);
        Ok(next)
    }

    #[cfg(test)]
    async fn install_settings_update_barrier(&self, parties: usize) {
        *self.settings_update_barrier.write().await = Some(Arc::new(Barrier::new(parties)));
    }

    async fn refresh_providers(&self, payload: &Value) -> Value {
        let instance_id = payload.get("instanceId").and_then(Value::as_str);
        let settings = self.settings.read().await.clone();
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let providers = provider_inventory::probe_full(&settings, instance_id, &cwd).await;
        let providers = self
            .merge_provider_snapshots(providers, instance_id.is_some())
            .await;
        self.publish_provider_snapshots(&providers);
        json!({ "providers": providers })
    }

    async fn merge_provider_snapshots(&self, refreshed: Vec<Value>, partial: bool) -> Vec<Value> {
        let mut current = self.providers.write().await;
        if partial {
            for provider in refreshed {
                let Some(id) = provider.get("instanceId").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(position) = current.iter().position(|row| row["instanceId"] == id) {
                    current[position] = provider;
                } else {
                    current.push(provider);
                }
            }
        } else {
            *current = refreshed;
        }
        current.clone()
    }

    fn publish_provider_snapshots(&self, providers: &[Value]) {
        self.publish(json!({
            "version": 1,
            "type": "providerStatuses",
            "payload": { "providers": providers },
        }));
    }

    fn spawn_full_provider_refresh(&self, mut settings: Value, cwd: PathBuf) {
        if self
            .full_provider_refresh_running
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let control = self.clone();
        tokio::spawn(async move {
            loop {
                let providers = provider_inventory::probe_full(&settings, None, &cwd).await;
                let latest_settings = control.settings.read().await.clone();
                if latest_settings != settings {
                    settings = latest_settings;
                    continue;
                }
                let providers = control.merge_provider_snapshots(providers, false).await;
                control.publish_provider_snapshots(&providers);
                break;
            }
            control
                .full_provider_refresh_running
                .store(false, Ordering::Release);
            let latest_settings = control.settings.read().await.clone();
            if latest_settings != settings {
                control.spawn_full_provider_refresh(latest_settings, cwd);
            }
        });
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
                "server.getConfig" => match &control.settings_load_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(control.config_snapshot().await),
                },
                "server.getSettings" => match &control.settings_load_error {
                    Some(error) => Err(error.clone()),
                    None => Ok(control.settings.read().await.clone()),
                },
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
                    if let Some(error) = &control.settings_load_error {
                        let _ = sender.send(Err(error.clone())).await;
                        return;
                    }
                    let settings = control.settings.read().await.clone();
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| control.config.base_dir.clone());
                    control.spawn_full_provider_refresh(settings, cwd);
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
                "cursor": { "enabled": false, "binaryPath": "cursor-agent", "apiEndpoint": "", "customModels": [] },
                "grok": { "enabled": true, "binaryPath": "grok", "customModels": [] },
                "opencode": { "enabled": true, "binaryPath": "opencode", "serverUrl": "", "serverPassword": "", "customModels": [] },
            },
            "providerInstances": {},
            "providerSessionDefaults": {},
            "observability": { "otlpTracesUrl": "", "otlpMetricsUrl": "" },
            "terminal": { "webglEnabled": true },
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
        if key == "providerInstances"
            || key == "providerSessionDefaults"
            || key == "automaticGitFetchInterval"
        {
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

#[cfg(test)]
mod tests {
    use crate::production::server_terminal::ProductionServerControl;

    use super::*;

    #[test]
    fn provider_session_defaults_are_defaulted_and_replaced_as_a_whole() {
        let mut settings = json!({
            "providers": {
                "codex": {
                    "enabled": false,
                    "binaryPath": "/opt/bin/codex"
                }
            },
            "providerInstances": {
                "work": {
                    "driver": "codex",
                    "displayName": "Work"
                }
            }
        });

        apply_settings_defaults(&mut settings);
        assert_eq!(settings["providerSessionDefaults"], json!({}));
        let providers = settings["providers"].clone();
        let provider_instances = settings["providerInstances"].clone();

        apply_settings_patch(
            &mut settings,
            json!({
                "providerSessionDefaults": {
                    "codex": {
                        "model": "gpt-5.4",
                        "options": [{"id": "reasoningEffort", "value": "medium"}]
                    },
                    "claudeAgent": {
                        "model": "claude-sonnet-4-6"
                    }
                }
            }),
        );
        assert_eq!(
            settings["providerSessionDefaults"],
            json!({
                "codex": {
                    "model": "gpt-5.4",
                    "options": [{"id": "reasoningEffort", "value": "medium"}]
                },
                "claudeAgent": {
                    "model": "claude-sonnet-4-6"
                }
            })
        );
        assert_eq!(settings["providers"], providers);
        assert_eq!(settings["providerInstances"], provider_instances);

        apply_settings_patch(
            &mut settings,
            json!({
                "providerSessionDefaults": {
                    "codex": {
                        "model": "gpt-5.4-mini",
                        "options": [{"id": "fastMode", "value": true}]
                    }
                }
            }),
        );
        assert_eq!(
            settings["providerSessionDefaults"],
            json!({
                "codex": {
                    "model": "gpt-5.4-mini",
                    "options": [{"id": "fastMode", "value": true}]
                }
            })
        );
        assert_eq!(settings["providers"], providers);
        assert_eq!(settings["providerInstances"], provider_instances);

        let provider_session_defaults = settings["providerSessionDefaults"].clone();
        apply_settings_patch(
            &mut settings,
            json!({"observability":{"otlpTracesUrl":"https://traces.example"}}),
        );
        assert_eq!(
            settings["providerSessionDefaults"],
            provider_session_defaults
        );
    }

    #[tokio::test]
    async fn server_settings_expose_terminal_webgl_default_and_patch() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-webgl".to_owned();
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("settings");
        assert_eq!(settings["terminal"]["webglEnabled"], true);

        let updated = control
            .update_settings(json!({ "patch": { "terminal": { "webglEnabled": false } } }))
            .await
            .expect("patch applies");
        assert_eq!(updated["terminal"]["webglEnabled"], false);
        assert_eq!(updated["enableProviderUpdateChecks"], true);
    }

    #[tokio::test]
    async fn concurrent_settings_updates_preserve_every_committed_patch() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-concurrent-settings".to_owned();
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        control.install_settings_update_barrier(24).await;

        let updates = (0..24)
            .map(|index| {
                let control = control.clone();
                tokio::spawn(async move {
                    control
                        .update_settings(json!({
                            "patch": {
                                "concurrentUpdates": {
                                    format!("update-{index}"): true
                                },
                                "providerInstances": {
                                    "concurrency-test": {
                                        "driver": "codex",
                                        "environment": [{
                                            "name": "TOKEN",
                                            "value": format!("secret-{index}"),
                                            "sensitive": true
                                        }]
                                    }
                                }
                            }
                        }))
                        .await
                })
            })
            .collect::<Vec<_>>();
        for update in updates {
            update
                .await
                .expect("settings task joins")
                .expect("settings update succeeds");
        }

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("settings remain readable");
        for index in 0..24 {
            assert_eq!(
                settings["concurrentUpdates"][format!("update-{index}")],
                true
            );
        }
        let persisted = read_json::<Value>(control.settings_path.clone())
            .await
            .expect("settings file reads")
            .expect("settings file exists");
        assert_eq!(
            persisted["concurrentUpdates"],
            settings["concurrentUpdates"]
        );
    }

    #[tokio::test]
    async fn malformed_settings_surface_structured_errors_and_refuse_mutation() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(&settings_path, b"{not-json")
            .await
            .expect("malformed settings fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let read_error = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect_err("malformed settings are not presented as defaults");
        assert_eq!(read_error["_tag"], "ServerSettingsError");
        assert_eq!(read_error["operation"], "read-file");
        assert_eq!(
            control
                .call("server.getConfig", json!({}), CancellationToken::new())
                .await
                .expect_err("malformed settings reject config reads"),
            read_error
        );
        let mut config_stream =
            control.subscribe("subscribeServerConfig", CancellationToken::new());
        assert_eq!(
            config_stream
                .recv()
                .await
                .expect("config stream reports its load failure")
                .expect_err("malformed settings reject config subscriptions"),
            read_error
        );

        let update_error = control
            .update_settings(json!({"patch":{"enableAssistantStreaming":true}}))
            .await
            .expect_err("malformed settings refuse mutation");
        assert_eq!(update_error, read_error);
        assert_eq!(
            tokio::fs::read(&settings_path)
                .await
                .expect("malformed file remains readable"),
            b"{not-json"
        );
    }

    #[tokio::test]
    async fn unit_build_covers_server_control_settings_keybindings_and_streams() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-1".to_owned();
        config.environment_label = "Environment One".to_owned();
        let control = NativeServerControl::new(config.clone(), json!({"policy":"test"})).await;

        let snapshot = control.config_snapshot().await;
        assert_eq!(snapshot["environment"]["environmentId"], "environment-1");
        assert_eq!(snapshot["auth"]["policy"], "test");
        assert!(!current_directory(&config).is_empty());
        assert!(!platform_os().is_empty());
        assert!(!platform_arch().is_empty());
        assert!(environment_descriptor(&config)["capabilities"]["repositoryIdentity"] == true);
        let _ = available_editors();
        assert!(!command_exists("definitely-not-a-t4code-editor"));

        let call = |method, payload, cancellation| control.call(method, payload, cancellation);
        assert!(
            call("server.getSettings", json!({}), CancellationToken::new())
                .await
                .expect("settings")
                .is_object()
        );
        assert!(
            call("server.getConfig", json!({}), CancellationToken::new())
                .await
                .expect("config")
                .is_object()
        );
        assert_eq!(
            call(
                "server.updateProvider",
                json!({"provider":"codex"}),
                CancellationToken::new(),
            )
            .await
            .expect_err("provider update unavailable")["_tag"],
            "ServerProviderUpdateError"
        );
        assert_eq!(
            call("server.unknown", json!({}), CancellationToken::new())
                .await
                .expect_err("unknown method")["_tag"],
            "InvalidRequest"
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(
            call("server.getConfig", json!({}), cancelled)
                .await
                .expect_err("cancelled call")["_tag"],
            "RequestCancelled"
        );
        assert_eq!(
            control
                .update_settings(json!({}))
                .await
                .expect_err("missing patch")["operation"],
            "normalize"
        );
        assert!(control.update_settings(json!({"patch":[]})).await.is_err());

        let updated = control
            .update_settings(json!({
                "patch":{
                    "enableAssistantStreaming":true,
                    "observability":{
                        "otlpTracesUrl":"https://traces.example",
                        "otlpMetricsUrl":"https://metrics.example"
                    },
                    "providerInstances":{
                        "work":{
                            "driver":"codex",
                            "environment":[
                                {"name":"TOKEN","value":"secret","sensitive":true},
                                {"name":"PLAIN","value":"visible","sensitive":false}
                            ]
                        }
                    }
                }
            }))
            .await
            .expect("settings update");
        assert_eq!(updated["enableAssistantStreaming"], true);
        assert_eq!(
            updated["providerInstances"]["work"]["environment"][0]["valueRedacted"],
            true
        );
        assert!(secret_path(&control.state_directory, "work", "TOKEN").is_file());
        let observability = observability_snapshot(&updated, &control.state_directory);
        assert_eq!(observability["otlpTracesEnabled"], true);
        assert_eq!(observability["otlpMetricsEnabled"], true);

        let mut merge_target = json!({"nested":{"left":1},"replace":1});
        merge_patch(
            &mut merge_target,
            json!({"nested":{"right":2},"replace":{"value":3}}),
        );
        assert_eq!(merge_target["nested"], json!({"left":1,"right":2}));
        assert_eq!(merge_target["replace"]["value"], 3);
        merge_patch(&mut merge_target, json!("scalar"));
        assert_eq!(merge_target, "scalar");
        let mut defaults = Value::Null;
        apply_settings_defaults(&mut defaults);
        apply_settings_patch(
            &mut defaults,
            json!({
                "automaticGitFetchInterval":5000,
                "textGenerationModelSelection":{"model":"custom"},
                "providers":{"codex":{"enabled":false}}
            }),
        );
        assert_eq!(defaults["providers"]["codex"]["enabled"], false);

        let added = control
            .update_keybinding(
                "server.upsertKeybinding",
                json!({"key":"ctrl+shift+k","command":"terminal.toggle"}),
            )
            .await
            .expect("keybinding adds");
        assert!(
            !added["keybindings"]
                .as_array()
                .expect("keybindings")
                .is_empty()
        );
        let removed = control
            .update_keybinding(
                "server.removeKeybinding",
                json!({"key":"ctrl+shift+k","command":"terminal.toggle"}),
            )
            .await
            .expect("keybinding removes");
        assert!(
            removed["keybindings"]
                .as_array()
                .expect("keybindings")
                .is_empty()
        );
        assert!(
            control
                .update_keybinding("server.upsertKeybinding", json!({"key":"bad"}))
                .await
                .is_err()
        );
        assert_eq!(
            settings_error(Path::new("settings.json"), "read", "bad")["_tag"],
            "ServerSettingsError"
        );
        assert_eq!(
            keybindings_error(Path::new("keys.json"), "bad")["_tag"],
            "KeybindingsConfigParseError"
        );

        let refreshed = control.refresh_providers(&json!({})).await;
        assert!(refreshed["providers"].is_array());
        let _ = control
            .merge_provider_snapshots(
                vec![json!({"instanceId":"unit-provider","status":"disabled"})],
                true,
            )
            .await;
        control.publish_provider_snapshots(&[json!({"instanceId":"unit-provider"})]);
        control.publish(json!({"type":"unit"}));
        assert!(control.trace_diagnostics().is_object());

        let lifecycle_cancellation = CancellationToken::new();
        let mut lifecycle =
            control.subscribe("subscribeServerLifecycle", lifecycle_cancellation.clone());
        let welcome = lifecycle
            .recv()
            .await
            .expect("lifecycle stream")
            .expect("welcome batch");
        assert_eq!(welcome[0]["type"], "welcome");
        let ready = lifecycle
            .recv()
            .await
            .expect("lifecycle stream")
            .expect("ready batch");
        assert_eq!(ready[0]["type"], "ready");
        lifecycle_cancellation.cancel();

        let config_cancellation = CancellationToken::new();
        let mut config_stream =
            control.subscribe("subscribeServerConfig", config_cancellation.clone());
        let config_event = config_stream
            .recv()
            .await
            .expect("config stream")
            .expect("snapshot batch");
        assert_eq!(config_event[0]["type"], "snapshot");
        config_cancellation.cancel();

        let unknown_cancellation = CancellationToken::new();
        let mut unknown_stream = control.subscribe("unknown", unknown_cancellation);
        assert!(unknown_stream.recv().await.is_none());
        assert!(!now_iso().is_empty());
    }
}
