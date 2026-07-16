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
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: input.rows,
                cols: input.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(&input.shell);
        command.args(&input.args);
        command.cwd(&input.cwd);
        for (key, value) in &input.env {
            command.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let pid = child
            .process_id()
            .ok_or_else(|| "PTY child did not expose a process id".to_string())?;
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader();
        #[cfg(windows)]
        let job = WindowsJob::attach(
            child
                .as_raw_handle()
                .ok_or_else(|| "PTY child did not expose a Windows process handle".to_owned())?,
        )
        .map_err(|error| error.to_string())?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        #[cfg(not(windows))]
        let killer = child.clone_killer();
        let (output, _) = broadcast::channel(256);
        let (exit, _) = watch::channel(None);
        let (resize, resize_requests) = mpsc::sync_channel(1);

        let output_sender = output.clone();
        thread::Builder::new()
            .name(format!("t4code-pty-output-{pid}"))
            .spawn(move || read_output(&mut reader, &output_sender))
            .map_err(|error| error.to_string())?;
        thread::Builder::new()
            .name(format!("t4code-pty-resize-{pid}"))
            .spawn(move || {
                while let Ok(size) = resize_requests.recv() {
                    let _ = pair.master.resize(size);
                }
            })
            .map_err(|error| error.to_string())?;
        let exit_sender = exit.clone();
        thread::Builder::new()
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
            .map_err(|error| error.to_string())?;

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
        let mut writer = self.writer.lock().map_err(|error| error.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
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
            self.job.terminate().map_err(|error| error.to_string())?;
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
