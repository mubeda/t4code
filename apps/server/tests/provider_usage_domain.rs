use serde_json::json;
use t4code_server::provider_usage;

use provider_usage::{
    MIN_MANUAL_REFRESH_MS, ProviderUsageFetchError, ProviderUsageFetcher, ProviderUsageProvider,
    ProviderUsageService, ProviderUsageSnapshot, ProviderUsageStatus, ProviderUsageWindow,
    RateLimitResetCredits, STALE_THRESHOLD_MS, production_fetchers,
};
use std::{
    ffi::{OsStr, OsString},
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use time::{Duration, OffsetDateTime};
use tokio::sync::oneshot;

struct EnvGuard {
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl EnvGuard {
    fn new(keys: &[&'static str]) -> Self {
        Self {
            saved: keys
                .iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        }
    }

    fn set(key: &'static str, value: impl AsRef<OsStr>) {
        // This test target runs with RUST_TEST_THREADS=1 and restores every value on drop.
        unsafe { std::env::set_var(key, value) };
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..) {
            // This test target runs with RUST_TEST_THREADS=1 and restores every value on drop.
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}

fn write_codex_fixture(
    directory: &Path,
    name: &str,
    initialize_output: &[&str],
    rate_limit_output: Option<&str>,
) -> PathBuf {
    let extension = if cfg!(windows) { "ps1" } else { "sh" };
    let path = directory.join(format!("{name}.{extension}"));
    let mut commands = if cfg!(windows) {
        vec!["$null = [Console]::ReadLine()".to_owned()]
    } else {
        vec![
            "#!/bin/sh".to_owned(),
            "IFS= read -r initialize || exit 0".to_owned(),
        ]
    };
    commands.extend(initialize_output.iter().map(|line| {
        if cfg!(windows) {
            format!("[Console]::Out.WriteLine('{line}')")
        } else {
            format!("printf '%s\\n' '{line}'")
        }
    }));
    if let Some(rate_limit_output) = rate_limit_output {
        if cfg!(windows) {
            commands.extend([
                "$null = [Console]::ReadLine()".to_owned(),
                "$null = [Console]::ReadLine()".to_owned(),
                format!("[Console]::Out.WriteLine('{rate_limit_output}')"),
            ]);
        } else {
            commands.extend([
                "IFS= read -r initialized || exit 0".to_owned(),
                "IFS= read -r request || exit 0".to_owned(),
                format!("printf '%s\\n' '{rate_limit_output}'"),
            ]);
        }
    }
    let body = format!("{}\n", commands.join("\n"));
    fs::write(&path, body).expect("write codex fixture");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(&path).expect("fixture metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).expect("fixture permissions");
    }
    path
}

fn fixed_time() -> OffsetDateTime {
    OffsetDateTime::parse(
        "2026-07-07T18:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("time")
}

fn snapshot(provider: ProviderUsageProvider, updated_at: OffsetDateTime) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        provider,
        status: ProviderUsageStatus::Ok,
        session: None,
        weekly: None,
        fable_weekly: None,
        plan_type: None,
        rate_limit_reset_credits: None,
        updated_at,
        error: None,
        metadata: Default::default(),
    }
}

#[tokio::test]
async fn preserves_last_successful_usage_after_refresh_failure() {
    let first = fixed_time();
    let second = first + Duration::milliseconds(MIN_MANUAL_REFRESH_MS);
    let now = Arc::new(Mutex::new(first));
    let calls = Arc::new(AtomicUsize::new(0));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, {
            let calls = calls.clone();
            move || {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if call == 0 {
                        let mut snapshot = snapshot(ProviderUsageProvider::Claude, first);
                        snapshot.session = Some(ProviderUsageWindow {
                            used_percent: 25,
                            window_minutes: 300,
                            resets_at: None,
                            reset_description: None,
                        });
                        snapshot.weekly = Some(ProviderUsageWindow {
                            used_percent: 50,
                            window_minutes: 10_080,
                            resets_at: None,
                            reset_description: None,
                        });
                        snapshot.fable_weekly = Some(ProviderUsageWindow {
                            used_percent: 75,
                            window_minutes: 10_080,
                            resets_at: None,
                            reset_description: None,
                        });
                        snapshot.plan_type = Some("max".to_owned());
                        snapshot.rate_limit_reset_credits = Some(RateLimitResetCredits {
                            available_count: 3,
                            total_earned_count: Some(5),
                            next_expires_at: None,
                        });
                        Ok(snapshot)
                    } else {
                        Err(ProviderUsageFetchError::new("Claude unavailable"))
                    }
                }
            }
        })],
        Arc::new({
            let now = now.clone();
            move || *now.lock().expect("now")
        }),
    );

    service
        .refresh(Some(vec![ProviderUsageProvider::Claude]))
        .await;
    *now.lock().expect("now") = second;
    let result = service
        .refresh(Some(vec![ProviderUsageProvider::Claude]))
        .await;
    let claude = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Claude)
        .expect("claude snapshot");

    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(claude.status, ProviderUsageStatus::Error);
    assert_eq!(claude.error.as_deref(), Some("Claude unavailable"));
    assert_eq!(claude.updated_at, first);
    assert_eq!(claude.session.as_ref().expect("session").used_percent, 25);
    assert_eq!(claude.weekly.as_ref().expect("weekly").used_percent, 50);
    assert_eq!(
        claude.fable_weekly.as_ref().expect("fable").used_percent,
        75
    );
    assert_eq!(claude.plan_type.as_deref(), Some("max"));
    assert_eq!(
        claude
            .rate_limit_reset_credits
            .as_ref()
            .expect("credits")
            .available_count,
        3
    );
}

