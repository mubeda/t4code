use process_wrap::tokio::CommandWrap;
use tokio::process::Command;

/// Configures a non-interactive Tokio child process so a GUI parent does not
/// flash a console window on Windows.
pub fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

/// Configures a non-interactive standard-library child process so a GUI parent
/// does not flash a console window on Windows.
pub fn configure_background_std_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Applies the same policy through process-wrap's creation-flags shim. This
/// must be installed before JobObject because JobObject also modifies Windows
/// creation flags while spawning the child.
pub(crate) fn configure_background_command_wrap(command: &mut CommandWrap) {
    #[cfg(windows)]
    command.wrap(process_wrap::tokio::CreationFlags(
        windows::Win32::System::Threading::CREATE_NO_WINDOW,
    ));
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(all(test, windows))]
mod tests {
    use std::process::Stdio;

    use process_wrap::tokio::{CommandWrap, JobObject, KillOnDrop};
    use tokio::io::AsyncReadExt;
    use windows_sys::Win32::System::Console::GetConsoleWindow;

    use super::{configure_background_command, configure_background_command_wrap};

    const CONSOLE_PROBE_ENV: &str = "T4CODE_WINDOWS_CONSOLE_PROBE";
    const CONSOLE_PROBE_MARKER: &str = "T4CODE_HAS_CONSOLE=";

    #[test]
    fn windows_child_console_probe() {
        if std::env::var_os(CONSOLE_PROBE_ENV).is_some() {
            // SAFETY: GetConsoleWindow takes no arguments and only reads the
            // calling process's console association.
            let has_console = !unsafe { GetConsoleWindow() }.is_null();
            println!("{CONSOLE_PROBE_MARKER}{has_console}");
        }
    }

    #[tokio::test]
    async fn background_tokio_command_has_no_console() {
        let mut command = tokio::process::Command::new(
            std::env::current_exe().expect("current test executable should resolve"),
        );
        command
            .args([
                "--exact",
                "process::background::tests::windows_child_console_probe",
                "--nocapture",
            ])
            .env(CONSOLE_PROBE_ENV, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_background_command(&mut command);

        let output = command
            .output()
            .await
            .expect("background console probe should run");
        assert!(output.status.success(), "console probe failed: {output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "background process unexpectedly inherited a console: {stdout}"
        );
    }

    #[tokio::test]
    async fn background_wrapped_command_has_no_console_with_job_object() {
        let executable = std::env::current_exe().expect("current test executable should resolve");
        let mut command = CommandWrap::with_new(executable, |command| {
            command
                .args([
                    "--exact",
                    "process::background::tests::windows_child_console_probe",
                    "--nocapture",
                ])
                .env(CONSOLE_PROBE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        });
        configure_background_command_wrap(&mut command);
        command.wrap(KillOnDrop);
        command.wrap(JobObject);

        let mut child = command
            .spawn()
            .expect("wrapped background console probe should run");
        let mut stdout = child
            .stdout()
            .take()
            .expect("wrapped console probe should expose stdout");
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .expect("wrapped console probe stdout should be readable");
        let status = child
            .wait()
            .await
            .expect("wrapped console probe should complete");
        assert!(status.success(), "wrapped console probe failed: {status}");
        let stdout = String::from_utf8_lossy(&bytes);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "wrapped background process unexpectedly inherited a console: {stdout}"
        );
    }
}
