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

use crate::diagnostics::{NativeProcessSampler, ProcessIdentity};
use crate::process::{
    Platform, launch_executable_extensions, locate_executable, wrap_launch_program,
    wrap_windows_batch_command,
};

#[cfg(windows)]
use crate::process::WindowsJob;

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
    fn process_identity(&self) -> Option<ProcessIdentity> {
        None
    }
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
    job: WindowsJob,
}

struct SpawnedChildGuard {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    root_killer: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    #[cfg(unix)]
    root_process_id: Option<i32>,
    #[cfg(unix)]
    process_group: Option<i32>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
    #[cfg(test)]
    tree_cleanup_observer: Option<Box<dyn FnOnce() + Send>>,
}

impl SpawnedChildGuard {
    #[cfg(any(not(unix), test))]
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self {
            child: Some(child),
            root_killer: None,
            #[cfg(unix)]
            root_process_id: None,
            #[cfg(unix)]
            process_group: None,
            #[cfg(windows)]
            job: None,
            #[cfg(test)]
            tree_cleanup_observer: None,
        }
    }

    #[cfg(unix)]
    fn new_with_process_group(
        child: Box<dyn portable_pty::Child + Send + Sync>,
        process_group: Option<i32>,
    ) -> Self {
        Self {
            child: Some(child),
            root_killer: None,
            root_process_id: None,
            process_group,
            #[cfg(test)]
            tree_cleanup_observer: None,
        }
    }

    fn child(&self) -> &(dyn portable_pty::Child + Send + Sync) {
        self.child.as_deref().expect("spawned child guard")
    }

    fn child_mut(&mut self) -> &mut (dyn portable_pty::Child + Send + Sync) {
        self.child.as_deref_mut().expect("spawned child guard")
    }

    fn handoff_child_to_waiter(&mut self) -> Box<dyn portable_pty::Child + Send + Sync> {
        let root_killer = self.child().clone_killer();
        let child = self.child.take().expect("spawned child guard");
        self.root_killer = Some(root_killer);
        child
    }

    #[cfg(unix)]
    fn remember_root_process_id(&mut self, process_id: u32) -> Result<(), String> {
        let process_id = i32::try_from(process_id)
            .map_err(|_| "PTY child process id exceeded the Unix PID range".to_owned())?;
        self.root_process_id = Some(process_id);
        Ok(())
    }

    #[cfg(test)]
    fn observe_tree_cleanup(&mut self, observer: impl FnOnce() + Send + 'static) {
        self.tree_cleanup_observer = Some(Box::new(observer));
    }

    #[cfg(unix)]
    fn commit_process_group(mut self) -> Option<i32> {
        self.root_killer.take();
        self.root_process_id.take();
        self.process_group.take()
    }

    #[cfg(windows)]
    fn own_job(&mut self, job: WindowsJob) {
        debug_assert!(self.job.is_none(), "PTY child job already attached");
        self.job = Some(job);
    }

    #[cfg(windows)]
    fn commit_job(mut self) -> Result<WindowsJob, String> {
        let job = self
            .job
            .take()
            .ok_or_else(|| "PTY child job was not retained during setup".to_owned())?;
        self.root_killer.take();
        Ok(job)
    }
}

type PtyThreadTask = Box<dyn FnOnce() + Send + 'static>;

fn spawn_pty_thread_with(
    name: String,
    task: PtyThreadTask,
    spawn: impl FnOnce(thread::Builder, PtyThreadTask) -> std::io::Result<thread::JoinHandle<()>>,
) -> std::io::Result<()> {
    spawn(thread::Builder::new().name(name), task).map(drop)
}

fn spawn_pty_thread(name: String, task: PtyThreadTask) -> std::io::Result<()> {
    spawn_pty_thread_with(name, task, |builder, task| builder.spawn(task))
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(process_group) = self.process_group
            && let Err(error) = kill_unix_process_group(process_group)
        {
            tracing::debug!(%error, process_group, "failed to kill PTY process group after spawn setup failure");
        }
        #[cfg(windows)]
        if let Some(job) = self.job.as_ref()
            && let Err(error) = job.terminate()
        {
            tracing::debug!(%error, "failed to kill PTY job after spawn setup failure");
        }
        #[cfg(test)]
        if let Some(observer) = self.tree_cleanup_observer.take() {
            observer();
        }
        if let Some(child) = self.child.as_mut() {
            if let Err(error) = child.kill() {
                tracing::debug!(%error, "failed to kill PTY child after spawn setup failure");
            }
            return;
        }
        #[cfg(unix)]
        let root_killed = self.root_process_id.is_some_and(|process_id| {
            if let Err(error) = kill_unix_process(process_id) {
                tracing::debug!(%error, process_id, "failed to SIGKILL PTY root after waiter spawn failure");
                false
            } else {
                true
            }
        });
        #[cfg(not(unix))]
        let root_killed = false;
        if !root_killed
            && let Some(root_killer) = self.root_killer.as_mut()
            && let Err(error) = root_killer.kill()
        {
            tracing::debug!(%error, "failed to kill PTY root after waiter spawn failure");
        }
    }
}

