use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};

use super::{
    AttributedProcess, AttributedProcessSnapshot, AttributionConfidence, AttributionKind,
    AttributionScope, ProcessAttributionTotals, ProcessIdentity, UiCoverage,
    build_process_tree_entries,
};

const RETENTION: Duration = Duration::from_secs(60 * 60);
const MAX_RETAINED_SAMPLES: usize = 20_000;

#[derive(Clone, Debug, PartialEq)]
pub struct AttributedProcessSample {
    pub sampled_at_ms: i128,
    pub processes: Vec<AttributedProcess>,
    pub totals: ProcessAttributionTotals,
    pub ui_coverage: UiCoverage,
    legacy_processes: Vec<LegacyProcessSample>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SplitMetric<T> {
    pub combined: T,
    pub core: T,
    pub external: T,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BucketMetric<T> {
    pub average: SplitMetric<T>,
    pub peak: SplitMetric<T>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessResourceBucket {
    pub started_at_ms: i128,
    pub ended_at_ms: i128,
    pub cpu_percent: BucketMetric<f64>,
    pub rss_bytes: BucketMetric<u64>,
    pub max_process_count: SplitMetric<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessResourceSummary {
    pub process_key: String,
    pub pid: u32,
    pub scope: AttributionScope,
    pub kind: AttributionKind,
    pub label: String,
    pub confidence: AttributionConfidence,
    pub first_seen_at_ms: i128,
    pub last_seen_at_ms: i128,
    pub current_cpu_percent: f64,
    pub avg_cpu_percent: f64,
    pub max_cpu_percent: f64,
    pub cpu_seconds_approx: f64,
    pub current_rss_bytes: u64,
    pub max_rss_bytes: u64,
    pub sample_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessResourceHistory {
    pub read_at_ms: i128,
    pub latest_sampled_at_ms: Option<i128>,
    pub window_ms: u64,
    pub bucket_ms: u64,
    pub sample_interval_ms: u64,
    pub retained_sample_count: usize,
    pub total_cpu_seconds_approx: SplitMetric<f64>,
    pub ui_coverage: UiCoverage,
    pub buckets: Vec<ProcessResourceBucket>,
    pub processes: Vec<ProcessResourceSummary>,
    pub error: Option<String>,
    pub(crate) legacy: LegacyProcessResourceHistory,
}

#[derive(Clone, Debug, PartialEq)]
struct LegacyProcessSample {
    sampled_at_ms: i128,
    process_key: String,
    pid: u32,
    ppid: u32,
    command: String,
    cpu_percent: f64,
    cpu_core_percent: f64,
    rss_bytes: u64,
    depth: usize,
    is_server_root: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LegacyProcessResourceHistory {
    pub retained_sample_count: usize,
    pub total_cpu_seconds_approx: f64,
    pub buckets: Vec<LegacyProcessResourceBucket>,
    pub top_processes: Vec<LegacyProcessResourceSummary>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LegacyProcessResourceBucket {
    pub started_at_ms: i128,
    pub ended_at_ms: i128,
    pub avg_cpu_percent: f64,
    pub max_cpu_percent: f64,
    pub max_rss_bytes: u64,
    pub max_process_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LegacyProcessResourceSummary {
    pub process_key: String,
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
    pub depth: usize,
    pub is_server_root: bool,
    pub first_seen_at_ms: i128,
    pub last_seen_at_ms: i128,
    pub current_cpu_percent: f64,
    pub avg_cpu_percent: f64,
    pub max_cpu_percent: f64,
    pub cpu_seconds_approx: f64,
    pub current_rss_bytes: u64,
    pub max_rss_bytes: u64,
    pub sample_count: usize,
}

impl From<&AttributedProcessSnapshot> for AttributedProcessSample {
    fn from(snapshot: &AttributedProcessSnapshot) -> Self {
        Self {
            sampled_at_ms: snapshot.sampled_at_ms,
            processes: snapshot.processes.clone(),
            totals: snapshot.totals,
            ui_coverage: snapshot.ui_coverage.clone(),
            legacy_processes: project_legacy_processes(snapshot),
        }
    }
}

fn project_legacy_processes(snapshot: &AttributedProcessSnapshot) -> Vec<LegacyProcessSample> {
    let rows_by_pid = snapshot
        .native_rows
        .iter()
        .map(|row| (row.pid, row))
        .collect::<HashMap<_, _>>();
    build_process_tree_entries(&snapshot.native_rows, snapshot.server_identity.pid)
        .into_iter()
        .map(|entry| {
            let row = rows_by_pid
                .get(&entry.pid)
                .expect("process tree entries originate from native rows");
            LegacyProcessSample {
                sampled_at_ms: snapshot.sampled_at_ms,
                process_key: ProcessIdentity {
                    pid: row.pid,
                    started_at: row.started_at,
                }
                .key(),
                pid: row.pid,
                ppid: entry.ppid,
                command: entry.command,
                cpu_percent: f64::from(entry.cpu_percent),
                cpu_core_percent: f64::from(row.cpu_core_percent.unwrap_or(entry.cpu_percent)),
                rss_bytes: entry.rss_bytes,
                depth: entry.depth,
                is_server_root: entry.pid == snapshot.server_identity.pid,
            }
        })
        .collect()
}

pub(crate) fn trim_samples(samples: &mut VecDeque<Arc<AttributedProcessSample>>, now_ms: i128) {
    let minimum = now_ms - RETENTION.as_millis() as i128;
    while samples
        .front()
        .is_some_and(|sample| sample.sampled_at_ms < minimum)
        || samples.len() > MAX_RETAINED_SAMPLES
    {
        samples.pop_front();
    }
}

pub(crate) fn aggregate_history(
    retained: &[Arc<AttributedProcessSample>],
    error: Option<String>,
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
    interval: Duration,
) -> ProcessResourceHistory {
    let minimum = read_at_ms - i128::from(window_ms);
    let samples = retained
        .iter()
        .map(Arc::as_ref)
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
    let legacy = aggregate_legacy_history(
        retained,
        &samples,
        read_at_ms,
        window_ms,
        bucket_ms,
        interval_seconds,
    );

    ProcessResourceHistory {
        read_at_ms,
        latest_sampled_at_ms: samples.iter().map(|sample| sample.sampled_at_ms).max(),
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
            .last()
            .map(|sample| sample.ui_coverage.clone())
            .unwrap_or_default(),
        buckets: build_buckets(&samples, read_at_ms, window_ms, bucket_ms),
        processes: summarize_processes(&samples, interval_seconds),
        error,
        legacy,
    }
}

fn aggregate_legacy_history(
    retained: &[Arc<AttributedProcessSample>],
    selected: &[&AttributedProcessSample],
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
    interval_seconds: f64,
) -> LegacyProcessResourceHistory {
    let samples = selected
        .iter()
        .flat_map(|sample| sample.legacy_processes.iter())
        .collect::<Vec<_>>();
    LegacyProcessResourceHistory {
        retained_sample_count: retained
            .iter()
            .map(|sample| sample.legacy_processes.len())
            .sum(),
        total_cpu_seconds_approx: samples
            .iter()
            .map(|sample| sample.cpu_core_percent / 100.0 * interval_seconds)
            .sum(),
        buckets: build_legacy_buckets(&samples, read_at_ms, window_ms, bucket_ms),
        top_processes: summarize_legacy_processes(&samples, interval_seconds),
    }
}

fn summarize_legacy_processes(
    samples: &[&LegacyProcessSample],
    interval_seconds: f64,
) -> Vec<LegacyProcessResourceSummary> {
    let latest_sampled_at_ms = samples.iter().map(|sample| sample.sampled_at_ms).max();
    let mut groups = HashMap::<String, Vec<&LegacyProcessSample>>::new();
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
            Some(LegacyProcessResourceSummary {
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

fn build_legacy_buckets(
    samples: &[&LegacyProcessSample],
    read_at_ms: i128,
    window_ms: u64,
    bucket_ms: u64,
) -> Vec<LegacyProcessResourceBucket> {
    let mut buckets = Vec::new();
    let mut started_at_ms = read_at_ms - i128::from(window_ms);
    while started_at_ms < read_at_ms {
        let ended_at_ms = (started_at_ms + i128::from(bucket_ms)).min(read_at_ms);
        let mut reads = HashMap::<i128, (f64, u64, usize)>::new();
        for sample in samples.iter().copied().filter(|sample| {
            sample.sampled_at_ms >= started_at_ms
                && (sample.sampled_at_ms < ended_at_ms
                    || ended_at_ms == read_at_ms && sample.sampled_at_ms <= ended_at_ms)
        }) {
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
        buckets.push(LegacyProcessResourceBucket {
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
    use crate::diagnostics::{
        AttributedProcess, AttributionConfidence, AttributionKind, AttributionScope,
        ProcessAttributionTotals, ProcessIdentity, ProcessResourceTotals, UiCoverage,
        UiCoverageStatus,
    };

    use super::*;

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
    ) -> Arc<AttributedProcessSample> {
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
        Arc::new(AttributedProcessSample {
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
            legacy_processes: Vec::new(),
        })
    }

    fn split_history_samples() -> Vec<Arc<AttributedProcessSample>> {
        vec![
            history_sample(1_000, 80.0, 100, 10.0, 900, UiCoverageStatus::Partial),
            history_sample(2_000, 10.0, 2_000, 100.0, 100, UiCoverageStatus::Partial),
            history_sample(3_000, 30.0, 1_000, 20.0, 5_000, UiCoverageStatus::Partial),
        ]
    }

    fn assert_near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn retained_samples_are_bounded_by_age_and_count() {
        let mut retained = (0..MAX_RETAINED_SAMPLES + 2)
            .map(|sampled_at_ms| {
                Arc::new(AttributedProcessSample {
                    sampled_at_ms: sampled_at_ms as i128,
                    processes: Vec::new(),
                    totals: ProcessAttributionTotals::default(),
                    ui_coverage: UiCoverage::default(),
                    legacy_processes: Vec::new(),
                })
            })
            .collect::<VecDeque<_>>();

        trim_samples(&mut retained, (MAX_RETAINED_SAMPLES + 1) as i128);

        assert_eq!(retained.len(), MAX_RETAINED_SAMPLES);
        assert_eq!(retained.front().map(|sample| sample.sampled_at_ms), Some(2));

        retained.push_back(Arc::new(AttributedProcessSample {
            sampled_at_ms: RETENTION.as_millis() as i128 + 3,
            processes: Vec::new(),
            totals: ProcessAttributionTotals::default(),
            ui_coverage: UiCoverage::default(),
            legacy_processes: Vec::new(),
        }));
        trim_samples(&mut retained, RETENTION.as_millis() as i128 + 3);

        assert_eq!(retained.front().map(|sample| sample.sampled_at_ms), Some(3));
        assert_eq!(retained.len(), MAX_RETAINED_SAMPLES);
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
            let retained = vec![history_sample(1_000, 1.0, 1, 2.0, 2, status)];
            let history =
                aggregate_history(&retained, None, 2_000, 1_000, 1_000, Duration::from_secs(2));

            assert_eq!(history.ui_coverage.status, status);
            assert_eq!(
                history.ui_coverage.message.as_deref(),
                Some("fixture coverage")
            );
        }
    }

    #[test]
    fn interior_bucket_boundary_sample_is_counted_once_in_the_following_bucket() {
        let retained = vec![history_sample(
            1_000,
            25.0,
            100,
            0.0,
            0,
            UiCoverageStatus::Partial,
        )];

        let history =
            aggregate_history(&retained, None, 3_000, 3_000, 1_000, Duration::from_secs(1));

        assert_eq!(history.buckets.len(), 3);
        assert_eq!(history.buckets[0].cpu_percent.average.combined, 0.0);
        assert_eq!(history.buckets[1].cpu_percent.average.combined, 25.0);
        assert_eq!(history.buckets[2].cpu_percent.average.combined, 0.0);
        assert_near(history.total_cpu_seconds_approx.combined, 0.25);
    }
}