#[test]
fn claude_fable_prefers_a_structured_weekly_scoped_limit() {
    let snapshot = provider_usage::map_claude_usage(
        &json!({
            "five_hour": {"utilization": 20},
            "limits": [{
                "kind": "weekly_scoped",
                "scope": {
                    "model": {
                        "display_name": "fAbLe"
                    }
                },
                "percent": 80.4,
                "resets_at": "1900000000",
                "is_active": false
            }],
            "fable_weekly": {"utilization": 10}
        }),
        fixed_time(),
    );

    let fable = snapshot.fable_weekly.expect("structured Fable limit");
    assert_eq!(fable.used_percent, 80);
    assert_eq!(fable.window_minutes, 10_080);
    assert_eq!(
        fable.resets_at.expect("reset").unix_timestamp(),
        1_900_000_000
    );
}

#[test]
fn claude_fable_uses_each_legacy_weekly_field_when_structured_data_is_missing() {
    for legacy_key in ["fable_weekly", "fable_seven_day", "seven_day_fable"] {
        let mut payload = json!({"five_hour": {"utilization": 20}});
        payload[legacy_key] = json!({"used_percentage": 42});

        let snapshot = provider_usage::map_claude_usage(&payload, fixed_time());
        assert_eq!(
            snapshot
                .fable_weekly
                .as_ref()
                .expect("legacy Fable limit")
                .used_percent,
            42,
            "{legacy_key}"
        );
    }
}

#[test]
fn claude_fable_ignores_malformed_or_non_matching_structured_limits() {
    let snapshot = provider_usage::map_claude_usage(
        &json!({
            "five_hour": {"utilization": 20},
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "scope": {"model": {"display_name": "Fable"}},
                    "percent": "NaN"
                },
                {
                    "kind": "weekly_scoped",
                    "scope": {"model": {"display_name": "Other"}},
                    "percent": 60
                },
                {
                    "kind": "weekly_scoped",
                    "scope": {"model": {"display_name": "Fable"}},
                    "percent": null
                },
                {
                    "kind": "weekly_scoped",
                    "model_display_name": "Fable",
                    "percent": 70
                }
            ]
        }),
        fixed_time(),
    );

    assert!(snapshot.fable_weekly.is_none());
}

fn fetcher<F, Fut>(provider: ProviderUsageProvider, func: F) -> ProviderUsageFetcher
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<ProviderUsageSnapshot, ProviderUsageFetchError>> + Send + 'static,
{
    ProviderUsageFetcher {
        provider,
        fetch: Arc::new(move || Box::pin(func()) as Pin<Box<_>>),
    }
}

