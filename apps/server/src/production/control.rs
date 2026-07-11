use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::{
    process::Command,
    sync::{RwLock, broadcast, mpsc},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    diagnostics::TraceDiagnosticsStore,
    persistence::{read_json, write_bytes_atomically, write_json_atomically},
    production::{
        provider_runtime::{provider_launch_program, resolve_provider_executable},
        server_terminal::{JsonFuture, JsonStream, ProductionServerControl},
    },
};

const MAX_KEYBINDINGS: usize = 256;
const PROVIDER_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct NativeServerControl {
    config: ServerConfig,
    auth_descriptor: Value,
    state_directory: PathBuf,
    settings_path: PathBuf,
    keybindings_path: PathBuf,
    settings: Arc<RwLock<Value>>,
    keybinding_rules: Arc<RwLock<Vec<Value>>>,
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
        let keybinding_rules = load_keybinding_rules(&keybindings_path).await;
        let providers = probe_providers(&settings, None).await;
        let (config_events, _) = broadcast::channel(32);
        Self {
            config,
            auth_descriptor,
            state_directory,
            settings_path,
            keybindings_path,
            settings: Arc::new(RwLock::new(settings)),
            keybinding_rules: Arc::new(RwLock::new(keybinding_rules)),
            providers: Arc::new(RwLock::new(providers)),
            config_events,
            trace_diagnostics,
        }
    }

    pub async fn config_snapshot(&self) -> Value {
        let settings = self.settings.read().await.clone();
        let rules = self.keybinding_rules.read().await.clone();
        let providers = self.providers.read().await.clone();
        let cwd = current_directory(&self.config);
        json!({
            "environment": environment_descriptor(&self.config),
            "auth": self.auth_descriptor,
            "cwd": cwd,
            "keybindingsConfigPath": self.keybindings_path.to_string_lossy(),
            "keybindings": resolve_keybindings(&rules),
            "issues": [],
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

        let providers = probe_providers(&next, None).await;
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
        let providers = probe_providers(&settings, instance_id).await;
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
        validate_keybinding_input(&payload, method == "server.upsertKeybinding")
            .map_err(|detail| keybindings_error(&self.keybindings_path, &detail))?;
        let mut rules = self.keybinding_rules.write().await;
        if method == "server.removeKeybinding" {
            rules.retain(|rule| !same_rule(rule, &payload));
        } else {
            let target = payload.get("replace").unwrap_or(&payload);
            rules.retain(|rule| !same_rule(rule, target));
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
        let result = json!({ "keybindings": resolve_keybindings(&rules), "issues": [] });
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
                "subscribeDiscoveredLocalServers" => {
                    let _ =
                        send_event(&sender, json!({ "servers": [], "scannedAt": now_iso() })).await;
                    cancellation.cancelled().await;
                }
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

async fn load_keybinding_rules(path: &Path) -> Vec<Value> {
    read_json::<Vec<Value>>(path)
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter(|rule| validate_keybinding_input(rule, false).is_ok())
        .collect()
}

fn validate_keybinding_input(input: &Value, allow_replace: bool) -> Result<(), String> {
    let object = input
        .as_object()
        .ok_or_else(|| "keybinding must be an object".to_owned())?;
    let key = object
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if key.is_empty() || key.len() > 64 || parse_shortcut(key).is_none() {
        return Err("invalid keybinding shortcut".into());
    }
    if command.is_empty() || command.len() > 64 {
        return Err("invalid keybinding command".into());
    }
    if object
        .get("when")
        .and_then(Value::as_str)
        .is_some_and(|when| when.is_empty() || when.len() > 256)
    {
        return Err("invalid keybinding condition".into());
    }
    if allow_replace && let Some(replace) = object.get("replace") {
        validate_keybinding_input(replace, false)?;
    }
    Ok(())
}

fn same_rule(left: &Value, right: &Value) -> bool {
    left.get("key") == right.get("key")
        && left.get("command") == right.get("command")
        && left.get("when") == right.get("when")
}

fn resolve_keybindings(rules: &[Value]) -> Vec<Value> {
    rules
        .iter()
        .filter_map(|rule| {
            let key = rule.get("key")?.as_str()?;
            let command = rule.get("command")?.as_str()?;
            let shortcut = parse_shortcut(key)?;
            let mut resolved = json!({ "command": command, "shortcut": shortcut });
            if let Some(when) = rule.get("when").and_then(Value::as_str)
                && let Some(ast) = parse_when(when)
            {
                resolved["whenAst"] = ast;
            }
            Some(resolved)
        })
        .collect()
}

fn parse_shortcut(input: &str) -> Option<Value> {
    let mut parts = input
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .peekable();
    let mut modifiers = HashSet::new();
    let mut key = None;
    while let Some(part) = parts.next() {
        let normalized = part.to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "mod" | "meta" | "cmd" | "ctrl" | "control" | "alt" | "option" | "shift"
        ) && parts.peek().is_some()
        {
            modifiers.insert(normalized);
        } else if key.is_none() && parts.peek().is_none() {
            key = Some(match normalized.as_str() {
                "space" => " ".to_owned(),
                _ => normalized,
            });
        } else {
            return None;
        }
    }
    let key = key?;
    let meta = modifiers.contains("meta") || modifiers.contains("cmd");
    let ctrl = modifiers.contains("ctrl") || modifiers.contains("control");
    let alt = modifiers.contains("alt") || modifiers.contains("option");
    Some(json!({
        "key": key,
        "metaKey": meta,
        "ctrlKey": ctrl,
        "shiftKey": modifiers.contains("shift"),
        "altKey": alt,
        "modKey": modifiers.contains("mod") || meta || ctrl,
    }))
}

fn parse_when(input: &str) -> Option<Value> {
    let input = input.trim();
    if let Some((left, right)) = split_condition(input, "||") {
        return Some(
            json!({ "type": "or", "left": parse_when(left)?, "right": parse_when(right)? }),
        );
    }
    if let Some((left, right)) = split_condition(input, "&&") {
        return Some(
            json!({ "type": "and", "left": parse_when(left)?, "right": parse_when(right)? }),
        );
    }
    if let Some(rest) = input.strip_prefix('!') {
        return Some(json!({ "type": "not", "node": parse_when(rest.trim_matches(['(', ')']))? }));
    }
    let identifier = input.trim_matches(['(', ')']).trim();
    (!identifier.is_empty()).then(|| json!({ "type": "identifier", "name": identifier }))
}

fn split_condition<'a>(input: &'a str, operator: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0_i32;
    for (index, character) in input.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth == 0 && input[index..].starts_with(operator) => {
                return Some((&input[..index], &input[index + operator.len()..]));
            }
            _ => {}
        }
    }
    None
}

