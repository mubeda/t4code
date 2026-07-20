#![cfg(windows)]

use std::{collections::BTreeMap, path::Path, time::Duration};

use t4code_server::terminal::{PortablePtyBackend, PtySpawnInput};

async fn assert_shim_output(
    executable: &Path,
    trampoline: &Path,
    arguments: &[String],
    environment: BTreeMap<String, String>,
    marker: &str,
) {
    let process = PortablePtyBackend
        .spawn_with_windows_batch_trampoline(
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