#[tokio::test]
async fn returns_unavailable_snapshots_before_any_fetch_succeeds() {
    let now = fixed_time();
    let service = ProviderUsageService::new(Vec::new(), Arc::new(move || now));

    let result = service.read().await;
    assert!(!result.is_fetching);
    assert_eq!(result.providers.len(), 2);
    assert!(
        result
            .providers
            .iter()
            .all(|provider| provider.status == ProviderUsageStatus::Unavailable)
    );
}

#[tokio::test]
async fn normalizes_fetch_failures_into_error_snapshots() {
    let now = fixed_time();
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Codex, move || async move {
            Err(ProviderUsageFetchError::new("codex auth missing"))
        })],
        Arc::new(move || now),
    );

    let result = service
        .refresh(Some(vec![ProviderUsageProvider::Codex]))
        .await;
    let codex = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Codex)
        .expect("codex snapshot");
    assert_eq!(codex.status, ProviderUsageStatus::Error);
    assert_eq!(codex.error.as_deref(), Some("codex auth missing"));
    assert!(codex.session.is_none());
    assert!(codex.weekly.is_none());
    assert!(codex.fable_weekly.is_none());
    assert!(codex.plan_type.is_none());
    assert!(codex.rate_limit_reset_credits.is_none());
}

#[tokio::test]
async fn marks_stale_successful_snapshots_unavailable_on_read() {
    let first = fixed_time();
    let later = first + Duration::milliseconds(STALE_THRESHOLD_MS + 1);
    let now = Arc::new(std::sync::Mutex::new(first));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, {
            let now = now.clone();
            move || {
                let now = *now.lock().expect("now");
                let mut snapshot = snapshot(ProviderUsageProvider::Claude, now);
                snapshot.session = Some(ProviderUsageWindow {
                    used_percent: 25,
                    window_minutes: 300,
                    resets_at: None,
                    reset_description: None,
                });
                snapshot.fable_weekly = Some(ProviderUsageWindow {
                    used_percent: 75,
                    window_minutes: 10_080,
                    resets_at: None,
                    reset_description: None,
                });
                snapshot.plan_type = Some("max".to_owned());
                snapshot.rate_limit_reset_credits = Some(RateLimitResetCredits {
                    available_count: 3,
                    total_earned_count: None,
                    next_expires_at: None,
                });
                async move { Ok(snapshot) }
            }
        })],
        Arc::new({
            let now = now.clone();
            move || *now.lock().expect("now")
        }),
    );

    let _ = service
        .refresh(Some(vec![ProviderUsageProvider::Claude]))
        .await;
    *now.lock().expect("now") = later;
    let result = service.read().await;
    let claude = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Claude)
        .expect("claude snapshot");
    assert_eq!(claude.status, ProviderUsageStatus::Unavailable);
    assert_eq!(
        claude.error.as_deref(),
        Some("Provider usage snapshot is stale.")
    );
    assert_eq!(claude.session.as_ref().expect("session").used_percent, 25);
    assert_eq!(
        claude.fable_weekly.as_ref().expect("fable").used_percent,
        75
    );
    assert_eq!(claude.plan_type.as_deref(), Some("max"));
    assert_eq!(
        claude
            .rate_limit_reset_credits
            .as_ref()
            .expect("credits")
            .available_count,
        3
    );
}

#[tokio::test]
async fn refreshes_only_the_selected_provider_and_preserves_its_snapshot() {
    let now = fixed_time();
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, move || async move {
            let mut snapshot = snapshot(ProviderUsageProvider::Claude, now);
            snapshot.session = Some(ProviderUsageWindow {
                used_percent: 37,
                window_minutes: 300,
                resets_at: None,
                reset_description: Some("in 2 hours".to_owned()),
            });
            Ok(snapshot)
        })],
        Arc::new(move || now),
    );

    let result = service
        .refresh(Some(vec![ProviderUsageProvider::Claude]))
        .await;

    assert!(!result.is_fetching);
    assert_eq!(result.read_at, now);
    let claude = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Claude)
        .expect("claude snapshot");
    assert_eq!(claude.status, ProviderUsageStatus::Ok);
    assert_eq!(claude.session.as_ref().expect("session").used_percent, 37);
    let codex = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Codex)
        .expect("codex snapshot");
    assert_eq!(codex.status, ProviderUsageStatus::Unavailable);
    assert_eq!(
        codex.error.as_deref(),
        Some("Provider usage has not been fetched yet.")
    );
}

