use std::{io, process::ExitStatus, time::Duration};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use super::{ProcessCleanupReport, configure_supervised_background_command_wrap};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SupervisedOverflow {
    Error,
    Truncate,
}

#[derive(Debug)]
pub(crate) struct SupervisedRunRequest {
    pub(crate) command: Command,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) timeout: Duration,
    pub(crate) max_output_bytes: usize,
    pub(crate) overflow: SupervisedOverflow,
}

#[derive(Debug)]
pub(crate) struct SupervisedStreamOutput {
    pub(crate) bytes: Vec<u8>,
    pub(crate) observed_bytes: usize,
}

impl SupervisedStreamOutput {
    pub(crate) fn truncated(&self) -> bool {
        self.observed_bytes > self.bytes.len()
    }
}

#[derive(Debug)]
pub(crate) struct SupervisedRunOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: SupervisedStreamOutput,
    pub(crate) stderr: SupervisedStreamOutput,
}

#[derive(Debug)]
pub(crate) enum SupervisedRunError {
    Spawn(io::Error),
    Pipe {
        stream: &'static str,
    },
    Stdin(io::Error),
    Read {
        stream: &'static str,
        source: io::Error,
    },
    OutputLimit {
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    Timeout,
    Cancelled,
    Wait(io::Error),
}

pub(crate) async fn run_supervised(
    request: SupervisedRunRequest,
    cancellation: &CancellationToken,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    let SupervisedRunRequest {
        command,
        stdin,
        timeout,
        max_output_bytes,
        overflow,
    } = request;
    let execution = SupervisedExecution {
        stdin,
        timeout,
        max_output_bytes,
        overflow,
    };
    let mut command = CommandWrap::from(command);
    configure_supervised_background_command_wrap(&mut command);
    let mut child = spawn_wrapped(&mut command).map_err(SupervisedRunError::Spawn)?;

    let outcome = execute_child(&mut *child, &execution, cancellation).await;
    if outcome.is_err() {
        let report = terminate_and_wait(&mut *child).await;
        log_cleanup_failures("supervised process", &report);
    }
    outcome
}

struct SupervisedExecution {
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
    overflow: SupervisedOverflow,
}

async fn execute_child(
    child: &mut dyn ChildWrapper,
    request: &SupervisedExecution,
    cancellation: &CancellationToken,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    let stdout = child
        .stdout()
        .take()
        .ok_or(SupervisedRunError::Pipe { stream: "stdout" })?;
    let stderr = child
        .stderr()
        .take()
        .ok_or(SupervisedRunError::Pipe { stream: "stderr" })?;
    let stdin = match request.stdin.as_ref() {
        Some(_) => Some(
            child
                .stdin()
                .take()
                .ok_or(SupervisedRunError::Pipe { stream: "stdin" })?,
        ),
        None => {
            drop(child.stdin().take());
            None
        }
    };

    enum Outcome {
        Completed(Result<SupervisedRunOutput, SupervisedRunError>),
        TimedOut,
        Cancelled,
    }

    let outcome = {
        let execution = async {
            let stdin = write_stdin(stdin, request.stdin.as_deref());
            let stdout =
                collect_output(stdout, "stdout", request.max_output_bytes, request.overflow);
            let stderr =
                collect_output(stderr, "stderr", request.max_output_bytes, request.overflow);
            let wait = async { child.wait().await.map_err(SupervisedRunError::Wait) };
            let ((), stdout, stderr, status) = tokio::try_join!(stdin, stdout, stderr, wait)?;
            Ok(SupervisedRunOutput {
                status,
                stdout,
                stderr,
            })
        };
        tokio::pin!(execution);
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Outcome::Cancelled,
            () = tokio::time::sleep(request.timeout) => Outcome::TimedOut,
            result = &mut execution => Outcome::Completed(result),
        }
    };

    match outcome {
        Outcome::Completed(result) => result,
        Outcome::TimedOut => Err(SupervisedRunError::Timeout),
        Outcome::Cancelled => Err(SupervisedRunError::Cancelled),
    }
}

