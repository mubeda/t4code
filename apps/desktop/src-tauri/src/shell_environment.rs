#[cfg(any(unix, test))]
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{
    io::{self, Read as _},
    os::unix::{ffi::OsStringExt as _, fs::PermissionsExt as _},
    process::{Child, ChildStdout, Command, Stdio},
    thread::JoinHandle,
    time::{Duration, Instant},
};

#[cfg(unix)]
const PATH_CAPTURE_START: &[u8] = b"__T4CODE_PATH_START__";
#[cfg(unix)]
const PATH_CAPTURE_END: &[u8] = b"__T4CODE_PATH_END__";
#[cfg(unix)]
const SUPPORTED_SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash"];
#[cfg(unix)]
const PATH_PROBE_COMMAND: &str = concat!(
    "printf '%s' '__T4CODE_PATH_START__'; ",
    "command printenv PATH; ",
    "printf '%s' '__T4CODE_PATH_END__'"
);
#[cfg(unix)]
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const PATH_PROBE_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathHydrationFailure {
    ShellUnavailable,
    SpawnFailed,
    WaitFailed,
    TimedOut,
    NonZeroExit,
    OutputReadFailed,
    OutputTooLarge,
    MalformedOutput,
    EmptyPath,
    InvalidPath,
}

impl PathHydrationFailure {
    fn category(self) -> &'static str {
        match self {
            Self::ShellUnavailable => "shell-unavailable",
            Self::SpawnFailed => "spawn-failed",
            Self::WaitFailed => "wait-failed",
            Self::TimedOut => "timed-out",
            Self::NonZeroExit => "non-zero-exit",
            Self::OutputReadFailed => "output-read-failed",
            Self::OutputTooLarge => "output-too-large",
            Self::MalformedOutput => "malformed-output",
            Self::EmptyPath => "empty-path",
            Self::InvalidPath => "invalid-path",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathHydrationReport {
    Applied { added_segments: usize },
    Unchanged { reason: PathHydrationFailure },
    Skipped,
}

impl PathHydrationReport {
    pub(crate) fn record(self) {
        match self {
            Self::Applied { added_segments } => {
                tracing::info!(added_segments, "hydrated desktop PATH from the login shell");
            }
            Self::Unchanged { reason } => {
                tracing::warn!(
                    reason = reason.category(),
                    "desktop PATH hydration was not applied"
                );
            }
            Self::Skipped => {
                tracing::debug!("desktop PATH hydration is not required on this platform");
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopPlatform {
    MacOs,
    Linux,
    Windows,
    Other,
}

impl DesktopPlatform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlatformAction {
    Hydrate(PosixPlatform),
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PosixPlatform {
    MacOs,
    Linux,
}

#[cfg(any(unix, test))]
#[derive(Debug, Eq, PartialEq)]
struct PreparedPath {
    value: OsString,
    added_segments: usize,
}

pub(crate) fn hydrate_process_path() -> PathHydrationReport {
    match platform_action(DesktopPlatform::current()) {
        #[cfg(unix)]
        PlatformAction::Hydrate(platform) => hydrate_posix_path(platform),
        #[cfg(not(unix))]
        PlatformAction::Hydrate(_) => PathHydrationReport::Skipped,
        PlatformAction::Skip => PathHydrationReport::Skipped,
    }
}

fn platform_action(platform: DesktopPlatform) -> PlatformAction {
    match platform {
        DesktopPlatform::MacOs => PlatformAction::Hydrate(PosixPlatform::MacOs),
        DesktopPlatform::Linux => PlatformAction::Hydrate(PosixPlatform::Linux),
        DesktopPlatform::Windows | DesktopPlatform::Other => PlatformAction::Skip,
    }
}

#[cfg(unix)]
fn select_shell(
    configured: Option<&OsStr>,
    platform: PosixPlatform,
    is_available: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let configured = configured.map(Path::new).filter(|path| {
        path.is_absolute()
            && path
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| SUPPORTED_SHELLS.contains(&name))
            && is_available(path)
    });
    if let Some(configured) = configured {
        return Some(configured.to_path_buf());
    }

    let fallback = match platform {
        PosixPlatform::MacOs => Path::new("/bin/zsh"),
        PosixPlatform::Linux => Path::new("/bin/bash"),
    };
    is_available(fallback).then(|| fallback.to_path_buf())
}

#[cfg(unix)]
fn parse_captured_path(
    output: &[u8],
    exceeded_limit: bool,
) -> Result<OsString, PathHydrationFailure> {
    if exceeded_limit {
        return Err(PathHydrationFailure::OutputTooLarge);
    }

    let start = find_subslice(output, PATH_CAPTURE_START)
        .map(|index| index + PATH_CAPTURE_START.len())
        .ok_or(PathHydrationFailure::MalformedOutput)?;
    let end = find_subslice(&output[start..], PATH_CAPTURE_END)
        .map(|index| start + index)
        .ok_or(PathHydrationFailure::MalformedOutput)?;
    let captured = trim_ascii_whitespace(&output[start..end]);
    if captured.is_empty() {
        return Err(PathHydrationFailure::EmptyPath);
    }

    Ok(OsString::from_vec(captured.to_vec()))
}

#[cfg(unix)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(unix)]
fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |index| index + 1);
    &bytes[start..end]
}

#[cfg(any(unix, test))]
fn merge_path_values(
    shell_path: &OsStr,
    inherited_path: Option<&OsStr>,
) -> Result<PreparedPath, PathHydrationFailure> {
    let inherited = inherited_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let inherited_set = inherited.iter().cloned().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut added_segments = 0;

    for path in std::env::split_paths(shell_path).filter(|path| !path.as_os_str().is_empty()) {
        if seen.insert(path.clone()) {
            added_segments += usize::from(!inherited_set.contains(&path));
            merged.push(path);
        }
    }
    for path in inherited {
        if seen.insert(path.clone()) {
            merged.push(path);
        }
    }

    if merged.is_empty() {
        return Err(PathHydrationFailure::EmptyPath);
    }
    let value = std::env::join_paths(merged).map_err(|_| PathHydrationFailure::InvalidPath)?;
    Ok(PreparedPath {
        value,
        added_segments,
    })
}

#[cfg(unix)]
#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

#[cfg(unix)]
fn drain_stdout(mut stdout: ChildStdout, limit: usize) -> io::Result<CapturedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded_limit = false;

    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        exceeded_limit |= retained < read;
    }

    Ok(CapturedOutput {
        bytes,
        exceeded_limit,
    })
}

#[cfg(unix)]
fn stop_and_join(child: &mut Child, reader: JoinHandle<io::Result<CapturedOutput>>) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
}

#[cfg(unix)]
fn probe_shell_path(
    shell: &Path,
    timeout: Duration,
    output_limit: usize,
) -> Result<OsString, PathHydrationFailure> {
    let mut child = Command::new(shell)
        .args(["-ilc", PATH_PROBE_COMMAND])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| PathHydrationFailure::SpawnFailed)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(PathHydrationFailure::OutputReadFailed);
    };
    let reader = std::thread::spawn(move || drain_stdout(stdout, output_limit));
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                stop_and_join(&mut child, reader);
                return Err(PathHydrationFailure::TimedOut);
            }
            Ok(None) => {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(_) => {
                stop_and_join(&mut child, reader);
                return Err(PathHydrationFailure::WaitFailed);
            }
        }
    };

    let captured = reader
        .join()
        .map_err(|_| PathHydrationFailure::OutputReadFailed)?
        .map_err(|_| PathHydrationFailure::OutputReadFailed)?;
    if !status.success() {
        return Err(PathHydrationFailure::NonZeroExit);
    }
    parse_captured_path(&captured.bytes, captured.exceeded_limit)
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(unix)]
fn hydrate_posix_path(platform: PosixPlatform) -> PathHydrationReport {
    let configured_shell = std::env::var_os("SHELL");
    let Some(shell) = select_shell(configured_shell.as_deref(), platform, is_executable_file)
    else {
        return PathHydrationReport::Unchanged {
            reason: PathHydrationFailure::ShellUnavailable,
        };
    };
    let shell_path = match probe_shell_path(&shell, PATH_PROBE_TIMEOUT, PATH_PROBE_OUTPUT_LIMIT) {
        Ok(path) => path,
        Err(reason) => return PathHydrationReport::Unchanged { reason },
    };
    let inherited = std::env::var_os("PATH");
    let prepared = match merge_path_values(&shell_path, inherited.as_deref()) {
        Ok(prepared) => prepared,
        Err(reason) => return PathHydrationReport::Unchanged { reason },
    };

    // SAFETY: `hydrate_process_path` is the first operation in `run`, before
    // Tauri creates worker threads. The shell child and stdout reader are fully
    // joined before this mutation, so no other thread in this process can read
    // or write the environment concurrently.
    unsafe {
        std::env::set_var("PATH", &prepared.value);
    }
    PathHydrationReport::Applied {
        added_segments: prepared.added_segments,
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::{process::Command, time::Duration};

    use super::{
        DesktopPlatform, PathHydrationFailure, PlatformAction, PosixPlatform, merge_path_values,
        platform_action,
    };
    #[cfg(unix)]
    use super::{parse_captured_path, probe_shell_path, select_shell};

    #[cfg(unix)]
    fn write_executable(directory: &tempfile::TempDir, name: &str, contents: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;

        let path = directory.path().join(name);
        std::fs::write(&path, contents).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn parses_path_between_delimiters_and_ignores_shell_output() {
        let output = b"welcome\n__T4CODE_PATH_START__/opt/homebrew/bin:/usr/bin\
__T4CODE_PATH_END__\nlogout";
        assert_eq!(
            parse_captured_path(output, false).unwrap(),
            OsString::from("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_missing_reversed_empty_and_oversized_captures() {
        assert_eq!(
            parse_captured_path(b"/usr/bin", false),
            Err(PathHydrationFailure::MalformedOutput)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_END__/usr/bin__T4CODE_PATH_START__", false),
            Err(PathHydrationFailure::MalformedOutput)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_START__  __T4CODE_PATH_END__", false),
            Err(PathHydrationFailure::EmptyPath)
        );
        assert_eq!(
            parse_captured_path(b"__T4CODE_PATH_START__/usr/bin__T4CODE_PATH_END__", true),
            Err(PathHydrationFailure::OutputTooLarge)
        );
    }

    #[test]
    fn merges_shell_path_first_preserving_spaces_and_unique_inherited_entries() {
        let shell = std::env::join_paths([
            Path::new("/Users/test/My Tools"),
            Path::new("/opt/homebrew/bin"),
            Path::new("/usr/bin"),
            Path::new("/opt/homebrew/bin"),
        ])
        .unwrap();
        let inherited = std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap();

        let prepared = merge_path_values(&shell, Some(&inherited)).unwrap();
        assert_eq!(
            std::env::split_paths(&prepared.value).collect::<Vec<_>>(),
            [
                PathBuf::from("/Users/test/My Tools"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
        assert_eq!(prepared.added_segments, 2);
    }

    #[cfg(unix)]
    #[test]
    fn selects_trusted_configured_shell_then_platform_default() {
        let exists = |path: &Path| {
            matches!(
                path.to_str(),
                Some("/opt/homebrew/bin/fish" | "/bin/zsh" | "/bin/bash")
            )
        };
        assert_eq!(
            select_shell(
                Some(OsStr::new("/opt/homebrew/bin/fish")),
                PosixPlatform::MacOs,
                exists
            ),
            Some(PathBuf::from("/opt/homebrew/bin/fish"))
        );
        assert_eq!(
            select_shell(
                Some(OsStr::new("relative/zsh")),
                PosixPlatform::MacOs,
                exists
            ),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(
            select_shell(
                Some(OsStr::new("/bin/nushell")),
                PosixPlatform::Linux,
                exists
            ),
            Some(PathBuf::from("/bin/bash"))
        );
    }

    #[test]
    fn windows_platform_skips_hydration() {
        assert_eq!(
            platform_action(DesktopPlatform::Windows),
            PlatformAction::Skip
        );
    }

    #[test]
    fn platform_actions_cover_supported_posix_and_unsupported_hosts() {
        assert_eq!(
            platform_action(DesktopPlatform::MacOs),
            PlatformAction::Hydrate(PosixPlatform::MacOs)
        );
        assert_eq!(
            platform_action(DesktopPlatform::Linux),
            PlatformAction::Hydrate(PosixPlatform::Linux)
        );
        assert_eq!(
            platform_action(DesktopPlatform::Other),
            PlatformAction::Skip
        );
    }

    #[test]
    fn hydration_failure_categories_remain_distinct() {
        let failures = [
            PathHydrationFailure::ShellUnavailable,
            PathHydrationFailure::SpawnFailed,
            PathHydrationFailure::WaitFailed,
            PathHydrationFailure::TimedOut,
            PathHydrationFailure::NonZeroExit,
            PathHydrationFailure::OutputReadFailed,
            PathHydrationFailure::OutputTooLarge,
            PathHydrationFailure::MalformedOutput,
            PathHydrationFailure::EmptyPath,
            PathHydrationFailure::InvalidPath,
        ];

        assert_eq!(failures.len(), 10);
        for (index, failure) in failures.iter().enumerate() {
            assert!(
                !failures[..index].contains(failure),
                "failure category was duplicated: {failure:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn probe_accepts_noisy_successful_shell_output() {
        let directory = tempfile::TempDir::new().unwrap();
        let fixture = write_executable(
            &directory,
            "success-shell",
            "#!/bin/sh\nprintf 'banner\\n__T4CODE_PATH_START__/user/bin:/usr/bin\
__T4CODE_PATH_END__\\nlogout\\n'\n",
        );

        assert_eq!(
            probe_shell_path(&fixture, Duration::from_secs(1), 4096).unwrap(),
            OsString::from("/user/bin:/usr/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_rejects_non_zero_and_oversized_output() {
        let directory = tempfile::TempDir::new().unwrap();
        let failing = write_executable(&directory, "failing-shell", "#!/bin/sh\nexit 7\n");
        assert_eq!(
            probe_shell_path(&failing, Duration::from_secs(1), 4096),
            Err(PathHydrationFailure::NonZeroExit)
        );

        let oversized = write_executable(
            &directory,
            "oversized-shell",
            "#!/bin/sh\nprintf '__T4CODE_PATH_START__';\
head -c 8192 /dev/zero;printf '__T4CODE_PATH_END__'\n",
        );
        assert_eq!(
            probe_shell_path(&oversized, Duration::from_secs(1), 128),
            Err(PathHydrationFailure::OutputTooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_spawn_failure_for_a_missing_shell() {
        let directory = tempfile::TempDir::new().unwrap();
        let fixture = write_executable(&directory, "removed-shell", "#!/bin/sh\nexit 0\n");
        std::fs::remove_file(&fixture).unwrap();

        assert_eq!(
            probe_shell_path(&fixture, Duration::from_secs(1), 4096),
            Err(PathHydrationFailure::SpawnFailed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_reaps_and_joins_shell_before_returning() {
        let directory = tempfile::TempDir::new().unwrap();
        let pid_path = directory.path().join("pid");
        let fixture = write_executable(
            &directory,
            "sleeping-shell",
            &format!(
                "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec sleep 30\n",
                pid_path.display()
            ),
        );

        assert_eq!(
            probe_shell_path(&fixture, Duration::from_secs(1), 4096),
            Err(PathHydrationFailure::TimedOut)
        );
        let pid = std::fs::read_to_string(pid_path).unwrap();
        let alive = Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        assert!(!alive, "timed-out shell process was not reaped");
    }

    #[test]
    fn preparing_a_merged_path_does_not_mutate_the_process_environment() {
        let before = std::env::var_os("PATH");
        let shell = std::env::join_paths([Path::new("/user/bin"), Path::new("/usr/bin")]).unwrap();
        let inherited = std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap();

        let prepared = merge_path_values(&shell, Some(&inherited)).unwrap();

        assert_eq!(std::env::var_os("PATH"), before);
        assert_eq!(
            std::env::split_paths(&prepared.value).collect::<Vec<_>>(),
            [
                PathBuf::from("/user/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }
}
