use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
#[cfg(test)]
use tokio::sync::{Barrier, Notify};
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
    server_settings::ProviderSettingsState,
};

const MAX_KEYBINDINGS: usize = 256;

fn provider_snapshot_identity(snapshot: &Value) -> Option<(&str, &str)> {
    Some((
        snapshot.get("instanceId")?.as_str()?,
        snapshot.get("driver")?.as_str()?,
    ))
}

fn merge_provider_snapshot(
    current: Option<&Value>,
    refreshed: provider_inventory::ProviderProbeResult,
) -> Value {
    let models_authoritative = refreshed.models_authoritative;
    let mut next = refreshed.snapshot;
    if refreshed.rich_metadata == provider_inventory::RichMetadataOutcome::Succeeded {
        return next;
    }
    let Some(current) = current else {
        return next;
    };
    let Some(current_identity) = provider_snapshot_identity(current) else {
        return next;
    };
    if provider_snapshot_identity(&next) != Some(current_identity) {
        return next;
    }
    if !models_authoritative && let Some(value) = current.get("models") {
        next["models"] = value.clone();
    }
    for field in ["slashCommands", "skills", "agents"] {
        if let Some(value) = current.get(field) {
            next[field] = value.clone();
        }
    }
    next
}

#[cfg(test)]
#[derive(Clone, Debug)]
struct ProviderProbePause {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[cfg(test)]
impl ProviderProbePause {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        }
    }

    async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

#[derive(Clone, Debug)]
pub struct NativeServerControl {
    config: ServerConfig,
    auth_descriptor: Value,
    state_directory: PathBuf,
    settings_path: PathBuf,
    keybindings_path: PathBuf,
    settings: Arc<RwLock<Value>>,
    settings_update_lock: Arc<Mutex<()>>,
    settings_generation: Arc<AtomicU64>,
    next_provider_probe_sequence: Arc<AtomicU64>,
    latest_published_provider_probe_sequence: Arc<AtomicU64>,
    settings_load_error: Option<Value>,
    #[cfg(test)]
    settings_update_barrier: Arc<RwLock<Option<Arc<Barrier>>>>,
    #[cfg(test)]
    next_quick_provider_probe_pause: Arc<Mutex<Option<ProviderProbePause>>>,
    #[cfg(test)]
    next_full_provider_probe_pause: Arc<Mutex<Option<ProviderProbePause>>>,
    keybinding_rules: Arc<RwLock<Vec<Value>>>,
    keybinding_issues: Arc<RwLock<Vec<Value>>>,
    providers: Arc<RwLock<Vec<Value>>>,
    full_provider_refresh_running: Arc<AtomicBool>,
    config_events: broadcast::Sender<Value>,
    trace_diagnostics: TraceDiagnosticsStore,
}