async fn write_stdin(
    stdin: Option<tokio::process::ChildStdin>,
    input: Option<&[u8]>,
) -> Result<(), SupervisedRunError> {
    let (Some(mut stdin), Some(input)) = (stdin, input) else {
        return Ok(());
    };
    stdin
        .write_all(input)
        .await
        .map_err(SupervisedRunError::Stdin)?;
    stdin.shutdown().await.map_err(SupervisedRunError::Stdin)
}

async fn collect_output(
    mut reader: impl AsyncRead + Unpin,
    stream: &'static str,
    max_bytes: usize,
    overflow: SupervisedOverflow,
) -> Result<SupervisedStreamOutput, SupervisedRunError> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut observed_bytes = 0usize;
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|source| SupervisedRunError::Read { stream, source })?;
        if read == 0 {
            break;
        }
        observed_bytes = observed_bytes.saturating_add(read);
        let remaining = max_bytes.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if observed_bytes > max_bytes && overflow == SupervisedOverflow::Error {
            return Err(SupervisedRunError::OutputLimit {
                stream,
                max_bytes,
                observed_bytes,
            });
        }
    }
    Ok(SupervisedStreamOutput {
        bytes,
        observed_bytes,
    })
}

async fn terminate_and_wait(child: &mut dyn ChildWrapper) -> ProcessCleanupReport {
    let mut report = ProcessCleanupReport::default();
    match child.start_kill() {
        Ok(()) => report.record_success(),
        Err(error) => report.record_failure(format!("kill: {error}")),
    }
    match child.wait().await {
        Ok(_) => report.record_success(),
        Err(error) => report.record_failure(format!("wait: {error}")),
    }
    report
}

fn log_cleanup_failures(operation: &'static str, report: &ProcessCleanupReport) {
    if report.failure_count > 0 {
        tracing::warn!(
            operation,
            attempted = report.attempted,
            succeeded = report.succeeded,
            failure_count = report.failure_count,
            failures = ?report.failures,
            "supervised process cleanup was incomplete"
        );
    }
}

#[cfg(not(windows))]
fn spawn_wrapped(command: &mut CommandWrap) -> io::Result<Box<dyn ChildWrapper>> {
    command.spawn()
}

#[cfg(windows)]
fn spawn_wrapped(command: &mut CommandWrap) -> io::Result<Box<dyn ChildWrapper>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE},
        System::Threading::GetCurrentProcess,
    };

    let mut duplicated: HANDLE = std::ptr::null_mut();
    let result = command.spawn_with(|command| {
        let child = command.spawn()?;
        let raw_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("spawned process handle is unavailable"))?;
        let process = raw_handle.cast();
        // SAFETY: the source process handle belongs to the newly spawned child,
        // both process pseudo-handles refer to the current process, and
        // `duplicated` is valid writable storage for the new owned handle.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut duplicated,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            cleanup_failed_windows_spawn_handle(process, "duplicate process handle");
            return Err(error);
        }
        Ok(child)
    });

    if result.is_err() && !duplicated.is_null() {
        cleanup_failed_windows_spawn_handle(duplicated, "process-wrap hook");
    }
    if !duplicated.is_null() {
        // SAFETY: this closes the duplicate created above exactly once. The
        // wrapped child retains its original process handle on success.
        unsafe { CloseHandle(duplicated) };
    }
    result
}

