mod background;
mod runner;
mod shell;

pub(crate) use background::configure_background_command_wrap;
pub use background::{configure_background_command, configure_background_std_command};
pub use runner::{
    OutputMode, ProcessError, ProcessRunInput, ProcessRunOutput, ProcessRunner, TimeoutBehavior,
};
pub use shell::{Platform, ShellCandidate, resolve_shell_candidates};

#[cfg(test)]
pub(crate) static EXTERNAL_PROCESS_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());
