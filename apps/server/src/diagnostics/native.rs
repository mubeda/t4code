use std::{
    ffi::OsStr,
    sync::{Arc, Mutex},
};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};
use thiserror::Error;

use super::{
    PROCESS_COMMAND_MAX_SCALARS, ProcessRow, ProcessSampler, SamplingError,
    bound_diagnostic_string, build_descendant_entries,
};

#[derive(Debug)]
pub struct NativeProcessSampler {
    system: Arc<Mutex<System>>,
}

impl Default for NativeProcessSampler {
    fn default() -> Self {
        Self {
            system: Arc::new(Mutex::new(System::new_all())),
        }
    }
}

impl ProcessSampler for NativeProcessSampler {
    fn sample(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>,
    > {
        self.collect_rows()
    }
}

impl NativeProcessSampler {
    pub(crate) fn collect_rows(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<ProcessRow>, SamplingError>> + Send + '_>,
    > {
        let system = self.system.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || collect_rows(&system))
                .await
                .map_err(|error| SamplingError::Failed(error.to_string()))?
        })
    }

    pub async fn signal_descendant(
        &self,
        server_pid: u32,
        target_pid: u32,
        signal: ProcessSignal,
    ) -> Result<(), SignalError> {
        if server_pid == target_pid {
            return Err(SignalError::ServerProcess);
        }
        let rows = self
            .sample()
            .await
            .map_err(|error| SignalError::Read(error.to_string()))?;
        if !build_descendant_entries(&rows, server_pid)
            .iter()
            .any(|entry| entry.pid == target_pid)
        {
            return Err(SignalError::NotDescendant(target_pid));
        }
        signal_pid(&self.system, target_pid, signal)
    }

    pub async fn cleanup_descendants(&self, root_pid: u32) -> Result<Vec<u32>, SignalError> {
        let rows = self
            .sample()
            .await
            .map_err(|error| SignalError::Read(error.to_string()))?;
        let mut descendants = build_descendant_entries(&rows, root_pid);
        descendants.sort_by_key(|entry| std::cmp::Reverse(entry.depth));
        let mut signaled = Vec::with_capacity(descendants.len());
        for entry in descendants {
            signal_pid(&self.system, entry.pid, ProcessSignal::Kill)?;
            signaled.push(entry.pid);
        }
        Ok(signaled)
    }
}

