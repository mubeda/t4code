#[cfg(windows)]
use process_wrap::tokio::CommandWrapper;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{CommandWrap, KillOnDrop};
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

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
struct WindowsSupervisedCreationFlags;

#[cfg(windows)]
impl CommandWrapper for WindowsSupervisedCreationFlags {
    fn pre_spawn(&mut self, command: &mut Command, _core: &CommandWrap) -> std::io::Result<()> {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

        // This wrapper must run after process-wrap's JobObject. JobObject
        // overwrites Tokio's creation flags while preparing its suspended
        // launch, so applying the complete flag set last preserves both the
        // race-free Job assignment and the GUI no-window policy.
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        Ok(())
    }
}

/// Applies the platform process-tree supervision policy for a non-interactive
/// background command.
pub fn configure_supervised_background_command_wrap(command: &mut CommandWrap) {
    command.wrap(KillOnDrop);
    #[cfg(windows)]
    {
        command.wrap(process_wrap::tokio::JobObject);
        command.wrap(WindowsSupervisedCreationFlags);
    }
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
}

#[cfg(all(test, windows))]
mod tests {
    use std::process::Stdio;

    use process_wrap::tokio::CommandWrap;
    use tokio::io::AsyncReadExt;
    use windows_sys::Win32::System::Console::GetConsoleWindow;

    use super::{configure_background_command, configure_supervised_background_command_wrap};

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
    async fn supervised_background_command_has_no_console() {
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
        configure_supervised_background_command_wrap(&mut command);

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

    #[tokio::test]
    async fn supervised_background_cmd_shim_has_no_console() {
        let executable = std::env::current_exe().expect("current test executable should resolve");
        let mut command = CommandWrap::with_new("cmd.exe", |command| {
            command
                .args(["/d", "/s", "/c"])
                .arg(executable)
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
        configure_supervised_background_command_wrap(&mut command);

        let mut child = command
            .spawn()
            .expect("wrapped cmd console probe should run");
        let mut stdout = child
            .stdout()
            .take()
            .expect("wrapped cmd console probe should expose stdout");
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .expect("wrapped cmd console probe stdout should be readable");
        let status = child
            .wait()
            .await
            .expect("wrapped cmd console probe should complete");
        assert!(status.success(), "wrapped cmd probe failed: {status}");
        let stdout = String::from_utf8_lossy(&bytes);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "wrapped cmd process unexpectedly inherited a console: {stdout}"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{configure_background_command, configure_background_std_command};

    #[test]
    fn background_configuration_is_a_noop_on_unix_commands() {
        let mut tokio_command = tokio::process::Command::new("true");
        configure_background_command(&mut tokio_command);

        let mut std_command = std::process::Command::new("true");
        configure_background_std_command(&mut std_command);
    }
}
