use std::{
    collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, process::Stdio, sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

use crate::{
    process::configure_background_command,
    production::provider_runtime::{
        prepare_provider_launch, resolve_provider_executable,
        sanitize_provider_subprocess_environment,
    },
};

pub const MIN_MANUAL_REFRESH_MS: i64 = 30_000;
pub const STALE_THRESHOLD_MS: i64 = 30 * 60_000;
const USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
#[cfg(target_os = "macos")]
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum ProviderUsageProvider {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderUsageStatus {
    Idle,
    Fetching,
    Ok,
    Error,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderUsageWindow {
    pub used_percent: u32,
    pub window_minutes: u32,
    pub resets_at: Option<OffsetDateTime>,
    pub reset_description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderUsageSnapshot {
    pub provider: ProviderUsageProvider,
    pub status: ProviderUsageStatus,
    pub session: Option<ProviderUsageWindow>,
    pub weekly: Option<ProviderUsageWindow>,
    pub updated_at: OffsetDateTime,
    pub error: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderUsageResult {
    pub read_at: OffsetDateTime,
    pub is_fetching: bool,
    pub providers: Vec<ProviderUsageSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderUsageFetchError {
    pub message: String,
}

impl ProviderUsageFetchError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
enum ClaudeCredentialStore {
    File(PathBuf),
    #[cfg(target_os = "macos")]
    Keychain {
        account: String,
    },
}

type FetchFuture =
    Pin<Box<dyn Future<Output = Result<ProviderUsageSnapshot, ProviderUsageFetchError>> + Send>>;

#[derive(Clone)]
pub struct ProviderUsageFetcher {
    pub provider: ProviderUsageProvider,
    pub fetch: Arc<dyn Fn() -> FetchFuture + Send + Sync>,
}

#[derive(Default)]
struct ProviderUsageState {
    snapshots: BTreeMap<ProviderUsageProvider, ProviderUsageSnapshot>,
    is_fetching: bool,
    last_refresh_started_at_ms: Option<i64>,
}

#[derive(Clone)]
pub struct ProviderUsageService {
    fetchers: Arc<BTreeMap<ProviderUsageProvider, ProviderUsageFetcher>>,
    now: Arc<dyn Fn() -> OffsetDateTime + Send + Sync>,
    state: Arc<Mutex<ProviderUsageState>>,
}

impl ProviderUsageService {
    #[must_use]
    pub fn new(
        fetchers: Vec<ProviderUsageFetcher>,
        now: Arc<dyn Fn() -> OffsetDateTime + Send + Sync>,
    ) -> Self {
        Self {
            fetchers: Arc::new(
                fetchers
                    .into_iter()
                    .map(|fetcher| (fetcher.provider, fetcher))
                    .collect(),
            ),
            now,
            state: Arc::new(Mutex::new(ProviderUsageState::default())),
        }
    }

    pub async fn read(&self) -> ProviderUsageResult {
        let read_at = (self.now)();
        let state = self.state.lock().await;
        ProviderUsageResult {
            read_at,
            is_fetching: state.is_fetching,
            providers: providers()
                .into_iter()
                .map(|provider| {
                    let snapshot = state.snapshots.get(&provider).cloned().unwrap_or_else(|| {
                        unavailable_snapshot(
                            provider,
                            read_at,
                            "Provider usage has not been fetched yet.",
                        )
                    });
                    apply_staleness(snapshot, read_at)
                })
                .collect(),
        }
    }

    pub async fn refresh(
        &self,
        selected_providers: Option<Vec<ProviderUsageProvider>>,
    ) -> ProviderUsageResult {
        let read_at = (self.now)();
        let now_ms = unix_timestamp_ms(read_at);
        {
            let mut state = self.state.lock().await;
            if state
                .last_refresh_started_at_ms
                .is_some_and(|last| now_ms - last < MIN_MANUAL_REFRESH_MS)
            {
                return drop_and_read(state, self).await;
            }
            state.is_fetching = true;
            state.last_refresh_started_at_ms = Some(now_ms);
        }

        let selected = selected_providers.unwrap_or_else(providers);
        let mut next_snapshots = Vec::with_capacity(selected.len());
        for provider in selected {
            let snapshot = match self.fetchers.get(&provider) {
                Some(fetcher) => match (fetcher.fetch)().await {
                    Ok(snapshot) => snapshot,
                    Err(error) => error_snapshot(provider, read_at, error.message),
                },
                None => unavailable_snapshot(
                    provider,
                    read_at,
                    "Provider usage fetcher is unavailable.",
                ),
            };
            next_snapshots.push(snapshot);
        }

        let mut state = self.state.lock().await;
        for snapshot in next_snapshots {
            state.snapshots.insert(snapshot.provider, snapshot);
        }
        state.is_fetching = false;
        drop_and_read(state, self).await
    }
}

#[must_use]
pub fn production_fetchers() -> Vec<ProviderUsageFetcher> {
    vec![claude_fetcher(), codex_fetcher()]
}

fn claude_fetcher() -> ProviderUsageFetcher {
    ProviderUsageFetcher {
        provider: ProviderUsageProvider::Claude,
        fetch: Arc::new(|| Box::pin(fetch_claude_usage())),
    }
}

fn codex_fetcher() -> ProviderUsageFetcher {
    ProviderUsageFetcher {
        provider: ProviderUsageProvider::Codex,
        fetch: Arc::new(|| Box::pin(fetch_codex_usage())),
    }
}

async fn fetch_claude_usage() -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let now = OffsetDateTime::now_utc();
    let configured_directory = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    let uses_default_config = configured_directory.is_none();
    let credentials_path = configured_directory
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .map(|directory| directory.join(".credentials.json"));
    let stores = credentials_path
        .into_iter()
        .map(ClaudeCredentialStore::File)
        .collect::<Vec<_>>();
    #[cfg(target_os = "macos")]
    if uses_default_config {
        if let Some(account) = claude_keychain_account() {
            stores.push(ClaudeCredentialStore::Keychain { account });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = uses_default_config;

    for store in stores {
        let credentials = match store.load().await {
            Ok(Some(credentials)) => credentials,
            Ok(None) | Err(_) => continue,
        };
        if !has_usable_claude_oauth_credentials(&credentials, now) {
            continue;
        }
        return fetch_claude_usage_from_credentials(
            store,
            credentials,
            CLAUDE_USAGE_URL,
            CLAUDE_OAUTH_TOKEN_URL,
            now,
            USAGE_TIMEOUT,
        )
        .await;
    }

    Ok(unavailable_snapshot(
        ProviderUsageProvider::Claude,
        now,
        "Claude OAuth credentials were not found.",
    ))
}

#[cfg(test)]
async fn fetch_claude_usage_from_store(
    store: ClaudeCredentialStore,
    usage_url: &str,
    oauth_token_url: &str,
    now: OffsetDateTime,
    timeout: Duration,
) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let credentials = store
        .load()
        .await?
        .ok_or_else(|| ProviderUsageFetchError::new("Claude OAuth credentials were not found."))?;
    fetch_claude_usage_from_credentials(
        store,
        credentials,
        usage_url,
        oauth_token_url,
        now,
        timeout,
    )
    .await
}

async fn fetch_claude_usage_from_credentials(
    store: ClaudeCredentialStore,
    mut credentials: Value,
    usage_url: &str,
    oauth_token_url: &str,
    now: OffsetDateTime,
    timeout: Duration,
) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let mut token = claude_oauth_access_token(&credentials, now);
    if token.is_none() {
        credentials =
            refresh_claude_oauth_credentials(oauth_token_url, credentials, now, timeout).await?;
        store.persist(&credentials).await?;
        token = claude_oauth_access_token(&credentials, now);
    }
    let token = token.ok_or_else(|| {
        ProviderUsageFetchError::new("Claude OAuth refresh returned unusable credentials.")
    })?;
    request_claude_usage(usage_url, &token, now, timeout).await
}

async fn request_claude_usage(
    url: &str,
    token: &str,
    now: OffsetDateTime,
    timeout: Duration,
) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.0")
        .send()
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ProviderUsageFetchError::new(format!(
            "Claude usage request failed with HTTP {}.",
            response.status().as_u16()
        )));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    Ok(map_claude_usage(&payload, now))
}

#[cfg(test)]
fn select_claude_oauth_token(
    credentials_file: Option<&str>,
    keychain_credentials: Option<&str>,
) -> Option<String> {
    let now = OffsetDateTime::now_utc();
    [credentials_file, keychain_credentials]
        .into_iter()
        .flatten()
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .find_map(|credentials| claude_oauth_access_token(&credentials, now))
}

fn claude_oauth_access_token(credentials: &Value, now: OffsetDateTime) -> Option<String> {
    let refresh_before_ms = now.unix_timestamp_nanos() / 1_000_000 + 30_000;
    if credentials
        .pointer("/claudeAiOauth/expiresAt")
        .and_then(Value::as_i64)
        .is_some_and(|expires_at| i128::from(expires_at) <= refresh_before_ms)
    {
        return None;
    }
    credentials
        .pointer("/claudeAiOauth/accessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn has_usable_claude_oauth_credentials(credentials: &Value, now: OffsetDateTime) -> bool {
    claude_oauth_access_token(credentials, now).is_some()
        || credentials
            .pointer("/claudeAiOauth/refreshToken")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

impl ClaudeCredentialStore {
    async fn load(&self) -> Result<Option<Value>, ProviderUsageFetchError> {
        let raw = match self {
            Self::File(path) => match tokio::fs::read_to_string(path).await {
                Ok(raw) => Some(raw),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(ProviderUsageFetchError::new(error.to_string())),
            },
            #[cfg(target_os = "macos")]
            Self::Keychain { .. } => read_claude_keychain_credentials().await,
        };
        raw.map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|error| ProviderUsageFetchError::new(error.to_string()))
        })
        .transpose()
    }

    async fn persist(&self, credentials: &Value) -> Result<(), ProviderUsageFetchError> {
        let encoded = serde_json::to_vec(credentials)
            .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
        match self {
            Self::File(path) => tokio::fs::write(path, encoded)
                .await
                .map_err(|error| ProviderUsageFetchError::new(error.to_string())),
            #[cfg(target_os = "macos")]
            Self::Keychain { account } => {
                let account = account.clone();
                tokio::task::spawn_blocking(move || {
                    security_framework::passwords::set_generic_password(
                        CLAUDE_KEYCHAIN_SERVICE,
                        &account,
                        &encoded,
                    )
                    .map_err(|error| ProviderUsageFetchError::new(error.to_string()))
                })
                .await
                .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn claude_keychain_account() -> Option<String> {
    std::env::var("USER")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            dirs::home_dir()?
                .file_name()?
                .to_str()
                .map(ToOwned::to_owned)
        })
}

async fn refresh_claude_oauth_credentials(
    url: &str,
    mut credentials: Value,
    now: OffsetDateTime,
    timeout: Duration,
) -> Result<Value, ProviderUsageFetchError> {
    let oauth = credentials
        .pointer("/claudeAiOauth")
        .and_then(Value::as_object)
        .ok_or_else(|| ProviderUsageFetchError::new("Claude OAuth credentials are malformed."))?;
    let refresh_token = oauth
        .get("refreshToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ProviderUsageFetchError::new("Claude OAuth refresh token was not found."))?
        .to_owned();
    let scopes = oauth
        .get("scopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLAUDE_OAUTH_CLIENT_ID,
            "scope": scopes,
        }))
        .send()
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ProviderUsageFetchError::new(format!(
            "Claude OAuth refresh failed with HTTP {}.",
            response.status().as_u16()
        )));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderUsageFetchError::new("Claude OAuth refresh returned no access token.")
        })?;
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            ProviderUsageFetchError::new("Claude OAuth refresh returned no valid expiry.")
        })?;
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000)
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let expires_at = now_ms
        .checked_add(expires_in.saturating_mul(1_000))
        .ok_or_else(|| ProviderUsageFetchError::new("Claude OAuth expiry overflowed."))?;
    let oauth = credentials
        .pointer_mut("/claudeAiOauth")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ProviderUsageFetchError::new("Claude OAuth credentials are malformed."))?;
    oauth.insert("accessToken".to_owned(), json!(access_token));
    oauth.insert("expiresAt".to_owned(), json!(expires_at));
    if let Some(rotated_refresh_token) = payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        oauth.insert("refreshToken".to_owned(), json!(rotated_refresh_token));
    }
    if let Some(refresh_expires_in) = payload
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
    {
        let refresh_expires_at = now_ms
            .checked_add(refresh_expires_in.saturating_mul(1_000))
            .ok_or_else(|| {
                ProviderUsageFetchError::new("Claude OAuth refresh expiry overflowed.")
            })?;
        oauth.insert(
            "refreshTokenExpiresAt".to_owned(),
            json!(refresh_expires_at),
        );
    }
    if let Some(scope) = payload.get("scope").and_then(Value::as_str) {
        oauth.insert(
            "scopes".to_owned(),
            Value::Array(scope.split_whitespace().map(|value| json!(value)).collect()),
        );
    }
    Ok(credentials)
}