impl crate::git::WorktreeBaseDirectoryProvider for NativeServerControl {
    fn worktree_base_directory<'a>(&'a self) -> crate::git::BoxWorktreeBaseDirectoryFuture<'a> {
        Box::pin(async move {
            self.settings
                .read()
                .await
                .get("worktreeBaseDirectory")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
    }
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
            Ok(Some(settings)) => match validate_settings_document(&settings) {
                Ok(()) => (settings, None),
                Err(cause) => (
                    json!({}),
                    Some(settings_error(&settings_path, "normalize", &cause)),
                ),
            },
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
        let providers = provider_inventory::probe(&settings, None, &cwd)
            .await
            .into_iter()
            .map(|result| result.snapshot)
            .collect();
        let (config_events, _) = broadcast::channel(32);
        Self {
            config,
            auth_descriptor,
            state_directory,
            settings_path,
            keybindings_path,
            settings: Arc::new(RwLock::new(settings.clone())),
            settings_update_lock: Arc::new(Mutex::new(())),
            settings_generation: Arc::new(AtomicU64::new(0)),
            next_provider_probe_sequence: Arc::new(AtomicU64::new(0)),
            latest_published_provider_probe_sequence: Arc::new(AtomicU64::new(0)),
            settings_load_error,
            #[cfg(test)]
            settings_update_barrier: Arc::new(RwLock::new(None)),
            #[cfg(test)]
            next_quick_provider_probe_pause: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            next_full_provider_probe_pause: Arc::new(Mutex::new(None)),
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
        let mut patch = payload.get("patch").cloned().ok_or_else(|| {
            settings_error(&self.settings_path, "normalize", "missing settings patch")
        })?;
        if !patch.is_object() {
            return Err(settings_error(
                &self.settings_path,
                "normalize",
                "settings patch must be an object",
            ));
        }
        if let Some(raw) = patch.get("worktreeBaseDirectory").and_then(Value::as_str) {
            let normalized = super::worktree_workspace::normalize_worktree_workspace(raw)
                .await
                .map_err(|error| error.to_wire())?;
            patch["worktreeBaseDirectory"] = json!(normalized);
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
        validate_settings_document(&next)
            .map_err(|cause| settings_error(&self.settings_path, "normalize", &cause))?;
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
        let generation = self.settings_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.publish(json!({
            "version": 1,
            "type": "settingsUpdated",
            "payload": { "settings": next.clone() },
        }));
        drop(_update_guard);

        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let probe_sequence = self.begin_provider_probe();
        let providers = self.probe_provider_snapshots(&next, None, &cwd).await;
        self.publish_provider_snapshots_if_current(
            providers,
            false,
            generation,
            &next,
            probe_sequence,
        )
        .await;
        self.spawn_full_provider_refresh(generation, next.clone(), cwd);
        Ok(next)
    }

    #[cfg(test)]
    async fn install_settings_update_barrier(&self, parties: usize) {
        *self.settings_update_barrier.write().await = Some(Arc::new(Barrier::new(parties)));
    }

    #[cfg(test)]
    async fn install_next_quick_provider_probe_pause(&self) -> ProviderProbePause {
        let pause = ProviderProbePause::new();
        *self.next_quick_provider_probe_pause.lock().await = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    async fn install_next_full_provider_probe_pause(&self) -> ProviderProbePause {
        let pause = ProviderProbePause::new();
        *self.next_full_provider_probe_pause.lock().await = Some(pause.clone());
        pause
    }

    async fn refresh_providers(&self, payload: &Value) -> Value {
        let instance_id = payload.get("instanceId").and_then(Value::as_str);
        let (generation, settings) = self.settings_snapshot().await;
        let cwd = std::env::current_dir().unwrap_or_else(|_| self.config.base_dir.clone());
        let probe_sequence = self.begin_provider_probe();
        let refreshed = self
            .probe_full_provider_snapshots(&settings, instance_id, &cwd)
            .await;
        let providers = match self
            .publish_provider_snapshots_if_current(
                refreshed,
                instance_id.is_some(),
                generation,
                &settings,
                probe_sequence,
            )
            .await
        {
            Some(providers) => providers,
            None => self.providers.read().await.clone(),
        };
        json!({ "providers": providers })
    }

    async fn settings_snapshot(&self) -> (u64, Value) {
        let _update_guard = self.settings_update_lock.lock().await;
        (
            self.settings_generation.load(Ordering::Acquire),
            self.settings.read().await.clone(),
        )
    }

    fn begin_provider_probe(&self) -> u64 {
        self.next_provider_probe_sequence
            .fetch_add(1, Ordering::AcqRel)
            + 1
    }

    async fn probe_provider_snapshots(
        &self,
        settings: &Value,
        instance_id: Option<&str>,
        cwd: &Path,
    ) -> Vec<provider_inventory::ProviderProbeResult> {
        #[cfg(test)]
        let pause = self.next_quick_provider_probe_pause.lock().await.take();
        #[cfg(test)]
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        provider_inventory::probe(settings, instance_id, cwd).await
    }

    async fn probe_full_provider_snapshots(
        &self,
        settings: &Value,
        instance_id: Option<&str>,
        cwd: &Path,
    ) -> Vec<provider_inventory::ProviderProbeResult> {
        #[cfg(test)]
        let pause = self.next_full_provider_probe_pause.lock().await.take();
        #[cfg(test)]
        if let Some(pause) = pause {
            pause.entered.notify_one();
            pause.release.notified().await;
        }
        provider_inventory::probe_full(settings, instance_id, cwd).await
    }

    async fn publish_provider_snapshots_if_current(
        &self,
        refreshed: Vec<provider_inventory::ProviderProbeResult>,
        partial: bool,
        generation: u64,
        expected_settings: &Value,
        probe_sequence: u64,
    ) -> Option<Vec<Value>> {
        let _update_guard = self.settings_update_lock.lock().await;
        let settings_are_current = self.settings.read().await.eq(expected_settings);
        if self.settings_generation.load(Ordering::Acquire) != generation
            || !settings_are_current
            || probe_sequence
                <= self
                    .latest_published_provider_probe_sequence
                    .load(Ordering::Acquire)
        {
            return None;
        }
        let providers = self.merge_provider_snapshots(refreshed, partial).await;
        self.latest_published_provider_probe_sequence
            .store(probe_sequence, Ordering::Release);
        self.publish_provider_snapshots(&providers);
        Some(providers)
    }

    async fn merge_provider_snapshots(
        &self,
        refreshed: Vec<provider_inventory::ProviderProbeResult>,
        partial: bool,
    ) -> Vec<Value> {
        let mut current = self.providers.write().await;
        if partial {
            for result in refreshed {
                let Some(id) = result
                    .snapshot
                    .get("instanceId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let position = current.iter().position(|row| {
                    row.get("instanceId").and_then(Value::as_str) == Some(id.as_str())
                });
                let merged = merge_provider_snapshot(position.map(|index| &current[index]), result);
                if let Some(position) = position {
                    current[position] = merged;
                } else {
                    current.push(merged);
                }
            }
        } else {
            let previous = current.clone();
            *current = refreshed
                .into_iter()
                .map(|result| {
                    let id = result.snapshot.get("instanceId").and_then(Value::as_str);
                    let previous = previous
                        .iter()
                        .find(|row| row.get("instanceId").and_then(Value::as_str) == id);
                    merge_provider_snapshot(previous, result)
                })
                .collect();
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

    fn spawn_full_provider_refresh(&self, mut generation: u64, mut settings: Value, cwd: PathBuf) {
        if self
            .full_provider_refresh_running
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let control = self.clone();
        tokio::spawn(async move {
            loop {
                let probe_sequence = control.begin_provider_probe();
                let providers = control
                    .probe_full_provider_snapshots(&settings, None, &cwd)
                    .await;
                if control
                    .publish_provider_snapshots_if_current(
                        providers,
                        false,
                        generation,
                        &settings,
                        probe_sequence,
                    )
                    .await
                    .is_some()
                {
                    break;
                }
                (generation, settings) = control.settings_snapshot().await;
            }
            control
                .full_provider_refresh_running
                .store(false, Ordering::Release);
            let (latest_generation, latest_settings) = control.settings_snapshot().await;
            if latest_generation != generation || latest_settings != settings {
                control.spawn_full_provider_refresh(latest_generation, latest_settings, cwd);
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
                    let (generation, settings) = control.settings_snapshot().await;
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| control.config.base_dir.clone());
                    control.spawn_full_provider_refresh(generation, settings, cwd);
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

fn validate_settings_document(settings: &Value) -> Result<(), String> {
    let object = settings
        .as_object()
        .ok_or_else(|| "settings document must be an object".to_owned())?;
    let normalized = normalize_legacy_settings_for_validation(settings);
    serde_json::from_value::<ProviderSettingsState>(normalized)
        .map_err(|error| format!("invalid known provider settings shape: {error}"))?;

    validate_optional_bool(object, "enableAssistantStreaming")?;
    validate_optional_bool(object, "enableProviderUpdateChecks")?;
    validate_optional_bool(object, "newWorktreesStartFromOrigin")?;
    validate_optional_string(object, "worktreeBaseDirectory")?;
    validate_optional_string(object, "addProjectBaseDirectory")?;
    validate_optional_duration_millis(object, "automaticGitFetchInterval")?;
    if let Some(mode) = object.get("defaultThreadEnvMode") {
        match mode.as_str() {
            Some("local" | "worktree") => {}
            _ => {
                return Err(
                    "defaultThreadEnvMode must be either \"local\" or \"worktree\"".to_owned(),
                );
            }
        }
    }
    if let Some(selection) = object.get("textGenerationModelSelection") {
        validate_model_selection(selection, "textGenerationModelSelection")?;
    }
    if let Some(providers) = object.get("providers") {
        validate_legacy_provider_settings(providers)?;
    }
    if let Some(instances) = object.get("providerInstances") {
        validate_provider_instances(instances)?;
    }
    if let Some(defaults) = object.get("providerSessionDefaults") {
        validate_provider_session_defaults(defaults)?;
    }
    if let Some(terminal) = object.get("terminal") {
        let terminal = terminal
            .as_object()
            .ok_or_else(|| "terminal must be an object".to_owned())?;
        validate_optional_bool(terminal, "webglEnabled")?;
    }
    Ok(())
}

fn normalize_legacy_settings_for_validation(settings: &Value) -> Value {
    let mut normalized = settings.clone();
    if let Some(object) = normalized.as_object_mut()
        && object.contains_key("automaticGitFetchInterval")
    {
        // The public contract accepts every nonnegative JSON number, including
        // fractional milliseconds. ProviderSettingsState predates that
        // contract and uses u64, so validate the real shape separately and
        // neutralize only the surrogate decode.
        object.insert("automaticGitFetchInterval".to_owned(), json!(0));
    }
    if let Some(instances) = normalized
        .get_mut("providerInstances")
        .and_then(Value::as_object_mut)
    {
        for instance in instances.values_mut().filter_map(Value::as_object_mut) {
            instance.entry("config").or_insert(Value::Null);
        }
    }
    if let Some(defaults) = normalized
        .get_mut("providerSessionDefaults")
        .and_then(Value::as_object_mut)
    {
        for options in defaults.values_mut().filter_map(|value| {
            value
                .as_object_mut()
                .and_then(|value| value.get_mut("options"))
        }) {
            let Some(legacy) = options.as_object() else {
                continue;
            };
            *options = Value::Array(
                legacy
                    .iter()
                    .filter_map(|(id, value)| match value {
                        Value::String(value)
                            if !id.trim().is_empty() && !value.trim().is_empty() =>
                        {
                            Some(json!({ "id": id.trim(), "value": value.trim() }))
                        }
                        Value::Bool(value) if !id.trim().is_empty() => {
                            Some(json!({ "id": id.trim(), "value": value }))
                        }
                        _ => None,
                    })
                    .collect(),
            );
        }
    }
    normalized
}

fn validate_optional_bool(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if object.get(field).is_some_and(|value| !value.is_boolean()) {
        return Err(format!("{field} must be a boolean"));
    }
    Ok(())
}

fn validate_optional_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if object.get(field).is_some_and(|value| !value.is_string()) {
        return Err(format!("{field} must be a string"));
    }
    Ok(())
}

fn validate_optional_duration_millis(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = object.get(field)
        && value
            .as_f64()
            .is_none_or(|milliseconds| !milliseconds.is_finite() || milliseconds < 0.0)
    {
        return Err(format!("{field} must be a nonnegative number"));
    }
    Ok(())
}

fn validate_optional_string_array(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(value) = object.get(field)
        && !value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
    {
        return Err(format!("{field} must be an array of strings"));
    }
    Ok(())
}

fn validate_non_empty_string(value: &Value, field: &str) -> Result<(), String> {
    if value.as_str().is_none_or(|value| value.trim().is_empty()) {
        return Err(format!("{field} must be a non-empty string"));
    }
    Ok(())
}

fn validate_slug(value: &str, field: &str) -> Result<(), String> {
    let value = value.trim();
    let mut characters = value.chars();
    if value.len() > 64
        || characters
            .next()
            .is_none_or(|character| !character.is_ascii_alphabetic())
        || characters.any(|character| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
    {
        return Err(format!("{field} must be a valid provider slug"));
    }
    Ok(())
}

fn validate_model_selection(selection: &Value, field: &str) -> Result<(), String> {
    let selection = selection
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    validate_non_empty_string(
        selection
            .get("model")
            .ok_or_else(|| format!("{field}.model is required"))?,
        &format!("{field}.model"),
    )?;
    let instance_id = selection
        .get("instanceId")
        .or_else(|| selection.get("provider"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.instanceId is required"))?;
    validate_slug(instance_id, &format!("{field}.instanceId"))?;
    if let Some(options) = selection.get("options") {
        validate_provider_options(options, &format!("{field}.options"))?;
    }
    Ok(())
}

fn validate_legacy_provider_settings(providers: &Value) -> Result<(), String> {
    let providers = providers
        .as_object()
        .ok_or_else(|| "providers must be an object".to_owned())?;
    for (driver, string_fields) in [
        ("codex", &["binaryPath", "homePath", "shadowHomePath"][..]),
        ("claudeAgent", &["binaryPath", "homePath", "launchArgs"][..]),
        ("cursor", &["binaryPath", "apiEndpoint"][..]),
        ("grok", &["binaryPath"][..]),
        (
            "opencode",
            &["binaryPath", "serverUrl", "serverPassword"][..],
        ),
    ] {
        let Some(settings) = providers.get(driver) else {
            continue;
        };
        let settings = settings
            .as_object()
            .ok_or_else(|| format!("providers.{driver} must be an object"))?;
        validate_optional_bool(settings, "enabled")?;
        for field in string_fields {
            validate_optional_string(settings, field)?;
        }
        validate_optional_string_array(settings, "customModels")?;
    }
    Ok(())
}

fn validate_provider_instances(instances: &Value) -> Result<(), String> {
    let instances = instances
        .as_object()
        .ok_or_else(|| "providerInstances must be an object".to_owned())?;
    for (instance_id, instance) in instances {
        validate_slug(instance_id, "providerInstances key")?;
        let instance = instance
            .as_object()
            .ok_or_else(|| format!("providerInstances.{instance_id} must be an object"))?;
        let driver = instance
            .get("driver")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("providerInstances.{instance_id}.driver is required"))?;
        validate_slug(driver, &format!("providerInstances.{instance_id}.driver"))?;
        validate_optional_bool(instance, "enabled")?;
        for field in ["displayName", "accentColor"] {
            if let Some(value) = instance.get(field) {
                validate_non_empty_string(
                    value,
                    &format!("providerInstances.{instance_id}.{field}"),
                )?;
            }
        }
        if let Some(environment) = instance.get("environment") {
            let environment = environment.as_array().ok_or_else(|| {
                format!("providerInstances.{instance_id}.environment must be an array")
            })?;
            for (index, variable) in environment.iter().enumerate() {
                let variable = variable.as_object().ok_or_else(|| {
                    format!(
                        "providerInstances.{instance_id}.environment[{index}] must be an object"
                    )
                })?;
                let name = variable
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!(
                            "providerInstances.{instance_id}.environment[{index}].name is required"
                        )
                    })?;
                let mut characters = name.trim().chars();
                if name.trim().len() > 128
                    || characters.next().is_none_or(|character| {
                        !character.is_ascii_alphabetic() && character != '_'
                    })
                    || characters
                        .any(|character| !character.is_ascii_alphanumeric() && character != '_')
                {
                    return Err(format!(
                        "providerInstances.{instance_id}.environment[{index}].name is invalid"
                    ));
                }
                validate_optional_string(variable, "value")?;
                validate_optional_bool(variable, "sensitive")?;
                validate_optional_bool(variable, "valueRedacted")?;
            }
        }
    }
    Ok(())
}

fn validate_provider_session_defaults(defaults: &Value) -> Result<(), String> {
    let defaults = defaults
        .as_object()
        .ok_or_else(|| "providerSessionDefaults must be an object".to_owned())?;
    for (driver, value) in defaults {
        validate_slug(driver, "providerSessionDefaults key")?;
        let value = value
            .as_object()
            .ok_or_else(|| format!("providerSessionDefaults.{driver} must be an object"))?;
        validate_non_empty_string(
            value
                .get("model")
                .ok_or_else(|| format!("providerSessionDefaults.{driver}.model is required"))?,
            &format!("providerSessionDefaults.{driver}.model"),
        )?;
        if let Some(options) = value.get("options") {
            validate_provider_options(
                options,
                &format!("providerSessionDefaults.{driver}.options"),
            )?;
        }
    }
    Ok(())
}

fn validate_provider_options(options: &Value, field: &str) -> Result<(), String> {
    if options.is_object() {
        return Ok(());
    }
    let options = options
        .as_array()
        .ok_or_else(|| format!("{field} must be an array or legacy object"))?;
    for (index, option) in options.iter().enumerate() {
        let option = option
            .as_object()
            .ok_or_else(|| format!("{field}[{index}] must be an object"))?;
        validate_non_empty_string(
            option
                .get("id")
                .ok_or_else(|| format!("{field}[{index}].id is required"))?,
            &format!("{field}[{index}].id"),
        )?;
        let value = option
            .get("value")
            .ok_or_else(|| format!("{field}[{index}].value is required"))?;
        match value {
            Value::String(value) if !value.trim().is_empty() => {}
            Value::Bool(_) => {}
            _ => {
                return Err(format!(
                    "{field}[{index}].value must be a non-empty string or boolean"
                ));
            }
        }
    }
    Ok(())
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
            "worktreeBaseDirectory": "",
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

    #[tokio::test]
    async fn workspace_update_normalizes_existing_directories_and_rejects_invalid_targets() {
        let temp = tempfile::tempdir().expect("control root");
        let workspace = temp.path().join("workspace");
        tokio::fs::create_dir(&workspace).await.expect("workspace");
        let file = temp.path().join("file.txt");
        tokio::fs::write(&file, b"file").await.expect("file");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        let control = NativeServerControl::new(config, json!({"policy":"test"})).await;

        let updated = control
            .update_settings(json!({
                "patch": {"worktreeBaseDirectory": workspace.to_string_lossy()}
            }))
            .await
            .expect("valid workspace");
        assert_eq!(
            PathBuf::from(updated["worktreeBaseDirectory"].as_str().expect("path")),
            super::super::host_paths::process_compatible_path(
                tokio::fs::canonicalize(&workspace)
                    .await
                    .expect("canonical workspace"),
            )
        );

        for (path, failure) in [
            ("relative/worktrees".to_owned(), "relative_path"),
            (
                temp.path().join("missing").to_string_lossy().into_owned(),
                "missing",
            ),
            (file.to_string_lossy().into_owned(), "not_directory"),
        ] {
            let error = control
                .update_settings(json!({"patch":{"worktreeBaseDirectory":path}}))
                .await
                .expect_err("invalid workspace");
            assert_eq!(error["_tag"], "WorktreeWorkspaceError");
            assert_eq!(error["failure"], failure);
            assert_eq!(
                control.settings.read().await["worktreeBaseDirectory"],
                updated["worktreeBaseDirectory"]
            );
            let persisted: Value = serde_json::from_slice(
                &tokio::fs::read(&settings_path)
                    .await
                    .expect("persisted settings"),
            )
            .expect("valid persisted JSON");
            assert_eq!(
                persisted["worktreeBaseDirectory"],
                updated["worktreeBaseDirectory"]
            );
        }
    }

    #[test]
    fn quick_and_failed_probes_retain_rich_metadata_but_update_health() {
        let current = json!({
            "instanceId": "codex",
            "driver": "codex",
            "status": "ready",
            "checkedAt": "old",
            "models": [{ "slug": "gpt-rich" }],
            "slashCommands": [{ "name": "goal" }],
            "skills": [{ "name": "review" }],
            "agents": [{ "name": "builder" }]
        });
        let quick = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "codex",
                "driver": "codex",
                "status": "warning",
                "checkedAt": "new",
                "models": [{ "slug": "gpt-fallback" }],
                "slashCommands": [{ "name": "goal" }],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::NotRequested,
            models_authoritative: false,
        };
        let failed = provider_inventory::ProviderProbeResult {
            rich_metadata: provider_inventory::RichMetadataOutcome::Failed,
            ..quick.clone()
        };

        for result in [quick, failed] {
            let merged = merge_provider_snapshot(Some(&current), result);
            assert_eq!(merged["status"], "warning");
            assert_eq!(merged["checkedAt"], "new");
            assert_eq!(merged["models"], current["models"]);
            assert_eq!(merged["skills"], current["skills"]);
            assert_eq!(merged["agents"], current["agents"]);
        }
    }

    #[test]
    fn authoritative_models_survive_a_failed_capabilities_probe() {
        let current = json!({
            "instanceId": "claudeAgent",
            "driver": "claudeAgent",
            "models": [{ "slug": "claude-too-new" }],
            "slashCommands": [{ "name": "old-command" }],
            "skills": [{ "name": "old-skill" }],
            "agents": [{ "name": "old-agent" }]
        });
        let refreshed = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "claudeAgent",
                "driver": "claudeAgent",
                "models": [{ "slug": "claude-supported" }],
                "slashCommands": [],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::Failed,
            models_authoritative: true,
        };

        let merged = merge_provider_snapshot(Some(&current), refreshed);

        assert_eq!(merged["models"], json!([{ "slug": "claude-supported" }]));
        assert_eq!(merged["slashCommands"], current["slashCommands"]);
        assert_eq!(merged["skills"], current["skills"]);
        assert_eq!(merged["agents"], current["agents"]);
    }

    #[test]
    fn disabled_replacement_does_not_retain_metadata_from_another_driver() {
        let current = json!({
            "instanceId": "shared",
            "driver": "codex",
            "enabled": true,
            "models": [{ "slug": "gpt-rich" }],
            "slashCommands": [{ "name": "goal" }],
            "skills": [{ "name": "review" }],
            "agents": [{ "name": "builder" }]
        });
        let replacement = provider_inventory::ProviderProbeResult {
            snapshot: json!({
                "instanceId": "shared",
                "driver": "claudeAgent",
                "enabled": false,
                "models": [{ "slug": "claude-disabled" }],
                "slashCommands": [{ "name": "loop" }],
                "skills": [],
                "agents": []
            }),
            rich_metadata: provider_inventory::RichMetadataOutcome::NotRequested,
            models_authoritative: false,
        };

        let merged = merge_provider_snapshot(Some(&current), replacement);

        assert_eq!(merged["driver"], "claudeAgent");
        assert_eq!(merged["enabled"], false);
        assert_eq!(merged["models"], json!([{ "slug": "claude-disabled" }]));
        assert_eq!(merged["slashCommands"], json!([{ "name": "loop" }]));
        assert_eq!(merged["skills"], json!([]));
        assert_eq!(merged["agents"], json!([]));
    }

    #[test]
    fn successful_rich_probe_can_authoritatively_clear_metadata() {
        let current = json!({
            "instanceId": "codex",
            "models": [{ "slug": "retired" }],
            "slashCommands": [{ "name": "old" }],
            "skills": [{ "name": "old" }],
            "agents": [{ "name": "old" }]
        });
        let merged = merge_provider_snapshot(
            Some(&current),
            provider_inventory::ProviderProbeResult {
                snapshot: json!({
                    "instanceId": "codex",
                    "models": [],
                    "slashCommands": [],
                    "skills": [],
                    "agents": []
                }),
                rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                models_authoritative: true,
            },
        );

        assert_eq!(merged["models"], json!([]));
        assert_eq!(merged["skills"], json!([]));
        assert_eq!(merged["agents"], json!([]));
    }

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
    async fn older_probe_completion_cannot_overwrite_newer_same_generation_snapshot() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-provider-probe-order".to_owned();
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            settings_path,
            br#"{
                "providers": {
                    "codex": {"enabled": false},
                    "claudeAgent": {"enabled": false},
                    "cursor": {"enabled": false},
                    "grok": {"enabled": false},
                    "opencode": {"enabled": false}
                }
            }"#,
        )
        .await
        .expect("disabled provider fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let (generation, settings) = control.settings_snapshot().await;

        let older_sequence = control.begin_provider_probe();
        let newer_sequence = control.begin_provider_probe();
        let older_release = Arc::new(Notify::new());
        let older_entered = Arc::new(Notify::new());
        let older_completion = {
            let control = control.clone();
            let settings = settings.clone();
            let older_release = older_release.clone();
            let older_entered = older_entered.clone();
            tokio::spawn(async move {
                older_entered.notify_one();
                older_release.notified().await;
                control
                    .publish_provider_snapshots_if_current(
                        vec![provider_inventory::ProviderProbeResult {
                            snapshot: json!({
                                "instanceId": "codex",
                                "driver": "codex",
                                "checkedAt": "older-completion",
                                "models": [],
                                "slashCommands": [],
                                "skills": [],
                                "agents": []
                            }),
                            rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                            models_authoritative: true,
                        }],
                        false,
                        generation,
                        &settings,
                        older_sequence,
                    )
                    .await
            })
        };
        older_entered.notified().await;

        control
            .publish_provider_snapshots_if_current(
                vec![provider_inventory::ProviderProbeResult {
                    snapshot: json!({
                        "instanceId": "codex",
                        "driver": "codex",
                        "checkedAt": "newer-completion",
                        "models": [],
                        "slashCommands": [],
                        "skills": [],
                        "agents": []
                    }),
                    rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                    models_authoritative: true,
                }],
                false,
                generation,
                &settings,
                newer_sequence,
            )
            .await
            .expect("newer probe publishes");
        older_release.notify_one();

        assert!(
            older_completion
                .await
                .expect("older completion joins")
                .is_none(),
            "older probe request must not publish after a newer request"
        );
        assert_eq!(
            control.providers.read().await[0]["checkedAt"],
            "newer-completion"
        );
    }

    #[tokio::test]
    async fn concurrent_settings_stream_discards_stale_provider_probes_in_commit_order() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let mut config = ServerConfig::new(temp.path());
        config.environment_id = "environment-concurrent-stream".to_owned();
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            &settings_path,
            br#"{
                "providers": {
                    "codex": {"enabled": false},
                    "claudeAgent": {"enabled": false},
                    "cursor": {"enabled": false},
                    "grok": {"enabled": false},
                    "opencode": {"enabled": false}
                }
            }"#,
        )
        .await
        .expect("disabled provider fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let initial_full_probe = control.install_next_full_provider_probe_pause().await;
        let cancellation = CancellationToken::new();
        let mut stream = control.subscribe("subscribeServerConfig", cancellation.clone());
        let snapshot = stream
            .recv()
            .await
            .expect("config stream")
            .expect("snapshot batch");
        assert_eq!(snapshot[0]["type"], "snapshot");
        initial_full_probe.wait_until_entered().await;

        let stale_quick_probe = control.install_next_quick_provider_probe_pause().await;
        let stale_control = control.clone();
        let stale_update = tokio::spawn(async move {
            stale_control
                .update_settings(json!({
                    "patch": {
                        "streamCommit": "first",
                        "providerInstances": {
                            "stale_instance": {
                                "driver": "codex",
                                "enabled": false,
                                "config": {}
                            }
                        }
                    }
                }))
                .await
        });
        stale_quick_probe.wait_until_entered().await;

        control
            .update_settings(json!({
                "patch": {
                    "streamCommit": "second",
                    "providerInstances": {
                        "current_instance": {
                            "driver": "codex",
                            "enabled": false,
                            "config": {}
                        }
                    }
                }
            }))
            .await
            .expect("current update succeeds");
        stale_quick_probe.release();
        stale_update
            .await
            .expect("stale update joins")
            .expect("stale update committed before it was delayed");
        initial_full_probe.release();

        tokio::time::timeout(tokio::time::Duration::from_secs(5), async {
            while control
                .full_provider_refresh_running
                .load(Ordering::Acquire)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("full provider refresh completes");

        let mut events = Vec::new();
        while let Ok(Some(batch)) =
            tokio::time::timeout(tokio::time::Duration::from_millis(50), stream.recv()).await
        {
            events.extend(batch.expect("config event batch"));
        }
        cancellation.cancel();

        let settings_events = events
            .iter()
            .filter(|event| event["type"] == "settingsUpdated")
            .collect::<Vec<_>>();
        assert_eq!(
            settings_events
                .iter()
                .map(|event| event["payload"]["settings"]["streamCommit"].as_str())
                .collect::<Vec<_>>(),
            vec![Some("first"), Some("second")]
        );
        let final_settings_index = events
            .iter()
            .rposition(|event| event["type"] == "settingsUpdated")
            .expect("final settings event");
        for event in events.iter().skip(final_settings_index + 1) {
            if event["type"] == "providerStatuses" {
                let providers = event["payload"]["providers"]
                    .as_array()
                    .expect("provider status payload");
                assert!(
                    providers
                        .iter()
                        .all(|provider| provider["instanceId"] != "stale_instance"),
                    "stale provider probe was published after the final settings event"
                );
            }
        }

        let memory_settings = control.settings.read().await.clone();
        let memory_providers = control.providers.read().await.clone();
        let persisted_settings = read_json::<Value>(&settings_path)
            .await
            .expect("settings file reads")
            .expect("settings file exists");
        assert_eq!(memory_settings, persisted_settings);
        assert_eq!(
            settings_events.last().expect("last settings event")["payload"]["settings"],
            memory_settings
        );
        assert_eq!(
            events
                .iter()
                .rev()
                .find(|event| event["type"] == "providerStatuses")
                .expect("last provider event")["payload"]["providers"],
            json!(memory_providers)
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
    async fn schema_invalid_settings_surface_structured_errors_and_preserve_original_bytes() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let cases = [
            ("top-level array", br#"[]"#.as_slice()),
            (
                "provider defaults array",
                br#"{"providerSessionDefaults":[]}"#.as_slice(),
            ),
            (
                "provider default model",
                br#"{"providerSessionDefaults":{"codex":{"model":42}}}"#.as_slice(),
            ),
            (
                "provider default option",
                br#"{"providerSessionDefaults":{"codex":{"model":"gpt-5.4","options":[{"id":"reasoningEffort","value":1}]}}}"#
                    .as_slice(),
            ),
            ("providers array", br#"{"providers":[]}"#.as_slice()),
            (
                "provider instances array",
                br#"{"providerInstances":[]}"#.as_slice(),
            ),
            (
                "provider instance null display name",
                br#"{"providerInstances":{"codex":{"driver":"codex","displayName":null}}}"#
                    .as_slice(),
            ),
            (
                "provider instance null accent color",
                br#"{"providerInstances":{"codex":{"driver":"codex","accentColor":null}}}"#
                    .as_slice(),
            ),
            (
                "model selection shape",
                br#"{"textGenerationModelSelection":{"instanceId":"codex","model":[]}}"#
                    .as_slice(),
            ),
            (
                "terminal shape",
                br#"{"terminal":{"webglEnabled":"yes"}}"#.as_slice(),
            ),
        ];

        for (name, original) in cases {
            let temp = tempfile::tempdir().expect("state directory");
            let mut config = ServerConfig::new(temp.path());
            config.environment_id = format!("environment-invalid-{name}");
            let settings_path = config.state_dir().join("settings.json");
            tokio::fs::create_dir_all(config.state_dir())
                .await
                .expect("state directory exists");
            tokio::fs::write(&settings_path, original)
                .await
                .expect("schema-invalid settings fixture");
            let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

            let read_error = control
                .call("server.getSettings", json!({}), CancellationToken::new())
                .await
                .expect_err(name);
            assert_eq!(read_error["_tag"], "ServerSettingsError", "{name}");
            assert_eq!(read_error["operation"], "normalize", "{name}");
            assert_eq!(
                control
                    .call("server.getConfig", json!({}), CancellationToken::new())
                    .await
                    .expect_err(name),
                read_error,
                "{name}"
            );
            let mut config_stream =
                control.subscribe("subscribeServerConfig", CancellationToken::new());
            assert_eq!(
                config_stream
                    .recv()
                    .await
                    .expect("config stream reports its load failure")
                    .expect_err(name),
                read_error,
                "{name}"
            );
            assert_eq!(
                control
                    .update_settings(json!({"patch":{"enableAssistantStreaming":true}}))
                    .await
                    .expect_err(name),
                read_error,
                "{name}"
            );
            assert_eq!(
                tokio::fs::read(&settings_path)
                    .await
                    .expect("schema-invalid file remains readable"),
                original,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_settings_patch_is_transactional_and_publishes_no_events() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        let original = br#"{"enableAssistantStreaming":false}"#;
        tokio::fs::write(&settings_path, original)
            .await
            .expect("valid settings fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let before = control.settings.read().await.clone();
        let mut events = control.config_events.subscribe();

        let error = control
            .update_settings(json!({"patch":{"terminal":{"webglEnabled":"yes"}}}))
            .await
            .expect_err("invalid patch is rejected");

        assert_eq!(error["_tag"], "ServerSettingsError");
        assert_eq!(error["operation"], "normalize");
        assert_eq!(*control.settings.read().await, before);
        assert_eq!(
            tokio::fs::read(&settings_path)
                .await
                .expect("settings file remains readable"),
            original
        );
        assert!(
            tokio::time::timeout(tokio::time::Duration::from_millis(50), events.recv())
                .await
                .is_err(),
            "invalid update must not publish settings or provider events"
        );
    }

    #[tokio::test]
    async fn settings_validation_accepts_fractional_fetch_intervals() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(&settings_path, br#"{"automaticGitFetchInterval":0.1}"#)
            .await
            .expect("fractional interval fixture");
        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;

        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("fractional millisecond interval is contract-valid");

        assert_eq!(settings["automaticGitFetchInterval"], json!(0.1));
    }

    #[tokio::test]
    async fn settings_validation_preserves_open_unknown_keys_and_legacy_options() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("state directory");
        let config = ServerConfig::new(temp.path());
        let settings_path = config.state_dir().join("settings.json");
        tokio::fs::create_dir_all(config.state_dir())
            .await
            .expect("state directory exists");
        tokio::fs::write(
            &settings_path,
            br#"{
                "futureSetting": {"nested": [1, true, null]},
                "providerInstances": {
                    "fork_one": {
                        "driver": "forkDriver",
                        "config": {"futureDriverField": {"kept": true}}
                    }
                },
                "providerSessionDefaults": {
                    "forkDriver": {
                        "model": "future-model",
                        "options": {"effort": "high", "futureNumericValue": 1}
                    }
                }
            }"#,
        )
        .await
        .expect("open settings fixture");

        let control = NativeServerControl::new(config, json!({"policy": "test"})).await;
        let settings = control
            .call("server.getSettings", json!({}), CancellationToken::new())
            .await
            .expect("open settings remain readable");

        assert_eq!(
            settings["futureSetting"],
            json!({"nested": [1, true, null]})
        );
        assert_eq!(
            settings["providerInstances"]["fork_one"]["config"]["futureDriverField"],
            json!({"kept": true})
        );
        assert_eq!(
            settings["providerSessionDefaults"]["forkDriver"]["options"],
            json!({"effort": "high", "futureNumericValue": 1})
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
                vec![provider_inventory::ProviderProbeResult {
                    snapshot: json!({"instanceId":"unit-provider","status":"disabled"}),
                    rich_metadata: provider_inventory::RichMetadataOutcome::Succeeded,
                    models_authoritative: true,
                }],
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
