use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};

use thiserror::Error;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::supervised::{
    SupervisedOverflow, SupervisedRunError, SupervisedRunRequest, SupervisedStreamOutput,
    run_supervised,
};

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
        let mut command = Command::new(&resolved.command);
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

        let result = run_supervised(
            SupervisedRunRequest {
                command,
                stdin: input.stdin.as_ref().map(|stdin| stdin.as_bytes().to_vec()),
                timeout: input.timeout,
                max_output_bytes: input.max_output_bytes,
                overflow: match input.output_mode {
                    OutputMode::Error => SupervisedOverflow::Error,
                    OutputMode::Truncate => SupervisedOverflow::Truncate,
                },
            },
            &cancellation,
        )
        .await;

        match result {
            Ok(output) => {
                let (stdout, stdout_truncated) = render_output(
                    output.stdout,
                    input.max_output_bytes,
                    &input.truncated_marker,
                );
                let (stderr, stderr_truncated) = render_output(
                    output.stderr,
                    input.max_output_bytes,
                    &input.truncated_marker,
                );
                Ok(ProcessRunOutput {
                    stdout,
                    stderr,
                    code: output.status.code(),
                    timed_out: false,
                    stdout_truncated,
                    stderr_truncated,
                })
            }
            Err(SupervisedRunError::Timeout)
                if input.timeout_behavior == TimeoutBehavior::TimedOutResult =>
            {
                Ok(ProcessRunOutput {
                    stdout: String::new(),
                    stderr: String::new(),
                    code: None,
                    timed_out: true,
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            }
            Err(error) => Err(map_supervised_error(error, &input)),
        }
    }
}

fn render_output(
    mut output: SupervisedStreamOutput,
    max_bytes: usize,
    marker: &str,
) -> (String, bool) {
    let truncated = output.truncated();
    if truncated && !marker.is_empty() && max_bytes > 0 {
        let marker = marker.as_bytes();
        let marker_len = marker.len().min(max_bytes);
        output.bytes.truncate(max_bytes - marker_len);
        output.bytes.extend_from_slice(&marker[..marker_len]);
    }
    (
        String::from_utf8_lossy(&output.bytes).into_owned(),
        truncated,
    )
}

fn map_supervised_error(error: SupervisedRunError, input: &ProcessRunInput) -> ProcessError {
    match error {
        SupervisedRunError::Spawn(error) => ProcessError::Spawn {
            command: input.command.clone(),
            message: error.to_string(),
        },
        SupervisedRunError::Pipe { stream: "stdin" } => {
            ProcessError::Stdin("spawned process did not expose stdin".to_string())
        }
        SupervisedRunError::Pipe { stream } => ProcessError::Read {
            stream,
            message: format!("spawned process did not expose {stream}"),
        },
        SupervisedRunError::Stdin(error) => ProcessError::Stdin(error.to_string()),
        SupervisedRunError::Read { stream, source } => ProcessError::Read {
            stream,
            message: source.to_string(),
        },
        SupervisedRunError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        } => ProcessError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        },
        SupervisedRunError::Timeout => ProcessError::Timeout {
            timeout_ms: input.timeout.as_millis(),
        },
        SupervisedRunError::Cancelled => ProcessError::Cancelled,
        SupervisedRunError::Wait(error) => ProcessError::Wait(error.to_string()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runner_covers_unit_build_success_spawn_timeout_and_cancellation() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let runner = ProcessRunner;
        let output = runner
            .run(
                ProcessRunInput::for_test_output(7)
                    .with_max_output_bytes(5)
                    .with_output_mode(OutputMode::Truncate),
            )
            .await
            .unwrap();
        assert_eq!(output.stdout, "xxxxx");
        assert!(output.stdout_truncated);

        let spawn = runner
            .run(ProcessRunInput::new(
                "definitely-not-a-real-t4code-command",
                Vec::<String>::new(),
            ))
            .await
            .unwrap_err();
        assert!(matches!(spawn, ProcessError::Spawn { .. }));

        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let cancelled = runner
            .run_with_cancellation(
                ProcessRunInput::for_test_sleep(Duration::from_secs(1)),
                cancellation,
            )
            .await
            .unwrap_err();
        assert!(cancelled.is_cancelled());

        let timed_out = runner
            .run(
                ProcessRunInput::for_test_sleep(Duration::from_secs(1))
                    .with_timeout(Duration::ZERO)
                    .with_timeout_behavior(TimeoutBehavior::TimedOutResult),
            )
            .await
            .unwrap();
        assert!(timed_out.timed_out);
    }

    #[test]
    fn output_rendering_covers_markers_and_command_resolution() {
        let (rendered, truncated) = render_output(
            SupervisedStreamOutput {
                bytes: b"abcd".to_vec(),
                observed_bytes: 6,
            },
            4,
            "++",
        );
        assert_eq!(rendered, "ab++");
        assert!(truncated);

        let input = ProcessRunInput::new("command", ["one", "two"]);
        let resolved = resolve_command(&input);
        assert_eq!(resolved.command, "command");
        assert_eq!(resolved.args, vec!["one", "two"]);
    }
}