impl PortablePtyBackend {
    fn spawn_command(
        &self,
        input: &PtySpawnInput,
        prepared: PreparedPtyCommand,
    ) -> Result<Arc<dyn PtyProcess>, String> {
        let command = prepared.command;
        #[cfg(windows)]
        let job = prepared.job;
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
            Ok(child) => child,
            Err(error) => return Err(error.to_string()),
        };
        #[cfg(unix)]
        let mut child =
            SpawnedChildGuard::new_with_process_group(child, pair.master.process_group_leader());
        #[cfg(not(unix))]
        let mut child = SpawnedChildGuard::new(child);
        #[cfg(windows)]
        child.own_job(job);
        drop(pair.slave);
        let pid = match child.child().process_id() {
            Some(pid) => pid,
            None => return Err("PTY child did not expose a process id".to_string()),
        };
        let process_identity = retain_captured_identity_if_child_live(
            child.child_mut(),
            NativeProcessSampler::process_identity(pid).ok(),
        );
        #[cfg(unix)]
        child.remember_root_process_id(pid)?;
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
        let wait_child = child.handoff_child_to_waiter();
        spawn_pty_thread(
            format!("t4code-pty-wait-{pid}"),
            Box::new(move || {
                let mut child = wait_child;
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
            }),
        )
        .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        let process_group = child.commit_process_group();
        #[cfg(windows)]
        let job = child.commit_job()?;