async fn probe_providers(settings: &Value, selected: Option<&str>) -> Vec<Value> {
    let definitions = provider_definitions(settings);
    let mut snapshots = Vec::new();
    for definition in definitions {
        if selected.is_none_or(|selected| selected == definition.instance_id) {
            snapshots.push(probe_provider(definition).await);
        }
    }
    snapshots
}

#[derive(Debug)]
struct ProviderDefinition {
    instance_id: String,
    driver: String,
    display_name: Option<String>,
    enabled: bool,
    binary_path: String,
    available: bool,
}

fn provider_definitions(settings: &Value) -> Vec<ProviderDefinition> {
    let legacy = settings.get("providers").and_then(Value::as_object);
    let instances = settings.get("providerInstances").and_then(Value::as_object);
    if let Some(instances) = instances.filter(|instances| !instances.is_empty()) {
        return instances
            .iter()
            .map(|(instance_id, instance)| {
                let driver = instance
                    .get("driver")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let driver_settings = legacy.and_then(|legacy| legacy.get(driver));
                ProviderDefinition {
                    instance_id: instance_id.clone(),
                    driver: driver.to_owned(),
                    display_name: instance
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    enabled: instance
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or_else(|| {
                            driver_settings
                                .and_then(|value| value.get("enabled"))
                                .and_then(Value::as_bool)
                                .unwrap_or(true)
                        }),
                    binary_path: driver_settings
                        .and_then(|value| value.get("binaryPath"))
                        .and_then(Value::as_str)
                        .unwrap_or(driver)
                        .to_owned(),
                    available: is_builtin_driver(driver),
                }
            })
            .collect();
    }
    ["codex", "claudeAgent", "cursor", "grok", "opencode"]
        .into_iter()
        .map(|driver| {
            let driver_settings = legacy.and_then(|legacy| legacy.get(driver));
            ProviderDefinition {
                instance_id: driver.to_owned(),
                driver: driver.to_owned(),
                display_name: None,
                enabled: driver_settings
                    .and_then(|value| value.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(driver != "cursor"),
                binary_path: driver_settings
                    .and_then(|value| value.get("binaryPath"))
                    .and_then(Value::as_str)
                    .unwrap_or(driver)
                    .to_owned(),
                available: true,
            }
        })
        .collect()
}

async fn probe_provider(definition: ProviderDefinition) -> Value {
    let checked_at = now_iso();
    if !definition.available {
        return provider_snapshot(
            &definition,
            false,
            None,
            "disabled",
            Some("Provider driver is unavailable in this build."),
            checked_at,
            "unavailable",
        );
    }
    if !definition.enabled {
        return provider_snapshot(
            &definition,
            false,
            None,
            "disabled",
            None,
            checked_at,
            "available",
        );
    }
    let Some(executable) = resolve_provider_executable(&definition.binary_path) else {
        return provider_snapshot(
            &definition,
            false,
            None,
            "error",
            Some("Provider executable was not found."),
            checked_at,
            "available",
        );
    };
    let (program, prefix_args) = provider_launch_program(&executable);
    let output = timeout(
        PROVIDER_PROBE_TIMEOUT,
        Command::new(program)
            .args(prefix_args)
            .arg("--version")
            .output(),
    )
    .await;
    match output {
        Ok(Ok(output)) => {
            let text = if output.stdout.is_empty() {
                &output.stderr
            } else {
                &output.stdout
            };
            let version = String::from_utf8_lossy(text)
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned);
            let message = (!output.status.success())
                .then_some("Provider executable returned a non-zero status.");
            let status = if output.status.success() {
                "ready"
            } else {
                "warning"
            };
            provider_snapshot(
                &definition,
                true,
                version,
                status,
                message,
                checked_at,
                "available",
            )
        }
        Ok(Err(_)) => provider_snapshot(
            &definition,
            false,
            None,
            "error",
            Some("Provider executable was not found."),
            checked_at,
            "available",
        ),
        Err(_) => provider_snapshot(
            &definition,
            true,
            None,
            "warning",
            Some("Provider version probe timed out."),
            checked_at,
            "available",
        ),
    }
}

fn provider_snapshot(
    definition: &ProviderDefinition,
    installed: bool,
    version: Option<String>,
    status: &str,
    message: Option<&str>,
    checked_at: String,
    availability: &str,
) -> Value {
    let mut snapshot = json!({
        "instanceId": definition.instance_id,
        "driver": definition.driver,
        "enabled": definition.enabled && definition.available,
        "installed": installed,
        "version": version,
        "status": status,
        "auth": { "status": "unknown" },
        "checkedAt": checked_at,
        "availability": availability,
        "models": [],
        "slashCommands": [],
        "skills": [],
    });
    if let Some(display_name) = &definition.display_name {
        snapshot["displayName"] = json!(display_name);
    }
    if let Some(message) = message {
        snapshot["message"] = json!(message);
    }
    if availability == "unavailable" {
        snapshot["unavailableReason"] = json!("Provider driver is unavailable in this build.");
    }
    snapshot
}

fn is_builtin_driver(driver: &str) -> bool {
    matches!(
        driver,
        "codex" | "claudeAgent" | "cursor" | "grok" | "opencode"
    )
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

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
