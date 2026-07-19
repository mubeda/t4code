#[cfg(unix)]
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::{
    io::{self, Read as _},
    os::{
        fd::AsRawFd as _,
        unix::{ffi::OsStringExt as _, fs::PermissionsExt as _, process::CommandExt as _},
    },
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
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

#[cfg(unix)]
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

#[cfg(unix)]
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
    #[cfg(unix)]
    Applied {
        added_segments: usize,
    },
    #[cfg(unix)]
    Unchanged {
        reason: PathHydrationFailure,
    },
    Skipped,
}

impl PathHydrationReport {
    pub(crate) fn record(self) {
        match self {
            #[cfg(unix)]
            Self::Applied { added_segments } => {
                tracing::info!(added_segments, "hydrated desktop PATH from the login shell");
            }
            #[cfg(unix)]
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

#[cfg(unix)]
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

#[cfg(unix)]
fn merge_path_values(
    shell_path: &OsStr,
    inherited_path: Option<&OsStr>,
) -> Result<PreparedPath, PathHydrationFailure> {
    let inherited = inherited_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .collect::<Vec<_>>();
    let inherited_set = inherited.iter().cloned().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut added_segments = 0;

    for path in std::env::split_paths(shell_path) {
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
fn set_nonblocking(stdout: &ChildStdout) -> io::Result<()> {
    let descriptor = stdout.as_raw_fd();
    // SAFETY: `descriptor` belongs to the live `ChildStdout`, and `F_GETFL`
    // only reads its current file status flags.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `descriptor` remains valid for this call and `F_SETFL` updates
    // only the nonblocking status flag while preserving all existing flags.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn drain_stdout(
    mut stdout: ChildStdout,
    limit: usize,
    stop: Arc<AtomicBool>,
) -> io::Result<CapturedOutput> {
    set_nonblocking(&stdout)?;
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded_limit = false;

    while !stop.load(Ordering::Acquire) {
        let read = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(error) => return Err(error),
        };
        if read > 0 {
            let remaining = limit.saturating_sub(bytes.len());
            let retained = remaining.min(read);
            bytes.extend_from_slice(&buffer[..retained]);
            exceeded_limit |= retained < read;
        }
    }

    Ok(CapturedOutput {
        bytes,
        exceeded_limit,
    })
}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child, process_group_id: u32) {
    if let Ok(process_group_id) = i32::try_from(process_group_id) {
        // SAFETY: the probe child is spawned as the leader of a new process
        // group. A negative PID targets that group; failures such as an already
        // empty group are intentionally ignored during best-effort cleanup.
        unsafe {
            libc::kill(-process_group_id, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn stop_and_join(
    child: &mut Child,
    process_group_id: u32,
    stop: &AtomicBool,
    reader: JoinHandle<io::Result<CapturedOutput>>,
) {
    stop.store(true, Ordering::Release);
    terminate_process_group(child, process_group_id);
    let _ = reader.join();
}

#[cfg(unix)]
fn probe_shell_path(
    shell: &Path,
    timeout: Duration,
    output_limit: usize,
) -> Result<OsString, PathHydrationFailure> {
    run_shell_probe(
        shell,
        &["-ilc", PATH_PROBE_COMMAND],
        timeout,
        output_limit,
        None,
    )
}

#[cfg(all(unix, test))]
fn probe_shell_path_with_command(
    shell: &Path,
    command: &str,
    timeout: Duration,
    output_limit: usize,
) -> Result<OsString, PathHydrationFailure> {
    run_shell_probe(shell, &["-c", command], timeout, output_limit, None)
}

#[cfg(all(unix, test))]
fn probe_shell_path_with_command_and_pid(
    shell: &Path,
    command: &str,
    timeout: Duration,
    output_limit: usize,
) -> (Result<OsString, PathHydrationFailure>, u32) {
    let spawned_pid = AtomicU32::new(0);
    let result = run_shell_probe(
        shell,
        &["-c", command],
        timeout,
        output_limit,
        Some(&spawned_pid),
    );
    (result, spawned_pid.load(Ordering::Acquire))
}

#[cfg(unix)]
fn run_shell_probe(
    shell: &Path,
    arguments: &[&str],
    timeout: Duration,
    output_limit: usize,
    spawned_pid: Option<&AtomicU32>,
) -> Result<OsString, PathHydrationFailure> {
    let mut command = Command::new(shell);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| PathHydrationFailure::SpawnFailed)?;
    let process_group_id = child.id();
    if let Some(spawned_pid) = spawned_pid {
        spawned_pid.store(process_group_id, Ordering::Release);
    }
    let Some(stdout) = child.stdout.take() else {
        terminate_process_group(&mut child, process_group_id);
        return Err(PathHydrationFailure::OutputReadFailed);
    };
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let reader = std::thread::spawn(move || drain_stdout(stdout, output_limit, reader_stop));
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                stop_and_join(&mut child, process_group_id, &stop, reader);
                return Err(PathHydrationFailure::TimedOut);
            }
            Ok(None) => {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(_) => {
                stop_and_join(&mut child, process_group_id, &stop, reader);
                return Err(PathHydrationFailure::WaitFailed);
            }
        }
    };

    terminate_process_group(&mut child, process_group_id);
    while !reader.is_finished() && Instant::now() < deadline {
        std::thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    if !reader.is_finished() {
        stop.store(true, Ordering::Release);
        let _ = reader.join();
        return Err(PathHydrationFailure::TimedOut);
    }
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
    use std::{
        ffi::{OsStr, OsString},
        path::{Path, PathBuf},
        process::Command,
        time::{Duration, Instant},
    };

    use super::{DesktopPlatform, PlatformAction, PosixPlatform, platform_action};
    #[cfg(unix)]
    use super::{
        PathHydrationFailure, merge_path_values, parse_captured_path,
        probe_shell_path_with_command, probe_shell_path_with_command_and_pid, select_shell,
    };

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn wait_for_process_disappearance(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while process_exists(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        !process_exists(pid)
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

    #[cfg(unix)]
    #[test]
    fn merges_shell_path_first_preserving_spaces_and_unique_inherited_entries() {
        let shell = std::env::join_paths([
            Path::new("/Users/test/My Tools"),
            Path::new("/opt/homebrew/bin"),
            Path::new("/usr/bin"),
            Path::new("/opt/homebrew/bin"),
        ])
        .unwrap();
        let inherited =
            std::env::join_paths([Path::new("/usr/bin"), Path::new(""), Path::new("/bin")])
                .unwrap();

        let prepared = merge_path_values(&shell, Some(&inherited)).unwrap();
        assert_eq!(
            std::env::split_paths(&prepared.value).collect::<Vec<_>>(),
            [
                PathBuf::from("/Users/test/My Tools"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::new(),
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

    #[cfg(unix)]
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
        assert_eq!(
            probe_shell_path_with_command(
                Path::new("/bin/sh"),
                "printf 'banner\\n__T4CODE_PATH_START__/user/bin:/usr/bin\
__T4CODE_PATH_END__\\nlogout\\n'",
                Duration::from_secs(5),
                4096,
            )
            .unwrap(),
            OsString::from("/user/bin:/usr/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_rejects_non_zero_and_oversized_output() {
        assert_eq!(
            probe_shell_path_with_command(
                Path::new("/bin/sh"),
                "exit 7",
                Duration::from_secs(5),
                4096,
            ),
            Err(PathHydrationFailure::NonZeroExit)
        );

        assert_eq!(
            probe_shell_path_with_command(
                Path::new("/bin/sh"),
                "printf '__T4CODE_PATH_START__'; i=0; \
while [ \"$i\" -lt 8192 ]; do printf x; i=$((i + 1)); done; \
printf '__T4CODE_PATH_END__'",
                Duration::from_secs(5),
                128,
            ),
            Err(PathHydrationFailure::OutputTooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_reports_spawn_failure_for_a_missing_shell() {
        assert_eq!(
            probe_shell_path_with_command(
                Path::new("/definitely/missing/t4code-shell"),
                "exit 0",
                Duration::from_secs(5),
                4096,
            ),
            Err(PathHydrationFailure::SpawnFailed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_reaps_and_joins_shell_before_returning() {
        let (result, pid) = probe_shell_path_with_command_and_pid(
            Path::new("/bin/sh"),
            "exec /bin/sleep 30",
            Duration::ZERO,
            4096,
        );

        assert_eq!(result, Err(PathHydrationFailure::TimedOut));
        assert_ne!(pid, 0, "probe did not record the spawned shell PID");
        assert!(
            wait_for_process_disappearance(pid, Duration::from_secs(1)),
            "timed-out shell process was not reaped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn background_descendant_cannot_hold_probe_stdout_past_the_deadline() {
        let directory = tempfile::TempDir::new().unwrap();
        let pid_path = directory.path().join("descendant-pid");
        let command = format!(
            "/bin/sleep 30 & descendant=$!; printf '%s' \"$descendant\" > '{}'; \
printf '__T4CODE_PATH_START__/user/bin:/usr/bin__T4CODE_PATH_END__'",
            pid_path.display()
        );
        let started = Instant::now();

        assert_eq!(
            probe_shell_path_with_command(
                Path::new("/bin/sh"),
                &command,
                Duration::from_secs(1),
                4096,
            ),
            Ok(OsString::from("/user/bin:/usr/bin"))
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "probe exceeded its bounded cleanup window"
        );
        let pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(
            wait_for_process_disappearance(pid, Duration::from_secs(1)),
            "background shell descendant remained alive"
        );
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
