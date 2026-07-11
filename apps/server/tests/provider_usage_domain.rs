use t4code_server::provider_usage;

use provider_usage::{
    ProviderUsageFetchError, ProviderUsageFetcher, ProviderUsageProvider, ProviderUsageService,
    ProviderUsageSnapshot, ProviderUsageStatus, STALE_THRESHOLD_MS,
};
use std::{future::Future, pin::Pin, sync::Arc};
use time::{Duration, OffsetDateTime};

fn snapshot(provider: ProviderUsageProvider, updated_at: OffsetDateTime) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        provider,
        status: ProviderUsageStatus::Ok,
        session: None,
        weekly: None,
        updated_at,
        error: None,
        metadata: Default::default(),
    }
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
    let now = OffsetDateTime::parse(
        "2026-07-07T18:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("time");
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
    let now = OffsetDateTime::parse(
        "2026-07-07T18:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("time");
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
}

#[tokio::test]
async fn marks_stale_successful_snapshots_unavailable_on_read() {
    let first = OffsetDateTime::parse(
        "2026-07-07T18:00:00Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("time");
    let later = first + Duration::milliseconds(STALE_THRESHOLD_MS + 1);
    let now = Arc::new(std::sync::Mutex::new(first));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, {
            let now = now.clone();
            move || {
                let now = *now.lock().expect("now");
                async move { Ok(snapshot(ProviderUsageProvider::Claude, now)) }
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
}