#[tokio::test]
async fn refreshes_all_providers_and_reports_missing_fetchers() {
    let now = fixed_time();
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, move || async move {
            Ok(snapshot(ProviderUsageProvider::Claude, now))
        })],
        Arc::new(move || now),
    );

    let result = service.refresh(None).await;

    let claude = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Claude)
        .expect("claude snapshot");
    assert_eq!(claude.status, ProviderUsageStatus::Ok);
    let codex = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Codex)
        .expect("codex snapshot");
    assert_eq!(codex.status, ProviderUsageStatus::Unavailable);
    assert_eq!(
        codex.error.as_deref(),
        Some("Provider usage fetcher is unavailable.")
    );
}

#[tokio::test]
async fn throttles_refreshes_until_the_exact_manual_refresh_boundary() {
    let first = fixed_time();
    let now = Arc::new(Mutex::new(first));
    let calls = Arc::new(AtomicUsize::new(0));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Codex, {
            let now = now.clone();
            let calls = calls.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let updated_at = *now.lock().expect("now");
                async move { Ok(snapshot(ProviderUsageProvider::Codex, updated_at)) }
            }
        })],
        Arc::new({
            let now = now.clone();
            move || *now.lock().expect("now")
        }),
    );

    service
        .refresh(Some(vec![ProviderUsageProvider::Codex]))
        .await;
    *now.lock().expect("now") = first + Duration::milliseconds(MIN_MANUAL_REFRESH_MS - 1);
    service
        .refresh(Some(vec![ProviderUsageProvider::Codex]))
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    *now.lock().expect("now") = first + Duration::milliseconds(MIN_MANUAL_REFRESH_MS);
    let refreshed = service
        .refresh(Some(vec![ProviderUsageProvider::Codex]))
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        refreshed
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderUsageProvider::Codex)
            .expect("codex snapshot")
            .updated_at,
        first + Duration::milliseconds(MIN_MANUAL_REFRESH_MS)
    );
}

#[tokio::test]
async fn keeps_a_snapshot_fresh_at_the_stale_threshold() {
    let first = fixed_time();
    let now = Arc::new(Mutex::new(first));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, move || async move {
            Ok(snapshot(ProviderUsageProvider::Claude, first))
        })],
        Arc::new({
            let now = now.clone();
            move || *now.lock().expect("now")
        }),
    );

    service
        .refresh(Some(vec![ProviderUsageProvider::Claude]))
        .await;
    *now.lock().expect("now") = first + Duration::milliseconds(STALE_THRESHOLD_MS);
    let result = service.read().await;

    let claude = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Claude)
        .expect("claude snapshot");
    assert_eq!(claude.status, ProviderUsageStatus::Ok);
    assert_eq!(claude.updated_at, first);
}

#[tokio::test]
async fn exposes_in_progress_state_without_waiting_for_the_fetch() {
    let now = fixed_time();
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let started_tx = Arc::new(Mutex::new(Some(started_tx)));
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, {
            let started_tx = started_tx.clone();
            let release_rx = release_rx.clone();
            move || {
                let started_tx = started_tx.lock().expect("started sender").take();
                let release_rx = release_rx.lock().expect("release receiver").take();
                async move {
                    started_tx
                        .expect("first fetch")
                        .send(())
                        .expect("signal start");
                    release_rx
                        .expect("first fetch")
                        .await
                        .expect("release fetch");
                    Ok(snapshot(ProviderUsageProvider::Claude, now))
                }
            }
        })],
        Arc::new(move || now),
    );

    let refresh = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .refresh(Some(vec![ProviderUsageProvider::Claude]))
                .await
        }
    });
    started_rx.await.expect("fetch started");

    let during_fetch = service.read().await;
    assert!(during_fetch.is_fetching);
    assert!(
        during_fetch
            .providers
            .iter()
            .all(|provider| provider.status == ProviderUsageStatus::Unavailable)
    );

    release_tx.send(()).expect("release fetch");
    let completed = refresh.await.expect("refresh task");
    assert!(!completed.is_fetching);
    assert_eq!(
        completed
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderUsageProvider::Claude)
            .expect("claude snapshot")
            .status,
        ProviderUsageStatus::Ok
    );
}

