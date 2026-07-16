use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Starting,
    Running,
    Exited,
    Error,
}

impl TerminalStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalOpenInput {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: PathBuf,
    pub worktree_path: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    pub env: BTreeMap<String, String>,
}

impl TerminalOpenInput {
    pub fn new(
        thread_id: impl Into<String>,
        terminal_id: impl Into<String>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            terminal_id: terminal_id.into(),
            cwd,
            worktree_path: None,
            cols,
            rows,
            env: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalAttachInput {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: Option<PathBuf>,
    pub worktree_path: Option<PathBuf>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub env: BTreeMap<String, String>,
    pub restart_if_not_running: bool,
}

impl TerminalAttachInput {
    pub fn existing(thread_id: impl Into<String>, terminal_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            terminal_id: terminal_id.into(),
            cwd: None,
            worktree_path: None,
            cols: None,
            rows: None,
            env: BTreeMap::new(),
            restart_if_not_running: false,
        }
    }
}

pub type TerminalRestartInput = TerminalOpenInput;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub status: TerminalStatus,
    pub pid: Option<u32>,
    pub history: String,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub label: String,
    pub updated_at: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub thread_id: String,
    pub terminal_id: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub status: TerminalStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub has_running_subprocess: bool,
    pub label: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalEvent {
    Started {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        snapshot: TerminalSessionSnapshot,
    },
    Output {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        data: String,
    },
    Exited {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        #[serde(rename = "exitSignal")]
        exit_signal: Option<i32>,
    },
    Closed {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
    },
    Error {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        message: String,
    },
    Cleared {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
    },
    Restarted {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        snapshot: TerminalSessionSnapshot,
    },
    Activity {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        sequence: u64,
        #[serde(rename = "hasRunningSubprocess")]
        has_running_subprocess: bool,
        label: String,
    },
}

impl TerminalEvent {
    pub const fn sequence(&self) -> u64 {
        match self {
            Self::Started { sequence, .. }
            | Self::Output { sequence, .. }
            | Self::Exited { sequence, .. }
            | Self::Closed { sequence, .. }
            | Self::Error { sequence, .. }
            | Self::Cleared { sequence, .. }
            | Self::Restarted { sequence, .. }
            | Self::Activity { sequence, .. } => *sequence,
        }
    }

    pub fn belongs_to(&self, thread_id: &str, terminal_id: &str) -> bool {
        let (event_thread_id, event_terminal_id) = match self {
            Self::Started {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Output {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Exited {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Closed {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Error {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Cleared {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Restarted {
                thread_id,
                terminal_id,
                ..
            }
            | Self::Activity {
                thread_id,
                terminal_id,
                ..
            } => (thread_id, terminal_id),
        };
        event_thread_id == thread_id && event_terminal_id == terminal_id
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalMetadataEvent {
    Snapshot {
        terminals: Vec<TerminalSummary>,
    },
    Upsert {
        terminal: TerminalSummary,
    },
    Remove {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
}
