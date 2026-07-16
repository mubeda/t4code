mod background;
mod runner;
mod shell;

pub use background::{configure_background_command, configure_background_std_command};
pub(crate) use background::configure_background_command_wrap;
pub use runner::{
    OutputMode, ProcessError, ProcessRunInput, ProcessRunOutput, ProcessRunner, TimeoutBehavior,
};
pub use shell::{Platform, ShellCandidate, resolve_shell_candidates};
