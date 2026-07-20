#![cfg(windows)]

use std::{collections::BTreeMap, io::Read, path::Path, time::Duration};

use base64::Engine as _;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use t4code_server::terminal::{PortablePtyBackend, PtyBackend, PtySpawnInput};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, HANDLE, WAIT_OBJECT_0},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

const OUTPUT_MARKER: &str = "T4CODE_NATIVE_PTY_OUTPUT";

struct OwnedHandle(HANDLE);

#[test]
fn raw_conpty_captures_native_windows_terminal_output() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/d", "/s", "/c", &format!("echo {OUTPUT_MARKER}")]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let output = std::thread::spawn(move || {
        let mut output = String::new();
        reader.read_to_string(&mut output).unwrap();
        output
    });

    assert!(child.wait().unwrap().success());
    drop(pair.master);
    let output = output.join().unwrap();
    assert!(
        output.contains(OUTPUT_MARKER),
        "captured output: {output:?}"
    );
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this type owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

async fn wait_for_pid_file(path: &Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(contents) = std::fs::read_to_string(path)
                && let Ok(pid) = contents.trim().parse::<u32>()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap()
}

fn powershell_encoded_command(command: &str) -> String {
    let utf16 = command
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

fn descendant_spawning_powershell_command() -> String {
    let child_command = powershell_encoded_command(
        "[IO.File]::WriteAllText($env:T4CODE_TEST_CHILD_PID, [string]$PID); Start-Sleep -Seconds 30",
    );
    format!(
        "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','{child_command}' -PassThru; Wait-Process -Id $child.Id"
    )
}

async fn assert_terminal_kills_descendant(input: PtySpawnInput, child_pid_file: &Path) {
    let process = PortablePtyBackend.spawn(&input).unwrap();
    let child_pid = wait_for_pid_file(child_pid_file).await;

    let mut exit = process.subscribe_exit();
    process.kill().unwrap();
    let already_exited = exit.borrow().is_some();
    if !already_exited {
        tokio::time::timeout(Duration::from_secs(10), exit.changed())
            .await
            .unwrap()
            .unwrap();
    }

    // SAFETY: OpenProcess only inspects the process identified by the fixture PID.
    let child = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child_pid) };
    if child.is_null() {
        // A process that has already been reaped is also a successful outcome.
        assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_PARAMETER);
        return;
    }
    let child = OwnedHandle(child);
    // SAFETY: `child` owns a live synchronization handle.
    assert_eq!(
        unsafe { WaitForSingleObject(child.0, 10_000) },
        WAIT_OBJECT_0,
        "PTY descendant survived terminal kill"
    );
}

async fn assert_shim_output(
    executable: &Path,
    arguments: &[String],
    environment: BTreeMap<String, String>,
    marker: &str,
) {
    let process = PortablePtyBackend
        .spawn(&PtySpawnInput {
            executable: executable.to_string_lossy().into_owned(),
            args: arguments.to_vec(),
            cwd: executable.parent().unwrap().to_path_buf(),
            cols: 80,
            rows: 24,
            env: environment,
        })
        .unwrap();
    let mut output = process.subscribe_output();
    let mut exit = process.subscribe_exit();
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while !text.contains(marker) {
            if exit.borrow().is_some() {
                break;
            }
            tokio::select! {
                received = output.recv() => {
                    text.push_str(&received.expect("terminal output channel should stay open"));
                }
                changed = exit.changed() => {
                    changed.expect("terminal exit channel should stay open");
                    if exit.borrow().is_some() {
                        break;
                    }
                }
            }
        }
        text
    })
    .await
    .unwrap();
    assert!(
        text.contains(marker),
        "terminal exited without the expected marker; output={text:?}, exit={:?}",
        exit.borrow().clone()
    );
    tokio::time::timeout(Duration::from_secs(10), exit.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        exit.borrow().as_ref().and_then(|event| event.exit_code),
        Some(0)
    );
}