        Ok(Arc::new(PortablePtyProcess {
            pid,
            process_identity,
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
    let mut command =
        build_pty_command_from_launch(input, prepare_pty_launch(platform, input, &executable)?);
    #[cfg(windows)]
    {
        let job = WindowsJob::new().map_err(|error| error.to_string())?;
        command.job_list(&[job.raw_handle()]);
        return Ok(PreparedPtyCommand { command, job });
    }
    #[cfg(not(windows))]
    {
        Ok(PreparedPtyCommand { command })
    }
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

fn resolve_pty_executable_for_launch(
    platform: Platform,
    input: &PtySpawnInput,
) -> Result<PathBuf, String> {
    match resolve_pty_executable_on(platform, &input.executable, &input.cwd, &input.env) {
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
    let target = wrap_launch_program(platform, executable)?.prepare(&input.args);
    wrap_windows_batch_command(platform, target, &input.env)
}

fn build_pty_command_from_launch(
    input: &PtySpawnInput,
    launch: crate::process::PreparedLaunch,
) -> CommandBuilder {
    let mut command = CommandBuilder::new(launch.program);
    command.args(launch.args);
    #[cfg(windows)]
    if let Some(raw_windows_args) = launch.raw_windows_args {
        command.raw_windows_args(raw_windows_args);
    }
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

fn retain_captured_identity_if_child_live(
    child: &mut (dyn portable_pty::Child + Send + Sync),
    captured: Option<ProcessIdentity>,
) -> Option<ProcessIdentity> {
    captured.filter(|_| matches!(child.try_wait(), Ok(None)))
}

struct PortablePtyProcess {
    pid: u32,
    process_identity: Option<ProcessIdentity>,
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

    fn process_identity(&self) -> Option<ProcessIdentity> {
        self.process_identity
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
            kill_unix_process_group(process_group).map_err(|error| error.to_string())?;
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

#[cfg(all(test, unix))]
unsafe extern "C" {
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

#[cfg(unix)]
fn kill_unix_process_group(process_group: i32) -> std::io::Result<()> {
    // Negative PIDs target the complete process group created by the PTY.
    kill_unix_target(-process_group)
}

#[cfg(unix)]
fn kill_unix_process(process_id: i32) -> std::io::Result<()> {
    kill_unix_target(process_id)
}

#[cfg(unix)]
fn kill_unix_target(target: i32) -> std::io::Result<()> {
    let result = unsafe { kill(target, 9) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(3) {
        Ok(())
    } else {
        Err(error)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    #[cfg(not(windows))]
    use std::io::{Error, ErrorKind};
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::time::Duration;

    #[derive(Clone, Debug)]
    struct FinishedPortableChild;

    impl portable_pty::ChildKiller for FinishedPortableChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl portable_pty::Child for FinishedPortableChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(Some(portable_pty::ExitStatus::with_exit_code(17)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(17))
        }

        fn process_id(&self) -> Option<u32> {
            Some(42)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn finished_pty_child_does_not_expose_a_captured_process_identity() {
        let mut child = FinishedPortableChild;
        let captured = ProcessIdentity {
            pid: 42,
            started_at: 100,
        };

        assert_eq!(
            retain_captured_identity_if_child_live(&mut child, Some(captured)),
            None
        );
    }

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
        panic_on_clone: bool,
    }

    impl portable_pty::ChildKiller for SetupTestChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            assert!(!self.panic_on_clone, "injected child killer clone failure");
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

    #[derive(Clone, Debug)]
    struct OrderedSetupTestChild {
        cleanup_order: Arc<Mutex<Vec<&'static str>>>,
    }

    impl portable_pty::ChildKiller for OrderedSetupTestChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.cleanup_order.lock().unwrap().push("root");
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl portable_pty::Child for OrderedSetupTestChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(42)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn spawned_child_guard_kills_on_setup_failure_until_process_ownership_commits() {
        let failed_setup_killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = SpawnedChildGuard::new(Box::new(SetupTestChild {
            killed: failed_setup_killed.clone(),
            panic_on_clone: false,
        }));
        drop(guard);
        assert!(failed_setup_killed.load(std::sync::atomic::Ordering::Acquire));

        #[cfg(unix)]
        {
            let committed_killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut guard = SpawnedChildGuard::new(Box::new(SetupTestChild {
                killed: committed_killed.clone(),
                panic_on_clone: false,
            }));
            let child = guard.handoff_child_to_waiter();
            let process_group = guard.commit_process_group();
            drop(child);
            assert!(process_group.is_none());
            assert!(!committed_killed.load(std::sync::atomic::Ordering::Acquire));
        }
    }

    #[test]
    fn waiter_spawn_failure_keeps_the_root_child_fallback() {
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut guard = SpawnedChildGuard::new(Box::new(SetupTestChild {
            killed: killed.clone(),
            panic_on_clone: false,
        }));
        let handoff = guard.handoff_child_to_waiter();

        let error = spawn_pty_thread_with(
            "injected-waiter-spawn-failure".to_owned(),
            Box::new(move || drop(handoff)),
            |_builder, _task| Err(std::io::Error::other("injected waiter spawn failure")),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), "injected waiter spawn failure");
        assert!(
            !killed.load(std::sync::atomic::Ordering::Acquire),
            "root cleanup must remain with the tree-owning setup guard"
        );
        drop(guard);
        assert!(killed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn child_killer_clone_panic_keeps_the_root_in_the_setup_guard() {
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = catch_unwind(AssertUnwindSafe({
            let killed = killed.clone();
            move || {
                let mut guard = SpawnedChildGuard::new(Box::new(SetupTestChild {
                    killed,
                    panic_on_clone: true,
                }));
                let _child = guard.handoff_child_to_waiter();
            }
        }));

        assert!(result.is_err());
        assert!(killed.load(std::sync::atomic::Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn waiter_spawn_failure_sigkills_a_hup_resistant_root_without_a_process_group() {
        let directory = tempfile::tempdir().unwrap();
        let ready_file = directory.path().join("root-ready.txt");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "trap '' HUP; echo ready > \"$T4CODE_ROOT_READY\"; exec sleep 30",
        ]);
        command.env("T4CODE_ROOT_READY", ready_file.as_os_str());
        let child = pair.slave.spawn_command(command).unwrap();
        let root_pid = child.process_id().unwrap();
        let root_pid_i32 = i32::try_from(root_pid).unwrap();
        let mut guard = SpawnedChildGuard::new_with_process_group(child, None);
        guard.remember_root_process_id(root_pid).unwrap();
        drop(pair.slave);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready_file.is_file() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture root did not publish readiness"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let child = guard.handoff_child_to_waiter();
        spawn_pty_thread_with(
            "injected-hup-resistant-waiter-spawn-failure".to_owned(),
            Box::new(move || drop(child)),
            |_builder, _task| Err(std::io::Error::other("injected waiter spawn failure")),
        )
        .unwrap_err();

        // SAFETY: signal zero only checks whether the fixture root still exists.
        assert_eq!(unsafe { kill(root_pid_i32, 0) }, 0);
        drop(guard);

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut status = 0;
        loop {
            // SAFETY: the fixture root is a direct child of this test process;
            // WNOHANG observes and reaps it only after termination.
            let result = unsafe { waitpid(root_pid_i32, &raw mut status, 1) };
            if result == root_pid_i32 {
                break;
            }
            if std::time::Instant::now() >= deadline {
                // SAFETY: the PID came from this test's fixture root.
                unsafe { kill(root_pid_i32, 9) };
                panic!("HUP-resistant PTY root survived waiter spawn failure");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn waiter_spawn_failure_terminates_the_tree_before_the_root() {
        let cleanup_order = Arc::new(Mutex::new(Vec::new()));
        let mut guard = SpawnedChildGuard::new(Box::new(OrderedSetupTestChild {
            cleanup_order: cleanup_order.clone(),
        }));
        guard.observe_tree_cleanup({
            let cleanup_order = cleanup_order.clone();
            move || cleanup_order.lock().unwrap().push("tree")
        });
        let child = guard.handoff_child_to_waiter();

        spawn_pty_thread_with(
            "injected-ordered-waiter-spawn-failure".to_owned(),
            Box::new(move || drop(child)),
            |_builder, _task| Err(std::io::Error::other("injected waiter spawn failure")),
        )
        .unwrap_err();

        assert!(cleanup_order.lock().unwrap().is_empty());
        drop(guard);
        assert_eq!(*cleanup_order.lock().unwrap(), ["tree", "root"]);
    }

    #[cfg(unix)]
    #[test]
    fn setup_failure_kills_the_unix_process_group() {
        let directory = tempfile::tempdir().unwrap();
        let child_pid_file = directory.path().join("descendant-pid.txt");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > \"$T4CODE_CHILD_PID\"; exec sleep 30' & wait",
        ]);
        command.env("T4CODE_CHILD_PID", child_pid_file.as_os_str());
        let child = pair.slave.spawn_command(command).unwrap();
        let process_group = pair
            .master
            .process_group_leader()
            .expect("fixture PTY should expose its process group");
        let guard = SpawnedChildGuard::new_with_process_group(child, Some(process_group));

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !child_pid_file.is_file() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture descendant did not publish its process id"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let descendant_pid = std::fs::read_to_string(&child_pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_ne!(descendant_pid, process_group);

        drop(guard);

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            // SAFETY: signal zero only checks whether the fixture PID still exists.
            let result = unsafe { kill(descendant_pid, 0) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(3) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                // SAFETY: the PID came from this test's fixture descendant.
                unsafe { kill(descendant_pid, 9) };
                panic!("PTY descendant survived post-spawn setup failure");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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

            let command = build_pty_command_on(Platform::Windows, &input).unwrap();
            let raw_arguments = format!(
                "/e:ON /v:OFF /d /c \"\"{}\" --flag \"value with spaces\" \"&literal\" \"%%cd:~,%%PATH%%cd:~,%%\" \"!literal!\" \"\"\"",
                executable.display()
            );
            let expected = vec![
                OsString::from("user-command-processor"),
                OsString::from(raw_arguments),
            ];
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

        let error = build_pty_command_on(Platform::Windows, &input).unwrap_err();

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

        let command = build_pty_command_on(Platform::Windows, &input).unwrap();
        let expected = std::iter::once(OsString::from("powershell.exe"))
            .chain(
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]
                .map(OsString::from),
            )
            .chain(std::iter::once(executable.into_os_string()))
            .chain(arguments.iter().map(OsString::from))
            .collect::<Vec<_>>();
        assert_eq!(command.get_argv(), &expected);
    }

    #[test]
    fn windows_pty_launches_native_executables_directly() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("provider.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        let arguments = vec!["--flag".to_owned(), "value with spaces".to_owned()];
        let input = PtySpawnInput {
            executable: executable.to_string_lossy().into_owned(),
            args: arguments.clone(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        };

        let command = build_pty_command_on(Platform::Windows, &input).unwrap();
        let expected = std::iter::once(executable.into_os_string())
            .chain(arguments.iter().map(OsString::from))
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
            process_identity: None,
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
            process_identity: None,
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
