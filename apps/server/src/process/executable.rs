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

pub(crate) const WINDOWS_BATCH_TRAMPOLINE_ARG: &str =
    "--t4code-internal-windows-batch-trampoline";

/// Runs a Windows batch shim requested by an internal same-binary launch.
///
/// `std::process::Command` owns the `.cmd`/`.bat` quoting here. Its Windows
/// implementation invokes the command processor with delayed expansion
/// disabled and rejects unsupported batch arguments, while the first launch
/// into this executable remains an ordinary structured argv invocation.
pub fn run_windows_batch_trampoline() -> Option<i32> {
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let mut arguments = std::env::args_os().skip(1);
        if arguments.next().as_deref() != Some(OsStr::new(WINDOWS_BATCH_TRAMPOLINE_ARG)) {
            return None;
        }
        let Some(script) = arguments.next() else {
            eprintln!("t4code: the internal Windows batch launch is missing its script.");
            return Some(1);
        };
        match std::process::Command::new(script).args(arguments).status() {
            Ok(status) => Some(status.code().unwrap_or(1)),
            Err(_) => {
                eprintln!("t4code: failed to start the requested Windows provider.");
                Some(1)
            }
        }
    }
}

pub(crate) fn wrap_launch_program(
    platform: Platform,
    executable: &Path,
    windows_batch_trampoline: Option<&Path>,
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
    if platform == Platform::Windows
        && extension.is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
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
        let trampoline = match windows_batch_trampoline {
            Some(trampoline) => trampoline.to_path_buf(),
            None => std::env::current_exe().map_err(|error| {
                format!("failed to resolve the Windows batch launch trampoline: {error}")
            })?,
        };
        return Ok(LaunchProgram {
            program: trampoline,
            prefix_args: [
                OsString::from(WINDOWS_BATCH_TRAMPOLINE_ARG),
                executable.as_os_str().to_owned(),
            ]
            .into_iter()
            .collect(),
        });
    }
    Ok(LaunchProgram {
        program: executable.to_path_buf(),
        prefix_args: Vec::new(),
    })
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
