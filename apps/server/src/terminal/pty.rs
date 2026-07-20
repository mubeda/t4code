use std::{
    collections::BTreeMap,
    env,
    ffi::OsStr,
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::sync::{broadcast, watch};

use crate::process::{
    Platform, launch_executable_extensions, locate_executable, wrap_launch_program,
};

#[cfg(any(windows, test))]
use crate::process::wrap_windows_pty_launch;
#[cfg(windows)]
use crate::process::{WindowsJob, WindowsPtyLaunchGate};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct PtySpawnInput {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub env: BTreeMap<String, String>,
}

pub trait PtyProcess: fmt::Debug + Send + Sync {
    fn pid(&self) -> u32;
    fn write(&self, data: &str) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn kill(&self) -> Result<(), String>;
    fn subscribe_output(&self) -> broadcast::Receiver<String>;
    fn subscribe_exit(&self) -> watch::Receiver<Option<PtyExit>>;
}

pub trait PtyBackend: fmt::Debug + Send + Sync {
    fn spawn(&self, input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String>;
}

#[derive(Debug, Default)]
pub struct PortablePtyBackend;

struct PreparedPtyCommand {
    command: CommandBuilder,
    #[cfg(windows)]
    launch_gate: WindowsPtyLaunchGate,
}

struct SpawnedChildGuard {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl SpawnedChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self { child: Some(child) }
    }

    fn child(&self) -> &(dyn portable_pty::Child + Send + Sync) {
        self.child.as_deref().expect("spawned child guard")
    }

    fn into_child(mut self) -> Box<dyn portable_pty::Child + Send + Sync> {
        self.child.take().expect("spawned child guard")
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if let Err(error) = child.kill() {
            tracing::debug!(%error, "failed to kill PTY child after spawn setup failure");
        }
    }
}

impl PortablePtyBackend {
    #[cfg(windows)]
    #[doc(hidden)]
    pub fn spawn_with_windows_pty_trampoline(
        &self,
        input: &PtySpawnInput,
        trampoline: &Path,
    ) -> Result<Arc<dyn PtyProcess>, String> {
        let launch_gate = WindowsPtyLaunchGate::new().map_err(|error| error.to_string())?;
        let command = build_pty_command_on_with_trampoline(
            Platform::Windows,
            input,
            trampoline,
            launch_gate.name(),
            launch_gate.ready_name(),
        )?;
        self.spawn_command(
            input,
            PreparedPtyCommand {
                command,
                launch_gate,
            },
        )
    }

    fn spawn_command(
        &self,
        input: &PtySpawnInput,
        prepared: PreparedPtyCommand,
    ) -> Result<Arc<dyn PtyProcess>, String> {
        let command = prepared.command;
        #[cfg(windows)]
        let launch_gate = prepared.launch_gate;
        let pair = match native_pty_system().openpty(PtySize {
            rows: input.rows,
            cols: input.cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(error) => return Err(error.to_string()),
        };

        let child = match pair.slave.spawn_command(command) {
            Ok(child) => SpawnedChildGuard::new(child),
            Err(error) => return Err(error.to_string()),
        };
        drop(pair.slave);
        let pid = match child.child().process_id() {
            Some(pid) => pid,
            None => return Err("PTY child did not expose a process id".to_string()),
        };
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader();
        #[cfg(windows)]
        let job = {
            let raw_handle = match child.child().as_raw_handle() {
                Some(raw_handle) => raw_handle,
                None => return Err("PTY child did not expose a Windows process handle".to_owned()),
            };
            match WindowsJob::attach(raw_handle) {
                Ok(job) => job,
                Err(error) => return Err(error.to_string()),
            }
        };
        #[cfg(windows)]
        if let Err(error) = launch_gate.signal() {
            return Err(error.to_string());
        }
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => return Err(error.to_string()),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => return Err(error.to_string()),
        };
        #[cfg(not(windows))]
        let killer = child.child().clone_killer();
        let (output, _) = broadcast::channel(256);
        let (exit, _) = watch::channel(None);
        let (resize, resize_requests) = mpsc::sync_channel(1);

        let output_sender = output.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-output-{pid}"))
            .spawn(move || read_output(&mut reader, &output_sender))
        {
            return Err(error.to_string());
        }
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-resize-{pid}"))
            .spawn(move || {
                while let Ok(size) = resize_requests.recv() {
                    let _ = pair.master.resize(size);
                }
            })
        {
            return Err(error.to_string());
        }
        let exit_sender = exit.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-wait-{pid}"))
            .spawn(move || {
                #[cfg(windows)]
                let _launch_gate = launch_gate;
                let mut child = child.into_child();
                let event = match child.wait() {
                    Ok(status) => PtyExit {
                        exit_code: i32::try_from(status.exit_code()).ok(),
                        signal: None,
                    },
                    Err(_) => PtyExit {
                        exit_code: None,
                        signal: None,
                    },
                };
                let _ = exit_sender.send(Some(event));
            })
        {
            return Err(error.to_string());
        }

        Ok(Arc::new(PortablePtyProcess {
            pid,
            resize,
            writer: Mutex::new(writer),
            #[cfg(not(windows))]
            killer: Mutex::new(killer),
            output,
            exit,
            #[cfg(unix)]
            process_group,
            #[cfg(windows)]
            job,
        }))
    }
}

impl PtyBackend for PortablePtyBackend {
    fn spawn(&self, input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
        let prepared = build_pty_command(input)?;
        self.spawn_command(input, prepared)
    }
}

fn build_pty_command(input: &PtySpawnInput) -> Result<PreparedPtyCommand, String> {
    let platform = Platform::current();
    let executable = resolve_pty_executable_for_launch(platform, input)?;
    #[cfg(windows)]
    {
        let launch_gate = WindowsPtyLaunchGate::new().map_err(|error| error.to_string())?;
        let trampoline = std::env::current_exe().map_err(|error| {
            format!("failed to resolve the Windows PTY launch trampoline: {error}")
        })?;
        let target = prepare_pty_launch(platform, input, &executable)?;
        let launch = wrap_windows_pty_launch(
            target,
            &trampoline,
            launch_gate.name(),
            launch_gate.ready_name(),
        );
        let command = build_pty_command_from_launch(input, launch);
        return Ok(PreparedPtyCommand {
            command,
            launch_gate,
        });
    }
    #[cfg(not(windows))]
    let command = build_pty_command_from_launch(
        input,
        prepare_pty_launch(platform, input, &executable)?,
    );
    Ok(PreparedPtyCommand {
        command,
    })
}

#[cfg(test)]
fn build_pty_command_on(
    platform: Platform,
    input: &PtySpawnInput,
) -> Result<CommandBuilder, String> {
    let executable = resolve_pty_executable_for_launch(platform, input)?;
    Ok(build_pty_command_from_launch(
        input,
        prepare_pty_launch(platform, input, &executable)?,
    ))
}

#[cfg(any(test, windows))]
fn build_pty_command_on_with_trampoline(
    platform: Platform,
    input: &PtySpawnInput,
    trampoline: &Path,
    gate_name: &OsStr,
    ready_name: &OsStr,
) -> Result<CommandBuilder, String> {
    let executable = resolve_pty_executable_for_launch(platform, input)?;
    let target = prepare_pty_launch(platform, input, &executable)?;
    let launch = wrap_windows_pty_launch(target, trampoline, gate_name, ready_name);
    Ok(build_pty_command_from_launch(input, launch))
}

fn resolve_pty_executable_for_launch(
    platform: Platform,
    input: &PtySpawnInput,
) -> Result<PathBuf, String> {
    match
        resolve_pty_executable_on(platform, &input.executable, &input.cwd, &input.env)
    {
        Some(executable) => Ok(executable),
        None => Err(format!(
            "terminal executable was not found: {}",
            input.executable
        )),
    }
}

fn prepare_pty_launch(
    platform: Platform,
    input: &PtySpawnInput,
    executable: &Path,
) -> Result<crate::process::PreparedLaunch, String> {
    Ok(wrap_launch_program(platform, executable)?.prepare(&input.args))
}

fn build_pty_command_from_launch(
    input: &PtySpawnInput,
    launch: crate::process::PreparedLaunch,
) -> CommandBuilder {
    let mut command = CommandBuilder::new(launch.program);
    command.args(launch.args);
    command.cwd(&input.cwd);
    for (key, value) in &input.env {
        command.env(key, value);
    }
    command
}

fn resolve_pty_executable_on(
    platform: Platform,
    command: &str,
    cwd: &Path,
    overrides: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let path = overrides
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| env::var("PATH").ok());

    let path_extensions = if platform == Platform::Windows {
        overrides
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATHEXT"))
            .map(|(_, value)| value.clone())
            .or_else(|| env::var("PATHEXT").ok())
    } else {
        None
    };
    let extensions = launch_executable_extensions(platform, path_extensions.as_deref());

    locate_executable(
        command,
        Some(cwd),
        path.as_deref().map(OsStr::new),
        &extensions,
    )
}