#[tokio::test]
async fn production_fetchers_handle_local_credentials_and_codex_rpc_responses() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let _environment = EnvGuard::new(&["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_BIN"]);
    let claude_home = temporary.path().join("claude");
    let codex_home = temporary.path().join("codex");
    fs::create_dir_all(&codex_home).expect("codex home");
    EnvGuard::set("CLAUDE_CONFIG_DIR", &claude_home);
    EnvGuard::set("CODEX_HOME", &codex_home);

    let fetchers = production_fetchers();
    assert_eq!(fetchers.len(), 2);
    assert_eq!(fetchers[0].provider, ProviderUsageProvider::Claude);
    assert_eq!(fetchers[1].provider, ProviderUsageProvider::Codex);
    let claude_fetch = &fetchers[0].fetch;
    let codex_fetch = &fetchers[1].fetch;

    let claude = claude_fetch().await.expect("missing Claude credentials");
    assert_eq!(claude.status, ProviderUsageStatus::Unavailable);
    assert_eq!(
        claude.error.as_deref(),
        Some("Claude OAuth credentials were not found.")
    );

    let signed_out = codex_fetch().await.expect("signed-out Codex snapshot");
    assert_eq!(signed_out.status, ProviderUsageStatus::Unavailable);
    assert_eq!(signed_out.error.as_deref(), Some("Codex not signed in."));

    fs::write(codex_home.join("auth.json"), "{}").expect("Codex auth fixture");
    let missing_binary = temporary.path().join("missing-codex.cmd");
    EnvGuard::set("CODEX_BIN", &missing_binary);
    let missing_binary_error = codex_fetch().await.expect_err("missing Codex binary");
    assert_eq!(
        missing_binary_error.message,
        format!(
            "Codex executable was not found: {}",
            missing_binary.display()
        )
    );

    let initialize_error = write_codex_fixture(
        temporary.path(),
        "initialize-error",
        &["{\"id\":1,\"error\":{}}"],
        None,
    );
    EnvGuard::set("CODEX_BIN", &initialize_error);
    let initialize_error = codex_fetch().await.expect_err("initialize error");
    assert_eq!(initialize_error.message, "Codex initialize failed.");

    const SENTINEL_SECRET: &str = "sentinel-private-rate-limit-detail";
    let rate_limit_error_payload =
        format!("{{\"id\":2,\"error\":{{\"message\":\"{SENTINEL_SECRET}\"}}}}");
    let rate_limit_error = write_codex_fixture(
        temporary.path(),
        "rate-limit-error",
        &["{\"id\":1,\"result\":{}}"],
        Some(&rate_limit_error_payload),
    );
    EnvGuard::set("CODEX_BIN", &rate_limit_error);
    let rate_limit_error = codex_fetch().await.expect_err("rate-limit error");
    assert_eq!(rate_limit_error.message, "Codex rate-limit read failed.");
    assert!(!rate_limit_error.message.contains(SENTINEL_SECRET));

    let service = ProviderUsageService::new(vec![fetchers[1].clone()], Arc::new(fixed_time));
    let result = service
        .refresh(Some(vec![ProviderUsageProvider::Codex]))
        .await;
    let codex_error = result
        .providers
        .iter()
        .find(|provider| provider.provider == ProviderUsageProvider::Codex)
        .and_then(|provider| provider.error.as_deref())
        .expect("Codex error snapshot");
    assert_eq!(codex_error, "Codex rate-limit read failed.");
    let serialized_error = serde_json::to_string(codex_error).expect("serialized provider error");
    assert!(!serialized_error.contains(SENTINEL_SECRET));

    let early_exit = write_codex_fixture(temporary.path(), "early-exit", &[], None);
    EnvGuard::set("CODEX_BIN", &early_exit);
    let early_exit = codex_fetch().await.expect_err("early app-server exit");
    assert_eq!(
        early_exit.message,
        "Codex app-server exited before replying."
    );

    let malformed = write_codex_fixture(
        temporary.path(),
        "malformed-rate-limits",
        &["{\"id\":1,\"result\":{}}"],
        Some(
            "{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":\"invalid\"},\"secondary\":{}}}}",
        ),
    );
    EnvGuard::set("CODEX_BIN", &malformed);
    let malformed = codex_fetch().await.expect("malformed rate-limit snapshot");
    assert_eq!(malformed.status, ProviderUsageStatus::Unavailable);
    assert_eq!(
        malformed.error.as_deref(),
        Some("Codex did not report rate-limit windows.")
    );

    let successful = write_codex_fixture(
        temporary.path(),
        "successful-rate-limits",
        &[
            "diagnostic-noise",
            "{\"id\":999,\"result\":{}}",
            "{\"id\":1,\"result\":{}}",
        ],
        Some(
            "{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":7.4,\"resetsAt\":\"1900000000\"},\"secondary\":{\"utilization\":101.2,\"resets_at\":1900000000000}},\"rateLimitResetCredits\":{\"availableCount\":2,\"totalEarnedCount\":5,\"nextExpiresAt\":1900000100,\"credits\":[{\"status\":\"available\",\"expiresAt\":1900000200}]}}}",
        ),
    );
    EnvGuard::set("CODEX_BIN", &successful);
    let successful = codex_fetch().await.expect("successful Codex usage");
    assert_eq!(successful.status, ProviderUsageStatus::Ok);
    assert_eq!(
        successful.metadata.get("source").map(String::as_str),
        Some("app-server")
    );
    assert!(successful.plan_type.is_none());
    let credits = successful
        .rate_limit_reset_credits
        .as_ref()
        .expect("app-server reset credits");
    assert_eq!(credits.available_count, 2);
    assert_eq!(credits.total_earned_count, Some(5));
    assert_eq!(
        credits
            .next_expires_at
            .expect("direct credit expiry")
            .unix_timestamp(),
        1_900_000_100
    );
    let session = successful.session.expect("primary window");
    assert_eq!(session.used_percent, 7);
    assert_eq!(session.window_minutes, 300);
    assert_eq!(
        session.resets_at.expect("seconds reset").unix_timestamp(),
        1_900_000_000
    );
    let weekly = successful.weekly.expect("secondary window");
    assert_eq!(weekly.used_percent, 100);
    assert_eq!(weekly.window_minutes, 10_080);
    assert_eq!(
        weekly
            .resets_at
            .expect("milliseconds reset")
            .unix_timestamp(),
        1_900_000_000
    );

    let derived_expiry = write_codex_fixture(
        temporary.path(),
        "rate-limit-credits-derived-expiry",
        &["{\"id\":1,\"result\":{}}"],
        Some(
            "{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":8}},\"rateLimitResetCredits\":{\"availableCount\":3,\"credits\":[{\"status\":\"available\",\"expiresAt\":1900000300},{\"status\":\"consumed\",\"expiresAt\":1800000000},{\"status\":\"AVAILABLE\",\"expiresAt\":\"1900000200\"}]}}}",
        ),
    );
    EnvGuard::set("CODEX_BIN", &derived_expiry);
    let derived_expiry = codex_fetch().await.expect("derived credit expiry");
    let credits = derived_expiry
        .rate_limit_reset_credits
        .expect("derived app-server reset credits");
    assert_eq!(credits.available_count, 3);
    assert_eq!(credits.total_earned_count, None);
    assert_eq!(
        credits
            .next_expires_at
            .expect("earliest available credit expiry")
            .unix_timestamp(),
        1_900_000_200
    );
}