#[cfg(target_os = "macos")]
async fn read_claude_keychain_credentials() -> Option<String> {
    read_claude_keychain_credentials_with(std::path::Path::new("/usr/bin/security"), USAGE_TIMEOUT)
        .await
}

#[cfg(target_os = "macos")]
async fn read_claude_keychain_credentials_with(
    program: &std::path::Path,
    timeout: Duration,
) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

async fn fetch_codex_usage() -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let now = OffsetDateTime::now_utc();
    let codex_home = match std::env::var_os("CODEX_HOME") {
        Some(home) => Some(PathBuf::from(home)),
        None => dirs::home_dir().map(|home| home.join(".codex")),
    };
    if !codex_home
        .as_ref()
        .is_some_and(|home| home.join("auth.json").is_file())
    {
        return Ok(unavailable_snapshot(
            ProviderUsageProvider::Codex,
            now,
            "Codex not signed in.",
        ));
    }
    let binary = match std::env::var("CODEX_BIN") {
        Ok(binary) => binary,
        Err(_) => "codex".to_owned(),
    };
    let executable = resolve_provider_executable(&binary).ok_or_else(|| {
        ProviderUsageFetchError::new(format!("Codex executable was not found: {binary}"))
    })?;
    let launch = prepare_provider_launch(
        &executable,
        ["-s", "read-only", "-a", "untrusted", "app-server"],
    )
    .map_err(ProviderUsageFetchError::new)?;
    let mut command = Command::new(launch.program);
    configure_background_command(&mut command);
    command
        .args(launch.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    sanitize_provider_subprocess_environment(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(ProviderUsageFetchError::new(error.to_string())),
    };
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            return Err(ProviderUsageFetchError::new(
                "Codex app-server stdin is unavailable.",
            ));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            return Err(ProviderUsageFetchError::new(
                "Codex app-server stdout is unavailable.",
            ));
        }
    };
    let operation = async {
        write_rpc(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "t4code", "title": "T4Code", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true}
                }
            }),
        )
        .await?;
        let mut lines = BufReader::new(stdout).lines();
        let initialized = read_rpc_result(&mut lines, 1).await?;
        if let Some(error) = initialized.get("error") {
            return Err(ProviderUsageFetchError::new(rpc_error(
                error,
                "Codex initialize failed.",
            )));
        }
        write_rpc(
            &mut stdin,
            &json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
        )
        .await?;
        write_rpc(
            &mut stdin,
            &json!({"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}),
        )
        .await?;
        let response = read_rpc_result(&mut lines, 2).await?;
        if let Some(error) = response.get("error") {
            return Err(ProviderUsageFetchError::new(rpc_error(
                error,
                "Codex rate-limit read failed.",
            )));
        }
        Ok(map_codex_usage(
            response.get("result").unwrap_or(&Value::Null),
            now,
        ))
    };
    let result = match tokio::time::timeout(USAGE_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => {
            return Err(ProviderUsageFetchError::new(
                "Codex app-server RPC timeout.",
            ));
        }
    };
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result
}

