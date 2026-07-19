use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use thiserror::Error;
use time::OffsetDateTime;
use tokio::sync::{Mutex, RwLock};

use super::{
    AttributedProcessSample, AttributedProcessSnapshot, ProcessResourceHistory, ProcessRow,
    ResourceSampler,
    history::{aggregate_history, trim_samples},
};

#[derive(Debug, Error)]
pub enum SamplingError {
    #[error("process diagnostics sampling failed: {0}")]
    Failed(String),
}

pub trait ProcessSampler: std::fmt::Debug + Send + Sync + 'static {
    fn sample(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>>;
}

#[derive(Debug, Default)]
struct MonitorState {
    current: Option<Arc<AttributedProcessSnapshot>>,
    samples: VecDeque<Arc<AttributedProcessSample>>,
    last_error: Option<String>,
    last_attempt: Option<Instant>,
}

#[derive(Clone, Debug)]
pub struct CurrentProcessDiagnostics {
    pub snapshot: Option<Arc<AttributedProcessSnapshot>>,
    pub error: Option<String>,
}

trait MonitorClock: std::fmt::Debug + Send + Sync + 'static {
    fn now(&self) -> Instant;
}

#[derive(Clone, Copy, Debug)]
struct SystemMonitorClock;

impl MonitorClock for SystemMonitorClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

trait HistoryAggregator: std::fmt::Debug + Send + Sync + 'static {
    fn aggregate(
        &self,
        retained: &[Arc<AttributedProcessSample>],
        error: Option<String>,
        read_at_ms: i128,
        window_ms: u64,
        bucket_ms: u64,
        interval: Duration,
    ) -> ProcessResourceHistory;
}

#[derive(Clone, Copy, Debug)]
struct DefaultHistoryAggregator;

impl HistoryAggregator for DefaultHistoryAggregator {
    fn aggregate(
        &self,
        retained: &[Arc<AttributedProcessSample>],
        error: Option<String>,
        read_at_ms: i128,
        window_ms: u64,
        bucket_ms: u64,
        interval: Duration,
    ) -> ProcessResourceHistory {
        aggregate_history(retained, error, read_at_ms, window_ms, bucket_ms, interval)
    }
}

#[derive(Debug)]
pub struct DiagnosticsMonitor<S: ResourceSampler> {
    state: Arc<RwLock<MonitorState>>,
    refresh: Arc<Mutex<()>>,
    interval: Duration,
    sampler: Arc<S>,
    clock: Arc<dyn MonitorClock>,
    history_aggregator: Arc<dyn HistoryAggregator>,
}

impl<S: ResourceSampler> DiagnosticsMonitor<S> {
    pub fn new(sampler: Arc<S>, interval: Duration) -> Self {
        Self::with_clock(sampler, interval, Arc::new(SystemMonitorClock))
    }

    fn with_clock(sampler: Arc<S>, interval: Duration, clock: Arc<dyn MonitorClock>) -> Self {
        Self::with_clock_and_aggregator(
            sampler,
            interval,
            clock,
            Arc::new(DefaultHistoryAggregator),
        )
    }

    fn with_clock_and_aggregator(
        sampler: Arc<S>,
        interval: Duration,
        clock: Arc<dyn MonitorClock>,
        history_aggregator: Arc<dyn HistoryAggregator>,
    ) -> Self {
        Self {
            state: Arc::new(RwLock::new(MonitorState::default())),
            refresh: Arc::new(Mutex::new(())),
            interval,
            sampler,
            clock,
            history_aggregator,
        }
    }

    pub async fn sample_current(&self) -> CurrentProcessDiagnostics {
        self.refresh_if_needed().await;
        let state = self.state.read().await;
        CurrentProcessDiagnostics {
            snapshot: state.current.clone(),
            error: state.last_error.clone(),
        }
    }

    pub async fn read_history(&self, window_ms: u64, bucket_ms: u64) -> ProcessResourceHistory {
        self.refresh_if_needed().await;
        let now_ms = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        let (retained, error) = {
            let state = self.state.read().await;
            (
                state.samples.iter().cloned().collect::<Vec<_>>(),
                state.last_error.clone(),
            )
        };
        let window_ms = window_ms.max(1_000);
        let bucket_ms = bucket_ms.max(1_000);
        let interval = self.interval;
        let aggregator = self.history_aggregator.clone();
        tokio::task::spawn_blocking(move || {
            aggregator.aggregate(&retained, error, now_ms, window_ms, bucket_ms, interval)
        })
        .await
        .unwrap_or_else(|error| {
            aggregate_history(
                &[],
                Some(format!("process history aggregation failed: {error}")),
                now_ms,
                window_ms,
                bucket_ms,
                interval,
            )
        })
    }

