use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use thiserror::Error;
use time::OffsetDateTime;
use tokio::sync::Mutex;

use super::{
    AttributedProcess, AttributedProcessSample, AttributedProcessSnapshot, BucketMetric,
    ProcessResourceBucket, ProcessResourceHistory, ProcessResourceSummary, ProcessRow,
    ResourceSampler, SplitMetric,
};

const RETENTION: Duration = Duration::from_secs(60 * 60);
const MAX_RETAINED_SAMPLES: usize = 20_000;

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
    current: Option<AttributedProcessSnapshot>,
    samples: VecDeque<AttributedProcessSample>,
    last_error: Option<String>,
    last_attempt: Option<Instant>,
}

impl From<&AttributedProcessSnapshot> for AttributedProcessSample {
    fn from(snapshot: &AttributedProcessSnapshot) -> Self {
        Self {
            sampled_at_ms: snapshot.sampled_at_ms,
            processes: snapshot.processes.clone(),
            totals: snapshot.totals,
            ui_coverage: snapshot.ui_coverage.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CurrentProcessDiagnostics {
    pub snapshot: Option<AttributedProcessSnapshot>,
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

#[derive(Debug)]
pub struct DiagnosticsMonitor<S: ResourceSampler> {
    state: Arc<Mutex<MonitorState>>,
    interval: Duration,
    sampler: Arc<S>,
    clock: Arc<dyn MonitorClock>,
}

impl<S: ResourceSampler> DiagnosticsMonitor<S> {
    pub fn new(sampler: Arc<S>, interval: Duration) -> Self {
        Self::with_clock(sampler, interval, Arc::new(SystemMonitorClock))
    }

    fn with_clock(sampler: Arc<S>, interval: Duration, clock: Arc<dyn MonitorClock>) -> Self {
        Self {
            state: Arc::new(Mutex::new(MonitorState::default())),
            interval,
            sampler,
            clock,
        }
    }

    pub async fn sample_current(&self) -> CurrentProcessDiagnostics {
        let mut state = self.state.lock().await;
        self.refresh(&mut state).await;
        CurrentProcessDiagnostics {
            snapshot: state.current.clone(),
            error: state.last_error.clone(),
        }
    }

    pub async fn read_history(&self, window_ms: u64, bucket_ms: u64) -> ProcessResourceHistory {
        {
            let mut state = self.state.lock().await;
            self.refresh(&mut state).await;
        }
        let now_ms = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        let state = self.state.lock().await;
        aggregate_history(
            &state.samples,
            state.last_error.clone(),
            now_ms,
            window_ms.max(1_000),
            bucket_ms.max(1_000),
            self.interval,
        )
    }

    async fn refresh(&self, state: &mut MonitorState) {
        let now = self.clock.now();
        if state
            .last_attempt
            .is_some_and(|last_attempt| now.duration_since(last_attempt) < self.interval)
        {
            return;
        }

        match self.sampler.sample().await {
            Ok(snapshot) => {
                state.samples.push_back((&snapshot).into());
                trim_samples(&mut state.samples, snapshot.sampled_at_ms);
                state.current = Some(snapshot);
                state.last_error = None;
            }
            Err(error) => state.last_error = Some(error.to_string()),
        }
        state.last_attempt = Some(self.clock.now());
    }
}

fn trim_samples(samples: &mut VecDeque<AttributedProcessSample>, now_ms: i128) {
    let minimum = now_ms - RETENTION.as_millis() as i128;
    while samples
        .front()
        .is_some_and(|sample| sample.sampled_at_ms < minimum)
        || samples.len() > MAX_RETAINED_SAMPLES
    {
        samples.pop_front();
    }
}

fn aggregate_history(
    retained: &VecDeque<AttributedProcessSample>,
    error: Option<String>,
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
    interval: Duration,
) -> ProcessResourceHistory {
    let minimum = read_at_ms - i128::from(window_ms);
    let samples = retained
        .iter()
        .filter(|sample| sample.sampled_at_ms >= minimum)
        .collect::<Vec<_>>();
    let interval_seconds = interval.as_secs_f64();
    let core_cpu_seconds_approx = samples
        .iter()
        .map(|sample| sample.totals.core.cpu_percent / 100.0 * interval_seconds)
        .sum::<f64>();
    let external_cpu_seconds_approx = samples
        .iter()
        .map(|sample| sample.totals.external.cpu_percent / 100.0 * interval_seconds)
        .sum::<f64>();

    ProcessResourceHistory {
        read_at_ms,
        window_ms,
        bucket_ms,
        sample_interval_ms: interval.as_millis().try_into().unwrap_or(u64::MAX),
        retained_sample_count: retained.len(),
        total_cpu_seconds_approx: SplitMetric {
            combined: core_cpu_seconds_approx + external_cpu_seconds_approx,
            core: core_cpu_seconds_approx,
            external: external_cpu_seconds_approx,
        },
        ui_coverage: retained
            .back()
            .map(|sample| sample.ui_coverage.clone())
            .unwrap_or_default(),
        buckets: build_buckets(&samples, read_at_ms, window_ms, bucket_ms),
        processes: summarize_processes(&samples, interval_seconds),
        error,
    }
}

fn summarize_processes(
    samples: &[&AttributedProcessSample],
    interval_seconds: f64,
) -> Vec<ProcessResourceSummary> {
    struct ProcessGroup<'a> {
        process_key: String,
        samples: Vec<(i128, &'a AttributedProcess)>,
    }

    let mut group_indexes = HashMap::<String, usize>::new();
    let mut groups = Vec::<ProcessGroup<'_>>::new();
    for sample in samples {
        for process in &sample.processes {
            let index = if let Some(index) = group_indexes.get(&process.process_key) {
                *index
            } else {
                let index = groups.len();
                group_indexes.insert(process.process_key.clone(), index);
                groups.push(ProcessGroup {
                    process_key: process.process_key.clone(),
                    samples: Vec::new(),
                });
                index
            };
            groups[index].samples.push((sample.sampled_at_ms, process));
        }
    }
    groups
        .into_iter()
        .filter_map(|group| {
            let (first_seen_at_ms, _) = group
                .samples
                .iter()
                .min_by_key(|(sampled_at_ms, _)| *sampled_at_ms)
                .copied()?;
            let (last_seen_at_ms, latest) = group
                .samples
                .iter()
                .max_by_key(|(sampled_at_ms, _)| *sampled_at_ms)
                .copied()?;
            let cpu_total = group
                .samples
                .iter()
                .map(|(_, process)| process.cpu_percent)
                .sum::<f64>();
            Some(ProcessResourceSummary {
                process_key: group.process_key,
                pid: latest.identity.pid,
                scope: latest.scope,
                kind: latest.kind,
                label: latest.label.clone(),
                confidence: latest.confidence,
                first_seen_at_ms,
                last_seen_at_ms,
                current_cpu_percent: latest.cpu_percent,
                avg_cpu_percent: cpu_total / group.samples.len() as f64,
                max_cpu_percent: group
                    .samples
                    .iter()
                    .map(|(_, process)| process.cpu_percent)
                    .fold(0.0, f64::max),
                cpu_seconds_approx: group
                    .samples
                    .iter()
                    .map(|(_, process)| process.cpu_percent / 100.0 * interval_seconds)
                    .sum(),
                current_rss_bytes: latest.rss_bytes,
                max_rss_bytes: group
                    .samples
                    .iter()
                    .map(|(_, process)| process.rss_bytes)
                    .max()
                    .unwrap_or(0),
                sample_count: group.samples.len(),
            })
        })
        .collect()
}

fn build_buckets(
    samples: &[&AttributedProcessSample],
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
) -> Vec<ProcessResourceBucket> {
    let mut buckets = Vec::new();
    let mut started_at_ms = read_at_ms - i128::from(window_ms);
    while started_at_ms < read_at_ms {
        let ended_at_ms = (started_at_ms + i128::from(bucket_ms)).min(read_at_ms);
        let reads = samples
            .iter()
            .copied()
            .filter(|sample| {
                sample.sampled_at_ms >= started_at_ms
                    && (sample.sampled_at_ms < ended_at_ms
                        || ended_at_ms == read_at_ms && sample.sampled_at_ms <= ended_at_ms)
            })
            .collect::<Vec<_>>();
        let cpu_average = average_cpu(&reads);
        let rss_average = average_rss(&reads);
        let cpu_peak = reads
            .iter()
            .copied()
            .reduce(|peak, sample| {
                if sample.totals.combined.cpu_percent > peak.totals.combined.cpu_percent {
                    sample
                } else {
                    peak
                }
            })
            .map(cpu_metric)
            .unwrap_or_default();
        let rss_peak = reads
            .iter()
            .copied()
            .reduce(|peak, sample| {
                if sample.totals.combined.rss_bytes > peak.totals.combined.rss_bytes {
                    sample
                } else {
                    peak
                }
            })
            .map(rss_metric)
            .unwrap_or_default();
        let max_process_count = reads
            .iter()
            .copied()
            .reduce(|peak, sample| {
                if sample.totals.combined.process_count > peak.totals.combined.process_count {
                    sample
                } else {
                    peak
                }
            })
            .map(process_count_metric)
            .unwrap_or_default();
        buckets.push(ProcessResourceBucket {
            started_at_ms,
            ended_at_ms,
            cpu_percent: BucketMetric {
                average: cpu_average,
                peak: cpu_peak,
            },
            rss_bytes: BucketMetric {
                average: rss_average,
                peak: rss_peak,
            },
            max_process_count,
        });
        started_at_ms = ended_at_ms;
    }
    buckets
}

fn average_cpu(samples: &[&AttributedProcessSample]) -> SplitMetric<f64> {
    if samples.is_empty() {
        return SplitMetric::default();
    }
    let divisor = samples.len() as f64;
    let core = samples
        .iter()
        .map(|sample| sample.totals.core.cpu_percent)
        .sum::<f64>()
        / divisor;
    let external = samples
        .iter()
        .map(|sample| sample.totals.external.cpu_percent)
        .sum::<f64>()
        / divisor;
    SplitMetric {
        combined: core + external,
        core,
        external,
    }
}

fn average_rss(samples: &[&AttributedProcessSample]) -> SplitMetric<u64> {
    let core = rounded_average(
        samples.iter().map(|sample| sample.totals.core.rss_bytes),
        samples.len(),
    );
    let external = rounded_average(
        samples
            .iter()
            .map(|sample| sample.totals.external.rss_bytes),
        samples.len(),
    );
    SplitMetric {
        combined: core.saturating_add(external),
        core,
        external,
    }
}

fn rounded_average(values: impl Iterator<Item = u64>, count: usize) -> u64 {
    if count == 0 {
        return 0;
    }
    let count = count as u128;
    let total = values.fold(0_u128, |total, value| total + u128::from(value));
    u64::try_from((total + count / 2) / count).unwrap_or(u64::MAX)
}

fn cpu_metric(sample: &AttributedProcessSample) -> SplitMetric<f64> {
    SplitMetric {
        combined: sample.totals.combined.cpu_percent,
        core: sample.totals.core.cpu_percent,
        external: sample.totals.external.cpu_percent,
    }
}

fn rss_metric(sample: &AttributedProcessSample) -> SplitMetric<u64> {
    SplitMetric {
        combined: sample.totals.combined.rss_bytes,
        core: sample.totals.core.rss_bytes,
        external: sample.totals.external.rss_bytes,
    }
}

fn process_count_metric(sample: &AttributedProcessSample) -> SplitMetric<usize> {
    SplitMetric {
        combined: sample.totals.combined.process_count,
        core: sample.totals.core.process_count,
        external: sample.totals.external.process_count,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::time::Instant;

    use tokio::sync::Notify;

    use crate::diagnostics::{
        AttributedProcess, AttributedProcessSnapshot, AttributionConfidence, AttributionKind,
        AttributionScope, ProcessAttributionTotals, ProcessIdentity, ProcessResourceTotals,
        ResourceSampler, UiCoverage, UiCoverageStatus,
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

    fn snapshot(sampled_at_ms: i128) -> AttributedProcessSnapshot {
        AttributedProcessSnapshot {
            sampled_at_ms,
            server_identity: ProcessIdentity {
                pid: 10,
                started_at: 100,
            },
            processes: Vec::new(),
            totals: ProcessAttributionTotals::default(),
            ui_coverage: UiCoverage::default(),
        }
    }

    fn attributed_process(
        pid: u32,
        started_at: u64,
        scope: AttributionScope,
        kind: AttributionKind,
        label: &str,
        confidence: AttributionConfidence,
        cpu_percent: f64,
        rss_bytes: u64,
    ) -> AttributedProcess {
        let identity = ProcessIdentity { pid, started_at };
        AttributedProcess {
            identity,
            process_key: identity.key(),
            scope,
            kind,
            label: label.to_owned(),
            confidence,
            cpu_percent,
            rss_bytes,
        }
    }

    fn history_sample(
        sampled_at_ms: i128,
        core_cpu_percent: f64,
        core_rss_bytes: u64,
        external_cpu_percent: f64,
        external_rss_bytes: u64,
        coverage_status: UiCoverageStatus,
    ) -> AttributedProcessSample {
        let core = attributed_process(
            10,
            100,
            AttributionScope::Core,
            AttributionKind::Server,
            "core/server",
            AttributionConfidence::Exact,
            core_cpu_percent,
            core_rss_bytes,
        );
        let external = attributed_process(
            20,
            200,
            AttributionScope::External,
            AttributionKind::Provider,
            "external/provider",
            AttributionConfidence::Inherited,
            external_cpu_percent,
            external_rss_bytes,
        );
        AttributedProcessSample {
            sampled_at_ms,
            processes: vec![core, external],
            totals: ProcessAttributionTotals {
                combined: ProcessResourceTotals {
                    cpu_percent: core_cpu_percent + external_cpu_percent,
                    rss_bytes: core_rss_bytes + external_rss_bytes,
                    process_count: 2,
                },
                core: ProcessResourceTotals {
                    cpu_percent: core_cpu_percent,
                    rss_bytes: core_rss_bytes,
                    process_count: 1,
                },
                external: ProcessResourceTotals {
                    cpu_percent: external_cpu_percent,
                    rss_bytes: external_rss_bytes,
                    process_count: 1,
                },
            },
            ui_coverage: UiCoverage {
                status: coverage_status,
                message: Some("fixture coverage".to_owned()),
            },
        }
    }

    fn split_history_samples() -> VecDeque<AttributedProcessSample> {
        VecDeque::from([
            history_sample(1_000, 80.0, 100, 10.0, 900, UiCoverageStatus::Partial),
            history_sample(2_000, 10.0, 2_000, 100.0, 100, UiCoverageStatus::Partial),
            history_sample(3_000, 30.0, 1_000, 20.0, 5_000, UiCoverageStatus::Partial),
        ])
    }

    fn assert_near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
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
    async fn failed_refresh_retains_the_last_good_snapshot_and_timestamp() {
        let sampler = Arc::new(FakeResourceSampler::new([
            FakeResponse::Snapshot(snapshot(1_000)),
            FakeResponse::Failure("refresh failed"),
        ]));
        let (monitor, clock) = monitor(sampler.clone());
        let first = monitor.sample_current().await;
        clock.advance(Duration::from_secs(2));

        let failed = monitor.sample_current().await;

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

    #[test]
    fn split_bucket_averages_and_source_sample_peaks_reconcile() {
        let history = aggregate_history(
            &split_history_samples(),
            None,
            4_000,
            3_000,
            3_000,
            Duration::from_secs(2),
        );
        let bucket = &history.buckets[0];

        assert_eq!(
            bucket.cpu_percent.average.combined,
            bucket.cpu_percent.average.core + bucket.cpu_percent.average.external
        );
        assert_near(bucket.cpu_percent.average.core, 40.0);
        assert_near(bucket.cpu_percent.average.external, 130.0 / 3.0);
        assert_eq!(
            bucket.rss_bytes.average,
            SplitMetric {
                combined: 3_033,
                core: 1_033,
                external: 2_000,
            }
        );
        assert_eq!(
            bucket.cpu_percent.peak,
            SplitMetric {
                combined: 110.0,
                core: 10.0,
                external: 100.0,
            }
        );
        assert_eq!(
            bucket.rss_bytes.peak,
            SplitMetric {
                combined: 6_000,
                core: 1_000,
                external: 5_000,
            }
        );
        assert_eq!(
            bucket.max_process_count,
            SplitMetric {
                combined: 2,
                core: 1,
                external: 1,
            }
        );
        assert_eq!(
            history.total_cpu_seconds_approx.combined,
            history.total_cpu_seconds_approx.core + history.total_cpu_seconds_approx.external
        );
        assert_near(history.total_cpu_seconds_approx.core, 2.4);
        assert_near(history.total_cpu_seconds_approx.external, 2.6);
    }

    #[test]
    fn process_summaries_retain_attribution_and_first_seen_order() {
        let history = aggregate_history(
            &split_history_samples(),
            None,
            4_000,
            3_000,
            3_000,
            Duration::from_secs(2),
        );

        assert_eq!(
            history
                .processes
                .iter()
                .map(|process| process.process_key.as_str())
                .collect::<Vec<_>>(),
            ["10:100", "20:200"]
        );
        let provider = &history.processes[1];
        assert_eq!(provider.pid, 20);
        assert_eq!(provider.scope, AttributionScope::External);
        assert_eq!(provider.kind, AttributionKind::Provider);
        assert_eq!(provider.label, "external/provider");
        assert_eq!(provider.confidence, AttributionConfidence::Inherited);
        assert_eq!(provider.first_seen_at_ms, 1_000);
        assert_eq!(provider.last_seen_at_ms, 3_000);
        assert_eq!(provider.sample_count, 3);
    }

    #[test]
    fn every_ui_coverage_state_survives_history_aggregation() {
        for status in [
            UiCoverageStatus::Available,
            UiCoverageStatus::Partial,
            UiCoverageStatus::Unavailable,
            UiCoverageStatus::NotApplicable,
        ] {
            let retained = VecDeque::from([history_sample(1_000, 1.0, 1, 2.0, 2, status)]);
            let history =
                aggregate_history(&retained, None, 2_000, 1_000, 1_000, Duration::from_secs(2));

            assert_eq!(history.ui_coverage.status, status);
            assert_eq!(
                history.ui_coverage.message.as_deref(),
                Some("fixture coverage")
            );
        }
    }
}
