use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilitySettingsState {
    #[serde(default)]
    pub otlp_traces_url: String,
    #[serde(default)]
    pub otlp_metrics_url: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBinarySettingsState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub binary_path: String,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub server_password: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProvidersState {
    pub codex: ProviderBinarySettingsState,
    pub claude_agent: ProviderBinarySettingsState,
    pub cursor: ProviderBinarySettingsState,
    pub grok: ProviderBinarySettingsState,
    pub opencode: ProviderBinarySettingsState,
}

impl ProvidersState {
    fn with_defaults() -> Self {
        Self {
            codex: ProviderBinarySettingsState {
                enabled: true,
                binary_path: "codex".to_owned(),
                ..ProviderBinarySettingsState::default()
            },
            claude_agent: ProviderBinarySettingsState {
                enabled: true,
                binary_path: "claude".to_owned(),
                ..ProviderBinarySettingsState::default()
            },
            cursor: ProviderBinarySettingsState {
                enabled: false,
                binary_path: "cursor-agent".to_owned(),
                ..ProviderBinarySettingsState::default()
            },
            grok: ProviderBinarySettingsState {
                enabled: true,
                binary_path: "grok".to_owned(),
                ..ProviderBinarySettingsState::default()
            },
            opencode: ProviderBinarySettingsState {
                enabled: true,
                binary_path: "opencode".to_owned(),
                ..ProviderBinarySettingsState::default()
            },
        }
    }
}

impl Default for ProvidersState {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnvironmentVariableState {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub sensitive: bool,
    #[serde(default)]
    pub value_redacted: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceState {
    pub driver: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub environment: Vec<ProviderEnvironmentVariableState>,
    #[serde(default)]
    pub config: Value,
}

const fn enabled_by_default() -> bool {
    true
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettingsState {
    #[serde(default = "default_git_fetch_interval")]
    pub automatic_git_fetch_interval: u64,
    #[serde(default)]
    pub add_project_base_directory: String,
    #[serde(default)]
    pub observability: ObservabilitySettingsState,
    #[serde(default)]
    pub providers: ProvidersState,
    #[serde(default)]
    pub provider_instances: BTreeMap<String, ProviderInstanceState>,
}

impl Default for ProviderSettingsState {
    fn default() -> Self {
        Self {
            automatic_git_fetch_interval: default_git_fetch_interval(),
            add_project_base_directory: String::new(),
            observability: ObservabilitySettingsState::default(),
            providers: ProvidersState::default(),
            provider_instances: BTreeMap::new(),
        }
    }
}

const fn default_git_fetch_interval() -> u64 {
    30_000
}

#[derive(Clone, Debug, Default)]
pub struct ObservabilitySettingsPatch {
    pub otlp_traces_url: Option<String>,
    pub otlp_metrics_url: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ProviderSettingsPatch {
    pub enabled: Option<bool>,
    pub binary_path: Option<String>,
    pub server_url: Option<String>,
    pub server_password: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ProvidersPatch {
    pub codex: Option<ProviderSettingsPatch>,
    pub claude_agent: Option<ProviderSettingsPatch>,
    pub cursor: Option<ProviderSettingsPatch>,
    pub grok: Option<ProviderSettingsPatch>,
    pub opencode: Option<ProviderSettingsPatch>,
}

#[derive(Clone, Debug, Default)]
pub struct ProviderEnvironmentVariableInput {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
    pub value_redacted: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ProviderInstanceInput {
    pub driver: String,
    pub enabled: bool,
    pub display_name: Option<String>,
    pub environment: Vec<ProviderEnvironmentVariableInput>,
    pub config: Value,
}

#[derive(Clone, Debug, Default)]
pub struct ServerSettingsPatch {
    pub automatic_git_fetch_interval_ms: Option<u64>,
    pub add_project_base_directory: Option<String>,
    pub observability: Option<ObservabilitySettingsPatch>,
    pub providers: Option<ProvidersPatch>,
    pub provider_instances: Option<BTreeMap<String, ProviderInstanceInput>>,
}

#[derive(Debug, Error)]
pub enum ServerSettingsReadError {
    #[error("failed to read settings from {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to decode settings from {path}")]
    Decode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to persist settings to {path}")]
    Persist {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "missing secret for provider instance {instance_id} and environment variable {environment_variable}"
    )]
    MissingSecret {
        instance_id: String,
        environment_variable: String,
        path: PathBuf,
    },
}

#[derive(Clone)]
pub struct ProviderSettingsStore {
    root: PathBuf,
    lock: ArcMutex,
}

type ArcMutex = std::sync::Arc<Mutex<()>>;

impl ProviderSettingsStore {
    #[must_use]
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            lock: std::sync::Arc::new(Mutex::new(())),
        }
    }

    pub async fn get(&self) -> Result<ProviderSettingsState, ServerSettingsReadError> {
        let _guard = self.lock.lock().await;
        let persisted = self.read_persisted().await?;
        self.materialize_secrets(persisted).await
    }

    pub async fn update(
        &self,
        patch: ServerSettingsPatch,
    ) -> Result<ProviderSettingsState, ServerSettingsReadError> {
        let _guard = self.lock.lock().await;
        let current = self
            .read_persisted()
            .await
            .unwrap_or_else(|_| ProviderSettingsState::default());
        let next = apply_patch(current, patch);
        let materialized = self.materialize_and_persist(next).await?;
        Ok(materialized)
    }

    fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    fn secrets_dir(&self) -> PathBuf {
        self.root.join("secrets")
    }

    async fn read_persisted(&self) -> Result<ProviderSettingsState, ServerSettingsReadError> {
        let path = self.settings_path();
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ProviderSettingsState::default());
            }
            Err(source) => return Err(ServerSettingsReadError::Read { path, source }),
        };
        serde_json::from_slice(&bytes)
            .map_err(|source| ServerSettingsReadError::Decode { path, source })
    }

    async fn materialize_and_persist(
        &self,
        mut settings: ProviderSettingsState,
    ) -> Result<ProviderSettingsState, ServerSettingsReadError> {
        fs::create_dir_all(self.secrets_dir())
            .await
            .map_err(|source| ServerSettingsReadError::Persist {
                path: self.secrets_dir(),
                source,
            })?;

        let mut persisted = settings.clone();
        for (instance_id, instance) in &mut settings.provider_instances {
            let Some(persisted_instance) = persisted.provider_instances.get_mut(instance_id) else {
                continue;
            };
            for (index, variable) in instance.environment.iter_mut().enumerate() {
                let persisted_variable = &mut persisted_instance.environment[index];
                if !variable.sensitive {
                    persisted_variable.value_redacted = false;
                    continue;
                }
                if !variable.value.is_empty() {
                    let secret_path = self.secret_path(instance_id, &variable.name);
                    write_bytes_atomically(&secret_path, variable.value.as_bytes())
                        .await
                        .map_err(|source| ServerSettingsReadError::Persist {
                            path: secret_path.clone(),
                            source,
                        })?;
                    persisted_variable.value.clear();
                    persisted_variable.value_redacted = true;
                    variable.value_redacted = true;
                    continue;
                }
                if variable.value_redacted {
                    let secret_path = self.secret_path(instance_id, &variable.name);
                    let secret = fs::read_to_string(&secret_path).await.map_err(|source| {
                        match source.kind() {
                            std::io::ErrorKind::NotFound => {
                                ServerSettingsReadError::MissingSecret {
                                    instance_id: instance_id.clone(),
                                    environment_variable: variable.name.clone(),
                                    path: secret_path.clone(),
                                }
                            }
                            _ => ServerSettingsReadError::Read {
                                path: secret_path.clone(),
                                source,
                            },
                        }
                    })?;
                    variable.value = secret;
                    persisted_variable.value.clear();
                    persisted_variable.value_redacted = true;
                }
            }
        }

        let persisted_value =
            serde_json::to_value(&persisted).map_err(|source| ServerSettingsReadError::Decode {
                path: self.settings_path(),
                source,
            })?;
        let defaults =
            serde_json::to_value(ProviderSettingsState::default()).map_err(|source| {
                ServerSettingsReadError::Decode {
                    path: self.settings_path(),
                    source,
                }
            })?;
        let stripped = strip_defaults(&persisted_value, &defaults)
            .unwrap_or(Value::Object(Default::default()));
        write_json_atomically(&self.settings_path(), &stripped).await?;
        Ok(settings)
    }

    async fn materialize_secrets(
        &self,
        mut settings: ProviderSettingsState,
    ) -> Result<ProviderSettingsState, ServerSettingsReadError> {
        for (instance_id, instance) in &mut settings.provider_instances {
            for variable in &mut instance.environment {
                if variable.sensitive && variable.value_redacted {
                    let secret_path = self.secret_path(instance_id, &variable.name);
                    variable.value = fs::read_to_string(&secret_path).await.map_err(|source| {
                        match source.kind() {
                            std::io::ErrorKind::NotFound => {
                                ServerSettingsReadError::MissingSecret {
                                    instance_id: instance_id.clone(),
                                    environment_variable: variable.name.clone(),
                                    path: secret_path.clone(),
                                }
                            }
                            _ => ServerSettingsReadError::Read {
                                path: secret_path.clone(),
                                source,
                            },
                        }
                    })?;
                }
            }
        }
        Ok(settings)
    }

    fn secret_path(&self, instance_id: &str, name: &str) -> PathBuf {
        self.secrets_dir().join(format!(
            "provider-env-{}-{}",
            URL_SAFE_NO_PAD.encode(instance_id),
            URL_SAFE_NO_PAD.encode(name)
        ))
    }
}

fn apply_patch(
    mut current: ProviderSettingsState,
    patch: ServerSettingsPatch,
) -> ProviderSettingsState {
    if let Some(value) = patch.automatic_git_fetch_interval_ms {
        current.automatic_git_fetch_interval = value;
    }
    if let Some(value) = patch.add_project_base_directory {
        current.add_project_base_directory = value.trim().to_owned();
    }
    if let Some(value) = patch.observability {
        if let Some(url) = value.otlp_traces_url {
            current.observability.otlp_traces_url = url.trim().to_owned();
        }
        if let Some(url) = value.otlp_metrics_url {
            current.observability.otlp_metrics_url = url.trim().to_owned();
        }
    }
    if let Some(providers) = patch.providers {
        apply_provider_patch(&mut current.providers.codex, providers.codex, "codex");
        apply_provider_patch(
            &mut current.providers.claude_agent,
            providers.claude_agent,
            "claude",
        );
        apply_provider_patch(
            &mut current.providers.cursor,
            providers.cursor,
            "cursor-agent",
        );
        apply_provider_patch(&mut current.providers.grok, providers.grok, "grok");
        apply_provider_patch(
            &mut current.providers.opencode,
            providers.opencode,
            "opencode",
        );
    }
    if let Some(instances) = patch.provider_instances {
        current.provider_instances = instances
            .into_iter()
            .map(|(instance_id, instance)| {
                (
                    instance_id,
                    ProviderInstanceState {
                        driver: instance.driver,
                        enabled: instance.enabled,
                        display_name: instance.display_name,
                        environment: instance
                            .environment
                            .into_iter()
                            .map(|variable| ProviderEnvironmentVariableState {
                                name: variable.name,
                                value: variable.value,
                                sensitive: variable.sensitive,
                                value_redacted: variable.value_redacted,
                            })
                            .collect(),
                        config: instance.config,
                    },
                )
            })
            .collect();
    }
    current
}

fn apply_provider_patch(
    current: &mut ProviderBinarySettingsState,
    patch: Option<ProviderSettingsPatch>,
    default_binary: &str,
) {
    let Some(patch) = patch else {
        return;
    };
    if let Some(enabled) = patch.enabled {
        current.enabled = enabled;
    }
    if let Some(binary_path) = patch.binary_path {
        let trimmed = binary_path.trim();
        current.binary_path = if trimmed.is_empty() {
            default_binary.to_owned()
        } else {
            trimmed.to_owned()
        };
    }
    if let Some(server_url) = patch.server_url {
        current.server_url = server_url.trim().to_owned();
    }
    if let Some(server_password) = patch.server_password {
        current.server_password = server_password.trim().to_owned();
    }
}

fn strip_defaults(current: &Value, defaults: &Value) -> Option<Value> {
    match (current, defaults) {
        (Value::Object(current), Value::Object(defaults)) => {
            let mut next = serde_json::Map::new();
            for (key, value) in current {
                let stripped = strip_defaults(value, defaults.get(key).unwrap_or(&Value::Null));
                if let Some(value) = stripped {
                    next.insert(key.clone(), value);
                }
            }
            (!next.is_empty()).then_some(Value::Object(next))
        }
        (Value::Array(_), Value::Array(_)) if current == defaults => None,
        _ if current == defaults => None,
        _ => Some(current.clone()),
    }
}

async fn write_json_atomically(path: &Path, value: &Value) -> Result<(), ServerSettingsReadError> {
    let mut encoded =
        serde_json::to_vec_pretty(value).map_err(|source| ServerSettingsReadError::Decode {
            path: path.to_path_buf(),
            source,
        })?;
    encoded.push(b'\n');
    write_bytes_atomically(path, &encoded)
        .await
        .map_err(|source| ServerSettingsReadError::Persist {
            path: path.to_path_buf(),
            source,
        })
}

async fn write_bytes_atomically(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).await?;
    let temporary_dir = parent.join(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("settings"),
        Uuid::new_v4()
    ));
    fs::create_dir(&temporary_dir).await?;
    let temporary_path = temporary_dir.join("contents.tmp");
    let result = async {
        let mut file = fs::File::create(&temporary_path).await?;
        file.write_all(contents).await?;
        file.sync_all().await?;
        drop(file);
        if fs::rename(&temporary_path, path).await.is_err() {
            let _ = fs::remove_file(path).await;
            fs::rename(&temporary_path, path).await?;
        }
        Ok(())
    }
    .await;
    let _ = fs::remove_dir_all(&temporary_dir).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn filesystem_and_patch_boundaries_cover_settings_failure_contracts() {
        assert_eq!(
            ProviderSettingsState::default().providers.cursor.binary_path,
            "cursor-agent"
        );

        let temporary = tempfile::tempdir().unwrap();
        let unreadable_settings = temporary.path().join("unreadable");
        fs::create_dir_all(unreadable_settings.join("settings.json"))
            .await
            .unwrap();
        assert!(matches!(
            ProviderSettingsStore::new(&unreadable_settings)
                .read_persisted()
                .await,
            Err(ServerSettingsReadError::Read { .. })
        ));

        let blocked_root = temporary.path().join("blocked-root");
        fs::write(&blocked_root, "file").await.unwrap();
        assert!(matches!(
            ProviderSettingsStore::new(&blocked_root)
                .materialize_and_persist(ProviderSettingsState::default())
                .await,
            Err(ServerSettingsReadError::Persist { .. })
        ));
        assert!(
            write_json_atomically(&blocked_root.join("settings.json"), &Value::Null)
                .await
                .is_err()
        );

        let secret_root = temporary.path().join("secret-root");
        let store = ProviderSettingsStore::new(&secret_root);
        fs::create_dir_all(store.secret_path("instance", "TOKEN"))
            .await
            .unwrap();
        let mut settings = ProviderSettingsState::default();
        settings.provider_instances.insert(
            "instance".to_owned(),
            ProviderInstanceState {
                driver: "codex".to_owned(),
                enabled: true,
                display_name: None,
                environment: vec![ProviderEnvironmentVariableState {
                    name: "TOKEN".to_owned(),
                    value: String::new(),
                    sensitive: true,
                    value_redacted: true,
                }],
                config: Value::Null,
            },
        );
        assert!(matches!(
            store.materialize_secrets(settings).await,
            Err(ServerSettingsReadError::Read { .. })
        ));

        let mut provider = ProviderBinarySettingsState::default();
        apply_provider_patch(
            &mut provider,
            Some(ProviderSettingsPatch {
                enabled: Some(true),
                binary_path: Some(" custom ".to_owned()),
                server_url: Some(" http://localhost ".to_owned()),
                server_password: Some(" secret ".to_owned()),
            }),
            "default",
        );
        assert!(provider.enabled);
        assert_eq!(provider.binary_path, "custom");
        assert_eq!(provider.server_url, "http://localhost");
        assert_eq!(provider.server_password, "secret");
        assert_eq!(strip_defaults(&Value::Null, &Value::Null), None);
        assert_eq!(
            strip_defaults(&Value::String("value".to_owned()), &Value::Null),
            Some(Value::String("value".to_owned()))
        );
    }
}