async fn write_rpc(
    stdin: &mut tokio::process::ChildStdin,
    message: &Value,
) -> Result<(), ProviderUsageFetchError> {
    let mut bytes = match serde_json::to_vec(message) {
        Ok(bytes) => bytes,
        Err(error) => return Err(ProviderUsageFetchError::new(error.to_string())),
    };
    bytes.push(b'\n');
    match stdin.write_all(&bytes).await {
        Ok(()) => Ok(()),
        Err(error) => Err(ProviderUsageFetchError::new(error.to_string())),
    }
}

async fn read_rpc_result<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<Value, ProviderUsageFetchError> {
    while let Some(line) = match lines.next_line().await {
        Ok(line) => line,
        Err(error) => return Err(ProviderUsageFetchError::new(error.to_string())),
    } {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return Ok(value);
        }
    }
    Err(ProviderUsageFetchError::new(
        "Codex app-server exited before replying.",
    ))
}

fn rpc_error(value: &Value, fallback: &str) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn map_claude_usage(payload: &Value, now: OffsetDateTime) -> ProviderUsageSnapshot {
    usage_snapshot(
        ProviderUsageProvider::Claude,
        map_window(payload.get("five_hour"), 300),
        map_window(payload.get("seven_day"), 10_080),
        now,
        [
            ("source", "oauth"),
            ("credentialSource", "credentials-file"),
        ],
        "Claude did not report usage windows.",
    )
}

