#![cfg(windows)]

use std::{collections::BTreeMap, time::Duration};

use t4code_server::terminal::{
    PortablePtyBackend, PtyBackend, PtySpawnInput, TerminalAttachInput, TerminalManager,
    TerminalMetadataEvent, TerminalOpenInput,
};

#[test]
fn portable_backend_rejects_an_undiscoverable_shell_synchronously() {
    let workspace = tempfile::tempdir().expect("workspace");
    let backend = PortablePtyBackend;
    let result = backend.spawn(&PtySpawnInput {
        shell: "t4code-shell-that-does-not-exist.exe".to_string(),
        args: Vec::new(),
        cwd: workspace.path().to_path_buf(),
        cols: 120,
        rows: 30,
        env: BTreeMap::new(),
    });

    assert!(
        result.is_err(),
        "missing shell must not produce a PTY process"
    );
}

#[tokio::test]
async fn default_windows_shell_inherits_the_path_needed_to_launch() {
    let workspace = tempfile::tempdir().expect("workspace");
    let manager = TerminalManager::default();
    manager
        .open(TerminalOpenInput::new(
            "thread-1",
            "terminal-1",
            workspace.path().to_path_buf(),
            120,
            30,
        ))
        .await
        .expect("terminal opens");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let attachment = manager
                .attach(TerminalAttachInput::existing("thread-1", "terminal-1"))
                .await
                .expect("terminal remains attachable");
            if attachment.initial.history.contains("\u{1b}[6n") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("PowerShell requests the terminal cursor position");
    tokio::time::timeout(
        Duration::from_secs(2),
        manager.resize("thread-1", "terminal-1", 100, 24),
    )
    .await
    .expect("terminal resize does not block while PowerShell awaits a cursor response")
    .expect("terminal resizes");
    manager
        .write("thread-1", "terminal-1", "\u{1b}[1;1R")
        .await
        .expect("terminal accepts cursor response");
    manager
        .write(
            "thread-1",
            "terminal-1",
            "Write-Output T4CODE_TERMINAL_OK\r\n",
        )
        .await
        .expect("terminal accepts input");

    let observed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let attachment = manager
                .attach(TerminalAttachInput::existing("thread-1", "terminal-1"))
                .await
                .expect("terminal remains attachable");
            if attachment.initial.history.contains("T4CODE_TERMINAL_OK") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    if observed.is_err() {
        let attachment = manager
            .attach(TerminalAttachInput::existing("thread-1", "terminal-1"))
            .await
            .expect("terminal remains attachable for diagnostics");
        panic!(
            "PowerShell command did not produce output: status={:?}, history={:?}",
            attachment.initial.status, attachment.initial.history
        );
    }
    manager.shutdown().await;
}

#[tokio::test]
async fn attaching_a_missing_terminal_opens_it_without_deadlocking() {
    let workspace = tempfile::tempdir().expect("workspace");
    let manager = TerminalManager::default();
    let attachment = tokio::time::timeout(
        Duration::from_secs(3),
        manager.attach(TerminalAttachInput {
            thread_id: "thread-attach".to_string(),
            terminal_id: "terminal-attach".to_string(),
            cwd: Some(workspace.path().to_path_buf()),
            worktree_path: None,
            cols: Some(120),
            rows: Some(30),
            env: BTreeMap::new(),
            restart_if_not_running: false,
        }),
    )
    .await
    .expect("missing terminal attach must not deadlock")
    .expect("missing terminal attach opens the terminal");

    assert_eq!(attachment.initial.thread_id, "thread-attach");
    assert_eq!(attachment.initial.terminal_id, "terminal-attach");
    manager.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_open_and_attach_share_one_native_process() {
    let workspace = tempfile::tempdir().expect("workspace");
    let manager = TerminalManager::default();
    let open_input = TerminalOpenInput::new(
        "thread-concurrent",
        "terminal-concurrent",
        workspace.path().to_path_buf(),
        120,
        30,
    );
    let input = TerminalAttachInput {
        thread_id: "thread-concurrent".to_string(),
        terminal_id: "terminal-concurrent".to_string(),
        cwd: Some(workspace.path().to_path_buf()),
        worktree_path: None,
        cols: Some(120),
        rows: Some(30),
        env: BTreeMap::new(),
        restart_if_not_running: false,
    };

    let open_manager = manager.clone();
    let open = tokio::spawn(async move { open_manager.open(open_input).await });
    let attach_manager = manager.clone();
    let attach = tokio::spawn(async move { attach_manager.attach(input).await });
    let first = open
        .await
        .expect("open task completes")
        .expect("terminal opens");
    let second = attach
        .await
        .expect("attach task completes")
        .expect("attach reuses the terminal");

    assert_eq!(first.pid, second.initial.pid);
    manager.shutdown().await;
}

#[tokio::test]
async fn closing_a_terminal_does_not_resurrect_its_metadata() {
    let workspace = tempfile::tempdir().expect("workspace");
    let manager = TerminalManager::default();
    manager
        .open(TerminalOpenInput::new(
            "thread-close",
            "terminal-close",
            workspace.path().to_path_buf(),
            120,
            30,
        ))
        .await
        .expect("terminal opens");
    let mut metadata = manager.subscribe_metadata().await;

    manager.close("thread-close", Some("terminal-close")).await;
    let removed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(
                metadata.recv().await,
                Some(TerminalMetadataEvent::Remove { ref thread_id, ref terminal_id })
                    if thread_id == "thread-close" && terminal_id == "terminal-close"
            ) {
                break;
            }
        }
    })
    .await;
    assert!(removed.is_ok(), "close emits terminal metadata removal");

    let resurrected = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            match metadata.recv().await {
                Some(TerminalMetadataEvent::Upsert { terminal })
                    if terminal.thread_id == "thread-close"
                        && terminal.terminal_id == "terminal-close" =>
                {
                    return true;
                }
                Some(_) => continue,
                None => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(!resurrected, "closed terminal metadata must stay removed");
    manager.shutdown().await;
}
