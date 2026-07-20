use std::{
    collections::BTreeMap,
    env, fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::sync::{broadcast, watch};

#[cfg(windows)]
use crate::process::WindowsJob;

const PTY_CLEANUP_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const PTY_CLEANUP_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct PtySpawnInput {
    pub shell: String,
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

impl PtyBackend for PortablePtyBackend {
    fn spawn(&self, input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
        if !executable_is_discoverable(&input.shell, &input.env) {
            return Err(format!("shell executable was not found: {}", input.shell));
        }
        let pair = match native_pty_system().openpty(PtySize {
            rows: input.rows,
            cols: input.cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(error) => return Err(error.to_string()),
        };
        let mut command = CommandBuilder::new(&input.shell);
        command.args(&input.args);
        command.cwd(&input.cwd);
        for (key, value) in &input.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        let job = WindowsJob::new().map_err(|error| error.to_string())?;
        #[cfg(windows)]
        command.job_list(&[job.raw_handle()]);

        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => return Err(error.to_string()),
        };
        drop(pair.slave);
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader();
        macro_rules! fail_initialization {
            ($error:expr) => {{
                let error = $error.to_string();
                #[cfg(windows)]
                cleanup_failed_pty_initialization(&mut *child, &job, &error);
                #[cfg(unix)]
                cleanup_failed_pty_initialization(&mut *child, process_group, &error);
                #[cfg(not(any(unix, windows)))]
                cleanup_failed_pty_initialization(&mut *child, &error);
                return Err(error);
            }};
        }
        let pid = match child.process_id() {
            Some(pid) => pid,
            None => fail_initialization!("PTY child did not expose a process id"),
        };
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => fail_initialization!(error),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => fail_initialization!(error),
        };
        #[cfg(not(windows))]
        let killer = child.clone_killer();
        let (output, _) = broadcast::channel(256);
        let (exit, _) = watch::channel(None);
        let (resize, resize_requests) = mpsc::sync_channel(1);

        let output_sender = output.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-output-{pid}"))
            .spawn(move || read_output(&mut reader, &output_sender))
        {
            fail_initialization!(error);
        }
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-resize-{pid}"))
            .spawn(move || {
                while let Ok(size) = resize_requests.recv() {
                    let _ = pair.master.resize(size);
                }
            })
        {
            fail_initialization!(error);
        }
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let wait_child_slot = Arc::clone(&child_slot);
        let exit_sender = exit.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("t4code-pty-wait-{pid}"))
            .spawn(move || {
                let Some(mut child) = wait_child_slot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                else {
                    return;
                };
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
            child = child_slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
                .expect("failed wait-worker spawn must retain the PTY child");
            fail_initialization!(error);
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

#[cfg(windows)]
fn cleanup_failed_pty_initialization(
    child: &mut dyn portable_pty::Child,
    job: &WindowsJob,
    primary_error: &str,
) -> crate::process::ProcessCleanupReport {
    let mut report = crate::process::ProcessCleanupReport::default();
    match job.terminate() {
        Ok(()) => report.record_success(),
        Err(error) => report.record_failure(format!("terminate job: {error}")),
    }
    terminate_and_wait_for_pty_child(child, &mut report);
    log_failed_pty_initialization(primary_error, &report);
    report
}

#[cfg(unix)]
fn cleanup_failed_pty_initialization(
    child: &mut dyn portable_pty::Child,
    process_group: Option<i32>,
    primary_error: &str,
) -> crate::process::ProcessCleanupReport {
    let mut report = crate::process::ProcessCleanupReport::default();
    if let Some(process_group) = process_group {
        // SAFETY: a negative process-group leader targets the complete PTY
        // process group, and signal 9 does not borrow any memory.
        let result = unsafe { kill(-process_group, 9) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(3) {
            report.record_success();
        } else {
            report.record_failure(format!(
                "kill process group: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    terminate_and_wait_for_pty_child(child, &mut report);
    log_failed_pty_initialization(primary_error, &report);
    report
}

#[cfg(not(any(unix, windows)))]
fn cleanup_failed_pty_initialization(
    child: &mut dyn portable_pty::Child,
    primary_error: &str,
) -> crate::process::ProcessCleanupReport {
    let mut report = crate::process::ProcessCleanupReport::default();
    terminate_and_wait_for_pty_child(child, &mut report);
    log_failed_pty_initialization(primary_error, &report);
    report
}

fn terminate_and_wait_for_pty_child(
    child: &mut dyn portable_pty::Child,
    report: &mut crate::process::ProcessCleanupReport,
) {
    match child.kill() {
        Ok(()) => report.record_success(),
        Err(error) => report.record_failure(format!("kill child: {error}")),
    }
    let deadline = Instant::now() + PTY_CLEANUP_WAIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                report.record_success();
                break;
            }
            Ok(None) => {
                let now = Instant::now();
                if now >= deadline {
                    report.record_failure(format!(
                        "wait child timed out after {} ms",
                        PTY_CLEANUP_WAIT_TIMEOUT.as_millis()
                    ));
                    break;
                }
                thread::sleep(
                    PTY_CLEANUP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)),
                );
            }
            Err(error) => {
                report.record_failure(format!("wait child: {error}"));
                break;
            }
        }
    }
}

fn log_failed_pty_initialization(
    primary_error: &str,
    report: &crate::process::ProcessCleanupReport,
) {
    if report.failure_count > 0 {
        tracing::warn!(
            primary_error = %crate::process::bound_process_cleanup_failure(primary_error),
            attempted = report.attempted,
            succeeded = report.succeeded,
            failure_count = report.failure_count,
            failures = ?report.failures,
            "PTY initialization failed and cleanup was incomplete"
        );
    }
}

fn executable_is_discoverable(command: &str, overrides: &BTreeMap<String, String>) -> bool {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command_path.components().count() > 1 {
        return command_path.is_file();
    }

    let path = overrides
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| env::var("PATH").ok());
    let Some(path) = path else {
        return false;
    };

    env::split_paths(&path).any(|directory| directory.join(command_path).is_file())
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
    #[cfg(windows)]
    use std::ffi::OsStr;
    #[cfg(windows)]
    use std::fs;
    #[cfg(not(windows))]
    use std::io::{Error, ErrorKind};
    #[cfg(windows)]
    use std::os::windows::ffi::OsStrExt;
    #[cfg(not(windows))]
    use std::panic::{AssertUnwindSafe, catch_unwind};
    #[cfg(windows)]
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[cfg(windows)]
    const JOB_PROBE_NAME_ENV: &str = "T4CODE_PTY_JOB_PROBE_NAME";
    #[cfg(windows)]
    const JOB_PROBE_RESULT_ENV: &str = "T4CODE_PTY_JOB_PROBE_RESULT";
    #[cfg(windows)]
    const PTY_TREE_ROLE_ENV: &str = "T4CODE_PTY_TREE_ROLE";
    #[cfg(windows)]
    const PTY_TREE_ROOT_READY_ENV: &str = "T4CODE_PTY_TREE_ROOT_READY";
    #[cfg(windows)]
    const PTY_TREE_CHILD_READY_ENV: &str = "T4CODE_PTY_TREE_CHILD_READY";
    #[cfg(windows)]
    const PTY_TREE_GRANDCHILD_READY_ENV: &str = "T4CODE_PTY_TREE_GRANDCHILD_READY";
    #[cfg(windows)]
    const PTY_TREE_ROOT_SURVIVED_ENV: &str = "T4CODE_PTY_TREE_ROOT_SURVIVED";
    #[cfg(windows)]
    const PTY_TREE_CHILD_SURVIVED_ENV: &str = "T4CODE_PTY_TREE_CHILD_SURVIVED";
    #[cfg(windows)]
    const PTY_TREE_GRANDCHILD_SURVIVED_ENV: &str = "T4CODE_PTY_TREE_GRANDCHILD_SURVIVED";
    #[cfg(windows)]
    const PTY_TREE_RELEASE_ENV: &str = "T4CODE_PTY_TREE_RELEASE";

    #[cfg(windows)]
    #[test]
    fn windows_job_membership_probe() {
        let Some(name) = std::env::var_os(JOB_PROBE_NAME_ENV) else {
            return;
        };
        let result =
            PathBuf::from(std::env::var_os(JOB_PROBE_RESULT_ENV).expect("job probe result path"));
        let mut name = OsStr::new(&name).encode_wide().collect::<Vec<_>>();
        name.push(0);
        // SAFETY: the name is a valid NUL-terminated UTF-16 string. The
        // returned handle is closed below.
        let job = unsafe {
            windows_sys::Win32::System::JobObjects::OpenJobObjectW(
                0x0004, // JOB_OBJECT_QUERY
                0,
                name.as_ptr(),
            )
        };
        assert!(!job.is_null(), "named job should be openable");
        let mut is_member = 0;
        // SAFETY: all handles are live and `is_member` is writable storage for
        // the BOOL result.
        let checked = unsafe {
            windows_sys::Win32::System::JobObjects::IsProcessInJob(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                job,
                &mut is_member,
            )
        };
        // SAFETY: `job` is the owned handle opened above.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        assert_ne!(checked, 0, "job membership query should succeed");
        fs::write(result, if is_member != 0 { "member" } else { "outside" })
            .expect("write job membership result");
    }

    #[cfg(windows)]
    #[test]
    fn conpty_child_is_in_the_supplied_job_when_application_code_starts() {
        let temp = tempfile::tempdir().expect("job membership fixture");
        let result = temp.path().join("membership.txt");
        let name = format!(
            "Local\\T4Code-Pty-{}-{}",
            std::process::id(),
            result.as_os_str().len()
        );
        let mut wide_name = OsStr::new(&name).encode_wide().collect::<Vec<_>>();
        wide_name.push(0);
        let job = WindowsJob::new_named(&wide_name).expect("create named PTY job");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open ConPTY");
        let mut command =
            CommandBuilder::new(std::env::current_exe().expect("current test executable"));
        command.args([
            "--exact",
            "terminal::pty::tests::windows_job_membership_probe",
            "--nocapture",
            "--test-threads=1",
        ]);
        command.env(JOB_PROBE_NAME_ENV, &name);
        command.env(JOB_PROBE_RESULT_ENV, &result);
        command.job_list(&[job.raw_handle()]);

        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn ConPTY job probe");
        drop(pair.slave);
        let status = child.wait().expect("wait for ConPTY job probe");
        assert!(status.success(), "job probe failed: {status}");
        assert_eq!(
            fs::read_to_string(&result).expect("read job membership result"),
            "member"
        );
    }

    #[cfg(windows)]
    #[derive(Clone, Debug)]
    struct TrackingPortableChild {
        kills: Arc<AtomicUsize>,
        waits: Arc<AtomicUsize>,
    }

    #[cfg(windows)]
    impl portable_pty::ChildKiller for TrackingPortableChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    #[cfg(windows)]
    impl portable_pty::Child for TrackingPortableChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            self.waits.fetch_add(1, Ordering::SeqCst);
            Ok(Some(portable_pty::ExitStatus::with_exit_code(1)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            panic!("PTY initialization cleanup must not call blocking wait")
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }

        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[cfg(windows)]
    #[test]
    fn injected_windows_initialization_failure_kills_and_waits() {
        let kills = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicUsize::new(0));
        let mut child = TrackingPortableChild {
            kills: Arc::clone(&kills),
            waits: Arc::clone(&waits),
        };
        let job = WindowsJob::new().expect("create cleanup job");

        cleanup_failed_pty_initialization(&mut child, &job, "injected initialization failure");

        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert_eq!(waits.load(Ordering::SeqCst), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_tree_fixture() {
        let Some(role) = std::env::var_os(PTY_TREE_ROLE_ENV) else {
            return;
        };
        let (ready, survived) = match role.to_string_lossy().as_ref() {
            "root" => {
                spawn_windows_pty_tree_role("child");
                (PTY_TREE_ROOT_READY_ENV, PTY_TREE_ROOT_SURVIVED_ENV)
            }
            "child" => {
                spawn_windows_pty_tree_role("grandchild");
                (PTY_TREE_CHILD_READY_ENV, PTY_TREE_CHILD_SURVIVED_ENV)
            }
            "grandchild" => (
                PTY_TREE_GRANDCHILD_READY_ENV,
                PTY_TREE_GRANDCHILD_SURVIVED_ENV,
            ),
            other => panic!("unknown Windows PTY tree role: {other}"),
        };
        fs::write(
            std::env::var_os(ready).expect("PTY tree ready path"),
            "ready",
        )
        .expect("write PTY tree ready marker");
        let release =
            PathBuf::from(std::env::var_os(PTY_TREE_RELEASE_ENV).expect("PTY tree release path"));
        while !release.is_file() {
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(
            std::env::var_os(survived).expect("PTY tree survived path"),
            "survived",
        )
        .expect("write PTY tree survived marker");
        loop {
            std::thread::park();
        }
    }

    #[cfg(windows)]
    fn spawn_windows_pty_tree_role(role: &str) {
        std::process::Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "terminal::pty::tests::windows_pty_tree_fixture",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(PTY_TREE_ROLE_ENV, role)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn Windows PTY tree role");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn portable_backend_kills_windows_child_and_grandchild() {
        let temp = tempfile::tempdir().expect("Windows PTY tree fixture");
        let root_ready = temp.path().join("root.ready");
        let child_ready = temp.path().join("child.ready");
        let grandchild_ready = temp.path().join("grandchild.ready");
        let root_survived = temp.path().join("root.survived");
        let child_survived = temp.path().join("child.survived");
        let grandchild_survived = temp.path().join("grandchild.survived");
        let release = temp.path().join("release");
        let env = BTreeMap::from([
            (PTY_TREE_ROLE_ENV.to_string(), "root".to_string()),
            (
                PTY_TREE_ROOT_READY_ENV.to_string(),
                root_ready.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_CHILD_READY_ENV.to_string(),
                child_ready.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_GRANDCHILD_READY_ENV.to_string(),
                grandchild_ready.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_ROOT_SURVIVED_ENV.to_string(),
                root_survived.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_CHILD_SURVIVED_ENV.to_string(),
                child_survived.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_GRANDCHILD_SURVIVED_ENV.to_string(),
                grandchild_survived.to_string_lossy().into_owned(),
            ),
            (
                PTY_TREE_RELEASE_ENV.to_string(),
                release.to_string_lossy().into_owned(),
            ),
        ]);
        let process = PortablePtyBackend
            .spawn(&PtySpawnInput {
                shell: std::env::current_exe()
                    .expect("current test executable")
                    .to_string_lossy()
                    .into_owned(),
                args: vec![
                    "--exact".to_string(),
                    "terminal::pty::tests::windows_pty_tree_fixture".to_string(),
                    "--nocapture".to_string(),
                    "--test-threads=1".to_string(),
                ],
                cwd: std::env::temp_dir(),
                cols: 80,
                rows: 24,
                env,
            })
            .expect("spawn Windows PTY tree");
        let mut exit = process.subscribe_exit();
        wait_for_windows_pty_path(&root_ready).await;
        wait_for_windows_pty_path(&child_ready).await;
        wait_for_windows_pty_path(&grandchild_ready).await;

        process.kill().expect("kill Windows PTY Job");
        tokio::time::timeout(Duration::from_secs(5), exit.changed())
            .await
            .expect("PTY root should exit")
            .expect("PTY exit sender should remain live");
        fs::write(&release, "release").expect("write PTY tree release");
        tokio::time::sleep(Duration::from_secs(1)).await;
        for sentinel in [&root_survived, &child_survived, &grandchild_survived] {
            assert!(
                !sentinel.exists(),
                "PTY descendant survived long enough to write {}",
                sentinel.display()
            );
        }
    }

    #[cfg(windows)]
    async fn wait_for_windows_pty_path(path: &Path) {
        for _ in 0..500 {
            if path.is_file() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {}", path.display());
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

    #[cfg(unix)]
    #[derive(Debug)]
    struct FailingLivePortableChild {
        child: Box<dyn portable_pty::Child + Send + Sync>,
    }

    #[cfg(unix)]
    impl portable_pty::ChildKiller for FailingLivePortableChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Err(Error::new(
                ErrorKind::PermissionDenied,
                "injected live-child kill failure",
            ))
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(TestKiller { fail: true })
        }
    }

    #[cfg(unix)]
    impl portable_pty::Child for FailingLivePortableChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            self.child.try_wait()
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.child.wait()
        }

        fn process_id(&self) -> Option<u32> {
            self.child.process_id()
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_live_pty_kill_cannot_block_initialization_cleanup() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("live cleanup PTY should open");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("live cleanup PTY child should spawn");
        drop(pair.slave);
        assert!(
            child
                .try_wait()
                .expect("live PTY status should be readable")
                .is_none()
        );
        let mut force_killer = child.clone_killer();
        let child = FailingLivePortableChild { child };
        let (completed_tx, completed_rx) = std::sync::mpsc::sync_channel(1);
        let cleanup_thread = std::thread::spawn(move || {
            let primary_error = "injected primary initialization failure".to_owned();
            let mut child = child;
            let report = cleanup_failed_pty_initialization(&mut child, None, &primary_error);
            completed_tx
                .send((child, primary_error, report))
                .expect("cleanup test receiver should remain connected");
        });

        let completed = completed_rx.recv_timeout(Duration::from_secs(3));
        if completed.is_err() {
            force_killer
                .kill()
                .expect("test fallback should kill live PTY fixture");
        }
        let (mut child, primary_error, report) = match completed {
            Ok(completed) => completed,
            Err(error) => {
                let completed = completed_rx
                    .recv_timeout(Duration::from_secs(3))
                    .expect("forced test cleanup should unblock PTY wait");
                cleanup_thread
                    .join()
                    .expect("cleanup thread should finish after forced kill");
                panic!("PTY cleanup did not return within its deadline: {error}; {completed:?}");
            }
        };
        force_killer
            .kill()
            .expect("test cleanup should kill surviving PTY fixture");
        child
            .child
            .wait()
            .expect("test cleanup should reap surviving PTY fixture");
        cleanup_thread
            .join()
            .expect("bounded cleanup thread should finish");
        assert_eq!(primary_error, "injected primary initialization failure");
        assert_eq!(report.attempted, 2);
        assert_eq!(report.failure_count, 2);
        assert!(
            report
                .failures
                .iter()
                .all(|failure| failure.chars().count() <= 160)
        );
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
        assert!(executable_is_discoverable(
            executable.to_str().expect("test executable path"),
            &overrides
        ));
        assert!(!executable_is_discoverable(
            executable
                .with_file_name("definitely-missing-t4code-shell")
                .to_str()
                .expect("missing executable path"),
            &overrides
        ));

        let mut isolated = BTreeMap::new();
        isolated.insert(
            "Path".to_owned(),
            std::env::join_paths([directory])
                .expect("test executable search path")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(executable_is_discoverable(command, &isolated));
        isolated.insert(
            "PATH".to_owned(),
            executable
                .parent()
                .expect("test executable directory")
                .join("definitely-missing-t4code-bin")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(!executable_is_discoverable("t4code-shell", &isolated));
    }

    #[tokio::test]
    async fn portable_backend_streams_input_output_resize_and_exit() {
        let (shell, args, input, output_marker) = if cfg!(windows) {
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
                shell,
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
        let (shell, args) = if cfg!(windows) {
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
                shell,
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
    fn portable_backend_rejects_a_missing_shell_before_opening_a_pty() {
        let error = PortablePtyBackend
            .spawn(&PtySpawnInput {
                shell: "/definitely/missing/t4code-shell".to_owned(),
                args: Vec::new(),
                cwd: std::env::temp_dir(),
                cols: 80,
                rows: 24,
                env: BTreeMap::new(),
            })
            .unwrap_err();
        assert!(error.contains("shell executable was not found"));
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