#[tokio::test]
async fn portable_backend_captures_native_windows_terminal_output() {
    let directory = tempfile::tempdir().unwrap();
    let process = PortablePtyBackend
        .spawn(&PtySpawnInput {
            executable: "cmd.exe".to_owned(),
            args: vec![
                "/d".to_owned(),
                "/s".to_owned(),
                "/c".to_owned(),
                format!("echo {OUTPUT_MARKER}"),
            ],
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::new(),
        })
        .unwrap();
    let mut output = process.subscribe_output();
    let mut exit = process.subscribe_exit();
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while !text.contains(OUTPUT_MARKER) {
            if exit.borrow().is_some() {
                break;
            }
            tokio::select! {
                received = output.recv() => text.push_str(&received.unwrap()),
                changed = exit.changed() => {
                    changed.unwrap();
                    if exit.borrow().is_some() {
                        break;
                    }
                }
            }
        }
        text
    })
    .await
    .unwrap();
    assert!(
        text.contains(OUTPUT_MARKER),
        "captured output: {text:?}; exit={:?}",
        exit.borrow().clone()
    );
}

#[tokio::test]
async fn portable_backend_runs_windows_command_and_powershell_shims() {
    let directory = tempfile::tempdir().unwrap();
    let shim_directory = directory.path().join("provider ! shims");
    std::fs::create_dir(&shim_directory).unwrap();
    let arguments = [
        "value with spaces".to_owned(),
        "literal-value".to_owned(),
        "percent-value".to_owned(),
        "!literal!".to_owned(),
    ];
    for extension in ["cmd", "bat"] {
        let executable = shim_directory.join(format!("provider.{extension}"));
        std::fs::write(
            &executable,
            format!(
                "@echo off\r\nping -n 2 127.0.0.1 >nul\r\necho {extension}:%~1:%~2:%~3:%~4:%T4CODE_INTERNAL_BATCH_SCRIPT%\r\n"
            ),
        )
        .unwrap();
        assert_shim_output(
            &executable,
            &arguments,
            BTreeMap::from([(
                "T4CODE_INTERNAL_BATCH_SCRIPT".to_owned(),
                "user-controlled-value".to_owned(),
            )]),
            &format!(
                "{extension}:value with spaces:literal-value:percent-value:!literal!:user-controlled-value"
            ),
        )
        .await;
    }

    let powershell = shim_directory.join("provider.ps1");
    std::fs::write(
        &powershell,
        "Start-Sleep -Milliseconds 250\nWrite-Output \"ps1:$($args[0]):$($args[1]):$($args[2]):$($args[3])\"\n",
    )
    .unwrap();
    assert_shim_output(
        &powershell,
        &arguments,
        BTreeMap::new(),
        "ps1:value with spaces:literal-value:percent-value:!literal!",
    )
    .await;
}

#[tokio::test]
async fn killing_a_batch_terminal_terminates_its_descendant_process() {
    let directory = tempfile::tempdir().unwrap();
    let child_pid_file = directory.path().join("child-pid.txt");
    let script = directory.path().join("long running provider.cmd");
    std::fs::write(
        &script,
        "@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command \"[IO.File]::WriteAllText($env:T4CODE_TEST_CHILD_PID, [string]$PID); Start-Sleep -Seconds 30\"\r\n",
    )
    .unwrap();
    assert_terminal_kills_descendant(
        PtySpawnInput {
            executable: script.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::from([(
                "T4CODE_TEST_CHILD_PID".to_owned(),
                child_pid_file.to_string_lossy().into_owned(),
            )]),
        },
        &child_pid_file,
    )
    .await;
}

#[tokio::test]
async fn killing_a_powershell_shim_terminal_terminates_its_descendant_process() {
    let directory = tempfile::tempdir().unwrap();
    let child_pid_file = directory.path().join("powershell-shim-child-pid.txt");
    let script = directory.path().join("long running provider.ps1");
    std::fs::write(&script, descendant_spawning_powershell_command()).unwrap();

    assert_terminal_kills_descendant(
        PtySpawnInput {
            executable: script.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::from([(
                "T4CODE_TEST_CHILD_PID".to_owned(),
                child_pid_file.to_string_lossy().into_owned(),
            )]),
        },
        &child_pid_file,
    )
    .await;
}

#[tokio::test]
async fn killing_a_native_windows_terminal_terminates_its_descendant_process() {
    let directory = tempfile::tempdir().unwrap();
    let child_pid_file = directory.path().join("native-child-pid.txt");

    assert_terminal_kills_descendant(
        PtySpawnInput {
            executable: "powershell.exe".to_owned(),
            args: vec![
                "-NoLogo".to_owned(),
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-Command".to_owned(),
                descendant_spawning_powershell_command(),
            ],
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::from([(
                "T4CODE_TEST_CHILD_PID".to_owned(),
                child_pid_file.to_string_lossy().into_owned(),
            )]),
        },
        &child_pid_file,
    )
    .await;
}