#[cfg(windows)]
fn cleanup_failed_windows_spawn_handle(
    process: windows_sys::Win32::Foundation::HANDLE,
    stage: &'static str,
) {
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{TerminateProcess, WaitForSingleObject},
    };

    const SPAWN_FAILURE_WAIT_MS: u32 = 5_000;

    // SAFETY: the handle names the newly spawned process and remains valid
    // through this bounded termination and wait sequence.
    let terminated = unsafe { TerminateProcess(process, 1) };
    // SAFETY: the same live process handle may be synchronously waited.
    let waited = unsafe { WaitForSingleObject(process, SPAWN_FAILURE_WAIT_MS) };
    if terminated == 0 || waited != WAIT_OBJECT_0 {
        let error = io::Error::last_os_error();
        tracing::warn!(
            stage,
            error = %super::bound_process_cleanup_failure(error),
            "failed to fully clean up process-wrap spawn failure"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        process::{ExitStatus, Stdio},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use tokio::process::Child;

    use super::*;

    #[derive(Debug)]
    struct TrackingChild {
        child: Child,
        kill_calls: Arc<AtomicUsize>,
        wait_calls: Arc<AtomicUsize>,
        fail_kill: bool,
    }

    impl ChildWrapper for TrackingChild {
        fn inner(&self) -> &dyn ChildWrapper {
            &self.child
        }

        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            &mut self.child
        }

        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            Box::new(self.child)
        }

        fn start_kill(&mut self) -> io::Result<()> {
            self.kill_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_kill {
                Err(io::Error::other("injected kill failure"))
            } else {
                self.child.start_kill()
            }
        }

        fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(self.child.wait())
        }
    }

    fn completed_command() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", "exit /b 0"]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        }
    }

    fn tracking_child(fail_kill: bool) -> (Box<TrackingChild>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let child = completed_command()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("tracking child should spawn");
        let kill_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        (
            Box::new(TrackingChild {
                child,
                kill_calls: Arc::clone(&kill_calls),
                wait_calls: Arc::clone(&wait_calls),
                fail_kill,
            }),
            kill_calls,
            wait_calls,
        )
    }

    fn execution() -> SupervisedExecution {
        SupervisedExecution {
            stdin: None,
            timeout: Duration::from_secs(5),
            max_output_bytes: 1024,
            overflow: SupervisedOverflow::Error,
        }
    }

    #[tokio::test]
    async fn missing_required_stream_still_kills_and_waits() {
        let (mut child, kill_calls, wait_calls) = tracking_child(false);
        let error = execute_child(&mut *child, &execution(), &CancellationToken::new())
            .await
            .expect_err("missing stdout should fail");
        assert!(matches!(
            error,
            SupervisedRunError::Pipe { stream: "stdout" }
        ));

        let report = terminate_and_wait(&mut *child).await;
        assert_eq!(kill_calls.load(Ordering::SeqCst), 1);
        assert_eq!(wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.attempted, 2);
    }

    #[tokio::test]
    async fn failed_kill_still_waits_and_bounds_cleanup_failures() {
        let (mut child, kill_calls, wait_calls) = tracking_child(true);
        let report = terminate_and_wait(&mut *child).await;
        assert_eq!(kill_calls.load(Ordering::SeqCst), 1);
        assert_eq!(wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.attempted, 2);
        assert_eq!(report.failure_count, 1);
        assert!(report.failures[0].chars().count() <= 160);

        let mut bounded = ProcessCleanupReport::default();
        for index in 0..32 {
            bounded.record_failure(format!("{index}:{}", "x".repeat(1_000)));
        }
        assert_eq!(bounded.failure_count, 32);
        assert_eq!(bounded.failures.len(), 8);
        assert!(
            bounded
                .failures
                .iter()
                .all(|failure| failure.chars().count() <= 160)
        );
    }

    #[tokio::test]
    async fn output_collection_enforces_or_records_overflow() {
        let error = collect_output(&b"abcdef"[..], "stdout", 3, SupervisedOverflow::Error)
            .await
            .expect_err("strict output should fail");
        assert!(matches!(
            error,
            SupervisedRunError::OutputLimit {
                stream: "stdout",
                max_bytes: 3,
                observed_bytes: 6,
            }
        ));

        let truncated = collect_output(&b"abcdef"[..], "stderr", 4, SupervisedOverflow::Truncate)
            .await
            .expect("truncate output should complete");
        assert_eq!(truncated.bytes, b"abcd");
        assert_eq!(truncated.observed_bytes, 6);
        assert!(truncated.truncated());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_failure_cleans_up_before_returning() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "exec 0<&-; sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let cancellation = CancellationToken::new();
        let error = run_supervised(
            SupervisedRunRequest {
                command,
                stdin: Some(vec![b'x'; 1024 * 1024]),
                timeout: Duration::from_secs(5),
                max_output_bytes: 1024,
                overflow: SupervisedOverflow::Error,
            },
            &cancellation,
        )
        .await
        .expect_err("closed stdin should fail");
        assert!(matches!(error, SupervisedRunError::Stdin(_)));
    }
}
