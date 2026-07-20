mod background;
mod executable;
mod runner;
mod shell;
#[cfg(windows)]
mod windows_job;

#[cfg(windows)]
pub(crate) use windows_job::{WindowsJob, WindowsPtyLaunchGate};

pub use background::{
    configure_background_command, configure_background_std_command,
    configure_supervised_background_command_wrap,
};
#[cfg(any(windows, test))]
pub(crate) use executable::wrap_windows_pty_launch;
pub(crate) use executable::{
    PreparedLaunch, launch_executable_extensions, locate_executable, wrap_launch_program,
};
pub use executable::{WINDOWS_PTY_TRAMPOLINE_ARG, run_windows_pty_trampoline};
pub use runner::{
    OutputMode, ProcessError, ProcessRunInput, ProcessRunOutput, ProcessRunner, TimeoutBehavior,
};
pub use shell::{Platform, ShellCandidate, resolve_shell_candidates};

#[cfg(test)]
pub(crate) static EXTERNAL_PROCESS_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());
