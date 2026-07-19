use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use time::OffsetDateTime;

use super::{
    AttributedProcess, AttributionKind, AttributionScope, NativeProcessSampler,
    ProcessAttributionRegistry, ProcessAttributionTotals, ProcessClaim, ProcessIdentity,
    ProcessRow, ResourceAttributor, SamplingError, bound_diagnostic_string,
};

const UI_OBSERVATION_TIMEOUT: Duration = Duration::from_millis(250);
const UI_IDENTITY_LIMIT: usize = 64;
const UI_COVERAGE_MESSAGE_MAX_SCALARS: usize = 160;
const UI_UNAVAILABLE_MESSAGE: &str =
    "Native server usage is included, but local UI/WebView usage could not be associated reliably.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UiCoverageStatus {
    Available,
    Partial,
    Unavailable,
    NotApplicable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UiCoverage {
    pub status: UiCoverageStatus,
    pub message: Option<String>,
}

impl Default for UiCoverage {
    fn default() -> Self {
        Self {
            status: UiCoverageStatus::Unavailable,
            message: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DesktopUiObservation {
    pub identities: Vec<ProcessIdentity>,
    pub coverage: UiCoverage,
}

pub trait DesktopUiProcessObserver: std::fmt::Debug + Send + Sync + 'static {
    fn observe(&self) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableDesktopUiProcessObserver;

impl DesktopUiProcessObserver for UnavailableDesktopUiProcessObserver {
    fn observe(&self) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>> {
        Box::pin(async {
            DesktopUiObservation {
                identities: Vec::new(),
                coverage: unavailable_coverage(UI_UNAVAILABLE_MESSAGE),
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NotApplicableUiProcessObserver;

impl DesktopUiProcessObserver for NotApplicableUiProcessObserver {
    fn observe(&self) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>> {
        Box::pin(async {
            DesktopUiObservation {
                identities: Vec::new(),
                coverage: UiCoverage {
                    status: UiCoverageStatus::NotApplicable,
                    message: None,
                },
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AttributedProcessSnapshot {
    pub sampled_at_ms: i128,
    pub server_identity: ProcessIdentity,
    pub native_rows: Arc<[ProcessRow]>,
    pub processes: Vec<AttributedProcess>,
    pub totals: ProcessAttributionTotals,
    pub ui_coverage: UiCoverage,
}

pub trait ResourceSampler: std::fmt::Debug + Send + Sync + 'static {
    fn sample(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<AttributedProcessSnapshot, SamplingError>> + Send + '_>>;
}

pub(crate) trait NativeProcessRowSource: std::fmt::Debug + Send + Sync + 'static {
    fn collect_rows(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>>;
}

impl NativeProcessRowSource for NativeProcessSampler {
    fn collect_rows(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>> {
        NativeProcessSampler::collect_rows(self)
    }
}

#[derive(Debug)]
pub struct NativeResourceSampler {
    native: Arc<dyn NativeProcessRowSource>,
    registry: ProcessAttributionRegistry,
    ui_observer: Arc<dyn DesktopUiProcessObserver>,
}

impl NativeResourceSampler {
    #[must_use]
    pub fn new(
        native: Arc<NativeProcessSampler>,
        registry: ProcessAttributionRegistry,
        ui_observer: Arc<dyn DesktopUiProcessObserver>,
    ) -> Self {
        Self::with_native_process_source(native, registry, ui_observer)
    }

    fn with_native_process_source(
        native: Arc<dyn NativeProcessRowSource>,
        registry: ProcessAttributionRegistry,
        ui_observer: Arc<dyn DesktopUiProcessObserver>,
    ) -> Self {
        Self {
            native,
            registry,
            ui_observer,
        }
    }
}

impl ResourceSampler for NativeResourceSampler {
    fn sample(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<AttributedProcessSnapshot, SamplingError>> + Send + '_>>
    {
        Box::pin(async move {
            let observation = observe_ui_processes(self.ui_observer.clone());
            let rows = self.native.collect_rows();
            let (observation, rows) = tokio::join!(observation, rows);
            let rows = rows?;
            let server_identity = rows
                .iter()
                .find(|row| row.pid == std::process::id())
                .map(|row| ProcessIdentity {
                    pid: row.pid,
                    started_at: row.started_at,
                })
                .ok_or_else(|| {
                    SamplingError::Failed(
                        "current server process is absent from native rows".into(),
                    )
                })?;
            let mut claims = self.registry.bind_and_snapshot(&rows, Instant::now());
            append_ui_claims(&mut claims, &rows, &observation.identities);
            let attribution = ResourceAttributor::attribute(
                &rows,
                server_identity,
                &claims,
                observation.coverage,
            );

            Ok(AttributedProcessSnapshot {
                sampled_at_ms: OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000,
                server_identity,
                native_rows: rows.into(),
                processes: attribution.processes,
                totals: attribution.totals,
                ui_coverage: attribution.ui_coverage,
            })
        })
    }
}

async fn observe_ui_processes(observer: Arc<dyn DesktopUiProcessObserver>) -> DesktopUiObservation {
    let mut task = tokio::spawn(async move { observer.observe().await });
    let observation = match tokio::time::timeout(UI_OBSERVATION_TIMEOUT, &mut task).await {
        Ok(Ok(observation)) => observation,
        Ok(Err(_)) => DesktopUiObservation {
            identities: Vec::new(),
            coverage: unavailable_coverage(&format!(
                "UI process observation failed. {UI_UNAVAILABLE_MESSAGE}"
            )),
        },
        Err(_) => {
            task.abort();
            DesktopUiObservation {
                identities: Vec::new(),
                coverage: unavailable_coverage(&format!(
                    "UI process observation timed out. {UI_UNAVAILABLE_MESSAGE}"
                )),
            }
        }
    };

    DesktopUiObservation {
        identities: observation
            .identities
            .into_iter()
            .take(UI_IDENTITY_LIMIT)
            .filter(|identity| identity.pid != 0 && identity.started_at != 0)
            .collect(),
        coverage: UiCoverage {
            status: observation.coverage.status,
            message: observation
                .coverage
                .message
                .map(|message| bound_diagnostic_string(&message, UI_COVERAGE_MESSAGE_MAX_SCALARS)),
        },
    }
}

fn append_ui_claims(
    claims: &mut Vec<ProcessClaim>,
    rows: &[ProcessRow],
    identities: &[ProcessIdentity],
) {
    let sampled_identities = rows
        .iter()
        .map(|row| ProcessIdentity {
            pid: row.pid,
            started_at: row.started_at,
        })
        .collect::<HashSet<_>>();
    claims.extend(
        identities
            .iter()
            .copied()
            .filter(|identity| sampled_identities.contains(identity))
            .map(|identity| ProcessClaim {
                identity,
                scope: AttributionScope::Core,
                kind: AttributionKind::Ui,
                label: "core/ui".to_owned(),
            }),
    );
}

fn unavailable_coverage(message: &str) -> UiCoverage {
    UiCoverage {
        status: UiCoverageStatus::Unavailable,
        message: Some(bound_diagnostic_string(
            message,
            UI_COVERAGE_MESSAGE_MAX_SCALARS,
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    use super::{
        DesktopUiObservation, DesktopUiProcessObserver, NativeProcessRowSource,
        NativeResourceSampler, ResourceSampler, UiCoverage, UiCoverageStatus,
    };
    use crate::diagnostics::{
        AttributionConfidence, AttributionKind, AttributionScope, ProcessAttributionRegistry,
        ProcessIdentity, ProcessRow, SamplingError,
    };

    #[derive(Debug)]
    struct FakeNativeProcessRowSource {
        rows: Vec<ProcessRow>,
        samples: AtomicUsize,
    }

    impl FakeNativeProcessRowSource {
        fn new(rows: Vec<ProcessRow>) -> Self {
            Self {
                rows,
                samples: AtomicUsize::new(0),
            }
        }
    }

    impl NativeProcessRowSource for FakeNativeProcessRowSource {
        fn collect_rows(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>>
        {
            Box::pin(async move {
                self.samples.fetch_add(1, Ordering::SeqCst);
                Ok(self.rows.clone())
            })
        }
    }

    #[derive(Clone, Debug)]
    enum FakeObservation {
        Return(DesktopUiObservation),
        Panic,
        Slow(Duration),
    }

    #[derive(Debug)]
    struct FakeDesktopUiProcessObserver {
        observation: FakeObservation,
    }

    impl DesktopUiProcessObserver for FakeDesktopUiProcessObserver {
        fn observe(&self) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>> {
            Box::pin(async move {
                match &self.observation {
                    FakeObservation::Return(observation) => observation.clone(),
                    FakeObservation::Panic => panic!("fake UI observer failure"),
                    FakeObservation::Slow(duration) => {
                        tokio::time::sleep(*duration).await;
                        DesktopUiObservation {
                            identities: Vec::new(),
                            coverage: UiCoverage {
                                status: UiCoverageStatus::Available,
                                message: None,
                            },
                        }
                    }
                }
            })
        }
    }

    fn row(pid: u32, ppid: u32, started_at: u64) -> ProcessRow {
        let mut row = ProcessRow::fixture(pid, ppid, format!("process-{pid}"));
        row.started_at = started_at;
        row.cpu_percent = 1.0;
        row.rss_bytes = 10;
        row
    }

    fn identity(pid: u32, started_at: u64) -> ProcessIdentity {
        ProcessIdentity { pid, started_at }
    }

    fn observer(observation: FakeObservation) -> Arc<dyn DesktopUiProcessObserver> {
        Arc::new(FakeDesktopUiProcessObserver { observation })
    }

    fn sampler(
        rows: Vec<ProcessRow>,
        observation: FakeObservation,
    ) -> (NativeResourceSampler, Arc<FakeNativeProcessRowSource>) {
        let native = Arc::new(FakeNativeProcessRowSource::new(rows));
        let sampler = NativeResourceSampler::with_native_process_source(
            native.clone(),
            ProcessAttributionRegistry::new(),
            observer(observation),
        );
        (sampler, native)
    }

    #[tokio::test]
    async fn exact_ui_identities_become_core_ui_and_are_bounded_to_sixty_four() {
        let server_pid = std::process::id();
        let ui_identities = (1..=65)
            .map(|offset| identity(server_pid + offset, 100 + u64::from(offset)))
            .collect::<Vec<_>>();
        let mut rows = vec![row(server_pid, 1, 100)];
        rows.extend(
            ui_identities
                .iter()
                .map(|identity| row(identity.pid, 1, identity.started_at)),
        );
        let (sampler, native) = sampler(
            rows,
            FakeObservation::Return(DesktopUiObservation {
                identities: ui_identities,
                coverage: UiCoverage {
                    status: UiCoverageStatus::Available,
                    message: None,
                },
            }),
        );

        let snapshot = sampler.sample().await.expect("sample should succeed");
        let ui_processes = snapshot
            .processes
            .iter()
            .filter(|process| process.kind == AttributionKind::Ui)
            .collect::<Vec<_>>();

        assert_eq!(ui_processes.len(), 64);
        assert!(ui_processes.iter().all(|process| {
            process.scope == AttributionScope::Core
                && process.label == "core/ui"
                && process.confidence == AttributionConfidence::Exact
        }));
        assert_eq!(native.samples.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn every_ui_coverage_status_survives_the_sample() {
        for status in [
            UiCoverageStatus::Available,
            UiCoverageStatus::Partial,
            UiCoverageStatus::Unavailable,
            UiCoverageStatus::NotApplicable,
        ] {
            let server_pid = std::process::id();
            let coverage = UiCoverage {
                status,
                message: Some("coverage detail".to_owned()),
            };
            let (sampler, _) = sampler(
                vec![row(server_pid, 1, 100)],
                FakeObservation::Return(DesktopUiObservation {
                    identities: Vec::new(),
                    coverage: coverage.clone(),
                }),
            );

            let snapshot = sampler.sample().await.expect("sample should succeed");

            assert_eq!(snapshot.ui_coverage, coverage);
        }
    }

    #[tokio::test]
    async fn partial_observations_keep_exact_rows_and_bound_utf8_messages() {
        let server_pid = std::process::id();
        let ui_identity = identity(server_pid + 1, 200);
        let (sampler, _) = sampler(
            vec![
                row(server_pid, 1, 100),
                row(ui_identity.pid, 1, ui_identity.started_at),
            ],
            FakeObservation::Return(DesktopUiObservation {
                identities: vec![ui_identity],
                coverage: UiCoverage {
                    status: UiCoverageStatus::Partial,
                    message: Some("é".repeat(200)),
                },
            }),
        );

        let snapshot = sampler.sample().await.expect("sample should succeed");

        assert_eq!(
            snapshot
                .processes
                .iter()
                .find(|process| process.identity == ui_identity)
                .map(|process| process.kind),
            Some(AttributionKind::Ui)
        );
        assert_eq!(
            snapshot
                .ui_coverage
                .message
                .as_deref()
                .expect("partial message")
                .chars()
                .count(),
            160
        );
    }

    #[tokio::test]
    async fn observer_panics_become_unavailable_without_losing_the_server_sample() {
        let server_pid = std::process::id();
        let (sampler, _) = sampler(vec![row(server_pid, 1, 100)], FakeObservation::Panic);

        let snapshot = sampler.sample().await.expect("sample should succeed");

        assert_eq!(snapshot.ui_coverage.status, UiCoverageStatus::Unavailable);
        assert!(snapshot.processes.iter().any(|process| {
            process.identity == identity(server_pid, 100) && process.kind == AttributionKind::Server
        }));
    }

    #[tokio::test]
    async fn slow_observers_time_out_without_blocking_native_diagnostics() {
        let server_pid = std::process::id();
        let (sampler, native) = sampler(
            vec![row(server_pid, 1, 100)],
            FakeObservation::Slow(Duration::from_secs(5)),
        );
        let started = Instant::now();

        let snapshot = sampler.sample().await.expect("sample should succeed");

        assert_eq!(snapshot.ui_coverage.status, UiCoverageStatus::Unavailable);
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(native.samples.load(Ordering::SeqCst), 1);
        assert!(snapshot.processes.iter().any(|process| {
            process.identity == identity(server_pid, 100) && process.kind == AttributionKind::Server
        }));
    }

    #[tokio::test]
    async fn malformed_and_unknown_ui_identities_are_ignored_without_guessing() {
        let server_pid = std::process::id();
        let ui_pid = server_pid + 1;
        let (sampler, _) = sampler(
            vec![row(server_pid, 1, 100), row(ui_pid, server_pid, 200)],
            FakeObservation::Return(DesktopUiObservation {
                identities: vec![
                    identity(0, 0),
                    identity(ui_pid, 201),
                    identity(u32::MAX, 999),
                ],
                coverage: UiCoverage {
                    status: UiCoverageStatus::Partial,
                    message: Some("Some helpers could not be observed.".to_owned()),
                },
            }),
        );

        let snapshot = sampler.sample().await.expect("sample should succeed");

        assert!(
            snapshot
                .processes
                .iter()
                .all(|process| process.kind != AttributionKind::Ui)
        );
        assert_eq!(
            snapshot
                .processes
                .iter()
                .find(|process| process.identity.pid == ui_pid)
                .map(|process| process.kind),
            Some(AttributionKind::Unknown)
        );
    }

    #[tokio::test]
    async fn each_resource_sample_collects_native_rows_exactly_once() {
        let server_pid = std::process::id();
        let (sampler, native) = sampler(
            vec![row(server_pid, 1, 100)],
            FakeObservation::Return(DesktopUiObservation {
                identities: Vec::new(),
                coverage: UiCoverage {
                    status: UiCoverageStatus::NotApplicable,
                    message: None,
                },
            }),
        );

        sampler.sample().await.expect("first sample should succeed");
        sampler
            .sample()
            .await
            .expect("second sample should succeed");

        assert_eq!(native.samples.load(Ordering::SeqCst), 2);
    }
}