fn read_output(reader: &mut dyn Read, sender: &broadcast::Sender<String>) {
    let mut buffer = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let _ = sender.send(text);
            }
        }
    }
}

struct PortablePtyProcess {
    pid: u32,
    resize: mpsc::SyncSender<PtySize>,
    writer: Mutex<Box<dyn Write + Send>>,
    #[cfg(not(windows))]
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    output: broadcast::Sender<String>,
    exit: watch::Sender<Option<PtyExit>>,
    #[cfg(unix)]
    process_group: Option<i32>,
    #[cfg(windows)]
    job: WindowsJob,
}

impl fmt::Debug for PortablePtyProcess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PortablePtyProcess")
            .field("pid", &self.pid)
            .finish()
    }
}

impl PtyProcess for PortablePtyProcess {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, data: &str) -> Result<(), String> {
        let mut writer = match self.writer.lock() {
            Ok(writer) => writer,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = writer.write_all(data.as_bytes()) {
            return Err(error.to_string());
        }
        match writer.flush() {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self.resize.try_send(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                Err("PTY resize worker is not available".to_string())
            }
        }
    }

    fn kill(&self) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(process_group) = self.process_group {
            // Negative PIDs target the complete process group created by the PTY.
            let result = unsafe { kill(-process_group, 9) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(3) {
                    return Err(error.to_string());
                }
            }
        }
        #[cfg(windows)]
        {
            if let Err(error) = self.job.terminate() {
                return Err(error.to_string());
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            self.killer
                .lock()
                .map_err(|error| error.to_string())?
                .kill()
                .map_err(|error| error.to_string())
        }
    }

