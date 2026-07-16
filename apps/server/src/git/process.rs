use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time,
};
use tokio_util::sync::CancellationToken;

const TRUNCATION_MARKER: &str = "\n\n[truncated]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputPolicy {
    Truncate,
    Error,
}

#[derive(Clone, Debug)]
pub struct ProcessRequest {
    pub operation: String,
    pub command: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub output_policy: OutputPolicy,
    pub append_truncation_marker: bool,
    pub allow_non_zero_exit: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("failed to spawn {command} for {operation}")]
    Spawn {
        operation: String,
        command: String,
        source: std::io::Error,
    },
    #[error("failed to access {stream} for {operation}")]
    Pipe {
        operation: String,
        stream: &'static str,
    },
    #[error("failed to read {stream} for {operation}")]
    Read {
        operation: String,
        stream: &'static str,
        source: std::io::Error,
    },
    #[error("failed to write process stdin for {operation}")]
    Stdin {
        operation: String,
        source: std::io::Error,
    },
    #[error("{operation} timed out after {timeout_ms}ms")]
    Timeout { operation: String, timeout_ms: u128 },
    #[error("{operation} was cancelled")]
    Cancelled { operation: String },
    #[error("{operation} output exceeded {max_bytes} bytes on {stream}")]
    OutputLimit {
        operation: String,
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    #[error("{operation} exited with code {exit_code}")]
    NonZeroExit {
        operation: String,
        exit_code: i32,
        stdout_length: usize,
        stderr_length: usize,
        stdout: Box<str>,
        stderr: Box<str>,
    },
    #[error("{operation} completed without an exit code")]
    MissingExitCode { operation: String },
    #[error("failed to wait for {operation}")]
    Wait {
        operation: String,
        source: std::io::Error,
    },
}

impl ProcessError {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }
}

struct BoundedBytes {
    bytes: Vec<u8>,
    observed: usize,
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    max_bytes: usize,
) -> std::io::Result<BoundedBytes> {
    let mut retained = Vec::with_capacity(max_bytes.min(8 * 1024));
    let mut observed = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        observed = observed.saturating_add(count);
        let remaining = max_bytes.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(BoundedBytes {
        bytes: retained,
        observed,
    })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessRunner;

impl ProcessRunner {
    pub async fn run(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        let command_label = request.command.to_string_lossy().into_owned();
        let mut command = Command::new(&request.command);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .envs(request.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|source| ProcessError::Spawn {
            operation: request.operation.clone(),
            command: command_label,
            source,
        })?;
        let stdout = child.stdout.take().ok_or_else(|| ProcessError::Pipe {
            operation: request.operation.clone(),
            stream: "stdout",
        })?;
        let stderr = child.stderr.take().ok_or_else(|| ProcessError::Pipe {
            operation: request.operation.clone(),
            stream: "stderr",
        })?;
        let stdout_task = tokio::spawn(read_bounded(stdout, request.max_output_bytes));
        let stderr_task = tokio::spawn(read_bounded(stderr, request.max_output_bytes));

        if let Some(input) = request.stdin.as_deref() {
            let mut stdin = child.stdin.take().ok_or_else(|| ProcessError::Pipe {
                operation: request.operation.clone(),
                stream: "stdin",
            })?;
            stdin
                .write_all(input)
                .await
                .map_err(|source| ProcessError::Stdin {
                    operation: request.operation.clone(),
                    source,
                })?;
            stdin
                .shutdown()
                .await
                .map_err(|source| ProcessError::Stdin {
                    operation: request.operation.clone(),
                    source,
                })?;
        } else {
            drop(child.stdin.take());
        }

        let status = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(ProcessError::Cancelled { operation: request.operation });
            }
            _ = time::sleep(request.timeout) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(ProcessError::Timeout {
                    operation: request.operation,
                    timeout_ms: request.timeout.as_millis(),
                });
            }
            status = child.wait() => status.map_err(|source| ProcessError::Wait {
                operation: request.operation.clone(),
                source,
            })?,
        };

        let stdout = stdout_task
            .await
            .map_err(|_| ProcessError::Pipe {
                operation: request.operation.clone(),
                stream: "stdout",
            })?
            .map_err(|source| ProcessError::Read {
                operation: request.operation.clone(),
                stream: "stdout",
                source,
            })?;
        let stderr = stderr_task
            .await
            .map_err(|_| ProcessError::Pipe {
                operation: request.operation.clone(),
                stream: "stderr",
            })?
            .map_err(|source| ProcessError::Read {
                operation: request.operation.clone(),
                stream: "stderr",
                source,
            })?;
        for (stream, output) in [("stdout", &stdout), ("stderr", &stderr)] {
            if output.observed > request.max_output_bytes
                && request.output_policy == OutputPolicy::Error
            {
                return Err(ProcessError::OutputLimit {
                    operation: request.operation,
                    stream,
                    max_bytes: request.max_output_bytes,
                    observed_bytes: output.observed,
                });
            }
        }
        let exit_code = status.code().ok_or_else(|| ProcessError::MissingExitCode {
            operation: request.operation.clone(),
        })?;
        let stdout_length = stdout.observed;
        let stderr_length = stderr.observed;
        let stdout_truncated = stdout.observed > request.max_output_bytes;
        let stderr_truncated = stderr.observed > request.max_output_bytes;
        let stdout = render(stdout, request.append_truncation_marker);
        let stderr = render(stderr, request.append_truncation_marker);
        if exit_code != 0 && !request.allow_non_zero_exit {
            return Err(ProcessError::NonZeroExit {
                operation: request.operation,
                exit_code,
                stdout_length,
                stderr_length,
                stdout: stdout.into(),
                stderr: stderr.into(),
            });
        }
        Ok(ProcessOutput {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
        })
    }
}

fn render(output: BoundedBytes, append_marker: bool) -> String {
    let truncated = output.observed > output.bytes.len();
    let mut rendered = String::from_utf8_lossy(&output.bytes).into_owned();
    if truncated && append_marker {
        rendered.push_str(TRUNCATION_MARKER);
    }
    rendered
}
