mod background;
mod cleanup;
mod executable;
mod runner;
mod shell;
pub(crate) mod supervised;
#[cfg(windows)]
mod windows_job;

#[cfg(windows)]
pub(crate) use windows_job::WindowsJob;

pub use background::{
    configure_background_command, configure_background_std_command,
    configure_supervised_background_command_wrap,
};
pub(crate) use cleanup::ProcessCleanupReport;
pub(crate) use executable::{
    PreparedLaunch, launch_executable_extensions, locate_executable, wrap_launch_program,
    wrap_windows_batch_command,
};
pub use runner::{
    OutputMode, ProcessError, ProcessRunInput, ProcessRunOutput, ProcessRunner, TimeoutBehavior,
};
pub use shell::{Platform, ShellCandidate, resolve_shell_candidates};

#[cfg(test)]
pub(crate) static EXTERNAL_PROCESS_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());