fn map_codex_usage(payload: &Value, now: OffsetDateTime) -> ProviderUsageSnapshot {
    usage_snapshot(
        ProviderUsageProvider::Codex,
        map_window(payload.pointer("/rateLimits/primary"), 300),
        map_window(payload.pointer("/rateLimits/secondary"), 10_080),
        now,
        [("source", "app-server")],
        "Codex did not report rate-limit windows.",
    )
}

fn usage_snapshot<const N: usize>(
    provider: ProviderUsageProvider,
    session: Option<ProviderUsageWindow>,
    weekly: Option<ProviderUsageWindow>,
    now: OffsetDateTime,
    metadata: [(&str, &str); N],
    unavailable_message: &str,
) -> ProviderUsageSnapshot {
    if session.is_none() && weekly.is_none() {
        return unavailable_snapshot(provider, now, unavailable_message);
    }
    ProviderUsageSnapshot {
        provider,
        status: ProviderUsageStatus::Ok,
        session,
        weekly,
        updated_at: now,
        error: None,
        metadata: metadata
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect(),
    }
}

fn map_window(value: Option<&Value>, window_minutes: u32) -> Option<ProviderUsageWindow> {
    let value = value?;
    let used_percent = value
        .get("utilization")
        .or_else(|| value.get("used_percentage"))
        .or_else(|| value.get("usedPercent"))
        .and_then(Value::as_f64)?
        .clamp(0.0, 100.0)
        .round() as u32;
    Some(ProviderUsageWindow {
        used_percent,
        window_minutes,
        resets_at: value
            .get("resets_at")
            .or_else(|| value.get("resetsAt"))
            .and_then(parse_reset),
        reset_description: None,
    })
}

