#![cfg(windows)]

use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

use base64::Engine as _;
use t4code_server::{
    process::WINDOWS_PTY_TRAMPOLINE_ARG,
    terminal::{PortablePtyBackend, PtySpawnInput},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, HANDLE, WAIT_OBJECT_0},
    System::Threading::{
        CreateEventW, OpenProcess, PROCESS_SYNCHRONIZE, SetEvent, WaitForSingleObject,
    },
};

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: this type owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

fn create_gate(name: &str) -> OwnedHandle {
    let name = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    // SAFETY: default security, a manual-reset nonsignalled event, and a
    // NUL-terminated name are valid CreateEventW inputs.
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
    assert!(!handle.is_null(), "failed to create test gate");
    OwnedHandle(handle)
}

async fn wait_for_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
}

fn wait_for_child_exit(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("trampoline child did not exit");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
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
    let process = PortablePtyBackend
        .spawn_with_windows_pty_trampoline(
            &input,
            Path::new(env!("CARGO_BIN_EXE_t4code")),
        )
        .unwrap();
    wait_for_file(child_pid_file).await;
    let child_pid = std::fs::read_to_string(child_pid_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();

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
    trampoline: &Path,
    arguments: &[String],
    environment: BTreeMap<String, String>,
    marker: &str,
) {
    let process = PortablePtyBackend
        .spawn_with_windows_pty_trampoline(
            &PtySpawnInput {
                executable: executable.to_string_lossy().into_owned(),
                args: arguments.to_vec(),
                cwd: executable.parent().unwrap().to_path_buf(),
                cols: 80,
                rows: 24,
                env: environment,
            },
            trampoline,
        )
        .unwrap();
    let mut output = process.subscribe_output();
    let mut exit = process.subscribe_exit();
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while !text.contains(marker) {
            text.push_str(&output.recv().await.unwrap());
        }
        text
    })
    .await
    .unwrap();
    assert!(text.contains(marker));
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
async fn portable_backend_runs_windows_command_and_powershell_shims() {
    let directory = tempfile::tempdir().unwrap();
    let shim_directory = directory.path().join("provider ! shims");
    std::fs::create_dir(&shim_directory).unwrap();
    let arguments = [
        "value with spaces".to_owned(),
        "&literal".to_owned(),
        "%PATH%".to_owned(),
        "!literal!".to_owned(),
    ];
    let trampoline = Path::new(env!("CARGO_BIN_EXE_t4code"));
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
            trampoline,
            &arguments,
            BTreeMap::from([(
                "T4CODE_INTERNAL_BATCH_SCRIPT".to_owned(),
                "user-controlled-value".to_owned(),
            )]),
            &format!(
                "{extension}:value with spaces:&literal:%PATH%:!literal!:user-controlled-value"
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
        trampoline,
        &arguments,
        BTreeMap::new(),
        "ps1:value with spaces:&literal:%PATH%:!literal!",
    )
    .await;
}

#[test]
fn pty_trampoline_waits_for_the_parent_supervision_gate() {
    let directory = tempfile::tempdir().unwrap();
    let marker_file = directory.path().join("batch-started.txt");
    let script = directory.path().join("gated provider.cmd");
    std::fs::write(&script, "@echo off\r\necho started>\"%~1\"\r\n").unwrap();
    let gate_name = format!(
        "Local\\T4CodePtyLaunch-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let ready_name = format!("{gate_name}-ready");
    let gate = create_gate(&gate_name);
    let ready = create_gate(&ready_name);

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_t4code"))
        .args([
            std::ffi::OsStr::new(WINDOWS_PTY_TRAMPOLINE_ARG),
            std::ffi::OsStr::new(&gate_name),
            std::ffi::OsStr::new(&ready_name),
            script.as_os_str(),
            marker_file.as_os_str(),
        ])
        .spawn()
        .unwrap();
    // SAFETY: `ready` owns a live synchronization handle. The trampoline
    // signals it immediately before waiting on the supervision gate.
    assert_eq!(
        unsafe { WaitForSingleObject(ready.0, 10_000) },
        WAIT_OBJECT_0,
        "batch trampoline did not reach the supervision gate"
    );
    assert!(
        !marker_file.exists(),
        "batch script started before supervision was ready"
    );

    // SAFETY: `gate` owns a live event handle.
    assert_ne!(unsafe { SetEvent(gate.0) }, 0);
    assert!(wait_for_child_exit(&mut child).success());
    assert_eq!(std::fs::read_to_string(marker_file).unwrap().trim(), "started");
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
