use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    env, fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::oneshot;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
use t4code_server::process::configure_background_command;
use uuid::Uuid;

const SSH_DIRECTORY_NAME: &str = ".ssh";
const SSH_CONFIG_FILE_NAME: &str = "config";
const KNOWN_HOSTS_FILE_NAME: &str = "known_hosts";
pub const SSH_PASSWORD_PROMPT_EVENT: &str = "desktop:ssh-password-prompt";
const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const DEFAULT_REMOTE_PORT: u16 = 3773;
const SSH_READY_PATH: &str = "/.well-known/t4code/environment";
const SSH_READY_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_READY_INTERVAL: Duration = Duration::from_millis(250);
const SSH_READY_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const SSH_TUNNEL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);
const REMOTE_PORT_SCAN_WINDOW: u16 = 200;
const REMOTE_READY_TIMEOUT_MS: u64 = 15_000;
const REMOTE_REUSE_READY_TIMEOUT_MS: u64 = 2_000;
const ASKPASS_POSIX_SCRIPT: &str = r#"#!/bin/sh
if [ "${T4CODE_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\n" "$T4CODE_SSH_AUTH_SECRET"
  exit 0
fi
printf 'T4Code ssh-askpass invoked without T4CODE_SSH_AUTH_SECRET.\n' >&2
exit 1
"#;
const ASKPASS_WINDOWS_LAUNCHER_SCRIPT: &str = "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ssh-askpass.ps1\" %*\r\n";
const ASKPASS_WINDOWS_SCRIPT: &str = r#"# Invoked by ssh via SSH_ASKPASS when T4Code re-runs ssh with a cached password.
if ($null -ne $env:T4CODE_SSH_AUTH_SECRET) {
  [Console]::Out.WriteLine($env:T4CODE_SSH_AUTH_SECRET)
  exit 0
}
[Console]::Error.WriteLine("T4Code ssh-askpass invoked without T4CODE_SSH_AUTH_SECRET.")
exit 1
"#;

const REMOTE_LAUNCH_SCRIPT: &str = r#"set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.t4code/ssh-launch/$STATE_KEY"
SERVER_HOME="$HOME/.t4code"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t4code.sh"
mkdir -p "$STATE_DIR"
cat >"$RUNNER_FILE" <<'SH'
#!/bin/sh
if command -v t4code >/dev/null 2>&1; then
  exec t4code "$@"
fi
printf 'Remote host is missing the native t4code CLI. Install the Rust t4code binary before connecting.\n' >&2
exit 1
SH
chmod 700 "$RUNNER_FILE"
wait_ready() {
  port="$1"
  attempts=$(($2 / 100))
  [ "$attempts" -gt 0 ] || attempts=1
  while [ "$attempts" -gt 0 ]; do
    if command -v curl >/dev/null 2>&1; then
      curl --fail --silent --show-error --max-time 1 \
        "http://127.0.0.1:$port/.well-known/t4code/environment" >/dev/null 2>&1 && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget --quiet --timeout=1 --output-document=/dev/null \
        "http://127.0.0.1:$port/.well-known/t4code/environment" >/dev/null 2>&1 && return 0
    else
      printf 'Remote host requires curl or wget for readiness checks.\n' >&2
      return 1
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done
  return 1
}
port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
    return $?
  fi
  hex_port=$(printf '%04X' "$port")
  awk -v suffix=":$hex_port" \
    '$2 ~ suffix "$" && $4 == "0A" { found = 1 } END { exit found ? 0 : 1 }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}
pick_port() {
  start=$(cat "$PORT_FILE" 2>/dev/null || true)
  case "$start" in
    ''|*[!0-9]*) start="@@DEFAULT_REMOTE_PORT@@" ;;
  esac
  end=$((start + @@REMOTE_PORT_SCAN_WINDOW@@))
  port="$start"
  while [ "$port" -lt "$end" ]; do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null && wait_ready "$REMOTE_PORT" "@@REMOTE_REUSE_READY_TIMEOUT_MS@@"; then
  printf '{"remotePort":%s,"serverKind":"managed"}\n' "$REMOTE_PORT"
  exit 0
fi
REMOTE_PORT="$(pick_port)" || true
if [ -z "$REMOTE_PORT" ]; then
  printf 'Failed to find an available port on the remote host.\n' >&2
  exit 1
fi
nohup env T4CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
REMOTE_PID="$!"
printf '%s\n' "$REMOTE_PID" >"$PID_FILE"
printf '%s\n' "$REMOTE_PORT" >"$PORT_FILE"
printf 'managed\n' >"$MANAGED_FILE"
if ! wait_ready "$REMOTE_PORT" "@@REMOTE_READY_TIMEOUT_MS@@"; then
  printf 'Remote T4 server did not become ready on 127.0.0.1:%s.\n' "$REMOTE_PORT" >&2
  tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
  kill "$REMOTE_PID" 2>/dev/null || true
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
  exit 1
fi
printf '{"remotePort":%s,"serverKind":"managed"}\n' "$REMOTE_PORT"
"#;

const REMOTE_STOP_SCRIPT: &str = r#"set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.t4code/ssh-launch/$STATE_KEY"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
printf '{"stopped":true}\n'
"#;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentTarget {
    pub alias: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentEnsureOptions {
    pub issue_pairing_token: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentBootstrap {
    pub target: SshEnvironmentTarget,
    pub http_base_url: String,
    pub ws_base_url: String,
    pub pairing_token: Option<String>,
    pub remote_port: u16,
    pub remote_server_kind: &'static str,
}

impl SshEnvironmentBootstrap {
    pub fn new(
        target: SshEnvironmentTarget,
        remote_port: u16,
        http_base_url: String,
        ws_base_url: String,
        pairing_token: Option<String>,
        remote_server_kind: &'static str,
    ) -> Self {
        Self {
            target,
            http_base_url,
            ws_base_url,
            pairing_token,
            remote_port,
            remote_server_kind,
        }
    }

    pub fn external(
        target: SshEnvironmentTarget,
        remote_port: u16,
        http_base_url: String,
        ws_base_url: String,
        pairing_token: Option<String>,
    ) -> Self {
        Self::new(
            target,
            remote_port,
            http_base_url,
            ws_base_url,
            pairing_token,
            "external",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLaunchResult {
    pub remote_port: u16,
    pub server_kind: String,
}

impl RemoteLaunchResult {
    fn server_kind_static(&self) -> &'static str {
        if self.server_kind == "external" {
            "external"
        } else {
            "managed"
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLaunchResultDocument {
    remote_port: u64,
    server_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshAuthOptions {
    auth_secret: Option<String>,
    batch_mode: &'static str,
    interactive_auth: bool,
}

impl SshAuthOptions {
    pub fn batch() -> Self {
        Self {
            auth_secret: None,
            batch_mode: "yes",
            interactive_auth: false,
        }
    }

    pub fn with_secret(auth_secret: String) -> Self {
        Self {
            auth_secret: Some(auth_secret),
            batch_mode: "no",
            interactive_auth: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEnvironmentLaunchPlan {
    pub key: String,
    pub program: String,
    pub args: Vec<String>,
    pub target: SshEnvironmentTarget,
    pub local_port: u16,
    pub remote_port: u16,
    pub remote_server_kind: &'static str,
    pub http_base_url: String,
    pub ws_base_url: String,
}

impl SshEnvironmentLaunchPlan {
    pub fn external(target: SshEnvironmentTarget, local_port: u16) -> Result<Self, String> {
        Self::forward(
            target,
            local_port,
            RemoteLaunchResult {
                remote_port: DEFAULT_REMOTE_PORT,
                server_kind: "external".to_string(),
            },
        )
    }

    pub fn forward(
        target: SshEnvironmentTarget,
        local_port: u16,
        remote: RemoteLaunchResult,
    ) -> Result<Self, String> {
        Self::forward_with_auth(target, local_port, remote, &SshAuthOptions::batch())
    }

    pub fn forward_with_auth(
        target: SshEnvironmentTarget,
        local_port: u16,
        remote: RemoteLaunchResult,
        auth: &SshAuthOptions,
    ) -> Result<Self, String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let remote_port = remote.remote_port;
        let http_base_url = format!("http://127.0.0.1:{local_port}/");
        let ws_base_url = format!("ws://127.0.0.1:{local_port}/");
        let mut args = Vec::new();
        args.extend(base_ssh_args_with_auth(&target, auth));
        args.extend([
            "-o".to_string(),
            "ExitOnForwardFailure=yes".to_string(),
            "-o".to_string(),
            "ServerAliveInterval=15".to_string(),
            "-o".to_string(),
            "ServerAliveCountMax=3".to_string(),
            "-n".to_string(),
            "-N".to_string(),
            "-L".to_string(),
            format!("{local_port}:127.0.0.1:{remote_port}"),
        ]);
        args.push(build_ssh_host_spec(&target)?);

        Ok(Self {
            key,
            program: ssh_command().to_string(),
            args,
            target,
            local_port,
            remote_port,
            remote_server_kind: remote.server_kind_static(),
            http_base_url,
            ws_base_url,
        })
    }
}

struct ManagedSshTunnel {
    child: Child,
    bootstrap: SshEnvironmentBootstrap,
}

pub struct SshEnvironmentManager {
    tunnels: Mutex<HashMap<String, ManagedSshTunnel>>,
    auth_secrets: Mutex<HashMap<String, String>>,
}

impl Default for SshEnvironmentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SshEnvironmentManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            auth_secrets: Mutex::new(HashMap::new()),
        }
    }

    pub async fn ensure_environment(
        &self,
        app: &AppHandle,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
        options: Option<SshEnvironmentEnsureOptions>,
    ) -> Result<SshEnvironmentBootstrap, String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        if let Some(existing) = self.take_existing_bootstrap_if_running(&key)? {
            return Ok(existing);
        }

        let local_port = portpicker::pick_unused_port()
            .ok_or_else(|| "Could not find an available local SSH tunnel port.".to_string())?;
        let askpass_launcher = ensure_ssh_askpass_launcher()?;
        let remote_launch = self
            .run_with_ssh_auth(app, prompts, &key, &target, |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                async move { launch_or_reuse_remote_server(&target, &auth, &askpass_launcher).await }
            })
            .await?;
        let tunnel_result = self
            .run_with_ssh_auth(app, prompts, &key, &target, |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let remote_launch = remote_launch.clone();
                async move {
                    let plan = SshEnvironmentLaunchPlan::forward_with_auth(
                        target,
                        local_port,
                        remote_launch,
                        &auth,
                    )?;
                    let child = start_ssh_tunnel(&plan, &auth, &askpass_launcher).await?;
                    Ok((plan, child))
                }
            })
            .await;
        let (plan, child) = match tunnel_result {
            Ok(result) => result,
            Err(error) => {
                let cleanup_auth = self
                    .cached_auth_secret(&key)
                    .map(SshAuthOptions::with_secret)
                    .unwrap_or_else(SshAuthOptions::batch);
                let _ = stop_remote_server(&target, &cleanup_auth, &askpass_launcher).await;
                return Err(error);
            }
        };

        let pairing_token = if options
            .as_ref()
            .and_then(|options| options.issue_pairing_token)
            .unwrap_or(false)
        {
            Some(
                self.run_with_ssh_auth(app, prompts, &key, &target, |auth| {
                    let target = target.clone();
                    let askpass_launcher = askpass_launcher.clone();
                    async move { issue_remote_pairing_token(&target, &auth, &askpass_launcher).await }
                })
                .await?,
            )
        } else {
            None
        };
        let bootstrap = SshEnvironmentBootstrap::new(
            target,
            plan.remote_port,
            plan.http_base_url,
            plan.ws_base_url,
            pairing_token,
            plan.remote_server_kind,
        );
        self.tunnels
            .lock()
            .map_err(|error| format!("Could not record SSH tunnel: {error}"))?
            .insert(
                key,
                ManagedSshTunnel {
                    child,
                    bootstrap: bootstrap.clone(),
                },
            );
        Ok(bootstrap)
    }

    pub async fn disconnect_environment(
        &self,
        app: &AppHandle,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
    ) -> Result<(), String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let tunnel = self
            .tunnels
            .lock()
            .map_err(|error| format!("Could not access SSH tunnels: {error}"))?
            .remove(&key);
        if let Some(mut tunnel) = tunnel {
            terminate_child(&mut tunnel.child).await;
        }
        let askpass_launcher = ensure_ssh_askpass_launcher()?;
        self.run_with_ssh_auth(app, prompts, &key, &target, |auth| {
            let target = target.clone();
            let askpass_launcher = askpass_launcher.clone();
            async move { stop_remote_server(&target, &auth, &askpass_launcher).await }
        })
        .await?;
        Ok(())
    }

    fn cached_auth_secret(&self, key: &str) -> Option<String> {
        self.auth_secrets.lock().ok()?.get(key).cloned()
    }

    fn remember_auth_secret(&self, key: &str, secret: String) -> Result<(), String> {
        self.auth_secrets
            .lock()
            .map_err(|error| format!("Could not cache SSH authentication secret: {error}"))?
            .insert(key.to_string(), secret);
        Ok(())
    }

    fn clear_auth_secret(&self, key: &str) {
        if let Ok(mut secrets) = self.auth_secrets.lock() {
            secrets.remove(key);
        }
    }

    async fn prompt_for_password(
        &self,
        app: &AppHandle,
        prompts: &SshPasswordPromptManager,
        target: &SshEnvironmentTarget,
        attempt: u8,
    ) -> Result<String, String> {
        let destination = build_ssh_host_spec(target)?;
        let prompt = if attempt == 1 {
            format!("Enter the SSH password for {destination}.")
        } else {
            format!("SSH authentication failed. Enter the password for {destination} again.")
        };
        prompts
            .request_password(
                app,
                SshPasswordRequest {
                    destination,
                    username: target.username.clone(),
                    prompt,
                },
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn run_with_ssh_auth<T, F, Fut>(
        &self,
        app: &AppHandle,
        prompts: &SshPasswordPromptManager,
        key: &str,
        target: &SshEnvironmentTarget,
        mut operation: F,
    ) -> Result<T, String>
    where
        F: FnMut(SshAuthOptions) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let mut prompted_attempts = 0_u8;
        let mut auth = self
            .cached_auth_secret(key)
            .map(SshAuthOptions::with_secret)
            .unwrap_or_else(SshAuthOptions::batch);

        loop {
            match operation(auth.clone()).await {
                Ok(result) => return Ok(result),
                Err(error) if is_ssh_auth_failure(&error) => {
                    if auth.auth_secret.is_some() {
                        self.clear_auth_secret(key);
                    }
                    if prompted_attempts >= 2 {
                        return Err(error);
                    }
                    prompted_attempts += 1;
                    let secret = self
                        .prompt_for_password(app, prompts, target, prompted_attempts)
                        .await?;
                    self.remember_auth_secret(key, secret.clone())?;
                    auth = SshAuthOptions::with_secret(secret);
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn take_existing_bootstrap_if_running(
        &self,
        key: &str,
    ) -> Result<Option<SshEnvironmentBootstrap>, String> {
        let mut tunnels = self
            .tunnels
            .lock()
            .map_err(|error| format!("Could not access SSH tunnels: {error}"))?;
        let Some(tunnel) = tunnels.get_mut(key) else {
            return Ok(None);
        };
        match tunnel
            .child
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH tunnel process: {error}"))?
        {
            None => Ok(Some(tunnel.bootstrap.clone())),
            Some(_status) => {
                tunnels.remove(key);
                Ok(None)
            }
        }
    }
}

fn ssh_command() -> &'static str {
    if cfg!(windows) { "ssh.exe" } else { "ssh" }
}

fn normalize_ssh_environment_target(
    mut target: SshEnvironmentTarget,
) -> Result<SshEnvironmentTarget, String> {
    target.alias = target.alias.trim().to_string();
    target.hostname = target.hostname.trim().to_string();
    target.username = target
        .username
        .map(|username| username.trim().to_string())
        .filter(|username| !username.is_empty());
    if target.alias.is_empty() {
        target.alias = target.hostname.clone();
    }
    if target.hostname.is_empty() {
        target.hostname = target.alias.clone();
    }
    if target.alias.is_empty() || target.hostname.is_empty() {
        return Err("SSH target is missing its alias/hostname.".to_string());
    }
    Ok(target)
}

fn target_connection_key(target: &SshEnvironmentTarget) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        target.alias,
        target.hostname,
        target.username.as_deref().unwrap_or_default(),
        target.port.map(|port| port.to_string()).unwrap_or_default()
    )
}

fn remote_state_key(target: &SshEnvironmentTarget) -> String {
    let digest = Sha256::digest(target_connection_key(target).as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn build_ssh_host_spec(target: &SshEnvironmentTarget) -> Result<String, String> {
    let destination = if target.alias.trim().is_empty() {
        target.hostname.trim()
    } else {
        target.alias.trim()
    };
    if destination.is_empty() {
        return Err("SSH target is missing its alias/hostname.".to_string());
    }
    Ok(match target.username.as_deref() {
        Some(username) => format!("{username}@{destination}"),
        None => destination.to_string(),
    })
}

fn base_ssh_args_with_auth(target: &SshEnvironmentTarget, auth: &SshAuthOptions) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        format!("BatchMode={}", auth.batch_mode),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
    ];
    if let Some(port) = target.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args
}

fn build_ssh_child_environment(
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> HashMap<String, String> {
    if !auth.interactive_auth {
        return HashMap::new();
    }
    let mut environment = HashMap::new();
    environment.insert(
        "SSH_ASKPASS".to_string(),
        askpass_launcher.to_string_lossy().into_owned(),
    );
    environment.insert("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string());
    if let Some(secret) = &auth.auth_secret {
        environment.insert("T4CODE_SSH_AUTH_SECRET".to_string(), secret.clone());
    }
    if !cfg!(windows) && env::var_os("DISPLAY").is_none() {
        environment.insert("DISPLAY".to_string(), "t4code".to_string());
    }
    environment
}

fn is_ssh_auth_failure(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("authentication failed")
        || normalized.contains("too many authentication failures")
        || (normalized.contains("permission denied (")
            && (normalized.contains("password")
                || normalized.contains("keyboard-interactive")
                || normalized.contains("publickey")
                || normalized.contains("hostbased")
                || normalized.contains("gssapi-with-mic")))
}

fn ensure_ssh_askpass_launcher() -> Result<PathBuf, String> {
    let directory = env::temp_dir()
        .join(format!("t4code-ssh-runtime-{}", std::process::id()))
        .join("t4code-ssh-askpass");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create SSH askpass directory: {error}"))?;
    if cfg!(windows) {
        let launcher = directory.join("ssh-askpass.cmd");
        let script = directory.join("ssh-askpass.ps1");
        write_askpass_file(&launcher, ASKPASS_WINDOWS_LAUNCHER_SCRIPT, None)?;
        write_askpass_file(&script, ASKPASS_WINDOWS_SCRIPT, None)?;
        Ok(launcher)
    } else {
        let launcher = directory.join("ssh-askpass.sh");
        write_askpass_file(&launcher, ASKPASS_POSIX_SCRIPT, Some(0o700))?;
        Ok(launcher)
    }
}

fn write_askpass_file(path: &Path, contents: &str, mode: Option<u32>) -> Result<(), String> {
    let existing = fs::read_to_string(path).ok();
    if existing.as_deref() != Some(contents) {
        fs::write(path, contents)
            .map_err(|error| format!("Failed to write SSH askpass helper: {error}"))?;
    }
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Failed to chmod SSH askpass helper: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

fn build_remote_launch_script() -> String {
    REMOTE_LAUNCH_SCRIPT
        .replace("@@DEFAULT_REMOTE_PORT@@", &DEFAULT_REMOTE_PORT.to_string())
        .replace(
            "@@REMOTE_PORT_SCAN_WINDOW@@",
            &REMOTE_PORT_SCAN_WINDOW.to_string(),
        )
        .replace(
            "@@REMOTE_REUSE_READY_TIMEOUT_MS@@",
            &REMOTE_REUSE_READY_TIMEOUT_MS.to_string(),
        )
        .replace(
            "@@REMOTE_READY_TIMEOUT_MS@@",
            &REMOTE_READY_TIMEOUT_MS.to_string(),
        )
}

async fn run_remote_ssh_script(
    target: &SshEnvironmentTarget,
    script: &str,
    script_args: &[String],
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
    operation: &str,
) -> Result<String, String> {
    let host_spec = build_ssh_host_spec(target)?;
    let mut args = base_ssh_args_with_auth(target, auth);
    args.push(host_spec);
    args.extend(["sh".to_string(), "-s".to_string(), "--".to_string()]);
    args.extend(script_args.iter().cloned());

    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    command
        .args(args)
        .envs(build_ssh_child_environment(auth, askpass_launcher))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to run SSH {operation} command: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("SSH {operation} command did not expose stdin."))?;
    stdin
        .write_all(script.as_bytes())
        .await
        .map_err(|error| format!("Failed to write SSH {operation} script: {error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("Failed to wait for SSH {operation} command: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "SSH {operation} command failed with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn last_non_empty_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).rfind(|line| !line.is_empty())
}

pub fn parse_remote_pairing_credential(output: &str) -> Result<String, String> {
    let line = last_non_empty_line(output)
        .ok_or_else(|| "SSH pairing did not return a credential.".to_string())?;
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("SSH pairing returned unparseable output: {error}"))?;
    let credential = value
        .get("credential")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if credential.is_empty() {
        return Err("SSH pairing command returned an invalid credential.".to_string());
    }
    Ok(credential)
}

pub fn parse_remote_launch_result(output: &str) -> Result<RemoteLaunchResult, String> {
    let line = last_non_empty_line(output)
        .ok_or_else(|| "SSH launch did not return a remote port.".to_string())?;
    let value: RemoteLaunchResultDocument = serde_json::from_str(line)
        .map_err(|error| format!("SSH launch returned unparseable output: {error}"))?;
    let remote_port = u16::try_from(value.remote_port)
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| {
            format!(
                "SSH launch returned an invalid remote port: {}.",
                value.remote_port
            )
        })?;
    let server_kind = value.server_kind.unwrap_or_else(|| "managed".to_string());
    if !matches!(server_kind.as_str(), "external" | "managed") {
        return Err(format!(
            "SSH launch returned an invalid remote server kind: {server_kind}."
        ));
    }
    Ok(RemoteLaunchResult {
        remote_port,
        server_kind,
    })
}

async fn launch_or_reuse_remote_server(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> Result<RemoteLaunchResult, String> {
    let state_key = remote_state_key(target);
    let output = run_remote_ssh_script(
        target,
        &build_remote_launch_script(),
        &[state_key],
        auth,
        askpass_launcher,
        "launch",
    )
    .await?;
    parse_remote_launch_result(&output)
}

async fn stop_remote_server(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> Result<(), String> {
    let state_key = remote_state_key(target);
    run_remote_ssh_script(
        target,
        REMOTE_STOP_SCRIPT,
        &[state_key],
        auth,
        askpass_launcher,
        "stop",
    )
    .await
    .map(|_| ())
}

async fn issue_remote_pairing_token(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> Result<String, String> {
    let host_spec = build_ssh_host_spec(target)?;
    let mut args = base_ssh_args_with_auth(target, auth);
    args.push(host_spec);
    args.extend([
        "sh".to_string(),
        "-lc".to_string(),
        "t4code auth pairing create --base-dir \"$HOME/.t4code\" --json".to_string(),
    ]);
    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    let output = command
        .args(args)
        .envs(build_ssh_child_environment(auth, askpass_launcher))
        .output()
        .await
        .map_err(|error| format!("Failed to run SSH pairing command: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "SSH pairing command failed with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    parse_remote_pairing_credential(&String::from_utf8_lossy(&output.stdout))
}

async fn start_ssh_tunnel(
    plan: &SshEnvironmentLaunchPlan,
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> Result<Child, String> {
    let mut command = Command::new(&plan.program);
    configure_background_command(&mut command);
    let mut child = command
        .args(&plan.args)
        .envs(build_ssh_child_environment(auth, askpass_launcher))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Failed to start SSH tunnel: {error}"))?;

    if let Err(error) = wait_for_ssh_tunnel_ready(&mut child, &plan.http_base_url).await {
        terminate_child(&mut child).await;
        return Err(error);
    }

    Ok(child)
}

async fn wait_for_ssh_tunnel_ready(child: &mut Child, http_base_url: &str) -> Result<(), String> {
    let mut url = url::Url::parse(http_base_url)
        .map_err(|error| format!("Could not parse SSH tunnel URL: {error}"))?;
    url.set_path(SSH_READY_PATH);
    url.set_query(None);
    url.set_fragment(None);
    let client = reqwest::Client::builder()
        .timeout(SSH_READY_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Could not create SSH readiness client: {error}"))?;
    let start = std::time::Instant::now();
    let mut last_error = String::new();
    while start.elapsed() <= SSH_READY_TIMEOUT {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH tunnel process: {error}"))?
        {
            let stderr = read_child_stderr(child).await;
            return Err(format!(
                "SSH tunnel exited before becoming ready with status {status}: {stderr}"
            ));
        }
        match client.get(url.clone()).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = format!("HTTP {}", response.status().as_u16());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
        tokio::time::sleep(SSH_READY_INTERVAL).await;
    }
    Err(format!(
        "SSH tunnel did not become ready at {http_base_url}: {last_error}"
    ))
}

async fn read_child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    if stderr.read_to_string(&mut output).await.is_err() {
        return String::new();
    }
    output.trim().to_string()
}

async fn terminate_child(child: &mut Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(SSH_TUNNEL_SHUTDOWN_TIMEOUT, child.wait()).await;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPasswordRequest {
    pub destination: String,
    pub username: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordPromptPayload {
    pub request_id: String,
    pub destination: String,
    pub username: Option<String>,
    pub prompt: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPasswordPromptResolution {
    pub request_id: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPasswordPromptRequestError {
    Presentation {
        request_id: String,
        destination: String,
        operation: &'static str,
        message: String,
    },
    TimedOut {
        request_id: String,
        destination: String,
    },
    Cancelled {
        request_id: String,
        destination: String,
    },
    ServiceStopped {
        request_id: String,
        destination: String,
    },
}

impl std::fmt::Display for SshPasswordPromptRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Presentation {
                destination,
                operation,
                message,
                ..
            } => write!(
                formatter,
                "Failed to present SSH password prompt for {destination} during {operation}: {message}"
            ),
            Self::TimedOut { destination, .. } => {
                write!(formatter, "SSH authentication timed out for {destination}.")
            }
            Self::Cancelled { destination, .. } => {
                write!(formatter, "SSH authentication cancelled for {destination}.")
            }
            Self::ServiceStopped { .. } => {
                formatter.write_str("SSH password prompt service stopped.")
            }
        }
    }
}

impl std::error::Error for SshPasswordPromptRequestError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPasswordPromptResolveError {
    InvalidRequestId,
    Expired { request_id: String },
}

impl std::fmt::Display for SshPasswordPromptResolveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequestId => formatter.write_str("Invalid SSH password prompt id."),
            Self::Expired { .. } => {
                formatter.write_str("SSH password prompt expired. Try connecting again.")
            }
        }
    }
}

impl std::error::Error for SshPasswordPromptResolveError {}

type PendingPromptResult = Result<String, SshPasswordPromptRequestError>;

struct PendingSshPasswordPrompt {
    destination: String,
    sender: oneshot::Sender<PendingPromptResult>,
}

#[derive(Clone)]
pub struct SshPasswordPromptManager {
    pending: Arc<Mutex<HashMap<String, PendingSshPasswordPrompt>>>,
    timeout: Duration,
}

impl Default for SshPasswordPromptManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SshPasswordPromptManager {
    pub fn new() -> Self {
        Self::with_timeout(DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT)
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            timeout,
        }
    }

    pub async fn request_password(
        &self,
        app: &AppHandle,
        request: SshPasswordRequest,
    ) -> PendingPromptResult {
        let request_id = Uuid::new_v4().simple().to_string();
        self.request_password_with(request_id, request, SystemTime::now(), |payload| {
            app.emit(SSH_PASSWORD_PROMPT_EVENT, payload)
                .map_err(|error| error.to_string())
        })
        .await
    }

    pub(crate) async fn request_password_with(
        &self,
        request_id: String,
        request: SshPasswordRequest,
        requested_at: SystemTime,
        emit: impl FnOnce(SshPasswordPromptPayload) -> Result<(), String>,
    ) -> PendingPromptResult {
        let expires_at = format_system_time(
            requested_at
                .checked_add(self.timeout)
                .unwrap_or(requested_at),
        );
        let payload = SshPasswordPromptPayload {
            request_id: request_id.clone(),
            destination: request.destination.clone(),
            username: request.username.clone(),
            prompt: request.prompt,
            expires_at,
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|error| {
                SshPasswordPromptRequestError::Presentation {
                    request_id: request_id.clone(),
                    destination: request.destination.clone(),
                    operation: "lock-pending-prompts",
                    message: error.to_string(),
                }
            })?;
            pending.insert(
                request_id.clone(),
                PendingSshPasswordPrompt {
                    destination: request.destination.clone(),
                    sender,
                },
            );
        }

        if let Err(message) = emit(payload) {
            self.remove_pending(&request_id);
            return Err(SshPasswordPromptRequestError::Presentation {
                request_id,
                destination: request.destination,
                operation: "send-prompt-request",
                message,
            });
        }

        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_closed)) => Err(SshPasswordPromptRequestError::ServiceStopped {
                request_id,
                destination: request.destination,
            }),
            Err(_elapsed) => {
                self.remove_pending(&request_id);
                Err(SshPasswordPromptRequestError::TimedOut {
                    request_id,
                    destination: request.destination,
                })
            }
        }
    }

    pub fn resolve(
        &self,
        input: SshPasswordPromptResolution,
    ) -> Result<(), SshPasswordPromptResolveError> {
        let request_id = input.request_id.trim().to_string();
        if request_id.is_empty() {
            return Err(SshPasswordPromptResolveError::InvalidRequestId);
        }
        let Some(pending) = self.remove_pending(&request_id) else {
            return Err(SshPasswordPromptResolveError::Expired { request_id });
        };
        let result = match input.password {
            Some(password) => Ok(password),
            None => Err(SshPasswordPromptRequestError::Cancelled {
                request_id: request_id.clone(),
                destination: pending.destination.clone(),
            }),
        };
        let _ = pending.sender.send(result);
        Ok(())
    }

    fn remove_pending(&self, request_id: &str) -> Option<PendingSshPasswordPrompt> {
        self.pending.lock().ok()?.remove(request_id)
    }
}

fn format_system_time(system_time: SystemTime) -> String {
    let duration = system_time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = i64::try_from(duration.as_secs()).unwrap_or(i64::MAX);
    OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSshHost {
    pub alias: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub source: &'static str,
}

impl DiscoveredSshHost {
    pub fn to_value(&self) -> Value {
        json!({
            "alias": &self.alias,
            "hostname": &self.hostname,
            "username": &self.username,
            "port": self.port,
            "source": self.source,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshConfigLineParseError {
    InvalidQuotes,
}

fn split_directive_args(value: &str) -> Result<Vec<String>, SshConfigLineParseError> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut characters = value.chars().peekable();

    while let Some(character) = characters.next() {
        if let Some(delimiter) = quote {
            match character {
                '\\' if characters.peek().is_some_and(|next| *next == delimiter) => {
                    current.push(delimiter);
                    characters.next();
                }
                value if value == delimiter => quote = None,
                value => current.push(value),
            }
            continue;
        }

        match character {
            '\\' if characters
                .peek()
                .is_some_and(|next| next.is_whitespace() || *next == '#') =>
            {
                current.push(
                    characters
                        .next()
                        .expect("peeked escaped value should exist"),
                );
            }
            '\'' | '"' => quote = Some(character),
            '#' if current.is_empty() => break,
            '#' => current.push(character),
            '=' if args.is_empty() && !current.is_empty() => {
                args.push(std::mem::take(&mut current));
            }
            '=' if args.len() == 1 && current.is_empty() => {}
            value if value.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }

    if quote.is_some() {
        return Err(SshConfigLineParseError::InvalidQuotes);
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn has_ssh_pattern(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.starts_with('!')
}

fn expand_home_path(input: &str, home_dir: &Path) -> PathBuf {
    if input == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        return home_dir.join(rest);
    }
    PathBuf::from(input)
}

fn resolve_ssh_config_include_pattern(include_pattern: &str, home_dir: &Path) -> PathBuf {
    let expanded_pattern = expand_home_path(include_pattern, home_dir);
    if expanded_pattern.is_absolute() {
        expanded_pattern
    } else {
        home_dir.join(SSH_DIRECTORY_NAME).join(expanded_pattern)
    }
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    fn matches_inner(pattern: &[char], value: &[char]) -> bool {
        match pattern.split_first() {
            None => value.is_empty(),
            Some(('*', rest)) => {
                matches_inner(rest, value)
                    || (!value.is_empty() && matches_inner(pattern, &value[1..]))
            }
            Some(('?', rest)) => !value.is_empty() && matches_inner(rest, &value[1..]),
            Some((expected, rest)) => value
                .split_first()
                .is_some_and(|(actual, tail)| actual == expected && matches_inner(rest, tail)),
        }
    }

    matches_inner(
        &pattern.chars().collect::<Vec<_>>(),
        &value.chars().collect::<Vec<_>>(),
    )
}

fn expand_glob(pattern: &Path) -> io::Result<Vec<PathBuf>> {
    let pattern_text = pattern.to_string_lossy();
    if !pattern_text.contains('*') && !pattern_text.contains('?') {
        return Ok(if pattern.exists() {
            vec![pattern.to_path_buf()]
        } else {
            Vec::new()
        });
    }

    let directory = pattern.parent().unwrap_or_else(|| Path::new("."));
    let Some(file_pattern) = pattern.file_name().and_then(|value| value.to_str()) else {
        return Ok(Vec::new());
    };
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if wildcard_matches(file_pattern, file_name) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn collect_ssh_config_aliases_from_file(
    file_path: &Path,
    home_dir: &Path,
    visited: &mut BTreeSet<PathBuf>,
) -> io::Result<BTreeSet<String>> {
    let resolved_path = file_path.to_path_buf();
    if visited.contains(&resolved_path) || !resolved_path.exists() {
        return Ok(BTreeSet::new());
    }
    visited.insert(resolved_path.clone());

    let mut aliases = BTreeSet::new();
    let raw = fs::read_to_string(&resolved_path)?;
    for line in raw.lines() {
        let Ok(parsed_args) = split_directive_args(line) else {
            continue;
        };
        let mut args = parsed_args.into_iter();
        let directive = args.next().unwrap_or_default().to_ascii_lowercase();
        if directive == "include" {
            for include_pattern in args {
                let resolved_pattern =
                    resolve_ssh_config_include_pattern(&include_pattern, home_dir);
                for included_path in expand_glob(&resolved_pattern)? {
                    aliases.extend(collect_ssh_config_aliases_from_file(
                        &included_path,
                        home_dir,
                        visited,
                    )?);
                }
            }
            continue;
        }

        if directive != "host" {
            continue;
        }

        for alias in args {
            if alias.is_empty() || has_ssh_pattern(&alias) {
                continue;
            }
            aliases.insert(alias);
        }
    }

    Ok(aliases)
}

fn normalize_known_hosts_hostname(raw_host: &str) -> String {
    if let Some(rest) = raw_host.strip_prefix('[')
        && let Some((host, _port)) = rest.split_once("]:")
    {
        return host.to_string();
    }

    if !raw_host.contains(':') {
        return raw_host.to_string();
    }

    let first_colon_index = raw_host.find(':');
    let last_colon_index = raw_host.rfind(':');
    if first_colon_index == last_colon_index {
        raw_host
            .split_once(':')
            .map_or_else(|| raw_host.to_string(), |(host, _port)| host.to_string())
    } else {
        raw_host.to_string()
    }
}

pub fn parse_known_hosts_hostnames(raw: &str) -> BTreeSet<String> {
    let mut hostnames = BTreeSet::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let without_marker = if trimmed.starts_with('@') {
            trimmed
                .split_whitespace()
                .skip(1)
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            trimmed.to_string()
        };
        let host_field = without_marker.split_whitespace().next().unwrap_or_default();
        if host_field.is_empty() || host_field.starts_with('|') {
            continue;
        }

        for raw_host in host_field.split(',') {
            let host = normalize_known_hosts_hostname(raw_host).trim().to_string();
            if host.is_empty() || has_ssh_pattern(&host) {
                continue;
            }
            hostnames.insert(host);
        }
    }

    hostnames
}

fn read_known_hosts_hostnames(file_path: &Path) -> io::Result<BTreeSet<String>> {
    match fs::read_to_string(file_path) {
        Ok(raw) => Ok(parse_known_hosts_hostnames(&raw)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}

pub fn default_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

pub fn discover_ssh_hosts(home_dir: Option<PathBuf>) -> Result<Vec<DiscoveredSshHost>, String> {
    let Some(home_dir) = home_dir else {
        return Ok(Vec::new());
    };
    if home_dir.as_os_str().is_empty() {
        return Ok(Vec::new());
    }

    let ssh_directory = home_dir.join(SSH_DIRECTORY_NAME);
    let config_aliases = collect_ssh_config_aliases_from_file(
        &ssh_directory.join(SSH_CONFIG_FILE_NAME),
        &home_dir,
        &mut BTreeSet::new(),
    )
    .map_err(|error| format!("Failed to read SSH config hosts: {error}"))?;
    let known_hosts = read_known_hosts_hostnames(&ssh_directory.join(KNOWN_HOSTS_FILE_NAME))
        .map_err(|error| format!("Failed to read known SSH hosts: {error}"))?;
    let mut discovered = BTreeMap::new();

    for alias in config_aliases {
        discovered.insert(
            alias.clone(),
            DiscoveredSshHost {
                alias: alias.clone(),
                hostname: alias,
                username: None,
                port: None,
                source: "ssh-config",
            },
        );
    }

    for hostname in known_hosts {
        discovered
            .entry(hostname.clone())
            .or_insert_with(|| DiscoveredSshHost {
                alias: hostname.clone(),
                hostname,
                username: None,
                port: None,
                source: "known-hosts",
            });
    }

    Ok(discovered.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn unique_temp_home() -> PathBuf {
        std::env::temp_dir().join(format!(
            "t4code-tauri-ssh-test-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn discovers_ssh_config_hosts_across_included_files() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        fs::create_dir_all(ssh_dir.join("config.d")).expect("ssh config dir should create");
        fs::write(
            ssh_dir.join("config"),
            [
                "Host devbox",
                "  HostName devbox.example.com",
                "Host=equalsbox",
                "Include=config.d/*.conf",
                "",
            ]
            .join("\n"),
        )
        .expect("ssh config should write");
        fs::write(
            ssh_dir.join("config.d").join("team.conf"),
            [
                "Host staging",
                "  HostName staging.example.com",
                "Host *",
                "  ServerAliveInterval 30",
                "",
            ]
            .join("\n"),
        )
        .expect("included ssh config should write");
        fs::write(
            ssh_dir.join("known_hosts"),
            [
                "known.example.com ssh-ed25519 AAAA",
                "|1|hashed|entry ssh-ed25519 AAAA",
                "[bastion.example.com]:2222 ssh-ed25519 AAAA",
                "",
            ]
            .join("\n"),
        )
        .expect("known hosts should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![
                DiscoveredSshHost {
                    alias: "bastion.example.com".to_string(),
                    hostname: "bastion.example.com".to_string(),
                    username: None,
                    port: None,
                    source: "known-hosts",
                },
                DiscoveredSshHost {
                    alias: "devbox".to_string(),
                    hostname: "devbox".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
                DiscoveredSshHost {
                    alias: "equalsbox".to_string(),
                    hostname: "equalsbox".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
                DiscoveredSshHost {
                    alias: "known.example.com".to_string(),
                    hostname: "known.example.com".to_string(),
                    username: None,
                    port: None,
                    source: "known-hosts",
                },
                DiscoveredSshHost {
                    alias: "staging".to_string(),
                    hostname: "staging".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
            ]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn discovers_ssh_config_hosts_from_quoted_include_paths() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("quoted include dir should create");
        fs::write(ssh_dir.join("config"), "Include \"config dir/team.conf\"\n")
            .expect("ssh config should write");
        fs::write(include_dir.join("team.conf"), "Host quoted-include\n")
            .expect("included ssh config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "quoted-include".to_string(),
                hostname: "quoted-include".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_hashes_inside_quoted_ssh_include_paths() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config #archive");
        fs::create_dir_all(&include_dir).expect("quoted include dir should create");
        fs::write(
            ssh_dir.join("config"),
            "Include \"config #archive/team.conf\" # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("team.conf"), "Host hash-include\n")
            .expect("included ssh config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "hash-include".to_string(),
                hostname: "hash-include".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_windows_backslashes_in_quoted_include_paths() {
        assert_eq!(
            split_directive_args(
                r#"Include "C:\Users\mauro\.ssh\config dir\team.conf" # trailing comment"#,
            ),
            Ok(vec![
                "Include".to_string(),
                r"C:\Users\mauro\.ssh\config dir\team.conf".to_string(),
            ])
        );
    }

    #[test]
    fn unquoted_backslash_escaped_whitespace_stays_in_one_include_token() {
        assert_eq!(
            split_directive_args(r"Include config\ dir/*.conf"),
            Ok(vec!["Include".to_string(), "config dir/*.conf".to_string(),])
        );
    }

    #[test]
    fn escaped_hash_stays_inside_an_unquoted_include_path() {
        assert_eq!(
            split_directive_args(r"Include config\#archive\team.conf"),
            Ok(vec![
                "Include".to_string(),
                r"config#archive\team.conf".to_string(),
            ])
        );
    }

    #[test]
    fn hash_starts_comments_only_at_token_boundaries() {
        assert_eq!(split_directive_args("# full-line comment"), Ok(Vec::new()));
        assert_eq!(
            split_directive_args("Include # token-leading comment"),
            Ok(vec!["Include".to_string()])
        );
        assert_eq!(
            split_directive_args("Include config#archive.conf # trailing comment"),
            Ok(vec![
                "Include".to_string(),
                "config#archive.conf".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args(r"Include \#literal.conf # trailing comment"),
            Ok(vec!["Include".to_string(), "#literal.conf".to_string()])
        );
    }

    #[cfg(windows)]
    #[test]
    fn discovers_unquoted_escaped_windows_include_globs_before_trailing_comments() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            r"  Include config\ dir\config\#*.conf # trailing comment",
        )
        .expect("ssh config should write");
        fs::write(
            include_dir.join("config#team.conf"),
            "Host escaped-windows-glob\n",
        )
        .expect("included config should write");
        fs::write(include_dir.join("config-team.conf"), "Host ignored\n")
            .expect("non-matching config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "escaped-windows-glob".to_string(),
                hostname: "escaped-windows-glob".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[cfg(windows)]
    #[test]
    fn discovers_windows_style_include_globs_with_whitespace_and_comments() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            "  Include   \"config dir\\*.conf\"   # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("alpha.conf"), "Host windows-alpha\n")
            .expect("alpha config should write");
        fs::write(include_dir.join("beta.txt"), "Host ignored\n")
            .expect("non-matching config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "windows-alpha".to_string(),
                hostname: "windows-alpha".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_equals_inside_include_filenames() {
        assert_eq!(
            split_directive_args("  Include   config=name.conf   # comment"),
            Ok(vec!["Include".to_string(), "config=name.conf".to_string(),])
        );
        assert_eq!(
            split_directive_args("Include=config=name.conf # comment"),
            Ok(vec!["Include".to_string(), "config=name.conf".to_string(),])
        );
    }

    #[test]
    fn discovers_include_globs_with_equals_in_filenames() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("ssh directory should create");
        fs::write(
            ssh_dir.join("config"),
            "  Include   config=*.conf   # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(ssh_dir.join("config=team.conf"), "Host equals-glob\n")
            .expect("included config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "equals-glob".to_string(),
                hostname: "equals-glob".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn rejects_unterminated_ssh_config_quotes() {
        assert_eq!(
            split_directive_args(r#"Include "config dir/*.conf"#),
            Err(SshConfigLineParseError::InvalidQuotes)
        );
        assert_eq!(
            split_directive_args("Host 'unterminated"),
            Err(SshConfigLineParseError::InvalidQuotes)
        );
    }

    #[test]
    fn ignores_entire_include_line_when_any_quote_is_unterminated() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config.d");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            [
                "# keep comments independent from malformed directives",
                "  Include config.d/*.conf \"unterminated#still-quoted",
                "Host direct-host",
                "",
            ]
            .join("\n"),
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("leaked.conf"), "Host must-not-leak\n")
            .expect("included config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "direct-host".to_string(),
                hostname: "direct-host".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn parses_known_hosts_entries_without_hashed_hosts() {
        assert_eq!(
            parse_known_hosts_hostnames(
                [
                    "github.com ssh-ed25519 AAAA",
                    "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
                    "|1|hashed|entry ssh-ed25519 CCCC",
                    "@cert-authority *.example.com ssh-ed25519 DDDD",
                    "[ssh.example.com]:2200 ssh-ed25519 EEEE",
                    "port.example.com:22 ssh-ed25519 HHHH",
                    "::1 ssh-ed25519 FFFF",
                    "2001:db8::1 ssh-ed25519 GGGG",
                    "",
                ]
                .join("\n")
                .as_str(),
            ),
            BTreeSet::from([
                "::1".to_string(),
                "2001:db8::1".to_string(),
                "github.com".to_string(),
                "gitlab-alias".to_string(),
                "gitlab.com".to_string(),
                "port.example.com".to_string(),
                "ssh.example.com".to_string(),
            ])
        );
    }

    #[tokio::test]
    async fn password_prompt_request_emits_payload_and_resolves_with_password() {
        let manager = SshPasswordPromptManager::with_timeout(std::time::Duration::from_secs(30));
        let resolver = manager.clone();
        let emitted = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let emitted_for_request = emitted.clone();
        let request = SshPasswordRequest {
            destination: "example.com".to_string(),
            username: Some("alice".to_string()),
            prompt: "alice@example.com's password:".to_string(),
        };

        let task = tokio::spawn(async move {
            manager
                .request_password_with(
                    "req-1".to_string(),
                    request,
                    std::time::SystemTime::UNIX_EPOCH,
                    move |payload| {
                        emitted_for_request
                            .lock()
                            .expect("emitted mutex")
                            .push(payload);
                        Ok(())
                    },
                )
                .await
        });
        tokio::task::yield_now().await;

        assert_eq!(emitted.lock().expect("emitted mutex").len(), 1);
        assert_eq!(
            emitted.lock().expect("emitted mutex")[0],
            SshPasswordPromptPayload {
                request_id: "req-1".to_string(),
                destination: "example.com".to_string(),
                username: Some("alice".to_string()),
                prompt: "alice@example.com's password:".to_string(),
                expires_at: "1970-01-01T00:00:30Z".to_string(),
            }
        );

        assert_eq!(
            resolver.resolve(SshPasswordPromptResolution {
                request_id: "req-1".to_string(),
                password: Some("hunter2".to_string()),
            }),
            Ok(())
        );
        assert_eq!(task.await.expect("prompt task"), Ok("hunter2".to_string()));
    }

    #[tokio::test]
    async fn password_prompt_resolution_rejects_blank_or_expired_ids() {
        let manager = SshPasswordPromptManager::new();

        assert_eq!(
            manager.resolve(SshPasswordPromptResolution {
                request_id: "   ".to_string(),
                password: Some("ignored".to_string()),
            }),
            Err(SshPasswordPromptResolveError::InvalidRequestId)
        );
        assert_eq!(
            manager.resolve(SshPasswordPromptResolution {
                request_id: "missing".to_string(),
                password: None,
            }),
            Err(SshPasswordPromptResolveError::Expired {
                request_id: "missing".to_string(),
            })
        );
    }

    #[test]
    fn builds_external_ssh_tunnel_launch_plan_with_exact_arguments() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        let plan = SshEnvironmentLaunchPlan::external(target.clone(), 45123)
            .expect("launch plan should build");

        assert_eq!(plan.key, "devbox\u{0}devbox.internal\u{0}alice\u{0}2222");
        assert_eq!(plan.program, ssh_command());
        assert_eq!(
            plan.args,
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-p",
                "2222",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-n",
                "-N",
                "-L",
                "45123:127.0.0.1:3773",
                "alice@devbox",
            ]
        );
        assert_eq!(plan.target, target);
        assert_eq!(plan.remote_port, 3773);
        assert_eq!(plan.http_base_url, "http://127.0.0.1:45123/");
        assert_eq!(plan.ws_base_url, "ws://127.0.0.1:45123/");
    }

    #[test]
    fn detects_ssh_password_auth_failures() {
        assert!(is_ssh_auth_failure(
            "Permission denied (publickey,password,keyboard-interactive)."
        ));
        assert!(is_ssh_auth_failure("Authentication failed."));
        assert!(is_ssh_auth_failure("Too many authentication failures"));
        assert!(!is_ssh_auth_failure("Connection timed out."));
    }

    #[test]
    fn builds_batch_mode_args_from_auth_options() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        assert_eq!(
            base_ssh_args_with_auth(&target, &SshAuthOptions::batch()),
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-p",
                "2222",
            ]
        );
        assert_eq!(
            base_ssh_args_with_auth(&target, &SshAuthOptions::with_secret("hunter2".to_string()))
                [1],
            "BatchMode=no",
        );
    }

    #[test]
    fn builds_askpass_environment_for_cached_password() {
        let environment = build_ssh_child_environment(
            &SshAuthOptions::with_secret("hunter2".to_string()),
            Path::new("C:/tmp/t4code-ssh/ssh-askpass.cmd"),
        );

        assert_eq!(
            environment
                .get("T4CODE_SSH_AUTH_SECRET")
                .map(String::as_str),
            Some("hunter2")
        );
        assert_eq!(
            environment.get("SSH_ASKPASS_REQUIRE").map(String::as_str),
            Some("force")
        );
        assert_eq!(
            environment.get("SSH_ASKPASS").map(String::as_str),
            Some("C:/tmp/t4code-ssh/ssh-askpass.cmd")
        );
    }

    #[test]
    fn remote_state_key_matches_typescript_manager() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        assert_eq!(remote_state_key(&target), "a39af6c8b8cc1930");
    }

    #[test]
    fn remote_launch_uses_only_the_native_t4code_runtime() {
        for forbidden in [
            "node -",
            "command -v node",
            "command -v npm",
            "command -v npx",
            "t4code@latest",
        ] {
            assert!(
                !REMOTE_LAUNCH_SCRIPT.contains(forbidden),
                "remote launch script must not contain {forbidden}"
            );
        }
        assert!(REMOTE_LAUNCH_SCRIPT.contains("command -v t4code"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("native t4code CLI"));
    }

    #[test]
    fn serializes_external_ssh_bootstrap_shape() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: None,
            port: None,
        };
        let bootstrap = SshEnvironmentBootstrap::external(
            target.clone(),
            3773,
            "http://127.0.0.1:45123/".to_string(),
            "ws://127.0.0.1:45123/".to_string(),
            Some("pairing-token".to_string()),
        );

        assert_eq!(
            serde_json::to_value(&bootstrap).expect("bootstrap should serialize"),
            json!({
                "target": {
                    "alias": "devbox",
                    "hostname": "devbox.internal",
                    "username": null,
                    "port": null,
                },
                "httpBaseUrl": "http://127.0.0.1:45123/",
                "wsBaseUrl": "ws://127.0.0.1:45123/",
                "pairingToken": "pairing-token",
                "remotePort": 3773,
                "remoteServerKind": "external",
            })
        );
    }

    #[test]
    fn parses_remote_launch_json_from_last_non_empty_line() {
        assert_eq!(
            parse_remote_launch_result(
                "banner\n{\"remotePort\":4111,\"serverKind\":\"managed\"}\n"
            )
            .expect("launch result should parse"),
            RemoteLaunchResult {
                remote_port: 4111,
                server_kind: "managed".to_string(),
            }
        );
        assert!(parse_remote_launch_result("{\"remotePort\":0}\n").is_err());
        assert!(
            parse_remote_launch_result("{\"remotePort\":3773,\"serverKind\":\"bogus\"}\n").is_err()
        );
    }

    #[test]
    fn serializes_managed_ssh_bootstrap_shape() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: None,
            port: None,
        };
        let bootstrap = SshEnvironmentBootstrap::new(
            target.clone(),
            4111,
            "http://127.0.0.1:45123/".to_string(),
            "ws://127.0.0.1:45123/".to_string(),
            None,
            "managed",
        );

        assert_eq!(
            serde_json::to_value(&bootstrap).expect("bootstrap should serialize"),
            json!({
                "target": {
                    "alias": "devbox",
                    "hostname": "devbox.internal",
                    "username": null,
                    "port": null,
                },
                "httpBaseUrl": "http://127.0.0.1:45123/",
                "wsBaseUrl": "ws://127.0.0.1:45123/",
                "pairingToken": null,
                "remotePort": 4111,
                "remoteServerKind": "managed",
            })
        );
    }

    #[test]
    fn parses_remote_pairing_json_from_last_non_empty_line() {
        assert_eq!(
            parse_remote_pairing_credential(
                "warning: shell banner\n{\"credential\":\"pairing-token\"}\n"
            ),
            Ok("pairing-token".to_string())
        );
        assert!(parse_remote_pairing_credential("{\"credential\":\"\"}\n").is_err());
    }

    #[test]
    fn normalizes_targets_and_builds_managed_password_launch_plans() {
        let hostname_only = normalize_ssh_environment_target(SshEnvironmentTarget {
            alias: "  ".to_string(),
            hostname: " host.internal ".to_string(),
            username: Some("  ".to_string()),
            port: None,
        })
        .expect("hostname-only target should normalize");
        assert_eq!(hostname_only.alias, "host.internal");
        assert_eq!(hostname_only.hostname, "host.internal");
        assert_eq!(hostname_only.username, None);

        let alias_only = normalize_ssh_environment_target(SshEnvironmentTarget {
            alias: " alias ".to_string(),
            hostname: String::new(),
            username: Some(" alice ".to_string()),
            port: None,
        })
        .expect("alias-only target should normalize");
        assert_eq!(alias_only.hostname, "alias");
        assert_eq!(alias_only.username.as_deref(), Some("alice"));
        assert!(
            normalize_ssh_environment_target(SshEnvironmentTarget {
                alias: " ".to_string(),
                hostname: " ".to_string(),
                username: None,
                port: None,
            })
            .is_err()
        );

        let plan = SshEnvironmentLaunchPlan::forward_with_auth(
            alias_only,
            41000,
            RemoteLaunchResult {
                remote_port: 42000,
                server_kind: "unexpected".to_string(),
            },
            &SshAuthOptions::with_secret("secret".to_string()),
        )
        .expect("managed password plan should build");
        assert_eq!(plan.remote_server_kind, "managed");
        assert_eq!(plan.remote_port, 42000);
        assert_eq!(plan.args[1], "BatchMode=no");
        assert!(!plan.args.iter().any(|argument| argument == "-p"));
        assert_eq!(plan.args.last().map(String::as_str), Some("alice@alias"));
    }

    #[test]
    fn remote_output_parsers_cover_defaults_and_error_context() {
        assert_eq!(last_non_empty_line(" \n first \n\n"), Some("first"));
        assert_eq!(last_non_empty_line(" \n\t"), None);
        assert!(
            parse_remote_pairing_credential("")
                .unwrap_err()
                .contains("credential")
        );
        assert!(
            parse_remote_pairing_credential("not-json")
                .unwrap_err()
                .contains("unparseable")
        );
        assert!(
            parse_remote_pairing_credential("{\"credential\":42}")
                .unwrap_err()
                .contains("invalid credential")
        );
        assert_eq!(
            parse_remote_pairing_credential("{\"credential\":\" token \"}"),
            Ok("token".to_string())
        );

        assert!(
            parse_remote_launch_result("")
                .unwrap_err()
                .contains("remote port")
        );
        assert!(
            parse_remote_launch_result("not-json")
                .unwrap_err()
                .contains("unparseable")
        );
        assert!(
            parse_remote_launch_result("{\"remotePort\":65536}")
                .unwrap_err()
                .contains("65536")
        );
        assert_eq!(
            parse_remote_launch_result("{\"remotePort\":3773}")
                .expect("missing kind should default"),
            RemoteLaunchResult {
                remote_port: 3773,
                server_kind: "managed".to_string(),
            }
        );

        let script = build_remote_launch_script();
        assert!(!script.contains("@@"));
        assert!(script.contains(&DEFAULT_REMOTE_PORT.to_string()));
        assert!(script.contains(&REMOTE_PORT_SCAN_WINDOW.to_string()));
    }

    #[test]
    fn auth_helpers_cover_noninteractive_and_permission_denied_variants() {
        assert!(
            build_ssh_child_environment(&SshAuthOptions::batch(), Path::new("unused")).is_empty()
        );
        for mechanism in [
            "password",
            "keyboard-interactive",
            "publickey",
            "hostbased",
            "gssapi-with-mic",
        ] {
            assert!(is_ssh_auth_failure(&format!(
                "PERMISSION DENIED ({mechanism})"
            )));
        }
        assert!(!is_ssh_auth_failure("Permission denied (certificate)"));
        assert!(!is_ssh_auth_failure("Permission denied"));
    }

    #[test]
    fn askpass_file_writes_are_idempotent_and_report_invalid_parents() {
        let directory = unique_temp_home();
        fs::create_dir_all(&directory).expect("temp directory should create");
        let helper = directory.join("askpass.cmd");
        write_askpass_file(&helper, "first", None).expect("helper should write");
        write_askpass_file(&helper, "first", None).expect("matching helper should be reused");
        assert_eq!(
            fs::read_to_string(&helper).expect("helper should read"),
            "first"
        );
        write_askpass_file(&helper, "second", None).expect("changed helper should rewrite");
        assert_eq!(
            fs::read_to_string(&helper).expect("helper should read"),
            "second"
        );

        let blocking_parent = directory.join("not-a-directory");
        fs::write(&blocking_parent, "file").expect("blocking file should write");
        assert!(
            write_askpass_file(&blocking_parent.join("child"), "value", None)
                .unwrap_err()
                .contains("Failed to write SSH askpass helper")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn password_prompt_reports_presentation_cancellation_and_service_stop() {
        let request = || SshPasswordRequest {
            destination: "host".to_string(),
            username: None,
            prompt: "Password".to_string(),
        };

        let manager = SshPasswordPromptManager::with_timeout(Duration::from_secs(30));
        let presentation = manager
            .request_password_with(
                "emit-failure".to_string(),
                request(),
                UNIX_EPOCH,
                |_payload| Err("renderer unavailable".to_string()),
            )
            .await;
        assert!(matches!(
            presentation,
            Err(SshPasswordPromptRequestError::Presentation {
                operation: "send-prompt-request",
                ..
            })
        ));
        assert!(manager.remove_pending("emit-failure").is_none());

        let resolver = manager.clone();
        let cancellation = tokio::spawn(async move {
            manager
                .request_password_with("cancel".to_string(), request(), UNIX_EPOCH, |_| Ok(()))
                .await
        });
        tokio::task::yield_now().await;
        resolver
            .resolve(SshPasswordPromptResolution {
                request_id: " cancel ".to_string(),
                password: None,
            })
            .expect("prompt should cancel");
        assert!(matches!(
            cancellation.await.expect("cancellation task"),
            Err(SshPasswordPromptRequestError::Cancelled { request_id, .. }) if request_id == "cancel"
        ));

        let manager = SshPasswordPromptManager::with_timeout(Duration::from_secs(30));
        let dropper = manager.clone();
        let stopped = manager
            .request_password_with(
                "stopped".to_string(),
                request(),
                UNIX_EPOCH,
                move |payload| {
                    drop(dropper.remove_pending(&payload.request_id));
                    Ok(())
                },
            )
            .await;
        assert!(matches!(
            stopped,
            Err(SshPasswordPromptRequestError::ServiceStopped { request_id, .. }) if request_id == "stopped"
        ));
    }

    #[test]
    fn prompt_errors_and_time_formatting_keep_stable_messages() {
        let presentation = SshPasswordPromptRequestError::Presentation {
            request_id: "id".to_string(),
            destination: "host".to_string(),
            operation: "emit",
            message: "closed".to_string(),
        };
        assert_eq!(
            presentation.to_string(),
            "Failed to present SSH password prompt for host during emit: closed"
        );
        assert_eq!(
            SshPasswordPromptRequestError::TimedOut {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH authentication timed out for host."
        );
        assert_eq!(
            SshPasswordPromptRequestError::Cancelled {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH authentication cancelled for host."
        );
        assert_eq!(
            SshPasswordPromptRequestError::ServiceStopped {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH password prompt service stopped."
        );
        assert_eq!(
            SshPasswordPromptResolveError::InvalidRequestId.to_string(),
            "Invalid SSH password prompt id."
        );
        assert_eq!(
            SshPasswordPromptResolveError::Expired {
                request_id: "id".to_string(),
            }
            .to_string(),
            "SSH password prompt expired. Try connecting again."
        );
        assert_eq!(format_system_time(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_system_time(UNIX_EPOCH - Duration::from_secs(1)),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn ssh_config_helpers_cover_quotes_assignments_paths_and_wildcards() {
        assert_eq!(
            split_directive_args(" Host foo # comment "),
            Ok(vec!["Host".to_string(), "foo".to_string()])
        );
        assert_eq!(
            split_directive_args("Include \"config #archive/file\" # comment"),
            Ok(vec![
                "Include".to_string(),
                "config #archive/file".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Include=\"dir with spaces/file=name\""),
            Ok(vec![
                "Include".to_string(),
                "dir with spaces/file=name".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Host 'one' two\\ three"),
            Ok(vec![
                "Host".to_string(),
                "one".to_string(),
                "two three".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Host trailing\\"),
            Ok(vec!["Host".to_string(), "trailing\\".to_string()])
        );
        assert_eq!(
            split_directive_args(r#"Host "quoted\"alias""#),
            Ok(vec!["Host".to_string(), "quoted\"alias".to_string()])
        );
        assert!(
            split_directive_args("  ")
                .expect("blank directive should parse")
                .is_empty()
        );

        assert!(has_ssh_pattern("*.example.com"));
        assert!(has_ssh_pattern("host?"));
        assert!(has_ssh_pattern("!blocked"));
        assert!(!has_ssh_pattern("host"));
        assert!(wildcard_matches("*.conf", "team.conf"));
        assert!(wildcard_matches("host?", "host1"));
        assert!(!wildcard_matches("host?", "host"));
        assert!(!wildcard_matches("*.conf", "team.txt"));

        let home = unique_temp_home();
        assert_eq!(expand_home_path("~", &home), home);
        assert_eq!(expand_home_path("~/config", &home), home.join("config"));
        assert_eq!(expand_home_path("~\\config", &home), home.join("config"));
        assert_eq!(expand_home_path("plain", &home), PathBuf::from("plain"));
        assert_eq!(
            resolve_ssh_config_include_pattern("relative.conf", &home),
            home.join(".ssh").join("relative.conf")
        );
        let absolute = home.join("absolute.conf");
        assert_eq!(
            resolve_ssh_config_include_pattern(absolute.to_str().expect("utf-8 path"), &home),
            absolute
        );
    }

    #[test]
    fn config_globs_and_include_cycles_are_deterministic() {
        let home = unique_temp_home();
        let ssh_dir = home.join(".ssh");
        let include_dir = ssh_dir.join("config.d");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        let alpha = include_dir.join("a.conf");
        let beta = include_dir.join("b.conf");
        fs::write(&alpha, "Host alpha\nInclude ../config\n").expect("alpha should write");
        fs::write(&beta, "Host beta\n").expect("beta should write");
        fs::write(ssh_dir.join("config"), "Include config.d/*.conf\n")
            .expect("config should write");

        assert_eq!(
            expand_glob(&alpha).expect("exact glob should resolve"),
            vec![alpha.clone()]
        );
        assert!(
            expand_glob(&include_dir.join("missing.conf"))
                .expect("missing exact path should resolve")
                .is_empty()
        );
        assert!(
            expand_glob(&ssh_dir.join("missing").join("*.conf"))
                .expect("missing glob directory should resolve")
                .is_empty()
        );
        assert_eq!(
            expand_glob(&include_dir.join("*.conf")).expect("glob should resolve"),
            vec![alpha, beta]
        );
        assert_eq!(
            collect_ssh_config_aliases_from_file(
                &ssh_dir.join("config"),
                &home,
                &mut BTreeSet::new(),
            )
            .expect("cyclic config should terminate"),
            BTreeSet::from(["alpha".to_string(), "beta".to_string()])
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_handles_empty_inputs_precedence_values_and_io_errors() {
        assert_eq!(discover_ssh_hosts(None), Ok(Vec::new()));
        assert_eq!(discover_ssh_hosts(Some(PathBuf::new())), Ok(Vec::new()));

        let home = unique_temp_home();
        assert_eq!(discover_ssh_hosts(Some(home.clone())), Ok(Vec::new()));
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("ssh directory should create");
        fs::write(ssh_dir.join("config"), "Host duplicate\n").expect("config should write");
        fs::write(
            ssh_dir.join("known_hosts"),
            "duplicate ssh-ed25519 AAAA\nknown ssh-ed25519 BBBB\n",
        )
        .expect("known hosts should write");
        let hosts = discover_ssh_hosts(Some(home.clone())).expect("hosts should discover");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "duplicate");
        assert_eq!(hosts[0].source, "ssh-config");
        assert_eq!(
            hosts[0].to_value(),
            json!({
                "alias": "duplicate",
                "hostname": "duplicate",
                "username": null,
                "port": null,
                "source": "ssh-config",
            })
        );
        let _ = fs::remove_dir_all(&home);

        let config_error_home = unique_temp_home();
        fs::create_dir_all(config_error_home.join(".ssh").join("config"))
            .expect("config directory should create");
        assert!(
            discover_ssh_hosts(Some(config_error_home.clone()))
                .unwrap_err()
                .contains("Failed to read SSH config hosts")
        );
        let _ = fs::remove_dir_all(config_error_home);

        let known_hosts_error_home = unique_temp_home();
        let ssh_dir = known_hosts_error_home.join(".ssh");
        fs::create_dir_all(ssh_dir.join("known_hosts"))
            .expect("known hosts directory should create");
        assert!(
            discover_ssh_hosts(Some(known_hosts_error_home.clone()))
                .unwrap_err()
                .contains("Failed to read known SSH hosts")
        );
        let _ = fs::remove_dir_all(known_hosts_error_home);
    }

    #[test]
    fn known_hosts_parser_covers_markers_patterns_and_host_normalization() {
        assert_eq!(normalize_known_hosts_hostname("[host]:2222"), "host");
        assert_eq!(normalize_known_hosts_hostname("host:22"), "host");
        assert_eq!(normalize_known_hosts_hostname("2001:db8::1"), "2001:db8::1");
        assert_eq!(normalize_known_hosts_hostname("[incomplete"), "[incomplete");
        assert_eq!(
            parse_known_hosts_hostnames(
                "# comment\n@revoked revoked.example ssh-ed25519 AAAA\n*.wild ssh-ed25519 BBBB\n!blocked ssh-ed25519 CCCC\n@marker\n"
            ),
            BTreeSet::from(["revoked.example".to_string()])
        );
        let missing = unique_temp_home().join("known_hosts");
        assert_eq!(
            read_known_hosts_hostnames(&missing).expect("missing known hosts should be empty"),
            BTreeSet::new()
        );
    }
}