fn parse_reset(value: &Value) -> Option<OffsetDateTime> {
    if let Some(number) = value.as_f64() {
        let seconds = if number < 10_000_000_000.0 {
            number
        } else {
            number / 1_000.0
        };
        return OffsetDateTime::from_unix_timestamp(seconds.trunc() as i64).ok();
    }
    let raw = value.as_str()?.trim();
    if let Ok(number) = raw.parse::<f64>() {
        return parse_reset(&json!(number));
    }
    OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
}

async fn drop_and_read(
    state: tokio::sync::MutexGuard<'_, ProviderUsageState>,
    service: &ProviderUsageService,
) -> ProviderUsageResult {
    drop(state);
    service.read().await
}

fn providers() -> Vec<ProviderUsageProvider> {
    vec![ProviderUsageProvider::Claude, ProviderUsageProvider::Codex]
}

fn unavailable_snapshot(
    provider: ProviderUsageProvider,
    now: OffsetDateTime,
    error: impl Into<String>,
) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        provider,
        status: ProviderUsageStatus::Unavailable,
        session: None,
        weekly: None,
        updated_at: now,
        error: Some(error.into()),
        metadata: BTreeMap::new(),
    }
}

fn error_snapshot(
    provider: ProviderUsageProvider,
    now: OffsetDateTime,
    error: impl Into<String>,
) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        provider,
        status: ProviderUsageStatus::Error,
        session: None,
        weekly: None,
        updated_at: now,
        error: Some(error.into()),
        metadata: BTreeMap::new(),
    }
}

fn apply_staleness(snapshot: ProviderUsageSnapshot, now: OffsetDateTime) -> ProviderUsageSnapshot {
    if snapshot.status != ProviderUsageStatus::Ok {
        return snapshot;
    }
    let age_ms = (now - snapshot.updated_at).whole_milliseconds();
    if age_ms <= i128::from(STALE_THRESHOLD_MS) {
        snapshot
    } else {
        unavailable_snapshot(
            snapshot.provider,
            snapshot.updated_at,
            "Provider usage snapshot is stale.",
        )
    }
}

