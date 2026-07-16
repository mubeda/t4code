use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use thiserror::Error;
use time::OffsetDateTime;
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use super::{
    ProcessResourceBucket, ProcessResourceHistory, ProcessResourceSummary, ProcessRow,
    ProcessSample, build_descendant_entries,
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
    samples: VecDeque<ProcessSample>,
    last_error: Option<String>,
}

#[derive(Debug)]
struct Demand {
    count: AtomicUsize,
    changed: Notify,
}

#[derive(Debug)]
pub struct SamplingLease {
    demand: Arc<Demand>,
}

impl Drop for SamplingLease {
    fn drop(&mut self) {
        self.demand.count.fetch_sub(1, Ordering::AcqRel);
        self.demand.changed.notify_waiters();
    }
}

#[derive(Debug)]
pub struct DiagnosticsMonitor<S: ProcessSampler> {
    state: Arc<Mutex<MonitorState>>,
    demand: Arc<Demand>,
    cancellation: CancellationToken,
    interval: Duration,
    _sampler: Arc<S>,
}

impl<S: ProcessSampler> DiagnosticsMonitor<S> {
    pub fn new(sampler: Arc<S>, interval: Duration) -> Self {
        let state = Arc::new(Mutex::new(MonitorState::default()));
        let demand = Arc::new(Demand {
            count: AtomicUsize::new(0),
            changed: Notify::new(),
        });
        let cancellation = CancellationToken::new();
        tokio::spawn(sample_loop(
            sampler.clone(),
            state.clone(),
            demand.clone(),
            cancellation.child_token(),
            interval,
        ));
        Self {
            state,
            demand,
            cancellation,
            interval,
            _sampler: sampler,
        }
    }

    pub fn subscribe(&self) -> SamplingLease {
        self.demand.count.fetch_add(1, Ordering::AcqRel);
        self.demand.changed.notify_waiters();
        SamplingLease {
            demand: self.demand.clone(),
        }
    }

    pub fn retain_history(&self) -> SamplingLease {
        self.subscribe()
    }

    pub fn active_consumers(&self) -> usize {
        self.demand.count.load(Ordering::Acquire)
    }