fn collect_rows(system: &Arc<Mutex<System>>) -> Result<Vec<ProcessRow>, SamplingError> {
    let mut system = system
        .lock()
        .map_err(|error| SamplingError::Failed(error.to_string()))?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
    let processors = std::thread::available_parallelism()
        .map(|count| count.get() as f32)
        .unwrap_or(1.0)
        .max(1.0);
    let mut rows = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let pid = pid.as_u32();
            (pid != 0 && process.thread_kind().is_none()).then(|| {
                let raw_cpu = process.cpu_usage().max(0.0);
                ProcessRow {
                    pid,
                    started_at: process.start_time(),
                    ppid: process.parent().map(Pid::as_u32).unwrap_or(0),
                    pgid: None,
                    status: format!("{:?}", process.status()),
                    cpu_percent: if cfg!(windows) {
                        (raw_cpu / processors).clamp(0.0, 100.0)
                    } else {
                        raw_cpu
                    },
                    cpu_core_percent: Some(raw_cpu),
                    rss_bytes: process.memory(),
                    elapsed: format_elapsed(process.run_time()),
                    command: command_string(process.cmd(), process.name()),
                }
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.pid);
    Ok(rows)
}

fn signal_pid(
    system: &Arc<Mutex<System>>,
    pid: u32,
    signal: ProcessSignal,
) -> Result<(), SignalError> {
    let mut system = system
        .lock()
        .map_err(|error| SignalError::Read(error.to_string()))?;
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    let process = system
        .process(Pid::from_u32(pid))
        .ok_or(SignalError::NotFound(pid))?;
    let signal = match signal {
        ProcessSignal::Interrupt => Signal::Interrupt,
        ProcessSignal::Kill => Signal::Kill,
    };
    match process.kill_with(signal) {
        Some(true) => Ok(()),
        Some(false) => Err(SignalError::Rejected(pid)),
        None => Err(SignalError::Unsupported),
    }
}

fn command_string(parts: &[impl AsRef<OsStr>], fallback: &OsStr) -> String {
    let joined = parts
        .iter()
        .map(|part| part.as_ref().to_string_lossy())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let command = if joined.trim().is_empty() {
        fallback.to_string_lossy().into_owned()
    } else {
        joined
    };
    bound_diagnostic_string(&command, PROCESS_COMMAND_MAX_SCALARS)
}

fn format_elapsed(seconds: u64) -> String {
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let seconds = seconds % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessSignal {
    Interrupt,
    Kill,
}

#[derive(Debug, Error)]
pub enum SignalError {
    #[error("refusing to signal the server process")]
    ServerProcess,
    #[error("process {0} is not a live descendant of the server")]
    NotDescendant(u32),
    #[error("process {0} no longer exists")]
    NotFound(u32),
    #[error("the operating system does not support this signal")]
    Unsupported,
    #[error("the operating system rejected the signal for process {0}")]
    Rejected(u32),
    #[error("failed to read process state: {0}")]
    Read(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::ProcessIdentity;

    #[tokio::test]
    async fn native_sampler_refreshes_repeatedly_and_keeps_the_current_process() {
        let sampler = NativeProcessSampler::default();

        for _ in 0..3 {
            let rows = sampler.sample().await.expect("processes should sample");
            let current = rows
                .iter()
                .find(|row| row.pid == std::process::id())
                .expect("current test process should remain visible");
            assert!(current.cpu_percent.is_finite());
            assert!(current.cpu_core_percent.is_some_and(f32::is_finite));
            assert!(current.rss_bytes > 0);
            assert!(current.started_at > 0);
        }
    }

    #[test]
    fn process_identity_distinguishes_reused_pids() {
        let first = ProcessRow::fixture(42, 1, "first");
        let mut second = ProcessRow::fixture(42, 1, "second");
        second.started_at = 1;

        let first_identity = ProcessIdentity {
            pid: first.pid,
            started_at: first.started_at,
        };
        let second_identity = ProcessIdentity {
            pid: second.pid,
            started_at: second.started_at,
        };

        assert_ne!(first_identity.key(), second_identity.key());
    }

    #[test]
    fn command_strings_are_bounded_without_breaking_utf8() {
        let command = command_string(&["é".repeat(513)], OsStr::new("fallback"));
        assert_eq!(command.chars().count(), 512);
    }

    #[tokio::test]
    async fn native_sampler_reports_missing_and_terminated_processes() {
        let sampler = NativeProcessSampler::default();
        assert!(matches!(
            signal_pid(&sampler.system, u32::MAX, ProcessSignal::Kill),
            Err(SignalError::NotFound(u32::MAX))
        ));

        let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("short-lived child");
        let pid = child.id();
        child.wait().expect("child should exit");

        assert!(matches!(
            signal_pid(&sampler.system, pid, ProcessSignal::Kill),
            Err(SignalError::NotFound(missing)) if missing == pid
        ));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn native_sampler_excludes_linux_threads_from_process_rows() {
        let sampler = NativeProcessSampler::default();
        let rows = sampler.sample().await.expect("processes should sample");
        let thread_pids = sampler
            .system
            .lock()
            .expect("system should lock")
            .processes()
            .iter()
            .filter_map(|(pid, process)| process.thread_kind().map(|_| pid.as_u32()))
            .collect::<Vec<_>>();

        assert!(
            !thread_pids.is_empty(),
            "test process should expose threads"
        );
        assert!(
            rows.iter().all(|row| !thread_pids.contains(&row.pid)),
            "sampled process rows must not contain Linux threads"
        );
    }
}