fn unix_timestamp_ms(value: OffsetDateTime) -> i64 {
    let milliseconds = value.unix_timestamp_nanos() / 1_000_000;
    i64::try_from(milliseconds).unwrap_or_else(|_| {
        if milliseconds.is_negative() {
            i64::MIN
        } else {
            i64::MAX
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn claude_usage_fixture(
        status: &str,
        body: &str,
    ) -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let body = body.to_owned();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 2048];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.starts_with("get /usage "));
            assert!(request.contains("authorization: bearer oauth-token"));
            assert!(request.contains("anthropic-beta: oauth-2025-04-20"));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let result = request_claude_usage(
            &format!("http://{address}/usage"),
            "oauth-token",
            OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap(),
            Duration::from_secs(1),
        )
        .await;
        server.await.unwrap();
        result
    }

    #[test]
    fn claude_oauth_token_falls_back_to_macos_keychain_payload() {
        let token = select_claude_oauth_token(
            None,
            Some(
                r#"{"claudeAiOauth":{"accessToken":"keychain-oauth-token","refreshToken":"ignored"}}"#,
            ),
        );

        assert_eq!(token.as_deref(), Some("keychain-oauth-token"));
    }

    #[test]
    fn claude_oauth_token_rejects_expired_access_token() {
        let token = select_claude_oauth_token(
            None,
            Some(
                r#"{"claudeAiOauth":{"accessToken":"expired-token","refreshToken":"refresh-token","expiresAt":1}}"#,
            ),
        );

        assert_eq!(token, None);
    }

    #[tokio::test]
    async fn claude_oauth_refresh_rotates_credentials_without_losing_keychain_data() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            let body = request.split("\r\n\r\n").nth(1).unwrap();
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["grant_type"], "refresh_token");
            assert_eq!(body["refresh_token"], "old-refresh-token");
            assert_eq!(body["client_id"], CLAUDE_OAUTH_CLIENT_ID);
            assert_eq!(
                body["scope"],
                "user:profile user:inference user:sessions:claude_code"
            );
            let response_body = json!({
                "access_token": "new-access-token",
                "refresh_token": "new-refresh-token",
                "expires_in": 3600,
                "refresh_token_expires_in": 7200,
                "scope": "user:profile user:inference user:sessions:claude_code"
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{response_body}",
                response_body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let credentials = json!({
            "claudeAiOauth": {
                "accessToken": "old-access-token",
                "refreshToken": "old-refresh-token",
                "expiresAt": 1,
                "scopes": ["user:profile", "user:inference", "user:sessions:claude_code"],
                "subscriptionType": "team"
            },
            "mcpOAuth": {"preserved": true}
        });

        let refreshed = refresh_claude_oauth_credentials(
            &format!("http://{address}/v1/oauth/token"),
            credentials,
            now,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(
            refreshed.pointer("/claudeAiOauth/accessToken"),
            Some(&json!("new-access-token"))
        );
        assert_eq!(
            refreshed.pointer("/claudeAiOauth/refreshToken"),
            Some(&json!("new-refresh-token"))
        );
        assert_eq!(
            refreshed.pointer("/claudeAiOauth/expiresAt"),
            Some(&json!(1_800_003_600_000_i64))
        );
        assert_eq!(
            refreshed.pointer("/claudeAiOauth/refreshTokenExpiresAt"),
            Some(&json!(1_800_007_200_000_i64))
        );
        assert_eq!(refreshed.pointer("/mcpOAuth/preserved"), Some(&json!(true)));
    }

    #[tokio::test]
    async fn expired_claude_credentials_are_refreshed_persisted_and_used_for_usage() {
        let temporary = tempfile::tempdir().unwrap();
        let credentials_path = temporary.path().join(".credentials.json");
        std::fs::write(
            &credentials_path,
            json!({
                "claudeAiOauth": {
                    "accessToken": "expired-access-token",
                    "refreshToken": "old-refresh-token",
                    "expiresAt": 1,
                    "scopes": ["user:profile", "user:inference"]
                },
                "mcpOAuth": {"preserved": true}
            })
            .to_string(),
        )
        .unwrap();
        let oauth_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let oauth_address = oauth_listener.local_addr().unwrap();
        let oauth_server = tokio::spawn(async move {
            let (mut stream, _) = oauth_listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            let body = json!({
                "access_token": "fresh-access-token",
                "refresh_token": "fresh-refresh-token",
                "expires_in": 3600
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let usage_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let usage_address = usage_listener.local_addr().unwrap();
        let usage_server = tokio::spawn(async move {
            let (mut stream, _) = usage_listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.contains("authorization: bearer fresh-access-token"));
            let body = r#"{"five_hour":{"utilization":45},"seven_day":{"utilization":92}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();

        let snapshot = fetch_claude_usage_from_store(
            ClaudeCredentialStore::File(credentials_path.clone()),
            &format!("http://{usage_address}/api/oauth/usage"),
            &format!("http://{oauth_address}/v1/oauth/token"),
            now,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        oauth_server.await.unwrap();
        usage_server.await.unwrap();

        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        assert_eq!(snapshot.session.unwrap().used_percent, 45);
        assert_eq!(snapshot.weekly.unwrap().used_percent, 92);
        let persisted: Value =
            serde_json::from_str(&std::fs::read_to_string(credentials_path).unwrap()).unwrap();
        assert_eq!(
            persisted.pointer("/claudeAiOauth/accessToken"),
            Some(&json!("fresh-access-token"))
        );
        assert_eq!(
            persisted.pointer("/claudeAiOauth/refreshToken"),
            Some(&json!("fresh-refresh-token"))
        );
        assert_eq!(persisted.pointer("/mcpOAuth/preserved"), Some(&json!(true)));
    }

    #[tokio::test]
    async fn claude_usage_request_covers_success_http_json_and_transport_failures() {
        let success = claude_usage_fixture(
            "200 OK",
            r#"{"five_hour":{"utilization":25},"seven_day":{"utilization":50}}"#,
        )
        .await
        .unwrap();
        assert_eq!(success.status, ProviderUsageStatus::Ok);

        assert_eq!(
            claude_usage_fixture("429 Too Many Requests", "{}")
                .await
                .unwrap_err()
                .message,
            "Claude usage request failed with HTTP 429."
        );
        assert!(
            claude_usage_fixture("200 OK", "not-json")
                .await
                .unwrap_err()
                .message
                .contains("decod")
        );
        assert!(
            request_claude_usage(
                "http://127.0.0.1:9/usage",
                "oauth-token",
                OffsetDateTime::UNIX_EPOCH,
                Duration::from_millis(100),
            )
            .await
            .is_err()
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn reads_claude_credentials_with_the_expected_macos_keychain_query() {
        use std::os::unix::fs::PermissionsExt;

        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temporary = tempfile::tempdir().expect("temporary directory");
        let security = temporary.path().join("security");
        std::fs::write(
            &security,
            r#"#!/bin/sh
if [ "$#" -ne 4 ] || [ "$1" != "find-generic-password" ] || [ "$2" != "-s" ] || [ "$3" != "Claude Code-credentials" ] || [ "$4" != "-w" ]; then
  exit 64
fi
printf '%s' '{"claudeAiOauth":{"accessToken":"keychain-oauth-token","refreshToken":"refresh-token","expiresAt":1900000000000,"refreshTokenExpiresAt":1900000000000,"scopes":["user:profile"],"subscriptionType":"team","rateLimitTier":"default"},"mcpOAuth":{}}'
"#,
        )
        .expect("security fixture");
        std::fs::set_permissions(&security, std::fs::Permissions::from_mode(0o700))
            .expect("security fixture permissions");

        let credentials = read_claude_keychain_credentials_with(&security, Duration::from_secs(1))
            .await
            .expect("keychain credentials");
        let token = select_claude_oauth_token(None, Some(&credentials));

        assert_eq!(token.as_deref(), Some("keychain-oauth-token"));

        let fixture = |name: &str, body: &str| {
            let path = temporary.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        let failed = fixture("security-failed", "exit 1");
        assert!(
            read_claude_keychain_credentials_with(&failed, Duration::from_secs(1))
                .await
                .is_none()
        );
        let invalid_utf8 = fixture("security-invalid", "printf '\\377'");
        assert!(
            read_claude_keychain_credentials_with(&invalid_utf8, Duration::from_secs(1))
                .await
                .is_none()
        );
        let slow = fixture("security-slow", "sleep 1");
        assert!(
            read_claude_keychain_credentials_with(&slow, Duration::from_millis(10))
                .await
                .is_none()
        );
        assert!(
            read_claude_keychain_credentials_with(
                &temporary.path().join("missing"),
                Duration::from_secs(1),
            )
            .await
            .is_none()
        );
    }

    #[test]
    fn maps_claude_oauth_windows() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("timestamp");
        let snapshot = map_claude_usage(
            &json!({
                "five_hour": {"utilization": 12.4, "resets_at": "2030-01-01T00:00:00Z"},
                "seven_day": {"used_percentage": 88}
            }),
            now,
        );

        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        assert_eq!(snapshot.session.expect("session").used_percent, 12);
        assert_eq!(snapshot.weekly.expect("weekly").used_percent, 88);
        assert_eq!(
            snapshot.metadata.get("source").map(String::as_str),
            Some("oauth")
        );
    }

    #[test]
    fn maps_codex_rate_limit_windows() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("timestamp");
        let snapshot = map_codex_usage(
            &json!({
                "rateLimits": {
                    "primary": {"usedPercent": 7, "resetsAt": 1_900_000_000},
                    "secondary": {"usedPercent": 41, "resetsAt": 1_900_000_000_000_i64}
                }
            }),
            now,
        );

        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        assert_eq!(snapshot.session.expect("session").window_minutes, 300);
        assert_eq!(snapshot.weekly.expect("weekly").window_minutes, 10_080);
        assert_eq!(
            snapshot.metadata.get("source").map(String::as_str),
            Some("app-server")
        );
    }

    #[test]
    fn maps_claude_optional_windows_and_reset_formats() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("timestamp");
        let snapshot = map_claude_usage(
            &json!({
                "five_hour": {
                    "utilization": -4.4,
                    "resets_at": "1900000000000"
                },
                "seven_day": {
                    "utilization": 99.6,
                    "resets_at": "2030-03-17T17:46:40Z"
                }
            }),
            now,
        );

        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        let session = snapshot.session.expect("session");
        assert_eq!(session.used_percent, 0);
        assert_eq!(
            session
                .resets_at
                .expect("milliseconds reset")
                .unix_timestamp(),
            1_900_000_000
        );
        let weekly = snapshot.weekly.expect("weekly");
        assert_eq!(weekly.used_percent, 100);
        assert_eq!(
            weekly.resets_at.expect("RFC3339 reset").unix_timestamp(),
            1_900_000_000
        );
        assert_eq!(
            snapshot
                .metadata
                .get("credentialSource")
                .map(String::as_str),
            Some("credentials-file")
        );
    }

    #[test]
    fn rejects_claude_payload_without_valid_windows() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("timestamp");
        let snapshot = map_claude_usage(
            &json!({
                "five_hour": {"utilization": "invalid"},
                "seven_day": null
            }),
            now,
        );

        assert_eq!(snapshot.status, ProviderUsageStatus::Unavailable);
        assert_eq!(
            snapshot.error.as_deref(),
            Some("Claude did not report usage windows.")
        );
        assert!(snapshot.session.is_none());
        assert!(snapshot.weekly.is_none());
        assert!(snapshot.metadata.is_empty());
    }

    #[test]
    fn maps_codex_payload_with_only_one_window() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).expect("timestamp");
        let snapshot = map_codex_usage(
            &json!({
                "rateLimits": {
                    "primary": {
                        "used_percentage": 42,
                        "resetsAt": "not-a-time"
                    }
                }
            }),
            now,
        );

        assert_eq!(snapshot.status, ProviderUsageStatus::Ok);
        let session = snapshot.session.expect("session");
        assert_eq!(session.used_percent, 42);
        assert!(session.resets_at.is_none());
        assert!(snapshot.weekly.is_none());
    }

    #[tokio::test]
    async fn service_refreshes_success_error_missing_and_rate_limited_providers() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let success = ProviderUsageFetcher {
            provider: ProviderUsageProvider::Claude,
            fetch: Arc::new(move || {
                Box::pin(async move {
                    Ok(ProviderUsageSnapshot {
                        provider: ProviderUsageProvider::Claude,
                        status: ProviderUsageStatus::Ok,
                        session: Some(ProviderUsageWindow {
                            used_percent: 25,
                            window_minutes: 300,
                            resets_at: None,
                            reset_description: Some("soon".to_owned()),
                        }),
                        weekly: None,
                        updated_at: now,
                        error: None,
                        metadata: BTreeMap::new(),
                    })
                })
            }),
        };
        let failure = ProviderUsageFetcher {
            provider: ProviderUsageProvider::Codex,
            fetch: Arc::new(|| {
                Box::pin(async { Err(ProviderUsageFetchError::new("fixture failure")) })
            }),
        };
        let service = ProviderUsageService::new(vec![success, failure], Arc::new(move || now));

        let initial = service.read().await;
        assert_eq!(initial.providers.len(), 2);
        assert!(
            initial
                .providers
                .iter()
                .all(|snapshot| snapshot.status == ProviderUsageStatus::Unavailable)
        );

        let refreshed = service.refresh(None).await;
        assert_eq!(refreshed.providers[0].status, ProviderUsageStatus::Ok);
        assert_eq!(refreshed.providers[1].status, ProviderUsageStatus::Error);
        assert_eq!(
            refreshed.providers[1].error.as_deref(),
            Some("fixture failure")
        );

        let rate_limited = service
            .refresh(Some(vec![ProviderUsageProvider::Claude]))
            .await;
        assert_eq!(rate_limited.providers, refreshed.providers);

        let missing = ProviderUsageService::new(Vec::new(), Arc::new(move || now))
            .refresh(Some(vec![ProviderUsageProvider::Claude]))
            .await;
        assert_eq!(
            missing.providers[0].status,
            ProviderUsageStatus::Unavailable
        );
        assert_eq!(production_fetchers().len(), 2);
    }

    #[test]
    fn staleness_error_and_timestamp_helpers_cover_boundary_values() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let fresh = ProviderUsageSnapshot {
            provider: ProviderUsageProvider::Claude,
            status: ProviderUsageStatus::Ok,
            session: None,
            weekly: None,
            updated_at: now,
            error: None,
            metadata: BTreeMap::new(),
        };
        assert_eq!(
            apply_staleness(fresh.clone(), now).status,
            ProviderUsageStatus::Ok
        );
        assert_eq!(
            apply_staleness(
                fresh,
                now + time::Duration::milliseconds(STALE_THRESHOLD_MS + 1),
            )
            .status,
            ProviderUsageStatus::Unavailable
        );
        let error = error_snapshot(ProviderUsageProvider::Codex, now, "failed");
        assert_eq!(
            apply_staleness(error, now).status,
            ProviderUsageStatus::Error
        );
        assert_eq!(unix_timestamp_ms(now), 1_800_000_000_000);
        assert_eq!(
            providers(),
            vec![ProviderUsageProvider::Claude, ProviderUsageProvider::Codex]
        );
    }

    #[tokio::test]
    async fn rpc_reader_ignores_noise_and_reports_remote_messages() {
        let input =
            b"not-json\n{\"id\":1,\"result\":{}}\n{\"id\":2,\"error\":{\"message\":\"denied\"}}\n";
        let mut lines = BufReader::new(&input[..]).lines();
        let first = read_rpc_result(&mut lines, 1).await.unwrap();
        assert!(first.get("result").is_some());
        let second = read_rpc_result(&mut lines, 2).await.unwrap();
        assert_eq!(rpc_error(&second["error"], "fallback"), "denied");

        let mut empty = BufReader::new(&b""[..]).lines();
        assert_eq!(
            read_rpc_result(&mut empty, 3).await.unwrap_err().message,
            "Codex app-server exited before replying."
        );
        assert_eq!(rpc_error(&json!({}), "fallback"), "fallback");
    }
}
