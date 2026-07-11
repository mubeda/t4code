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

use crate::production::provider_runtime::{provider_launch_program, resolve_provider_executable};

pub const MIN_MANUAL_REFRESH_MS: i64 = 30_000;
pub const STALE_THRESHOLD_MS: i64 = 30 * 60_000;
const USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

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
    let credentials_path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .map(|directory| directory.join(".credentials.json"));
    let Some(credentials_path) = credentials_path else {
        return Ok(unavailable_snapshot(
            ProviderUsageProvider::Claude,
            now,
            "Claude OAuth credentials were not found.",
        ));
    };
    let Ok(raw) = tokio::fs::read_to_string(credentials_path).await else {
        return Ok(unavailable_snapshot(
            ProviderUsageProvider::Claude,
            now,
            "Claude OAuth credentials were not found.",
        ));
    };
    let token = serde_json::from_str::<Value>(&raw).ok().and_then(|value| {
        value
            .pointer("/claudeAiOauth/accessToken")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });
    let Some(token) = token else {
        return Ok(unavailable_snapshot(
            ProviderUsageProvider::Claude,
            now,
            "Claude OAuth credentials were not found.",
        ));
    };
    let client = reqwest::Client::builder()
        .timeout(USAGE_TIMEOUT)
        .build()
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let response = client
        .get(CLAUDE_USAGE_URL)
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

async fn fetch_codex_usage() -> Result<ProviderUsageSnapshot, ProviderUsageFetchError> {
    let now = OffsetDateTime::now_utc();
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
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
    let binary = std::env::var("CODEX_BIN").unwrap_or_else(|_| "codex".to_owned());
    let executable = resolve_provider_executable(&binary).ok_or_else(|| {
        ProviderUsageFetchError::new(format!("Codex executable was not found: {binary}"))
    })?;
    let (program, prefix_args) = provider_launch_program(&executable);
    let mut child = Command::new(program)
        .args(prefix_args)
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ProviderUsageFetchError::new("Codex app-server stdin is unavailable."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProviderUsageFetchError::new("Codex app-server stdout is unavailable."))?;
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
    let result = tokio::time::timeout(USAGE_TIMEOUT, operation)
        .await
        .map_err(|_| ProviderUsageFetchError::new("Codex app-server RPC timeout."))?;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result
}

async fn write_rpc(
    stdin: &mut tokio::process::ChildStdin,
    message: &Value,
) -> Result<(), ProviderUsageFetchError> {
    let mut bytes = serde_json::to_vec(message)
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))
}

async fn read_rpc_result<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<Value, ProviderUsageFetchError> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| ProviderUsageFetchError::new(error.to_string()))?
    {
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
}
