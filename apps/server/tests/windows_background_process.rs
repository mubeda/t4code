#![cfg(windows)]
#![windows_subsystem = "windows"]

use std::{process::Stdio, thread, time::Duration};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use t4code_server::process::{
    configure_background_command, configure_supervised_background_command_wrap,
};
use windows_sys::Win32::{
    Foundation::GetLastError,
    System::Console::{AttachConsole, FreeConsole, GetConsoleWindow},
    UI::WindowsAndMessaging::IsWindowVisible,
};

#[tokio::test]
async fn direct_background_command_has_no_console_window_from_gui_parent() {
    let mut command = tokio::process::Command::new("cmd.exe");
    command
        .args(["/d", "/s", "/c", "ping -n 30 127.0.0.1 >nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    let mut child = command
        .spawn()
        .expect("direct background console probe should start");

    assert_child_has_no_visible_console(&mut child).await;
}

#[tokio::test]
async fn supervised_background_command_has_no_console_window_from_gui_parent() {
    let mut command = CommandWrap::with_new("cmd.exe", |command| {
        command
            .args(["/d", "/s", "/c", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    });
    configure_supervised_background_command_wrap(&mut command);

    let mut child = command
        .spawn()
        .expect("background console probe should start");
    assert_child_has_no_visible_console(&mut *child).await;
}

async fn assert_child_has_no_visible_console(child: &mut dyn ChildWrapper) {
    let child_id = child.id().expect("background child should expose its id");
    thread::sleep(Duration::from_millis(300));

    // SAFETY: these calls only alter this GUI test process's console
    // association and take no borrowed pointers.
    let (attached, has_visible_window, error) = unsafe {
        FreeConsole();
        let attached = AttachConsole(child_id) != 0;
        let error = if attached { 0 } else { GetLastError() };
        let console_window = GetConsoleWindow();
        let has_visible_window =
            attached && !console_window.is_null() && IsWindowVisible(console_window) != 0;
        if attached {
            FreeConsole();
        }
        (attached, has_visible_window, error)
    };

    child
        .start_kill()
        .expect("background console probe should be terminated");
    child
        .wait()
        .await
        .expect("background console probe should exit");

    assert!(
        attached,
        "GUI test process could not attach to child console: {error}"
    );
    assert!(
        !has_visible_window,
        "background child unexpectedly owns a visible console window"
    );
}
