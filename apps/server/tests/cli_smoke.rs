use std::{
    process::{Command, Stdio},
    time::Duration,
};

use clap::Parser;
use serde_json::{Value, json};
use t4code_server::Cli;
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command as TokioCommand,
    time::timeout,
};

#[test]
fn headless_binary_exposes_the_compatible_serve_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_t4code"))
        .args(["serve", "--help"])
        .output()
        .expect("run t4code serve --help");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 help output");
    for expected in [
        "--host",
        "--port",
        "--base-dir",
        "--bootstrap-fd",
        "--no-browser",
    ] {
        assert!(stdout.contains(expected), "missing {expected} in {stdout}");
    }
}

#[test]
#[cfg(windows)]
fn headless_binary_reports_invalid_bootstrap_descriptors_without_panicking() {
    let output = Command::new(env!("CARGO_BIN_EXE_t4code"))
        .args(["serve", "--bootstrap-fd", "4"])
        .output()
        .expect("run t4code with unsupported bootstrap fd");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 error output");
    assert!(stderr.contains("bootstrap file descriptor 4 is unsupported on this platform"));
    assert!(!stderr.to_ascii_lowercase().contains("panicked"));
}

#[test]
fn serve_flags_have_the_same_value_before_or_after_the_subcommand() {
    let temp = TempDir::new().expect("temporary base directory");
    let base_dir = temp.path().to_string_lossy();
    let before = Cli::try_parse_from([
        "t4code",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--base-dir",
        base_dir.as_ref(),
        "serve",
    ])
    .expect("flags before serve")
    .into_server_config()
    .expect("configuration before serve");
    let after = Cli::try_parse_from([
        "t4code",
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--base-dir",
        base_dir.as_ref(),
    ])
    .expect("flags after serve")
    .into_server_config()
    .expect("configuration after serve");

    assert_eq!(before.host, after.host);
    assert_eq!(before.port, after.port);
    assert_eq!(before.base_dir, after.base_dir);
    assert!(before.no_browser);
    assert!(after.no_browser);
}

#[test]
fn start_opens_a_browser_unless_disabled_while_serve_is_always_headless() {
    let start = Cli::try_parse_from(["t4code", "start"])
        .expect("start arguments")
        .into_server_config()
        .expect("start configuration");
    let disabled = Cli::try_parse_from(["t4code", "start", "--no-browser"])
        .expect("disabled browser arguments")
        .into_server_config()
        .expect("disabled browser configuration");
    let serve = Cli::try_parse_from(["t4code", "serve"])
        .expect("serve arguments")
        .into_server_config()
        .expect("serve configuration");

    assert!(!start.no_browser);
    assert!(disabled.no_browser);
    assert!(serve.no_browser);
}

#[tokio::test]
async fn desktop_bootstrap_rejects_an_empty_shutdown_token() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut child = TokioCommand::new(env!("CARGO_BIN_EXE_t4code"))
        .args([
            "serve",
            "--mode",
            "desktop",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--base-dir",
        ])
        .arg(temp.path())
        .args(["--bootstrap-fd", "0"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn t4code server");
    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 0,
        "host": "127.0.0.1",
        "desktopBootstrapToken": "",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    let mut stdin = child.stdin.take().expect("child stdin");
    stdin
        .write_all(format!("{bootstrap}\n").as_bytes())
        .await
        .expect("write empty-token bootstrap");
    drop(stdin);

    let mut stderr = child.stderr.take().expect("child stderr");
    let status = match timeout(Duration::from_secs(3), child.wait()).await {
        Ok(status) => status.expect("server exit status"),
        Err(_) => {
            child.kill().await.expect("kill server after timeout");
            panic!("server accepted an empty desktop bootstrap token");
        }
    };
    let mut error = String::new();
    stderr
        .read_to_string(&mut error)
        .await
        .expect("read server error");
    assert!(!status.success());
    assert!(
        error.contains("desktop bootstrap token must not be empty"),
        "{error}"
    );
}

#[test]
#[cfg(unix)]
fn headless_configuration_reads_an_inherited_nonzero_bootstrap_fd() {
    use std::{
        io::Write,
        os::{fd::IntoRawFd, unix::net::UnixStream},
    };

    let (mut writer, reader) = UnixStream::pair().expect("bootstrap socket pair");
    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 4567,
        "host": "127.0.0.1",
        "desktopBootstrapToken": "inherited-fd-secret",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    writeln!(writer, "{bootstrap}").expect("write inherited bootstrap");
    let fd = reader.into_raw_fd().to_string();

    let config = Cli::try_parse_from(["t4code", "serve", "--bootstrap-fd", fd.as_str()])
        .expect("inherited bootstrap arguments")
        .into_server_config()
        .expect("inherited bootstrap configuration");
    assert_eq!(config.port, 4567);
    assert_eq!(
        config.desktop_bootstrap_token.as_deref(),
        Some("inherited-fd-secret")
    );
}

#[tokio::test]
async fn headless_binary_reads_desktop_bootstrap_and_shuts_down_over_http() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut child = TokioCommand::new(env!("CARGO_BIN_EXE_t4code"))
        .args([
            "serve",
            "--mode",
            "desktop",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--base-dir",
        ])
        .arg(temp.path())
        .args(["--no-browser", "--bootstrap-fd", "0"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn t4code server");

    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 0,
        "t4codeHome": temp.path(),
        "host": "127.0.0.1",
        "desktopBootstrapToken": "process-smoke-secret",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    let mut stdin = child.stdin.take().expect("child stdin");
    stdin
        .write_all(format!("{bootstrap}\n").as_bytes())
        .await
        .expect("write desktop bootstrap");
    drop(stdin);

    let stdout = child.stdout.take().expect("child stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready_line = match timeout(Duration::from_secs(30), lines.next_line()).await {
        Ok(result) => result
            .expect("read readiness line")
            .expect("server readiness line"),
        Err(error) => {
            child.kill().await.expect("terminate unready server");
            panic!("server readiness timeout: {error}");
        }
    };
    let ready: Value = serde_json::from_str(&ready_line).expect("readiness JSON");
    let http_base_url = ready["httpBaseUrl"].as_str().expect("HTTP base URL");

    let shutdown = reqwest::Client::new()
        .post(format!(
            "{http_base_url}/.well-known/t4code/desktop/shutdown"
        ))
        .header("x-t4code-desktop-bootstrap-token", "process-smoke-secret")
        .send()
        .await
        .expect("desktop shutdown request");
    assert_eq!(shutdown.status(), reqwest::StatusCode::ACCEPTED);

    let status = timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("server exit timeout")
        .expect("server exit status");
    assert!(status.success(), "server exited with {status}");
}