    fn subscribe_output(&self) -> broadcast::Receiver<String> {
        self.output.subscribe()
    }

    fn subscribe_exit(&self) -> watch::Receiver<Option<PtyExit>> {
        self.exit.subscribe()
    }
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(windows))]
    use std::io::{Error, ErrorKind};
    #[cfg(not(windows))]
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::time::Duration;

    #[cfg(not(windows))]
    #[derive(Debug)]
    enum TestWriter {
        WriteError,
        FlushError,
    }

    #[cfg(not(windows))]
    impl Write for TestWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            match self {
                Self::WriteError => Err(Error::new(ErrorKind::BrokenPipe, "write failed")),
                Self::FlushError => Ok(buffer.len()),
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            match self {
                Self::WriteError => Ok(()),
                Self::FlushError => Err(Error::new(ErrorKind::BrokenPipe, "flush failed")),
            }
        }
    }

    #[cfg(not(windows))]
    #[derive(Clone, Debug)]
    struct TestKiller {
        fail: bool,
    }

    #[cfg(not(windows))]
    impl portable_pty::ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            if self.fail {
                Err(Error::new(ErrorKind::PermissionDenied, "kill failed"))
            } else {
                Ok(())
            }
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    #[derive(Clone, Debug)]
    struct SetupTestChild {
        killed: Arc<std::sync::atomic::AtomicBool>,
    }

    impl portable_pty::ChildKiller for SetupTestChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl portable_pty::Child for SetupTestChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(41)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn spawned_child_guard_kills_on_setup_failure_until_waiter_owns_child() {
        let failed_setup_killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = SpawnedChildGuard::new(Box::new(SetupTestChild {
            killed: failed_setup_killed.clone(),
        }));
        drop(guard);
        assert!(failed_setup_killed.load(std::sync::atomic::Ordering::Acquire));

        let committed_killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let child = SpawnedChildGuard::new(Box::new(SetupTestChild {
            killed: committed_killed.clone(),
        }))
        .into_child();
        drop(child);
        assert!(!committed_killed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn executable_discovery_handles_absolute_relative_and_overridden_paths() {
        let executable = std::env::current_exe().expect("current test executable");
        let command = executable
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .expect("test executable file name");
        let directory = executable.parent().expect("test executable directory");
        let overrides = BTreeMap::new();
        assert_eq!(
            resolve_pty_executable_on(
                Platform::current(),
                executable.to_str().expect("test executable path"),
                directory,
                &overrides,
            ),
            Some(executable.clone())
        );
        assert_eq!(
            resolve_pty_executable_on(
                Platform::current(),
                executable
                    .with_file_name("definitely-missing-t4code-shell")
                    .to_str()
                    .expect("missing executable path"),
                directory,
                &overrides,
            ),
            None
        );

        let mut isolated = BTreeMap::new();
        isolated.insert(
            "Path".to_owned(),
            std::env::join_paths([directory])
                .expect("test executable search path")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            resolve_pty_executable_on(Platform::current(), command, directory, &isolated),
            Some(executable.clone())
        );
        isolated.insert(
            "PATH".to_owned(),
            executable
                .parent()
                .expect("test executable directory")
                .join("definitely-missing-t4code-bin")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(
            resolve_pty_executable_on(Platform::current(), "t4code-shell", directory, &isolated,),
            None
        );
    }

    #[test]
    fn executable_discovery_honors_windows_pathext_for_bare_commands() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("claude.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        let mut environment = BTreeMap::new();
        environment.insert(
            "Path".to_owned(),
            std::env::join_paths([directory.path()])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        environment.insert("PATHEXT".to_owned(), ".COM;.EXE;.BAT;.CMD".to_owned());

        assert_eq!(
            resolve_pty_executable_on(Platform::Windows, "claude", directory.path(), &environment,),
            Some(executable)
        );
        assert_eq!(
            resolve_pty_executable_on(Platform::Unix, "claude", directory.path(), &environment,),
            None
        );
    }

    #[test]
    fn windows_executable_discovery_includes_powershell_shims_when_pathext_omits_them() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("claude.ps1");
        std::fs::write(&executable, b"fixture").unwrap();
        let environment = BTreeMap::from([
            (
                "Path".to_owned(),
                std::env::join_paths([directory.path()])
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
            ("PATHEXT".to_owned(), ".COM;.EXE;.BAT;.CMD".to_owned()),
        ]);

        assert_eq!(
            resolve_pty_executable_on(Platform::Windows, "claude", directory.path(), &environment),
            Some(executable)
        );
    }

    #[test]
    fn windows_pty_launch_wraps_cmd_and_bat_case_insensitively() {
        let directory = tempfile::tempdir().unwrap();
        let shim_directory = directory.path().join("provider ! shims");
        std::fs::create_dir(&shim_directory).unwrap();
        let trampoline = directory.path().join("t4code ! trampoline.exe");
        let gate_name = OsStr::new("Local\\T4CodeBatchLaunch-test");
        let ready_name = OsStr::new("Local\\T4CodeBatchLaunch-test-ready");
        let arguments = vec![
            "--flag".to_owned(),
            "value with spaces".to_owned(),
            "&literal".to_owned(),
            "%PATH%".to_owned(),
            "!literal!".to_owned(),
            String::new(),
        ];

        for extension in ["CmD", "bAt"] {
            let executable = shim_directory.join(format!("provider.{extension}"));
            std::fs::write(&executable, b"fixture").unwrap();
            let input = PtySpawnInput {
                executable: executable.to_string_lossy().into_owned(),
                args: arguments.clone(),
                cwd: directory.path().to_path_buf(),
                cols: 80,
                rows: 24,
                env: BTreeMap::from([
                    ("ComSpec".to_owned(), "user-command-processor".to_owned()),
                    (
                        "T4CODE_INTERNAL_BATCH_SCRIPT".to_owned(),
                        "user-controlled-value".to_owned(),
                    ),
                    (
                        "T4CODE_INTERNAL_BATCH_ARG_2".to_owned(),
                        "user-controlled-value".to_owned(),
                    ),
                ]),
            };

            let command = build_pty_command_on_with_trampoline(
                Platform::Windows,
                &input,
                &trampoline,
                gate_name,
                ready_name,
            )
            .unwrap();
            let expected = std::iter::once(trampoline.clone().into_os_string())
                .chain(
                    [
                        crate::process::WINDOWS_PTY_TRAMPOLINE_ARG,
                        gate_name.to_str().unwrap(),
                        ready_name.to_str().unwrap(),
                        executable.to_str().unwrap(),
                    ]
                    .map(std::ffi::OsString::from),
                )
                .chain(arguments.iter().map(std::ffi::OsString::from))
                .collect::<Vec<_>>();
            assert_eq!(command.get_argv(), &expected);
            assert_eq!(
                command.get_env("T4CODE_INTERNAL_BATCH_SCRIPT"),
                Some(std::ffi::OsStr::new("user-controlled-value"))
            );
            assert_eq!(
                command.get_env("T4CODE_INTERNAL_BATCH_ARG_2"),
                Some(std::ffi::OsStr::new("user-controlled-value"))
            );
            assert_eq!(
                command.get_env("ComSpec"),
                Some(std::ffi::OsStr::new("user-command-processor"))
            );
        }
    }

    #[test]
    fn windows_batch_launch_rejects_control_characters_in_the_script_path() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("provider\nshim.cmd");
        std::fs::write(&executable, b"fixture").unwrap();
        let input = PtySpawnInput {
            executable: executable.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        };

        let error = build_pty_command_on_with_trampoline(
            Platform::Windows,
            &input,
            &directory.path().join("t4code.exe"),
            OsStr::new("Local\\T4CodeBatchLaunch-test"),
            OsStr::new("Local\\T4CodeBatchLaunch-test-ready"),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Windows batch executable paths cannot contain control characters"
        );
    }

    #[test]
    fn windows_pty_launch_discovers_and_wraps_powershell_shims() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("provider.ps1");
        std::fs::write(&executable, b"fixture").unwrap();
        let trampoline = directory.path().join("t4code.exe");
        let gate_name = OsStr::new("Local\\T4CodePtyLaunch-test");
        let ready_name = OsStr::new("Local\\T4CodePtyLaunch-test-ready");
        let arguments = vec![
            "--flag".to_owned(),
            "value with spaces".to_owned(),
            "$literal".to_owned(),
            String::new(),
        ];
        let input = PtySpawnInput {
            executable: "provider".to_owned(),
            args: arguments.clone(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::from([
                (
                    "Path".to_owned(),
                    std::env::join_paths([directory.path()])
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                ),
                ("PATHEXT".to_owned(), ".COM;.EXE;.BAT;.CMD".to_owned()),
            ]),
        };

        let command = build_pty_command_on_with_trampoline(
            Platform::Windows,
            &input,
            &trampoline,
            gate_name,
            ready_name,
        )
        .unwrap();
        let expected = std::iter::once(trampoline.into_os_string())
            .chain(
                [
                    crate::process::WINDOWS_PTY_TRAMPOLINE_ARG,
                    gate_name.to_str().unwrap(),
                    ready_name.to_str().unwrap(),
                    "powershell.exe",
                ]
                .map(std::ffi::OsString::from),
            )
            .chain(
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]
                .map(std::ffi::OsString::from),
            )
            .chain(std::iter::once(executable.into_os_string()))
            .chain(arguments.iter().map(std::ffi::OsString::from))
            .collect::<Vec<_>>();
        assert_eq!(command.get_argv(), &expected);
    }

    #[test]
    fn windows_pty_launch_gates_native_executables() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("provider.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        let trampoline = directory.path().join("t4code.exe");
        let gate_name = OsStr::new("Local\\T4CodePtyLaunch-test");
        let ready_name = OsStr::new("Local\\T4CodePtyLaunch-test-ready");
        let arguments = vec!["--flag".to_owned(), "value with spaces".to_owned()];
        let input = PtySpawnInput {
            executable: executable.to_string_lossy().into_owned(),
            args: arguments.clone(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        };

        let command = build_pty_command_on_with_trampoline(
            Platform::Windows,
            &input,
            &trampoline,
            gate_name,
            ready_name,
        )
        .unwrap();
        let expected = std::iter::once(trampoline.into_os_string())
            .chain(
                [
                    crate::process::WINDOWS_PTY_TRAMPOLINE_ARG,
                    gate_name.to_str().unwrap(),
                    ready_name.to_str().unwrap(),
                    executable.to_str().unwrap(),
                ]
                .map(std::ffi::OsString::from),
            )
            .chain(arguments.iter().map(std::ffi::OsString::from))
            .collect::<Vec<_>>();
        assert_eq!(command.get_argv(), &expected);
    }

    #[test]
    fn pty_launch_resolves_a_multi_component_executable_to_the_exact_cwd_path() {
        let cwd = tempfile::tempdir().unwrap();
        let bin = cwd.path().join("tools");
        std::fs::create_dir(&bin).unwrap();
        let executable = bin.join("provider-fixture");
        std::fs::write(&executable, b"fixture").unwrap();
        let input = PtySpawnInput {
            executable: "tools/provider-fixture".to_owned(),
            args: vec!["--direct".to_owned()],
            cwd: cwd.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        };

        let command = build_pty_command_on(Platform::Unix, &input).unwrap();
        assert_eq!(
            command.get_argv(),
            &[
                executable.into_os_string(),
                std::ffi::OsString::from("--direct"),
            ]
        );
    }

    #[test]
    fn executable_resolution_anchors_relative_path_entries_to_the_terminal_cwd() {
        let cwd = tempfile::tempdir().unwrap();
        let bin = cwd.path().join("relative-bin");
        std::fs::create_dir(&bin).unwrap();
        let executable = bin.join("provider-fixture");
        std::fs::write(&executable, b"fixture").unwrap();
        let mut environment = BTreeMap::new();
        environment.insert("PATH".to_owned(), "relative-bin".to_owned());

        assert_eq!(
            resolve_pty_executable_on(Platform::Unix, "provider-fixture", cwd.path(), &environment,),
            Some(executable)
        );
    }

    #[test]
    fn platform_resolution_rejects_missing_candidates() {
        let directory = tempfile::tempdir().unwrap();
        let environment = BTreeMap::from([(
            "PATH".to_owned(),
            directory.path().to_string_lossy().into_owned(),
        )]);

        assert_eq!(
            resolve_pty_executable_on(
                Platform::Windows,
                "missing-provider",
                directory.path(),
                &environment,
            ),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn portable_backend_discovers_a_relative_executable_from_the_terminal_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let cwd = tempfile::tempdir().unwrap();
        let executable = cwd.path().join("provider-fixture");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let process = PortablePtyBackend
            .spawn(&PtySpawnInput {
                executable: "./provider-fixture".to_owned(),
                args: Vec::new(),
                cwd: cwd.path().to_path_buf(),
                cols: 80,
                rows: 24,
                env: BTreeMap::new(),
            })
            .unwrap();
        assert!(process.pid() > 0);
    }

    #[tokio::test]
    async fn portable_backend_streams_input_output_resize_and_exit() {
        let (executable, args, input, output_marker) = if cfg!(windows) {
            (
                "cmd.exe".to_owned(),
                vec!["/D".to_owned(), "/Q".to_owned()],
                "echo ready\r\necho got:hello from test\r\nexit /b 7\r\n",
                "got:hello from test",
            )
        } else {
            (
                "/bin/sh".to_owned(),
                vec![
                    "-c".to_owned(),
                    "printf 'ready\\n'; IFS= read -r line; printf 'got:%s\\n' \"$line\"; exit 7"
                        .to_owned(),
                ],
                "hello from test\n",
                "got:hello from test",
            )
        };
        let event_timeout = Duration::from_secs(if cfg!(windows) { 10 } else { 3 });
        let backend = PortablePtyBackend;
        let process = backend
            .spawn(&PtySpawnInput {
                executable,
                args,
                cwd: std::env::temp_dir(),
                cols: 80,
                rows: 24,
                env: BTreeMap::new(),
            })
            .unwrap();
        assert!(process.pid() > 0);
        assert!(format!("{process:?}").contains("PortablePtyProcess"));

        let mut output = process.subscribe_output();
        let mut exit = process.subscribe_exit();
        process.resize(100, 40).unwrap();
        process.resize(120, 50).unwrap();
        if cfg!(windows) {
            process.write("\u{1b}[1;1R").unwrap();
        }
        process.write(input).unwrap();

        let text = tokio::time::timeout(event_timeout, async {
            let mut text = String::new();
            while !text.contains(output_marker) {
                text.push_str(&output.recv().await.unwrap());
            }
            text
        })
        .await
        .unwrap();
        assert!(text.contains("ready"));

        tokio::time::timeout(event_timeout, exit.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            *exit.borrow(),
            Some(PtyExit {
                exit_code: Some(7),
                signal: None,
            })
        );
    }

    #[tokio::test]
    async fn portable_backend_kills_a_live_process_group() {
        let (executable, args) = if cfg!(windows) {
            (
                "powershell.exe".to_owned(),
                vec![
                    "-NoLogo".to_owned(),
                    "-NoProfile".to_owned(),
                    "-Command".to_owned(),
                    "Start-Sleep -Seconds 30".to_owned(),
                ],
            )
        } else {
            (
                "/bin/sh".to_owned(),
                vec!["-c".to_owned(), "sleep 30".to_owned()],
            )
        };
        let process = PortablePtyBackend
            .spawn(&PtySpawnInput {
                executable,
                args,
                cwd: std::env::temp_dir(),
                cols: 80,
                rows: 24,
                env: BTreeMap::new(),
            })
            .unwrap();
        let mut exit = process.subscribe_exit();

        process.kill().unwrap();
        tokio::time::timeout(Duration::from_secs(3), exit.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(exit.borrow().is_some());
    }

    #[test]
    fn portable_backend_rejects_a_missing_executable_before_opening_a_pty() {
        let error = PortablePtyBackend
            .spawn(&PtySpawnInput {
                executable: "/definitely/missing/t4code-shell".to_owned(),
                args: Vec::new(),
                cwd: std::env::temp_dir(),
                cols: 80,
                rows: 24,
                env: BTreeMap::new(),
            })
            .unwrap_err();
        assert!(error.contains("terminal executable was not found"));
    }

    #[cfg(not(windows))]
    #[test]
    fn portable_process_reports_writer_resize_and_killer_failures() {
        let (resize, resize_requests) = mpsc::sync_channel(1);
        let (output, _) = broadcast::channel(1);
        let (exit, _) = watch::channel(None);
        let process = PortablePtyProcess {
            pid: 42,
            resize,
            writer: Mutex::new(Box::new(TestWriter::WriteError)),
            killer: Mutex::new(Box::new(TestKiller { fail: true })),
            output,
            exit,
            #[cfg(unix)]
            process_group: None,
        };

        assert!(process.write("data").unwrap_err().contains("write failed"));
        *process.writer.lock().unwrap() = Box::new(TestWriter::FlushError);
        assert!(process.write("data").unwrap_err().contains("flush failed"));

        process.resize(80, 24).unwrap();
        process.resize(100, 40).unwrap();
        drop(resize_requests);
        assert_eq!(
            process.resize(120, 50).unwrap_err(),
            "PTY resize worker is not available"
        );

        assert!(process.kill().unwrap_err().contains("kill failed"));
        let mut cloned_killer = process.killer.lock().unwrap().clone_killer();
        assert!(
            cloned_killer
                .kill()
                .unwrap_err()
                .to_string()
                .contains("kill failed")
        );
        *process.killer.lock().unwrap() = Box::new(TestKiller { fail: false });
        process.kill().unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn portable_process_reports_poisoned_writer_and_killer_locks() {
        let (resize, _resize_requests) = mpsc::sync_channel(1);
        let (output, _) = broadcast::channel(1);
        let (exit, _) = watch::channel(None);
        let process = PortablePtyProcess {
            pid: 43,
            resize,
            writer: Mutex::new(Box::new(TestWriter::FlushError)),
            killer: Mutex::new(Box::new(TestKiller { fail: false })),
            output,
            exit,
            #[cfg(unix)]
            process_group: None,
        };

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = process.writer.lock().unwrap();
            panic!("poison writer");
        }));
        assert!(process.write("data").unwrap_err().contains("poisoned lock"));

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = process.killer.lock().unwrap();
            panic!("poison killer");
        }));
        assert!(process.kill().unwrap_err().contains("poisoned lock"));
    }
}
