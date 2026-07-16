use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::{ExitStatus, Stdio},
    time::Duration,
};

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OutputMode {
    #[default]
    Error,
    Truncate,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TimeoutBehavior {
    #[default]
    Error,
    TimedOutResult,
}

#[derive(Clone, Debug)]
pub struct ProcessRunInput {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub spawn_cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub env: Option<BTreeMap<String, String>>,
    pub stdin: Option<String>,
    pub max_output_bytes: usize,
    pub output_mode: OutputMode,
    pub truncated_marker: String,
    pub timeout_behavior: TimeoutBehavior,
}

impl ProcessRunInput {
    pub fn new(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            cwd: None,
            spawn_cwd: None,
            timeout: DEFAULT_TIMEOUT,
            env: None,
            stdin: None,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            output_mode: OutputMode::Error,
            truncated_marker: String::new(),
            timeout_behavior: TimeoutBehavior::Error,
        }
    }

    pub fn with_max_output_bytes(mut self, max_output_bytes: usize) -> Self {
        self.max_output_bytes = max_output_bytes;
        self
    }

    pub fn with_output_mode(mut self, output_mode: OutputMode) -> Self {
        self.output_mode = output_mode;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_timeout_behavior(mut self, timeout_behavior: TimeoutBehavior) -> Self {
        self.timeout_behavior = timeout_behavior;
        self
    }

    #[doc(hidden)]
    pub fn for_test_output(bytes: usize) -> Self {
        if cfg!(windows) {
            Self::new(
                "powershell.exe",
                [
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!("[Console]::Out.Write('x' * {bytes})"),
                ],
            )
        } else {
            Self::new(
                "sh",
                [
                    "-c".to_string(),
                    format!("head -c {bytes} /dev/zero | tr '\\0' x"),
                ],
            )
        }
    }

    #[doc(hidden)]
    pub fn for_test_sleep(duration: Duration) -> Self {
        if cfg!(windows) {
            Self::new(
                "powershell.exe",
                [
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!("Start-Sleep -Milliseconds {}", duration.as_millis()),
                ],
            )
        } else {
            Self::new("sleep", [duration.as_secs_f64().to_string()])
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessRunOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("failed to spawn process '{command}': {message}")]
    Spawn { command: String, message: String },
    #[error("failed to write process stdin: {0}")]
    Stdin(String),
    #[error("failed to read process {stream}: {message}")]
    Read {
        stream: &'static str,
        message: String,
    },
    #[error(
        "process {stream} exceeded the {max_bytes} byte output limit after {observed_bytes} bytes"
    )]
    OutputLimit {
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    #[error("process timed out after {timeout_ms}ms")]
    Timeout { timeout_ms: u128 },
    #[error("process was cancelled")]
    Cancelled,
    #[error("failed while waiting for process: {0}")]
    Wait(String),
}

impl ProcessError {
    pub const fn output_limit(&self) -> Option<(&'static str, usize)> {
        match self {
            Self::OutputLimit {
                stream, max_bytes, ..
            } => Some((*stream, *max_bytes)),
            _ => None,
        }
    }

    pub const fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProcessRunner;

impl ProcessRunner {
    pub async fn run(&self, input: ProcessRunInput) -> Result<ProcessRunOutput, ProcessError> {
        self.run_with_cancellation(input, CancellationToken::new())
            .await
    }

    pub async fn run_with_cancellation(
        &self,
        input: ProcessRunInput,
        cancellation: CancellationToken,
    ) -> Result<ProcessRunOutput, ProcessError> {
        let resolved = resolve_command(&input);
        let mut command = CommandWrap::with_new(&resolved.command, |command| {
            command
                .args(&resolved.args)
                .stdin(if input.stdin.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(cwd) = input.spawn_cwd.as_ref().or(input.cwd.as_ref()) {
                command.current_dir(cwd);
            }
            if let Some(env) = &input.env {
                command.env_clear().envs(env);
            }
        });
        command.wrap(KillOnDrop);
        #[cfg(windows)]
        command.wrap(JobObject);
        #[cfg(unix)]
        command.wrap(ProcessGroup::leader());

        let mut child = command.spawn().map_err(|error| ProcessError::Spawn {
            command: input.command.clone(),
            message: error.to_string(),
        })?;

        if let Some(stdin) = input.stdin.as_ref() {
            let mut writer = child.stdin().take().ok_or_else(|| {
                ProcessError::Stdin("spawned process did not expose stdin".to_string())
            })?;
            writer
                .write_all(stdin.as_bytes())
                .await
                .map_err(|error| ProcessError::Stdin(error.to_string()))?;
            writer
                .shutdown()
                .await
                .map_err(|error| ProcessError::Stdin(error.to_string()))?;
        }

        let stdout = child.stdout().take().ok_or_else(|| ProcessError::Read {
            stream: "stdout",
            message: "spawned process did not expose stdout".to_string(),
        })?;
        let stderr = child.stderr().take().ok_or_else(|| ProcessError::Read {
            stream: "stderr",
            message: "spawned process did not expose stderr".to_string(),
        })?;

        enum Outcome {
            Completed(Result<(CollectedOutput, CollectedOutput, ExitStatus), ProcessError>),
            TimedOut,
            Cancelled,
        }

        let outcome = {
            let execution = async {
                let stdout = collect_output(
                    stdout,
                    "stdout",
                    input.max_output_bytes,
                    input.output_mode,
                    &input.truncated_marker,
                );
                let stderr = collect_output(
                    stderr,
                    "stderr",
                    input.max_output_bytes,
                    input.output_mode,
                    &input.truncated_marker,
                );
                let wait = async {
                    child
                        .wait()
                        .await
                        .map_err(|error| ProcessError::Wait(error.to_string()))
                };
                tokio::try_join!(stdout, stderr, wait)
            };
            tokio::pin!(execution);
            tokio::select! {
                result = &mut execution => Outcome::Completed(result),
                () = cancellation.cancelled() => Outcome::Cancelled,
                () = tokio::time::sleep(input.timeout) => Outcome::TimedOut,
            }
        };

        match outcome {
            Outcome::Completed(Ok((stdout, stderr, status))) => Ok(ProcessRunOutput {
                stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
                stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
                code: status.code(),
                timed_out: false,
                stdout_truncated: stdout.truncated,
                stderr_truncated: stderr.truncated,
            }),
            Outcome::Completed(Err(error)) => {
                kill_child(&mut *child).await;
                Err(error)
            }
            Outcome::Cancelled => {
                kill_child(&mut *child).await;
                Err(ProcessError::Cancelled)
            }
            Outcome::TimedOut => {
                kill_child(&mut *child).await;
                if input.timeout_behavior == TimeoutBehavior::TimedOutResult {
                    Ok(ProcessRunOutput {
                        stdout: String::new(),
                        stderr: String::new(),
                        code: None,
                        timed_out: true,
                        stdout_truncated: false,
                        stderr_truncated: false,
                    })
                } else {
                    Err(ProcessError::Timeout {
                        timeout_ms: input.timeout.as_millis(),
                    })
                }
            }
        }
    }
}

async fn kill_child(child: &mut dyn ChildWrapper) {
    if let Err(error) = child.start_kill() {
        tracing::debug!(%error, "failed to start supervised process cleanup");
        return;
    }
    if let Err(error) = child.wait().await {
        tracing::debug!(%error, "failed to wait for supervised process cleanup");
    }
}

#[derive(Debug)]
struct CollectedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn collect_output(
    mut reader: impl AsyncRead + Unpin,
    stream: &'static str,
    max_bytes: usize,
    mode: OutputMode,
    marker: &str,
) -> Result<CollectedOutput, ProcessError> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut observed_bytes = 0usize;
    let mut buffer = [0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| ProcessError::Read {
                stream,
                message: error.to_string(),
            })?;
        if read == 0 {
            break;
        }
        observed_bytes = observed_bytes.saturating_add(read);
        let remaining = max_bytes.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if observed_bytes > max_bytes {
            if mode == OutputMode::Error {
                return Err(ProcessError::OutputLimit {
                    stream,
                    max_bytes,
                    observed_bytes,
                });
            }
            truncated = true;
        }
    }

    if truncated && !marker.is_empty() && max_bytes > 0 {
        let marker = marker.as_bytes();
        let marker_len = marker.len().min(max_bytes);
        bytes.truncate(max_bytes - marker_len);
        bytes.extend_from_slice(&marker[..marker_len]);
    }
    Ok(CollectedOutput { bytes, truncated })
}

#[derive(Debug)]
struct ResolvedCommand {
    command: String,
    args: Vec<String>,
}

fn resolve_command(input: &ProcessRunInput) -> ResolvedCommand {
    #[cfg(windows)]
    if input.command.to_ascii_lowercase().ends_with(".cmd")
        || input.command.to_ascii_lowercase().ends_with(".bat")
    {
        let mut args = vec![
            "/d".to_string(),
            "/s".to_string(),
            "/v:off".to_string(),
            "/c".to_string(),
            "call".to_string(),
            input.command.clone(),
        ];
        args.extend(input.args.iter().cloned());
        return ResolvedCommand {
            command: "cmd.exe".to_string(),
            args,
        };
    }
    ResolvedCommand {
        command: input.command.clone(),
        args: input.args.clone(),
    }
}
