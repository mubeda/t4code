use std::{
    collections::BTreeMap,
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
    // Bare Windows commands must follow PATHEXT semantics. Checking the exact
    // name first can select npm's extensionless POSIX shim before its .cmd
    // launcher, which CreateProcess rejects with ERROR_BAD_EXE_FORMAT.
    let mut extensions: Vec<String> = Vec::new();
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
    pub(crate) raw_windows_args: Option<OsString>,
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
            raw_windows_args: None,
        }
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
        && executable
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            })
}

pub(crate) fn wrap_windows_batch_command(
    platform: Platform,
    target: PreparedLaunch,
    environment: &BTreeMap<String, String>,
) -> Result<PreparedLaunch, String> {
    if !is_windows_batch_executable(platform, &target.program) {
        return Ok(target);
    }

    let command_processor = environment
        .iter()
        .find(|(key, value)| key.eq_ignore_ascii_case("ComSpec") && !value.trim().is_empty())
        .map(|(_, value)| value.as_str())
        .unwrap_or("cmd.exe");
    let raw_windows_args = make_windows_batch_command_line(&target.program, &target.args)?;

    Ok(PreparedLaunch {
        program: PathBuf::from(command_processor),
        args: vec![raw_windows_args.clone()],
        raw_windows_args: Some(raw_windows_args),
    })
}

fn make_windows_batch_command_line(
    script: &Path,
    arguments: &[OsString],
) -> Result<OsString, String> {
    let script = script.to_string_lossy();
    if script.contains('"') || script.ends_with('\\') {
        return Err(
            "Windows batch executable paths cannot contain quotes or end with a backslash"
                .to_owned(),
        );
    }

    let mut command = String::from("/e:ON /v:OFF /d /c \"\"");
    command.push_str(&script);
    command.push('"');
    for argument in arguments {
        command.push(' ');
        append_windows_batch_argument(&mut command, &argument.to_string_lossy())?;
    }
    command.push('"');
    Ok(command.into())
}

fn append_windows_batch_argument(command: &mut String, argument: &str) -> Result<(), String> {
    if argument
        .chars()
        .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err("Windows batch executable arguments cannot contain line breaks".to_owned());
    }

    const SAFE_UNQUOTED: &str = r"#$*+-./:?@\_";
    let quote = argument.is_empty()
        || argument.ends_with('\\')
        || argument.chars().any(|character| {
            (character.is_ascii()
                && !(character.is_ascii_alphanumeric() || SAFE_UNQUOTED.contains(character)))
                || character.is_control()
        });
    if quote {
        command.push('"');
    }

    let mut backslashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                command.extend(std::iter::repeat_n('\\', backslashes));
                command.push('"');
            } else if character == '%' {
                // Prevent `%VAR%` expansion with the same zero-length `%cd%`
                // substring used by Rust's hardened batch launcher.
                command.push_str("%%cd:~,%");
            }
            backslashes = 0;
        }
        command.push(character);
    }
    if quote {
        command.extend(std::iter::repeat_n('\\', backslashes));
        command.push('"');
    }
    Ok(())
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
            if command_path.extension().is_some() {
                let candidate = directory.join(command);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
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