    pub async fn read_history(&self, window_ms: u64, bucket_ms: u64) -> ProcessResourceHistory {
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

    pub fn shutdown(&self) {
        self.cancellation.cancel();
    }
}

async fn sample_loop<S: ProcessSampler>(
    sampler: Arc<S>,
    state: Arc<Mutex<MonitorState>>,
    demand: Arc<Demand>,
    cancellation: CancellationToken,
    interval: Duration,
) {
    loop {
        while demand.count.load(Ordering::Acquire) == 0 {
            tokio::select! {
                () = cancellation.cancelled() => return,
                () = demand.changed.notified() => {}
            }
        }

        let sampled_at_ms = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        match sampler.sample().await {
            Ok(rows) => {
                let samples = collect_samples(&rows, std::process::id(), sampled_at_ms);
                let mut state = state.lock().await;
                state.samples.extend(samples);
                trim_samples(&mut state.samples, sampled_at_ms);
                state.last_error = None;
            }
            Err(error) => state.lock().await.last_error = Some(error.to_string()),
        }

        tokio::select! {
            () = cancellation.cancelled() => return,
            () = demand.changed.notified() => {},
            () = tokio::time::sleep(interval) => {},
        }
    }
}

fn collect_samples(
    rows: &[ProcessRow],
    server_pid: u32,
    sampled_at_ms: i128,
) -> Vec<ProcessSample> {
    let row_by_pid = rows
        .iter()
        .map(|row| (row.pid, row))
        .collect::<HashMap<_, _>>();
    let mut samples = Vec::new();
    if let Some(root) = row_by_pid.get(&server_pid) {
        samples.push(ProcessSample {
            sampled_at_ms,
            process_key: format!("{}:{}", root.pid, root.command),
            pid: root.pid,
            ppid: root.ppid,
            command: root.command.clone(),
            cpu_percent: f64::from(root.cpu_percent),
            cpu_core_percent: f64::from(root.cpu_core_percent.unwrap_or(root.cpu_percent)),
            rss_bytes: root.rss_bytes,
            depth: 0,
            is_server_root: true,
        });
    }
    for entry in build_descendant_entries(rows, server_pid) {
        let cpu_core = row_by_pid
            .get(&entry.pid)
            .and_then(|row| row.cpu_core_percent)
            .unwrap_or(entry.cpu_percent);
        samples.push(ProcessSample {
            sampled_at_ms,
            process_key: format!("{}:{}", entry.pid, entry.command),
            pid: entry.pid,
            ppid: entry.ppid,
            command: entry.command,
            cpu_percent: f64::from(entry.cpu_percent),
            cpu_core_percent: f64::from(cpu_core),
            rss_bytes: entry.rss_bytes,
            depth: entry.depth + 1,
            is_server_root: false,
        });
    }
    samples
}

fn trim_samples(samples: &mut VecDeque<ProcessSample>, now_ms: i128) {
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
    retained: &VecDeque<ProcessSample>,
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
        .cloned()
        .collect::<Vec<_>>();
    let interval_seconds = interval.as_secs_f64();
    let total_cpu_seconds_approx = samples
        .iter()
        .map(|sample| sample.cpu_core_percent / 100.0 * interval_seconds)
        .sum();

    ProcessResourceHistory {
        read_at_ms,
        window_ms,
        bucket_ms,
        sample_interval_ms: interval.as_millis().try_into().unwrap_or(u64::MAX),
        retained_sample_count: retained.len(),
        total_cpu_seconds_approx,
        buckets: build_buckets(&samples, read_at_ms, window_ms, bucket_ms),
        top_processes: summarize_processes(&samples, interval_seconds),
        error,
    }
}

fn summarize_processes(
    samples: &[ProcessSample],
    interval_seconds: f64,
) -> Vec<ProcessResourceSummary> {
    let latest_sampled_at_ms = samples.iter().map(|sample| sample.sampled_at_ms).max();
    let mut groups = HashMap::<String, Vec<&ProcessSample>>::new();
    for sample in samples {
        groups
            .entry(sample.process_key.clone())
            .or_default()
            .push(sample);
    }
    let mut summaries = groups
        .into_iter()
        .filter_map(|(process_key, mut samples)| {
            samples.sort_by_key(|sample| sample.sampled_at_ms);
            let first = *samples.first()?;
            let latest = *samples.last()?;
            if Some(latest.sampled_at_ms) != latest_sampled_at_ms {
                return None;
            }
            let cpu_total = samples.iter().map(|sample| sample.cpu_percent).sum::<f64>();
            Some(ProcessResourceSummary {
                process_key,
                pid: latest.pid,
                ppid: latest.ppid,
                command: latest.command.clone(),
                depth: latest.depth,
                is_server_root: latest.is_server_root,
                first_seen_at_ms: first.sampled_at_ms,
                last_seen_at_ms: latest.sampled_at_ms,
                current_cpu_percent: latest.cpu_percent,
                avg_cpu_percent: cpu_total / samples.len() as f64,
                max_cpu_percent: samples
                    .iter()
                    .map(|sample| sample.cpu_percent)
                    .fold(0.0, f64::max),
                cpu_seconds_approx: samples
                    .iter()
                    .map(|sample| sample.cpu_core_percent / 100.0 * interval_seconds)
                    .sum(),
                current_rss_bytes: latest.rss_bytes,
                max_rss_bytes: samples
                    .iter()
                    .map(|sample| sample.rss_bytes)
                    .max()
                    .unwrap_or(0),
                sample_count: samples.len(),
            })
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        right
            .cpu_seconds_approx
            .total_cmp(&left.cpu_seconds_approx)
            .then_with(|| left.process_key.cmp(&right.process_key))
    });
    summaries
}

fn build_buckets(
    samples: &[ProcessSample],
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
) -> Vec<ProcessResourceBucket> {
    let mut buckets = Vec::new();
    let mut started_at_ms = read_at_ms - i128::from(window_ms);
    while started_at_ms < read_at_ms {
        let ended_at_ms = (started_at_ms + i128::from(bucket_ms)).min(read_at_ms);
        let bucket_samples = samples
            .iter()
            .filter(|sample| {
                sample.sampled_at_ms >= started_at_ms
                    && (sample.sampled_at_ms < ended_at_ms
                        || ended_at_ms == read_at_ms && sample.sampled_at_ms <= ended_at_ms)
            })
            .collect::<Vec<_>>();
        let mut reads = HashMap::<i128, (f64, u64, usize)>::new();
        for sample in bucket_samples {
            let totals = reads.entry(sample.sampled_at_ms).or_default();
            totals.0 += sample.cpu_percent;
            totals.1 = totals.1.saturating_add(sample.rss_bytes);
            totals.2 += 1;
        }
        let avg_cpu_percent = if reads.is_empty() {
            0.0
        } else {
            reads.values().map(|totals| totals.0).sum::<f64>() / reads.len() as f64
        };
        buckets.push(ProcessResourceBucket {
            started_at_ms,
            ended_at_ms,
            avg_cpu_percent,
            max_cpu_percent: reads.values().map(|totals| totals.0).fold(0.0, f64::max),
            max_rss_bytes: reads.values().map(|totals| totals.1).max().unwrap_or(0),
            max_process_count: reads.values().map(|totals| totals.2).max().unwrap_or(0),
        });
        started_at_ms = ended_at_ms;
    }
    buckets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct EmptySampler;

    impl ProcessSampler for EmptySampler {
        fn sample(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>>
        {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    fn sample(pid: u32, sampled_at_ms: i128, command: &str) -> ProcessSample {
        ProcessSample {
            sampled_at_ms,
            process_key: format!("{pid}:{command}"),
            pid,
            ppid: 1,
            command: command.to_owned(),
            cpu_percent: 1.0,
            cpu_core_percent: 1.0,
            rss_bytes: 100,
            depth: 0,
            is_server_root: pid == 10,
        }
    }

    #[test]
    fn top_processes_exclude_processes_missing_from_the_latest_sample() {
        let summaries = summarize_processes(
            &[
                sample(10, 1_000, "t4code.exe"),
                sample(11, 1_000, "git.exe"),
                sample(10, 2_000, "t4code.exe"),
            ],
            2.0,
        );

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].pid, 10);
        assert!(summaries[0].is_server_root);
        assert_eq!(summaries[0].sample_count, 2);
    }

    #[tokio::test]
    async fn consumer_count_tracks_subscription_and_history_leases() {
        let monitor = DiagnosticsMonitor::new(Arc::new(EmptySampler), Duration::from_secs(60));
        assert_eq!(monitor.active_consumers(), 0);
        let subscription = monitor.subscribe();
        let history = monitor.retain_history();
        assert_eq!(monitor.active_consumers(), 2);
        drop(subscription);
        assert_eq!(monitor.active_consumers(), 1);
        drop(history);
        assert_eq!(monitor.active_consumers(), 0);
        monitor.shutdown();
    }
}
