use std::{
    collections::BTreeMap,
    env, fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use tokio::sync::{broadcast, watch};

#[cfg(windows)]
use crate::process::WindowsJob;

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

        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => return Err(error.to_string()),
        };
        drop(pair.slave);
        let pid = match child.process_id() {
            Some(pid) => pid,
            None => return Err("PTY child did not expose a process id".to_string()),
        };
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader();
        #[cfg(windows)]
        let job = {
            let raw_handle = match child.as_raw_handle() {
                Some(raw_handle) => raw_handle,
                None => return Err("PTY child did not expose a Windows process handle".to_owned()),
            };
            match WindowsJob::attach(raw_handle) {
                Ok(job) => job,
                Err(error) => return Err(error.to_string()),
            }
        };
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => return Err(error.to_string()),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => return Err(error.to_string()),
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
                "powershell.exe".to_owned(),
                vec!["-NoLogo".to_owned(), "-NoProfile".to_owned()],
                "Write-Output 'ready'; Write-Output 'got:hello from test'; exit 7\r\n",
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

        let text = tokio::time::timeout(Duration::from_secs(3), async {
            let mut text = String::new();
            while !text.contains(output_marker) {
                text.push_str(&output.recv().await.unwrap());
            }
            text
        })
        .await
        .unwrap();
        assert!(text.contains("ready"));

        tokio::time::timeout(Duration::from_secs(3), exit.changed())
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
