use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use super::Platform;

pub(crate) const WINDOWS_LAUNCH_EXECUTABLE_EXTENSIONS: &[&str] =
    &["exe", "com", "cmd", "bat", "ps1"];

pub(crate) fn launch_executable_extensions(
    platform: Platform,
    windows_path_extensions: Option<&str>,
) -> Vec<String> {
    if platform == Platform::Unix {
        return vec![String::new()];
    }

    let configured = windows_path_extensions
        .into_iter()
        .flat_map(|extensions| extensions.split(';'))
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            if extension.starts_with('.') {
                extension.to_ascii_lowercase()
            } else {
                format!(".{}", extension.to_ascii_lowercase())
            }
        });
    let fallback = WINDOWS_LAUNCH_EXECUTABLE_EXTENSIONS
        .iter()
        .map(|extension| format!(".{extension}"));
    let mut extensions = vec![String::new()];
    for extension in configured.chain(fallback) {
        if !extensions
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
        {
            extensions.push(extension);
        }
    }
    extensions
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LaunchProgram {
    program: PathBuf,
    prefix_args: Vec<OsString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
}

impl LaunchProgram {
    pub(crate) fn prepare<I, S>(self, arguments: I) -> PreparedLaunch
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        PreparedLaunch {
            program: self.program,
            args: self
                .prefix_args
                .into_iter()
                .chain(
                    arguments
                        .into_iter()
                        .map(|argument| argument.as_ref().to_owned()),
                )
                .collect(),
        }
    }
}

#[doc(hidden)]
pub const WINDOWS_PTY_TRAMPOLINE_ARG: &str = "--t4code-internal-windows-pty-trampoline";

/// Runs a Windows PTY target requested by an internal same-binary launch.
///
/// The parent attaches this trampoline to the terminal job before authorizing
/// the prepared target. `std::process::Command` retains ownership of Windows
/// `.cmd`/`.bat` quoting and invokes other targets with their structured argv.
pub fn run_windows_pty_trampoline() -> Option<i32> {
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let mut arguments = std::env::args_os().skip(1);
        if arguments.next().as_deref() != Some(OsStr::new(WINDOWS_PTY_TRAMPOLINE_ARG)) {
            return None;
        }
        let Some(gate_name) = arguments.next() else {
            eprintln!("t4code: the internal Windows PTY launch is missing its gate.");
            return Some(1);
        };
        let Some(ready_name) = arguments.next() else {
            eprintln!("t4code: the internal Windows PTY launch is missing its ready event.");
            return Some(1);
        };
        let Some(program) = arguments.next() else {
            eprintln!("t4code: the internal Windows PTY launch is missing its target.");
            return Some(1);
        };
        if wait_for_windows_pty_gate(&gate_name, &ready_name).is_err() {
            eprintln!("t4code: the internal Windows PTY launch was not authorized.");
            return Some(1);
        }
        match std::process::Command::new(program).args(arguments).status() {
            Ok(status) => Some(status.code().unwrap_or(1)),
            Err(_) => {
                eprintln!("t4code: failed to start the requested Windows PTY target.");
                Some(1)
            }
        }
    }
}

#[cfg(windows)]
fn wait_for_windows_pty_gate(gate_name: &OsStr, ready_name: &OsStr) -> Result<(), ()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{
            EVENT_MODIFY_STATE, OpenEventW, SYNCHRONIZATION_SYNCHRONIZE, SetEvent,
            WaitForSingleObject,
        },
    };

    const GATE_TIMEOUT_MS: u32 = 30_000;

    let gate_name = gate_name
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: `gate_name` is NUL terminated and remains live for this call.
    let gate = unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, 0, gate_name.as_ptr()) };
    if gate.is_null() {
        return Err(());
    }
    let ready_name = ready_name
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: `ready_name` is NUL terminated and remains live for this call.
    let ready = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, ready_name.as_ptr()) };
    if ready.is_null() {
        // SAFETY: this function owns the event handle returned by OpenEventW.
        unsafe { CloseHandle(gate) };
        return Err(());
    }
    // SAFETY: `ready` is a live event handle opened with modify access.
    let ready_result = unsafe { SetEvent(ready) };
    // SAFETY: this function owns the ready-event handle returned by OpenEventW.
    unsafe { CloseHandle(ready) };
    if ready_result == 0 {
        // SAFETY: this function owns the gate handle returned by OpenEventW.
        unsafe { CloseHandle(gate) };
        return Err(());
    }
    // SAFETY: `gate` is a live event handle returned by OpenEventW.
    let result = unsafe { WaitForSingleObject(gate, GATE_TIMEOUT_MS) };
    // SAFETY: this function owns the event handle returned by OpenEventW.
    unsafe { CloseHandle(gate) };
    if result == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err(())
    }
}

pub(crate) fn wrap_launch_program(
    platform: Platform,
    executable: &Path,
) -> Result<LaunchProgram, String> {
    let extension = executable.extension().and_then(OsStr::to_str);
    if platform == Platform::Windows
        && extension.is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"))
    {
        return Ok(LaunchProgram {
            program: PathBuf::from("powershell.exe"),
            prefix_args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .into_iter()
            .map(OsString::from)
            .chain(std::iter::once(executable.as_os_str().to_owned()))
            .collect(),
        });
    }
    if is_windows_batch_executable(platform, executable) {
        if executable
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
        {
            return Err(
                "Windows batch executable paths cannot contain control characters".to_owned(),
            );
        }
        return Ok(LaunchProgram {
            program: executable.to_path_buf(),
            prefix_args: Vec::new(),
        });
    }
    Ok(LaunchProgram {
        program: executable.to_path_buf(),
        prefix_args: Vec::new(),
    })
}

fn is_windows_batch_executable(platform: Platform, executable: &Path) -> bool {
    platform == Platform::Windows
        && executable.extension().and_then(OsStr::to_str).is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

#[cfg(any(windows, test))]
pub(crate) fn wrap_windows_pty_launch(
    target: PreparedLaunch,
    trampoline: &Path,
    gate_name: &OsStr,
    ready_name: &OsStr,
) -> PreparedLaunch {
    PreparedLaunch {
        program: trampoline.to_path_buf(),
        args: [
            OsString::from(WINDOWS_PTY_TRAMPOLINE_ARG),
            gate_name.to_owned(),
            ready_name.to_owned(),
            target.program.into_os_string(),
        ]
        .into_iter()
        .chain(target.args)
        .collect(),
    }
}

pub(crate) fn locate_executable<E>(
    command: &str,
    cwd: Option<&Path>,
    search_path: Option<&OsStr>,
    extensions: &[E],
) -> Option<PathBuf>
where
    E: AsRef<str>,
{
    let command_path = Path::new(command);
    if command_path.is_absolute() {
        return command_path.is_file().then(|| command_path.to_path_buf());
    }
    if command_path.components().count() > 1 {
        let resolved = cwd?.join(command_path);
        return resolved.is_file().then_some(resolved);
    }

    search_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .find_map(|directory| {
            let directory = if directory.is_absolute() {
                directory
            } else {
                cwd?.join(directory)
            };
            extensions.iter().find_map(|extension| {
                let extension = extension.as_ref().trim();
                let candidate = if extension.is_empty() {
                    directory.join(command)
                } else if extension.starts_with('.') {
                    directory.join(format!("{command}{extension}"))
                } else {
                    directory.join(format!("{command}.{extension}"))
                };
                candidate.is_file().then_some(candidate)
            })
        })
}