    async fn refresh_if_needed(&self) {
        let now = self.clock.now();
        if self.is_fresh(now).await {
            return;
        }

        let _refresh = self.refresh.lock().await;
        let now = self.clock.now();
        if self.is_fresh(now).await {
            return;
        }

        let sampled = self.sampler.sample().await;
        let attempted_at = self.clock.now();
        let mut state = self.state.write().await;
        match sampled {
            Ok(snapshot) => {
                let snapshot = Arc::new(snapshot);
                state
                    .samples
                    .push_back(Arc::new(AttributedProcessSample::from(snapshot.as_ref())));
                trim_samples(&mut state.samples, snapshot.sampled_at_ms);
                state.current = Some(snapshot);
                state.last_error = None;
            }
            Err(error) => state.last_error = Some(error.to_string()),
        }
        state.last_attempt = Some(attempted_at);
    }

    async fn is_fresh(&self, now: Instant) -> bool {
        self.state
            .read()
            .await
            .last_attempt
            .is_some_and(|last_attempt| now.duration_since(last_attempt) < self.interval)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Barrier, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use tokio::sync::Notify;

    use crate::diagnostics::{
        AttributedProcessSnapshot, ProcessAttributionTotals, ProcessIdentity, ResourceSampler,
        UiCoverage,
    };

    use super::*;

    #[derive(Debug)]
    struct TestClock {
        now: SyncMutex<Instant>,
    }

    impl TestClock {
        fn new() -> Self {
            Self {
                now: SyncMutex::new(Instant::now()),
            }
        }

        fn advance(&self, duration: Duration) {
            let mut now = self.now.lock().expect("test clock lock");
            *now += duration;
        }
    }

    impl MonitorClock for TestClock {
        fn now(&self) -> Instant {
            *self.now.lock().expect("test clock lock")
        }
    }

    #[derive(Debug)]
    enum FakeResponse {
        Snapshot(AttributedProcessSnapshot),
        Failure(&'static str),
    }

    #[derive(Debug)]
    struct FakeResourceSampler {
        calls: AtomicUsize,
        responses: SyncMutex<VecDeque<FakeResponse>>,
        block_next: AtomicBool,
        started: Notify,
        release: Notify,
    }

    impl FakeResourceSampler {
        fn new(responses: impl IntoIterator<Item = FakeResponse>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                responses: SyncMutex::new(responses.into_iter().collect()),
                block_next: AtomicBool::new(false),
                started: Notify::new(),
                release: Notify::new(),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::Acquire)
        }
    }

    impl ResourceSampler for FakeResourceSampler {
        fn sample(
            &self,
        ) -> Pin<
            Box<dyn Future<Output = Result<AttributedProcessSnapshot, SamplingError>> + Send + '_>,
        > {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::AcqRel);
                if self.block_next.swap(false, Ordering::AcqRel) {
                    self.started.notify_one();
                    self.release.notified().await;
                }
                match self
                    .responses
                    .lock()
                    .expect("fake responses lock")
                    .pop_front()
                    .expect("fake response")
                {
                    FakeResponse::Snapshot(snapshot) => Ok(snapshot),
                    FakeResponse::Failure(message) => {
                        Err(SamplingError::Failed(message.to_owned()))
                    }
                }
            })
        }
    }

    #[derive(Debug)]
    struct BlockingHistoryAggregator {
        entered: Arc<Barrier>,
        release: Arc<Barrier>,
    }

    impl HistoryAggregator for BlockingHistoryAggregator {
        fn aggregate(
            &self,
            retained: &[Arc<AttributedProcessSample>],
            error: Option<String>,
            read_at_ms: i128,
            window_ms: u64,
            bucket_ms: u64,
            interval: Duration,
        ) -> ProcessResourceHistory {
            self.entered.wait();
            self.release.wait();
            aggregate_history(retained, error, read_at_ms, window_ms, bucket_ms, interval)
        }
    }

    fn snapshot(sampled_at_ms: i128) -> AttributedProcessSnapshot {
        AttributedProcessSnapshot {
            sampled_at_ms,
            server_identity: ProcessIdentity {
                pid: 10,
                started_at: 100,
            },
            native_rows: Arc::from([]),
            processes: Vec::new(),
            totals: ProcessAttributionTotals::default(),
            ui_coverage: UiCoverage::default(),
        }
    }

    fn monitor(
        sampler: Arc<FakeResourceSampler>,
    ) -> (DiagnosticsMonitor<FakeResourceSampler>, Arc<TestClock>) {
        let clock = Arc::new(TestClock::new());
        (
            DiagnosticsMonitor::with_clock(sampler, Duration::from_secs(2), clock.clone()),
            clock,
        )
    }

    #[tokio::test]
    async fn construction_performs_zero_samples() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));

        let (_monitor, _clock) = monitor(sampler.clone());

        assert_eq!(sampler.calls(), 0);
    }

    #[tokio::test]
    async fn first_current_read_samples_once() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));
        let (monitor, _clock) = monitor(sampler.clone());

        let current = monitor.sample_current().await;

        assert_eq!(sampler.calls(), 1);
        assert_eq!(
            current
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.sampled_at_ms),
            Some(1_000)
        );
    }

    #[tokio::test]
    async fn concurrent_current_and_history_reads_share_one_in_flight_sample() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));
        sampler.block_next.store(true, Ordering::Release);
        let (monitor, _clock) = monitor(sampler.clone());
        let monitor = Arc::new(monitor);

        let current_task = tokio::spawn({
            let monitor = monitor.clone();
            async move { monitor.sample_current().await }
        });
        sampler.started.notified().await;
        let history_task = tokio::spawn({
            let monitor = monitor.clone();
            async move { monitor.read_history(60_000, 1_000).await }
        });
        tokio::task::yield_now().await;

        assert_eq!(sampler.calls(), 1);
        sampler.release.notify_one();
        let current = current_task.await.expect("current task");
        let history = history_task.await.expect("history task");
        assert!(current.snapshot.is_some());
        assert_eq!(history.retained_sample_count, 1);
        assert_eq!(sampler.calls(), 1);
    }

    #[tokio::test]
    async fn reads_within_the_interval_reuse_the_latest_sample() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));
        let (monitor, _clock) = monitor(sampler.clone());

        let _ = monitor.sample_current().await;
        let _ = monitor.read_history(60_000, 1_000).await;
        let _ = monitor.sample_current().await;

        assert_eq!(sampler.calls(), 1);
    }

    #[tokio::test]
    async fn read_at_the_interval_samples_again() {
        let sampler = Arc::new(FakeResourceSampler::new([
            FakeResponse::Snapshot(snapshot(1_000)),
            FakeResponse::Snapshot(snapshot(3_000)),
        ]));
        let (monitor, clock) = monitor(sampler.clone());

        let _ = monitor.sample_current().await;
        clock.advance(Duration::from_secs(2));
        let current = monitor.sample_current().await;

        assert_eq!(sampler.calls(), 2);
        assert_eq!(
            current
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.sampled_at_ms),
            Some(3_000)
        );
    }

    #[tokio::test]
    async fn no_timer_samples_after_reads_stop() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));
        let (monitor, clock) = monitor(sampler.clone());

        let _ = monitor.sample_current().await;
        clock.advance(Duration::from_secs(60));
        tokio::task::yield_now().await;

        assert_eq!(sampler.calls(), 1);
    }

    #[tokio::test]
    async fn failed_refresh_retains_the_last_good_snapshot_and_history() {
        let sampler = Arc::new(FakeResourceSampler::new([
            FakeResponse::Snapshot(snapshot(1_000)),
            FakeResponse::Failure("refresh failed"),
        ]));
        let (monitor, clock) = monitor(sampler.clone());
        let first = monitor.sample_current().await;
        let retained_before = monitor.state.read().await.samples.clone();
        clock.advance(Duration::from_secs(2));

        let failed = monitor.sample_current().await;
        let retained_after = monitor.state.read().await.samples.clone();

        assert_eq!(sampler.calls(), 2);
        assert_eq!(
            failed
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.sampled_at_ms),
            first
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.sampled_at_ms)
        );
        assert_eq!(
            failed.error.as_deref(),
            Some("process diagnostics sampling failed: refresh failed")
        );
        assert_eq!(retained_after, retained_before);
    }

    #[tokio::test]
    async fn cached_current_read_does_not_wait_for_history_aggregation() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Snapshot(
            snapshot(1_000),
        )]));
        let clock = Arc::new(TestClock::new());
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let monitor = Arc::new(DiagnosticsMonitor::with_clock_and_aggregator(
            sampler.clone(),
            Duration::from_secs(2),
            clock,
            Arc::new(BlockingHistoryAggregator {
                entered: entered.clone(),
                release: release.clone(),
            }),
        ));
        let current = monitor.sample_current().await;
        assert!(current.snapshot.is_some());

        let history_task = tokio::spawn({
            let monitor = monitor.clone();
            async move { monitor.read_history(60_000, 1_000).await }
        });
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .expect("aggregation entry waiter");

        let cached = tokio::time::timeout(Duration::from_millis(100), monitor.sample_current())
            .await
            .expect("cached current read should not wait for history aggregation");
        assert!(cached.snapshot.is_some());
        assert_eq!(sampler.calls(), 1);

        tokio::task::spawn_blocking(move || release.wait())
            .await
            .expect("aggregation release waiter");
        let _ = history_task.await.expect("history task");
    }

    #[tokio::test]
    async fn first_read_failure_returns_no_snapshot() {
        let sampler = Arc::new(FakeResourceSampler::new([FakeResponse::Failure(
            "initial failure",
        )]));
        let (monitor, _clock) = monitor(sampler.clone());

        let current = monitor.sample_current().await;

        assert_eq!(sampler.calls(), 1);
        assert!(current.snapshot.is_none());
        assert_eq!(
            current.error.as_deref(),
            Some("process diagnostics sampling failed: initial failure")
        );
    }
}
