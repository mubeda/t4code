use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use t4code_server::process::{configure_background_command, configure_background_std_command};
use t4code_server::{
    DESKTOP_SHUTDOWN_PATH as SERVER_BACKEND_SHUTDOWN_PATH,
    DESKTOP_SHUTDOWN_TOKEN_HEADER as SERVER_BACKEND_SHUTDOWN_TOKEN_HEADER, ServerConfig,
    ServerRuntime,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt as TokioAsyncWriteExt},
    process::{Child, Command},
    sync::{Mutex as AsyncMutex, Notify, oneshot},
};
use uuid::Uuid;

use crate::config::state_dir;

const PRIMARY_LOCAL_ENVIRONMENT_ID: &str = "primary";
const DESKTOP_MODE: &str = "desktop";
const BACKEND_BOOTSTRAP_FD: &str = "0";
const TAILSCALE_SERVE_PORT: u16 = 443;
const DESKTOP_LOOPBACK_HOST: &str = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST: &str = "0.0.0.0";
const DEFAULT_BACKEND_PORT: u16 = 3773;
const MAX_TCP_PORT: u16 = u16::MAX;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS: [&str; 3] = ["127.0.0.1", "0.0.0.0", "::"];
pub const BACKEND_READY_EVENT: &str = "desktop:backend-ready";
const WSL_SERVER_BINARY_ENV: &str = "T4CODE_WSL_SERVER_BINARY";
const T4CODE_HOME_ENV: &str = "T4CODE_HOME";
const DESKTOP_SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const BACKEND_READINESS_PATH: &str = "/.well-known/t4code/environment";
const DEFAULT_BACKEND_READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_BACKEND_READINESS_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_BACKEND_SOFT_SHUTDOWN_REQUEST_TIMEOUT: Duration = Duration::from_millis(500);
const DEFAULT_BACKEND_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);
const DEFAULT_BACKEND_RESTART_INITIAL_DELAY: Duration = Duration::from_millis(250);
const DEFAULT_BACKEND_RESTART_MAX_DELAY: Duration = Duration::from_secs(5);
const DEFAULT_BACKEND_MONITOR_INTERVAL: Duration = Duration::from_millis(250);
const PRIMARY_BACKEND_LOG_FILE_NAME: &str = "server-child.log";
const WSL_BACKEND_LOG_FILE_PREFIX: &str = "server-child-wsl-";
const WSL_BACKEND_LOG_FILE_EXTENSION: &str = ".log";
const WSL_INSTANCE_ID_PREFIX: &str = "wsl:";
const WSL_BACKEND_BIND_HOST: &str = "0.0.0.0";
const WSL_SERVER_SYSTEM_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendRunConfig {
    pub environment_id: String,
    pub label: String,
    pub running_distro: Option<String>,
    pub port: u16,
    pub bind_host: String,
    pub local_host: String,
    pub desktop_bootstrap_token: String,
    pub server_exposure_mode: String,
    pub endpoint_url: Option<String>,
    pub advertised_host: Option<String>,
    pub tailscale_serve_enabled: bool,
    pub tailscale_serve_port: u16,
}

impl BackendRunConfig {
    pub fn http_base_url(&self) -> String {
        format!("http://{}:{}", self.local_host, self.port)
    }

    pub fn ws_base_url(&self) -> String {
        format!("ws://{}:{}", self.local_host, self.port)
    }

    pub fn to_environment_bootstrap(&self) -> Value {
        json!({
            "id": &self.environment_id,
            "label": &self.label,
            "runningDistro": &self.running_distro,
            "httpBaseUrl": self.http_base_url(),
            "wsBaseUrl": self.ws_base_url(),
            "bootstrapToken": self.desktop_bootstrap_token,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendDesktopSettings {
    server_exposure_mode: String,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    wsl_backend_enabled: bool,
    wsl_only: bool,
    wsl_distro: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackendDesktopSettingsDocument {
    server_exposure_mode: Option<String>,
    tailscale_serve_enabled: Option<bool>,
    tailscale_serve_port: Option<u64>,
    wsl_backend_enabled: Option<bool>,
    wsl_only: Option<bool>,
    wsl_distro: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendLaunchPlan {
    pub target: BackendLaunchTarget,
    pub log_path: Option<PathBuf>,
    pub config: BackendRunConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendLaunchTarget {
    InProcess {
        base_dir: PathBuf,
    },
    ExternalProcess {
        program: String,
        args: Vec<String>,
        bootstrap_line: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslBackendLaunchPlanInput {
    pub environment_id: String,
    pub label: String,
    pub running_distro: String,
    pub port: u16,
    pub renderer_host: String,
    pub desktop_bootstrap_token: String,
    pub binary_path: String,
}

impl BackendLaunchPlan {
    pub fn local(base_dir: PathBuf, config: BackendRunConfig) -> Self {
        Self {
            target: BackendLaunchTarget::InProcess { base_dir },
            log_path: None,
            config,
        }
    }

    pub fn with_log_path(mut self, log_path: PathBuf) -> Self {
        self.log_path = Some(log_path);
        self
    }

    pub fn wsl(input: WslBackendLaunchPlanInput) -> Self {
        let config = BackendRunConfig {
            environment_id: input.environment_id,
            label: input.label,
            running_distro: Some(input.running_distro.clone()),
            port: input.port,
            bind_host: WSL_BACKEND_BIND_HOST.to_string(),
            local_host: input.renderer_host,
            desktop_bootstrap_token: input.desktop_bootstrap_token,
            server_exposure_mode: "local-only".to_string(),
            endpoint_url: None,
            advertised_host: None,
            tailscale_serve_enabled: false,
            tailscale_serve_port: TAILSCALE_SERVE_PORT,
        };
        let bootstrap = json!({
            "mode": DESKTOP_MODE,
            "noBrowser": true,
            "port": config.port,
            "host": &config.bind_host,
            "desktopBootstrapToken": &config.desktop_bootstrap_token,
            "tailscaleServeEnabled": false,
            "tailscaleServePort": TAILSCALE_SERVE_PORT,
        });
        let args = vec![
            "-d".to_string(),
            input.running_distro,
            "--exec".to_string(),
            "env".to_string(),
            format!("PATH={WSL_SERVER_SYSTEM_PATH}"),
            input.binary_path,
            "serve".to_string(),
            "--bootstrap-fd".to_string(),
            BACKEND_BOOTSTRAP_FD.to_string(),
        ];

        Self {
            target: BackendLaunchTarget::ExternalProcess {
                program: "wsl.exe".to_string(),
                args,
                bootstrap_line: format!("{bootstrap}\n"),
            },
            log_path: None,
            config,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendReadinessConfig {
    pub timeout: Duration,
    pub interval: Duration,
    pub request_timeout: Duration,
}

impl Default for BackendReadinessConfig {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_BACKEND_READINESS_TIMEOUT,
            interval: DEFAULT_BACKEND_READINESS_INTERVAL,
            request_timeout: DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendShutdownConfig {
    pub timeout: Duration,
}

impl Default for BackendShutdownConfig {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_BACKEND_SHUTDOWN_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendRestartConfig {
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub monitor_interval: Duration,
}

impl Default for BackendRestartConfig {
    fn default() -> Self {
        Self {
            initial_delay: DEFAULT_BACKEND_RESTART_INITIAL_DELAY,
            max_delay: DEFAULT_BACKEND_RESTART_MAX_DELAY,
            monitor_interval: DEFAULT_BACKEND_MONITOR_INTERVAL,
        }
    }
}

#[derive(Clone)]
struct ManagedBackendChild {
    run_id: u64,
    config: BackendRunConfig,
    child: Arc<AsyncMutex<Child>>,
    stop_requested: Arc<AtomicBool>,
}

impl ManagedBackendChild {
    fn new(run_id: u64, config: BackendRunConfig, child: Child) -> Self {
        Self {
            run_id,
            config,
            child: Arc::new(AsyncMutex::new(child)),
            stop_requested: Arc::new(AtomicBool::new(false)),
        }
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
    }
}

impl std::fmt::Debug for ManagedBackendChild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedBackendChild")
            .field("run_id", &self.run_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct ManagedBackendRuntime {
    run_id: u64,
    stop_requested: Arc<AtomicBool>,
    shutdown: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    completion: Arc<Notify>,
    join_result: Arc<AsyncMutex<Option<Result<(), String>>>>,
}

impl ManagedBackendRuntime {
    fn new(run_id: u64, handle: t4code_server::ServerHandle) -> Self {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let completion = Arc::new(Notify::new());
        let join_result = Arc::new(AsyncMutex::new(None));
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let completion_task = completion.clone();
        let join_result_task = join_result.clone();

        tauri::async_runtime::spawn(async move {
            let handle = handle;
            tokio::select! {
                _ = &mut shutdown_rx => {
                    handle.shutdown();
                }
                () = handle.wait_for_shutdown() => {}
            }

            let result = handle.join().await.map_err(|error| error.to_string());
            *join_result_task.lock().await = Some(result);
            completion_task.notify_waiters();
        });

        Self {
            run_id,
            stop_requested,
            shutdown: Arc::new(Mutex::new(Some(shutdown_tx))),
            completion,
            join_result,
        }
    }

    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        if let Ok(mut shutdown) = self.shutdown.lock()
            && let Some(sender) = shutdown.take()
        {
            let _ = sender.send(());
        }
    }

    async fn wait_for_completion(&self) -> Result<(), String> {
        loop {
            if let Some(result) = self.join_result.lock().await.clone() {
                return result;
            }
            self.completion.notified().await;
        }
    }
}

impl std::fmt::Debug for ManagedBackendRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedBackendRuntime")
            .field("run_id", &self.run_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
enum ManagedBackend {
    Child(Box<ManagedBackendChild>),
    Runtime(Box<ManagedBackendRuntime>),
}

#[derive(Debug, Default)]
struct BackendSlotState {
    launch_plan: Option<BackendLaunchPlan>,
    backend: Option<ManagedBackend>,
    pid: Option<u32>,
    last_error: Option<String>,
    restart_attempt: u32,
    restart_scheduled: bool,
}

#[derive(Debug, Default)]
struct BackendState {
    slots: BTreeMap<String, BackendSlotState>,
    next_run_id: u64,
}

fn backend_slot_key(plan: &BackendLaunchPlan) -> String {
    plan.config.environment_id.clone()
}

#[derive(Debug, Clone, Default)]
pub struct BackendSupervisor {
    state: Arc<Mutex<BackendState>>,
}

impl BackendSupervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn local_environment_bootstraps(&self) -> Vec<Value> {
        let state = self
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        let mut bootstraps = Vec::new();
        if let Some(slot) = state.slots.get(PRIMARY_LOCAL_ENVIRONMENT_ID)
            && let Some(plan) = &slot.launch_plan
            && slot.last_error.is_none()
        {
            bootstraps.push(plan.config.to_environment_bootstrap());
        }
        for (slot_key, slot) in &state.slots {
            if slot_key == PRIMARY_LOCAL_ENVIRONMENT_ID {
                continue;
            }
            if let Some(plan) = &slot.launch_plan
                && slot.last_error.is_none()
            {
                bootstraps.push(plan.config.to_environment_bootstrap());
            }
        }
        bootstraps
    }

    pub fn current_run_config(&self) -> Option<BackendRunConfig> {
        let state = self
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        state
            .slots
            .get(PRIMARY_LOCAL_ENVIRONMENT_ID)
            .and_then(|slot| slot.launch_plan.as_ref())
            .or_else(|| {
                state
                    .slots
                    .values()
                    .find_map(|slot| slot.launch_plan.as_ref())
            })
            .map(|plan| plan.config.clone())
    }

    pub fn record_error(&self, error: impl Into<String>) {
        let mut state = self
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        state
            .slots
            .entry(PRIMARY_LOCAL_ENVIRONMENT_ID.to_string())
            .or_default()
            .last_error = Some(error.into());
    }

    pub async fn start_default<R: Runtime>(
        &self,
        app: AppHandle<R>,
    ) -> Result<BackendRunConfig, String> {
        self.start_default_with_reason(app, "started").await
    }

    async fn start_default_with_reason<R: Runtime>(
        &self,
        app: AppHandle<R>,
        reason: &'static str,
    ) -> Result<BackendRunConfig, String> {
        let mut plans = default_launch_plans(&app)?;
        let primary_index = plans
            .iter()
            .position(|plan| plan.config.environment_id == PRIMARY_LOCAL_ENVIRONMENT_ID)
            .unwrap_or(0);
        let primary_plan = plans.remove(primary_index);
        let primary_config = self.start(primary_plan).await?;

        for plan in plans {
            if let Err(error) = self.start(plan.clone()).await {
                self.record_plan_error(&plan, error.clone());
                tracing::warn!(
                    target: "t4code_desktop_tauri::backend",
                    environment_id = plan.config.environment_id,
                    "secondary desktop backend launch failed: {error}"
                );
            }
        }

        emit_backend_ready(&app, reason, self.local_environment_bootstraps())?;
        Ok(primary_config)
    }

    pub async fn restart_default_if_active<R: Runtime>(
        &self,
        app: AppHandle<R>,
    ) -> Result<Option<BackendRunConfig>, String> {
        let is_active = {
            let state = self
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state
                .slots
                .values()
                .any(|slot| slot.backend.is_some() || slot.launch_plan.is_some())
        };
        if !is_active {
            return Ok(None);
        }

        self.stop(BackendShutdownConfig::default()).await?;
        self.start_default_with_reason(app, "restarted")
            .await
            .map(Some)
    }

    pub async fn start(&self, plan: BackendLaunchPlan) -> Result<BackendRunConfig, String> {
        self.start_with_options(
            plan,
            BackendReadinessConfig::default(),
            BackendRestartConfig::default(),
        )
        .await
    }

    async fn start_with_options(
        &self,
        plan: BackendLaunchPlan,
        readiness: BackendReadinessConfig,
        restart: BackendRestartConfig,
    ) -> Result<BackendRunConfig, String> {
        self.start_with_options_inner(plan, readiness, restart, true)
            .await
    }

    async fn start_with_options_inner(
        &self,
        plan: BackendLaunchPlan,
        readiness: BackendReadinessConfig,
        restart: BackendRestartConfig,
        reset_restart_attempt: bool,
    ) -> Result<BackendRunConfig, String> {
        let (config, managed, pid) =
            start_managed_backend(plan.clone(), readiness, self.next_run_id()?).await?;
        let mut active_plan = plan;
        active_plan.config = config.clone();
        let monitor_plan = active_plan.clone();
        let slot_key = backend_slot_key(&active_plan);
        let (managed, previous) = {
            let mut state = self
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            let slot = state.slots.entry(slot_key.clone()).or_default();
            let previous = slot.backend.take();
            slot.launch_plan = Some(active_plan);
            slot.pid = pid;
            slot.last_error = None;
            slot.restart_scheduled = false;
            if reset_restart_attempt {
                slot.restart_attempt = 0;
            }
            slot.backend = Some(managed.clone());
            (managed, previous)
        };

        if let Some(previous) = previous {
            let _ = stop_managed_backend(previous, BackendShutdownConfig::default()).await;
        }

        spawn_backend_monitor(self.clone(), managed, monitor_plan, readiness, restart);

        Ok(config)
    }

    pub async fn stop(&self, shutdown: BackendShutdownConfig) -> Result<(), String> {
        let backends = {
            let mut state = self
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            let backends = state
                .slots
                .values_mut()
                .filter_map(|slot| slot.backend.take())
                .collect::<Vec<_>>();
            state.slots.clear();
            backends
        };

        let mut first_error = None;
        for backend in backends {
            if let Err(error) = stop_managed_backend(backend, shutdown).await
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }

        first_error.map_or(Ok(()), Err)
    }

    fn restart_still_desired(&self, slot_key: &str) -> bool {
        let state = self
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        state
            .slots
            .get(slot_key)
            .map(|slot| {
                slot.restart_scheduled && slot.launch_plan.is_some() && slot.backend.is_none()
            })
            .unwrap_or(false)
    }

    fn schedule_restart(
        &self,
        plan: BackendLaunchPlan,
        readiness: BackendReadinessConfig,
        restart: BackendRestartConfig,
        reason: String,
    ) {
        let slot_key = backend_slot_key(&plan);
        let (attempt, delay) = {
            let mut state = self
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            let Some(slot) = state.slots.get_mut(&slot_key) else {
                return;
            };
            if slot.launch_plan.is_none() {
                return;
            }
            slot.backend = None;
            slot.pid = None;
            slot.last_error = Some(reason);
            slot.restart_attempt = slot.restart_attempt.saturating_add(1);
            slot.restart_scheduled = true;
            let attempt = slot.restart_attempt;
            (attempt, restart_delay_for_attempt(attempt, &restart))
        };

        tracing::warn!(
            target: "t4code_desktop_tauri::backend",
            "desktop backend restart attempt {attempt} scheduled after {delay:?}"
        );

        let supervisor = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if !supervisor.restart_still_desired(&slot_key) {
                return;
            }
            if let Err(error) = supervisor
                .start_with_options_inner(plan.clone(), readiness, restart, false)
                .await
            {
                supervisor.schedule_restart(plan, readiness, restart, error);
            }
        });
    }

    fn record_plan_error(&self, plan: &BackendLaunchPlan, error: String) {
        let mut state = self
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        let slot = state.slots.entry(backend_slot_key(plan)).or_default();
        slot.launch_plan = Some(plan.clone());
        slot.backend = None;
        slot.pid = None;
        slot.last_error = Some(error);
        slot.restart_scheduled = false;
    }

    fn next_run_id(&self) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("backend supervisor mutex poisoned: {error}"))?;
        let run_id = state.next_run_id;
        state.next_run_id = state.next_run_id.saturating_add(1);
        Ok(run_id)
    }
}

fn emit_backend_ready<R: Runtime>(
    app: &AppHandle<R>,
    reason: &'static str,
    bootstraps: Vec<Value>,
) -> Result<(), String> {
    app.emit(
        BACKEND_READY_EVENT,
        json!({
            "reason": reason,
            "bootstraps": bootstraps,
        }),
    )
    .map_err(|error| format!("Could not emit desktop backend readiness: {error}"))
}

async fn start_managed_backend(
    plan: BackendLaunchPlan,
    readiness: BackendReadinessConfig,
    run_id: u64,
) -> Result<(BackendRunConfig, ManagedBackend, Option<u32>), String> {
    match &plan.target {
        BackendLaunchTarget::InProcess { base_dir } => {
            let server_config = server_config_for_launch(base_dir.clone(), &plan.config);
            let handle = ServerRuntime::start(server_config)
                .await
                .map_err(|error| format!("Could not start in-process desktop backend: {error}"))?;

            let mut config = plan.config.clone();
            config.port = handle.local_addr().port();
            if let Err(error) = wait_for_http_ready(&config.http_base_url(), &readiness).await {
                handle.shutdown();
                let _ = handle.join().await;
                return Err(error);
            }

            Ok((
                config.clone(),
                ManagedBackend::Runtime(Box::new(ManagedBackendRuntime::new(run_id, handle))),
                None,
            ))
        }
        BackendLaunchTarget::ExternalProcess {
            program,
            args,
            bootstrap_line,
        } => {
            let mut command = Command::new(program);
            configure_background_command(&mut command);
            command
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let mut child = command.spawn().map_err(|error| {
                format!("Could not start desktop backend using {program}: {error}")
            })?;

            let mut stdin = child.stdin.take().ok_or_else(|| {
                "Desktop backend child process did not expose stdin for bootstrap delivery."
                    .to_string()
            })?;
            stdin
                .write_all(bootstrap_line.as_bytes())
                .await
                .map_err(|error| format!("Could not write desktop backend bootstrap: {error}"))?;
            drop(stdin);

            drain_output("stdout", child.stdout.take(), plan.log_path.clone());
            drain_output("stderr", child.stderr.take(), plan.log_path.clone());

            let config = plan.config.clone();
            if let Err(error) = wait_for_http_ready(&config.http_base_url(), &readiness).await {
                let _ = child.start_kill();
                return Err(error);
            }

            let pid = child.id();
            Ok((
                config.clone(),
                ManagedBackend::Child(Box::new(ManagedBackendChild::new(run_id, config, child))),
                pid,
            ))
        }
    }
}

fn server_config_for_launch(base_dir: PathBuf, config: &BackendRunConfig) -> ServerConfig {
    let mut server_config = ServerConfig::new(base_dir).with_bind(&config.bind_host, config.port);
    server_config.mode = t4code_server::ServerMode::Desktop;
    server_config.no_browser = true;
    server_config.desktop_bootstrap_token = Some(config.desktop_bootstrap_token.clone());
    server_config.environment_id = config.environment_id.clone();
    server_config.environment_label = config.label.clone();
    server_config
}

fn spawn_backend_monitor(
    supervisor: BackendSupervisor,
    backend: ManagedBackend,
    plan: BackendLaunchPlan,
    readiness: BackendReadinessConfig,
    restart: BackendRestartConfig,
) {
    tauri::async_runtime::spawn(async move {
        match backend {
            ManagedBackend::Child(child) => {
                loop {
                    tokio::time::sleep(restart.monitor_interval).await;
                    if child.stop_requested.load(Ordering::SeqCst) {
                        return;
                    }

                    let exit = {
                        let mut process = child.child.lock().await;
                        process.try_wait()
                    };

                    match exit {
                        Ok(None) => {}
                        Ok(Some(status)) => {
                            if child.stop_requested.load(Ordering::SeqCst) {
                                return;
                            }
                            supervisor.schedule_restart(
                            plan.clone(),
                            readiness,
                            restart,
                            format!("Desktop backend child exited unexpectedly with status {status}."),
                        );
                            return;
                        }
                        Err(error) => {
                            supervisor.schedule_restart(
                                plan.clone(),
                                readiness,
                                restart,
                                format!("Could not inspect desktop backend child status: {error}"),
                            );
                            return;
                        }
                    }
                }
            }
            ManagedBackend::Runtime(runtime) => {
                if let Err(error) = runtime.wait_for_completion().await
                    && !runtime.stop_requested.load(Ordering::SeqCst)
                {
                    supervisor.schedule_restart(plan, readiness, restart, error);
                }
            }
        }
    });
}

async fn stop_managed_backend(
    backend: ManagedBackend,
    shutdown: BackendShutdownConfig,
) -> Result<(), String> {
    match backend {
        ManagedBackend::Child(child) => stop_managed_child(*child, shutdown).await,
        ManagedBackend::Runtime(runtime) => {
            runtime.request_stop();
            tokio::time::timeout(shutdown.timeout, runtime.wait_for_completion())
                .await
                .map_err(|_| {
                    format!(
                        "Timed out after {:?} while stopping in-process desktop backend.",
                        shutdown.timeout
                    )
                })?
        }
    }
}

async fn stop_managed_child(
    child: ManagedBackendChild,
    shutdown: BackendShutdownConfig,
) -> Result<(), String> {
    child.request_stop();

    let soft_shutdown_timeout = shutdown
        .timeout
        .min(DEFAULT_BACKEND_SOFT_SHUTDOWN_REQUEST_TIMEOUT);
    let soft_shutdown_requested =
        request_backend_soft_shutdown(&child.config, soft_shutdown_timeout)
            .await
            .inspect_err(|error| {
                tracing::debug!("desktop backend soft shutdown request failed: {error}");
            })
            .is_ok();

    let mut process = child.child.lock().await;

    if matches!(process.try_wait(), Ok(Some(_))) {
        return Ok(());
    }

    let graceful_requested =
        soft_shutdown_requested || request_child_soft_termination(&mut process);
    if !graceful_requested && let Err(error) = process.start_kill() {
        tracing::debug!(
            "desktop backend child was already stopped or could not be killed: {error}"
        );
    }

    match tokio::time::timeout(shutdown.timeout, process.wait()).await {
        Ok(Ok(_status)) => Ok(()),
        Ok(Err(error)) => Err(format!(
            "Could not wait for desktop backend shutdown: {error}"
        )),
        Err(_) if graceful_requested => {
            if let Err(error) = process.start_kill() {
                tracing::debug!(
                    "desktop backend child was already stopped or could not be force-killed: {error}"
                );
            }
            match tokio::time::timeout(shutdown.timeout, process.wait()).await {
                Ok(Ok(_status)) => Ok(()),
                Ok(Err(error)) => Err(format!(
                    "Could not wait for forced desktop backend shutdown: {error}"
                )),
                Err(_) => Err(format!(
                    "Timed out after {:?} while force-stopping desktop backend.",
                    shutdown.timeout
                )),
            }
        }
        Err(_) => Err(format!(
            "Timed out after {:?} while stopping desktop backend.",
            shutdown.timeout
        )),
    }
}

#[cfg(unix)]
fn request_child_soft_termination(child: &mut Child) -> bool {
    let Some(pid) = child.id() else {
        return false;
    };
    std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn request_child_soft_termination(_child: &mut Child) -> bool {
    false
}

fn restart_delay_for_attempt(attempt: u32, restart: &BackendRestartConfig) -> Duration {
    if attempt <= 1 {
        return restart.initial_delay.min(restart.max_delay);
    }

    let multiplier = 1_u32
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u32::MAX);
    restart
        .initial_delay
        .saturating_mul(multiplier)
        .min(restart.max_delay)
}

async fn request_backend_soft_shutdown(
    config: &BackendRunConfig,
    timeout: Duration,
) -> Result<(), String> {
    let mut url = url::Url::parse(&config.http_base_url())
        .map_err(|error| format!("Invalid backend shutdown URL: {error}"))?;
    url.set_path(SERVER_BACKEND_SHUTDOWN_PATH);
    url.set_query(None);
    url.set_fragment(None);

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Could not create backend shutdown HTTP client: {error}"))?;
    let response = client
        .post(url)
        .header(
            SERVER_BACKEND_SHUTDOWN_TOKEN_HEADER,
            &config.desktop_bootstrap_token,
        )
        .send()
        .await
        .map_err(|error| format!("Could not request desktop backend shutdown: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Desktop backend shutdown endpoint returned {}.",
            response.status().as_u16()
        ))
    }
}

async fn wait_for_http_ready(
    base_url: &str,
    readiness: &BackendReadinessConfig,
) -> Result<(), String> {
    let started_at = Instant::now();

    loop {
        let attempt_error = match probe_http_ready(base_url, readiness.request_timeout).await {
            Ok(true) => return Ok(()),
            Ok(false) => "readiness endpoint returned a non-success status".to_string(),
            Err(error) => error,
        };

        if started_at.elapsed() >= readiness.timeout {
            return Err(format!(
                "Desktop backend did not become ready at {base_url}{BACKEND_READINESS_PATH} within {:?}: {}",
                readiness.timeout, attempt_error,
            ));
        }

        tokio::time::sleep(readiness.interval).await;
    }
}

async fn probe_http_ready(base_url: &str, request_timeout: Duration) -> Result<bool, String> {
    let base_url = base_url.to_string();
    tokio::task::spawn_blocking(move || probe_http_ready_blocking(&base_url, request_timeout))
        .await
        .map_err(|error| format!("Desktop backend readiness task failed: {error}"))?
}

fn probe_http_ready_blocking(base_url: &str, request_timeout: Duration) -> Result<bool, String> {
    let base = url::Url::parse(base_url)
        .map_err(|error| format!("Invalid backend URL {base_url}: {error}"))?;
    if base.scheme() != "http" {
        return Err(format!(
            "Unsupported backend readiness URL scheme: {}",
            base.scheme()
        ));
    }
    let ready_url = base
        .join(BACKEND_READINESS_PATH)
        .map_err(|error| format!("Invalid backend readiness path: {error}"))?;
    let host = ready_url
        .host_str()
        .ok_or_else(|| format!("Backend readiness URL has no host: {ready_url}"))?;
    let port = ready_url
        .port_or_known_default()
        .ok_or_else(|| format!("Backend readiness URL has no port: {ready_url}"))?;
    let address = format!("{host}:{port}");
    let mut addresses = address.to_socket_addrs().map_err(|error| {
        format!("Could not resolve backend readiness address {address}: {error}")
    })?;
    let Some(socket_address) = addresses.next() else {
        return Err(format!(
            "Could not resolve any backend readiness address for {address}"
        ));
    };

    let mut stream =
        TcpStream::connect_timeout(&socket_address, request_timeout).map_err(|error| {
            format!("Could not connect to backend readiness endpoint {ready_url}: {error}")
        })?;
    stream
        .set_read_timeout(Some(request_timeout))
        .map_err(|error| format!("Could not set backend readiness read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(request_timeout))
        .map_err(|error| format!("Could not set backend readiness write timeout: {error}"))?;

    let path = if let Some(query) = ready_url.query() {
        format!("{}?{query}", ready_url.path())
    } else {
        ready_url.path().to_string()
    };
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Could not write backend readiness request: {error}"))?;

    let mut buffer = [0_u8; 128];
    let count = stream
        .read(&mut buffer)
        .map_err(|error| format!("Could not read backend readiness response: {error}"))?;
    let response = String::from_utf8_lossy(&buffer[..count]);
    let status_line = response.lines().next().unwrap_or_default();
    Ok(status_line.starts_with("HTTP/1.1 2") || status_line.starts_with("HTTP/1.0 2"))
}

fn drain_output(
    stream_name: &'static str,
    stream: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    log_path: Option<PathBuf>,
) {
    let Some(mut stream) = stream else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        let mut log_file = log_path.as_deref().and_then(open_backend_log_file);
        let mut buffer = [0_u8; 4096];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => {
                    let text = String::from_utf8_lossy(&buffer[..count]);
                    tracing::debug!(target: "t4code_desktop_tauri::backend", stream = stream_name, "{text}");
                    if let Some(file) = log_file.as_mut()
                        && let Err(error) =
                            write_backend_log_chunk(file, stream_name, &buffer[..count])
                    {
                        tracing::debug!(target: "t4code_desktop_tauri::backend", stream = stream_name, "backend output log write failed: {error}");
                        log_file = None;
                    }
                }
                Err(error) => {
                    tracing::debug!(target: "t4code_desktop_tauri::backend", stream = stream_name, "backend output drain failed: {error}");
                    break;
                }
            }
        }
    });
}

fn open_backend_log_file(path: &Path) -> Option<fs::File> {
    if let Some(directory) = path.parent()
        && let Err(error) = fs::create_dir_all(directory)
    {
        tracing::debug!(target: "t4code_desktop_tauri::backend", "backend log directory creation failed: {error}");
        return None;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            tracing::debug!(target: "t4code_desktop_tauri::backend", "backend log file open failed: {error}");
            error
        })
        .ok()
}

fn write_backend_log_chunk(file: &mut fs::File, stream_name: &str, chunk: &[u8]) -> io::Result<()> {
    file.write_all(format!("[{stream_name}] ").as_bytes())?;
    file.write_all(chunk)?;
    if !chunk.ends_with(b"\n") {
        file.write_all(b"\n")?;
    }
    file.flush()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WslDistroEntry {
    name: String,
    is_default: bool,
}

fn decode_wsl_command_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let values = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&values);
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn parse_wsl_distro_entries(raw: &str) -> Vec<WslDistroEntry> {
    raw.lines()
        .filter_map(|line| {
            let line = line.replace('\0', "");
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("NAME") {
                return None;
            }
            let is_default = trimmed.starts_with('*');
            let without_marker = trimmed.trim_start_matches('*').trim();
            let name = without_marker.split_whitespace().next()?;
            if name.eq_ignore_ascii_case("name") {
                return None;
            }
            Some(WslDistroEntry {
                name: name.to_string(),
                is_default,
            })
        })
        .collect()
}

fn run_wsl_command(distro: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("wsl.exe");
    configure_background_std_command(&mut command);
    let output = command
        .args(["-d", distro, "--"])
        .args(args)
        .output()
        .map_err(|error| format!("Could not run wsl.exe for distro {distro}: {error}"))?;
    if !output.status.success() {
        let stderr = decode_wsl_command_output(&output.stderr);
        return Err(format!(
            "wsl.exe for distro {distro} exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(decode_wsl_command_output(&output.stdout))
}

fn list_wsl_distros() -> Result<Vec<WslDistroEntry>, String> {
    let mut command = std::process::Command::new("wsl.exe");
    configure_background_std_command(&mut command);
    let output = command
        .args(["-l", "-v"])
        .output()
        .map_err(|error| format!("Could not list WSL distributions: {error}"))?;
    if !output.status.success() {
        let stderr = decode_wsl_command_output(&output.stderr);
        return Err(format!(
            "wsl.exe -l -v exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(parse_wsl_distro_entries(&decode_wsl_command_output(
        &output.stdout,
    )))
}

fn resolve_wsl_distro(settings: &BackendDesktopSettings) -> Result<String, String> {
    if let Some(distro) = &settings.wsl_distro {
        return Ok(distro.clone());
    }
    let distros = list_wsl_distros()?;
    distros
        .iter()
        .find(|distro| distro.is_default)
        .or_else(|| distros.first())
        .map(|distro| distro.name.clone())
        .ok_or_else(|| "WSL has no installed distributions.".to_string())
}

fn resolve_wsl_path(distro: &str, windows_path: &Path) -> Result<String, String> {
    let windows_path = windows_path.to_string_lossy();
    let output = run_wsl_command(distro, &["wslpath", "-a", &windows_path])?;
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("wslpath returned no Linux path for {windows_path}"))
}

fn resolve_wsl_server_binary(distro: &str) -> Result<String, String> {
    let candidates = wsl_server_binary_candidates()?;
    for candidate in candidates {
        if candidate.is_file() {
            return resolve_wsl_path(distro, &candidate);
        }
    }

    Err(format!(
        "Could not find a Linux t4code server binary for WSL. Set {WSL_SERVER_BINARY_ENV} or build one under target/<triple>/(debug|release)/t4code."
    ))
}

fn resolve_wsl_renderer_host(distro: &str) -> Option<String> {
    let output = run_wsl_command(distro, &["hostname", "-I"]).ok()?;
    output
        .split_whitespace()
        .find(|value| value.parse::<Ipv4Addr>().is_ok())
        .map(ToOwned::to_owned)
}

fn resolve_wsl_launch_plan_for_distro(
    running_distro: String,
    port: u16,
    desktop_bootstrap_token: String,
    log_path: PathBuf,
    environment_id: String,
    label: String,
) -> Result<BackendLaunchPlan, String> {
    let binary_path = resolve_wsl_server_binary(&running_distro)?;
    let renderer_host = resolve_wsl_renderer_host(&running_distro)
        .unwrap_or_else(|| DESKTOP_LOOPBACK_HOST.to_string());

    Ok(BackendLaunchPlan::wsl(WslBackendLaunchPlanInput {
        environment_id,
        label,
        running_distro,
        port,
        renderer_host,
        desktop_bootstrap_token,
        binary_path,
    })
    .with_log_path(log_path))
}

fn resolve_wsl_primary_launch_plan(
    settings: &BackendDesktopSettings,
    port: u16,
    desktop_bootstrap_token: String,
    log_path: PathBuf,
) -> Result<BackendLaunchPlan, String> {
    let running_distro = resolve_wsl_distro(settings)?;
    resolve_wsl_launch_plan_for_distro(
        running_distro,
        port,
        desktop_bootstrap_token,
        log_path,
        PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
        "Local".to_string(),
    )
}

fn resolve_wsl_secondary_launch_plan<R: Runtime>(
    app: &AppHandle<R>,
    settings: &BackendDesktopSettings,
    primary_port: u16,
) -> Result<BackendLaunchPlan, String> {
    let running_distro = resolve_wsl_distro(settings)?;
    let port = pick_desktop_backend_port_excluding(&[primary_port]).ok_or_else(|| {
        format!("Could not find an available desktop backend port outside {primary_port}.")
    })?;
    let log_path = wsl_backend_log_path(app, &running_distro)?;
    let environment_id = format!("{WSL_INSTANCE_ID_PREFIX}{running_distro}");
    let label = format!("WSL ({running_distro})");
    resolve_wsl_launch_plan_for_distro(
        running_distro,
        port,
        Uuid::new_v4().simple().to_string(),
        log_path,
        environment_id,
        label,
    )
}

fn default_launch_plans<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<BackendLaunchPlan>, String> {
    let base_dir = desktop_base_dir(app)?;
    let log_path = primary_backend_log_path(app)?;
    let port = std::env::var("T4CODE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .or_else(select_desktop_backend_port)
        .or_else(portpicker::pick_unused_port)
        .unwrap_or(DEFAULT_BACKEND_PORT);
    let settings = read_backend_desktop_settings(app)?;
    let desktop_bootstrap_token = Uuid::new_v4().simple().to_string();
    if settings.wsl_backend_enabled && settings.wsl_only {
        match resolve_wsl_primary_launch_plan(
            &settings,
            port,
            desktop_bootstrap_token.clone(),
            log_path.clone(),
        ) {
            Ok(plan) => return Ok(vec![plan]),
            Err(error) => {
                tracing::warn!(
                    target: "t4code_desktop_tauri::backend",
                    "falling back to Windows backend after WSL-only launch planning failed: {error}"
                );
            }
        }
    }
    let exposure = resolve_backend_exposure(&settings, port);
    let config = BackendRunConfig {
        environment_id: PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
        label: "Local".to_string(),
        running_distro: None,
        port,
        bind_host: exposure.bind_host,
        local_host: DESKTOP_LOOPBACK_HOST.to_string(),
        desktop_bootstrap_token,
        server_exposure_mode: exposure.mode,
        endpoint_url: exposure.endpoint_url,
        advertised_host: exposure.advertised_host,
        tailscale_serve_enabled: settings.tailscale_serve_enabled,
        tailscale_serve_port: settings.tailscale_serve_port,
    };

    let primary_plan = BackendLaunchPlan::local(base_dir.clone(), config).with_log_path(log_path);
    let mut plans = vec![primary_plan];

    if settings.wsl_backend_enabled {
        match resolve_wsl_secondary_launch_plan(app, &settings, port) {
            Ok(plan) => plans.push(plan),
            Err(error) => {
                tracing::warn!(
                    target: "t4code_desktop_tauri::backend",
                    "skipping secondary WSL backend launch planning: {error}"
                );
            }
        }
    }

    Ok(plans)
}

fn wsl_server_binary_candidates() -> Result<Vec<PathBuf>, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(WSL_SERVER_BINARY_ENV)
        && !path.is_empty()
    {
        candidates.push(PathBuf::from(path));
    }
    let current_dir = std::env::current_dir().map_err(|error| {
        format!("Could not resolve current directory for WSL binary discovery: {error}")
    })?;
    let target_root = current_dir.join("target");
    for triple in ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
        for profile in ["debug", "release"] {
            candidates.push(target_root.join(triple).join(profile).join("t4code"));
        }
    }
    Ok(candidates)
}

fn primary_backend_log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(state_dir(app)?
        .join("logs")
        .join(PRIMARY_BACKEND_LOG_FILE_NAME))
}

fn wsl_backend_log_path<R: Runtime>(app: &AppHandle<R>, distro: &str) -> Result<PathBuf, String> {
    let filename = format!(
        "{WSL_BACKEND_LOG_FILE_PREFIX}{}{WSL_BACKEND_LOG_FILE_EXTENSION}",
        sanitize_backend_log_file_segment(distro)
    );
    Ok(state_dir(app)?.join("logs").join(filename))
}

fn sanitize_backend_log_file_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedBackendExposure {
    mode: String,
    bind_host: String,
    endpoint_url: Option<String>,
    advertised_host: Option<String>,
}

pub fn resolve_lan_advertised_host() -> Option<String> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    let address = socket.local_addr().ok()?.ip();
    if !address.is_ipv4() || address.is_loopback() {
        return None;
    }
    let text = address.to_string();
    if text.starts_with("169.254.") {
        return None;
    }
    Some(text)
}

fn resolve_backend_exposure(
    settings: &BackendDesktopSettings,
    port: u16,
) -> ResolvedBackendExposure {
    resolve_backend_exposure_with(settings, port, resolve_lan_advertised_host)
}

fn resolve_backend_exposure_with(
    settings: &BackendDesktopSettings,
    port: u16,
    resolve_advertised_host: impl FnOnce() -> Option<String>,
) -> ResolvedBackendExposure {
    if settings.server_exposure_mode != "network-accessible" {
        return ResolvedBackendExposure {
            mode: "local-only".to_string(),
            bind_host: DESKTOP_LOOPBACK_HOST.to_string(),
            endpoint_url: None,
            advertised_host: None,
        };
    }

    match resolve_advertised_host() {
        Some(advertised_host) => ResolvedBackendExposure {
            mode: "network-accessible".to_string(),
            bind_host: DESKTOP_LAN_BIND_HOST.to_string(),
            endpoint_url: Some(format!("http://{advertised_host}:{port}")),
            advertised_host: Some(advertised_host),
        },
        None => ResolvedBackendExposure {
            mode: "local-only".to_string(),
            bind_host: DESKTOP_LOOPBACK_HOST.to_string(),
            endpoint_url: None,
            advertised_host: None,
        },
    }
}

fn select_desktop_backend_port() -> Option<u16> {
    select_desktop_backend_port_excluding(&[])
}

fn pick_desktop_backend_port_excluding(excluded: &[u16]) -> Option<u16> {
    select_desktop_backend_port_excluding(excluded).or_else(|| {
        (0..32)
            .filter_map(|_| portpicker::pick_unused_port())
            .find(|port| !excluded.contains(port))
    })
}

fn select_desktop_backend_port_excluding(excluded: &[u16]) -> Option<u16> {
    (DEFAULT_BACKEND_PORT..=MAX_TCP_PORT).find(|port| {
        !excluded.contains(port)
            && DESKTOP_BACKEND_PORT_PROBE_HOSTS
                .iter()
                .all(|host| can_listen_on_host(*port, host))
    })
}

fn can_listen_on_host(port: u16, host: &str) -> bool {
    TcpListener::bind((host, port)).is_ok()
}

fn normalize_tailscale_serve_port(value: Option<u64>) -> u16 {
    match value {
        Some(value) if (1..=u16::MAX as u64).contains(&value) => value as u16,
        _ => TAILSCALE_SERVE_PORT,
    }
}

fn normalize_wsl_distro(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| {
            value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
        })
}

fn read_backend_desktop_settings<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<BackendDesktopSettings, String> {
    let path = desktop_base_dir(app)?
        .join(if cfg!(debug_assertions) {
            "dev"
        } else {
            "userdata"
        })
        .join(DESKTOP_SETTINGS_FILE_NAME);

    let raw = match fs::read_to_string(&path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Could not read desktop backend settings from {}: {error}",
                path.display()
            ));
        }
    };

    Ok(decode_backend_desktop_settings(raw.as_deref()))
}

fn decode_backend_desktop_settings(raw: Option<&str>) -> BackendDesktopSettings {
    let document = raw
        .and_then(|raw| serde_json::from_str::<BackendDesktopSettingsDocument>(raw).ok())
        .unwrap_or_default();

    BackendDesktopSettings {
        server_exposure_mode: match document.server_exposure_mode.as_deref() {
            Some("network-accessible") => "network-accessible".to_string(),
            _ => "local-only".to_string(),
        },
        tailscale_serve_enabled: document.tailscale_serve_enabled.unwrap_or(false),
        tailscale_serve_port: normalize_tailscale_serve_port(document.tailscale_serve_port),
        wsl_backend_enabled: document.wsl_backend_enabled.unwrap_or(false),
        wsl_only: document.wsl_only.unwrap_or(false),
        wsl_distro: normalize_wsl_distro(document.wsl_distro),
    }
}

fn desktop_base_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match std::env::var_os(T4CODE_HOME_ENV) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => app
            .path()
            .home_dir()
            .map(|home| home.join(".t4code"))
            .map_err(|error| format!("Could not resolve desktop backend base directory: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        collections::VecDeque,
        io::{Read, Write},
        net::TcpListener,
        pin::Pin,
        sync::mpsc,
        task::{Context, Poll},
        thread,
        time::Duration,
    };
    use tokio::io::{AsyncRead, ReadBuf};

    struct ScriptedReader {
        steps: VecDeque<io::Result<Vec<u8>>>,
        completion: Option<oneshot::Sender<()>>,
    }

    impl AsyncRead for ScriptedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.steps.pop_front() {
                Some(Ok(bytes)) => {
                    buffer.put_slice(&bytes);
                    Poll::Ready(Ok(()))
                }
                Some(Err(error)) => {
                    if let Some(completion) = self.completion.take() {
                        let _ = completion.send(());
                    }
                    Poll::Ready(Err(error))
                }
                None => {
                    if let Some(completion) = self.completion.take() {
                        let _ = completion.send(());
                    }
                    Poll::Ready(Ok(()))
                }
            }
        }
    }

    fn spawn_http_response(
        response: &'static [u8],
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let address = listener.local_addr().expect("listener address");
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("listener should accept one request");
            let mut buffer = [0_u8; 4096];
            let count = stream.read(&mut buffer).expect("request should read");
            sender
                .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                .expect("request should be captured");
            stream.write_all(response).expect("response should write");
        });
        (format!("http://{address}"), receiver, server)
    }

    fn spawn_http_responses(
        responses: Vec<&'static [u8]>,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let address = listener.local_addr().expect("listener address");
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("listener should accept request");
                let mut buffer = [0_u8; 4096];
                let count = stream.read(&mut buffer).expect("request should read");
                sender
                    .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                    .expect("request should be captured");
                stream.write_all(response).expect("response should write");
            }
        });
        (format!("http://{address}"), receiver, server)
    }

    #[cfg(windows)]
    fn spawn_external_backend_http_server(
        shutdown_signal_path: PathBuf,
    ) -> (u16, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let port = listener.local_addr().expect("listener address").port();
        let (sender, receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            for (index, response) in [
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".as_slice(),
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                    .as_slice(),
            ]
            .into_iter()
            .enumerate()
            {
                let (mut stream, _) = listener.accept().expect("listener should accept request");
                let mut buffer = [0_u8; 8192];
                let count = stream.read(&mut buffer).expect("request should read");
                sender
                    .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                    .expect("request should be captured");
                stream.write_all(response).expect("response should write");
                stream.flush().expect("response should flush");
                if index == 1 {
                    fs::write(&shutdown_signal_path, b"shutdown")
                        .expect("shutdown signal should write");
                }
            }
        });
        (port, receiver, server)
    }

    #[cfg(windows)]
    fn powershell_string_literal(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "''"))
    }

    async fn start_test_server(base_dir: &Path) -> (t4code_server::ServerHandle, BackendRunConfig) {
        let mut config = local_test_config(0);
        let handle =
            ServerRuntime::start(server_config_for_launch(base_dir.to_path_buf(), &config))
                .await
                .expect("test server should start");
        config.port = handle.local_addr().port();
        (handle, config)
    }

    fn local_test_config(port: u16) -> BackendRunConfig {
        BackendRunConfig {
            environment_id: PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port,
            bind_host: "127.0.0.1".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "local-only".to_string(),
            endpoint_url: None,
            advertised_host: None,
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        }
    }

    #[test]
    fn builds_primary_bootstrap_for_frontend_resolution() {
        let config = local_test_config(3773);

        let bootstrap = config.to_environment_bootstrap();

        assert_eq!(bootstrap["id"], "primary");
        assert_eq!(bootstrap["label"], "Local");
        assert_eq!(bootstrap["runningDistro"], Value::Null);
        assert_eq!(bootstrap["httpBaseUrl"], "http://127.0.0.1:3773");
        assert_eq!(bootstrap["wsBaseUrl"], "ws://127.0.0.1:3773");
        assert_eq!(bootstrap["bootstrapToken"], "desktop-token");
    }

    #[test]
    fn run_config_builds_http_and_websocket_urls_from_renderer_host() {
        let mut config = local_test_config(65_535);
        config.local_host = "192.0.2.10".to_string();

        assert_eq!(config.http_base_url(), "http://192.0.2.10:65535");
        assert_eq!(config.ws_base_url(), "ws://192.0.2.10:65535");
    }

    #[test]
    fn backend_lifecycle_defaults_match_operational_limits() {
        assert_eq!(
            BackendReadinessConfig::default(),
            BackendReadinessConfig {
                timeout: Duration::from_secs(30),
                interval: Duration::from_millis(250),
                request_timeout: Duration::from_secs(2),
            }
        );
        assert_eq!(
            BackendShutdownConfig::default(),
            BackendShutdownConfig {
                timeout: Duration::from_millis(1_500),
            }
        );
        assert_eq!(
            BackendRestartConfig::default(),
            BackendRestartConfig {
                initial_delay: Duration::from_millis(250),
                max_delay: Duration::from_secs(5),
                monitor_interval: Duration::from_millis(250),
            }
        );
    }

    #[test]
    fn builds_local_server_launch_plan() {
        let config = local_test_config(3773);
        let plan =
            BackendLaunchPlan::local(PathBuf::from("C:/Users/mauro/.t4code"), config.clone());

        assert_eq!(plan.log_path, None);
        assert!(matches!(
            plan.target,
            BackendLaunchTarget::InProcess { ref base_dir } if base_dir == &PathBuf::from("C:/Users/mauro/.t4code")
        ));

        let logged_plan = plan.with_log_path(PathBuf::from(
            "C:/Users/mauro/.t4code/dev/logs/server-child.log",
        ));
        assert_eq!(
            logged_plan.log_path,
            Some(PathBuf::from(
                "C:/Users/mauro/.t4code/dev/logs/server-child.log"
            ))
        );
    }

    #[test]
    fn server_config_for_launch_uses_desktop_runtime_settings() {
        let config = local_test_config(3773);
        let server_config =
            server_config_for_launch(PathBuf::from("C:/Users/mauro/.t4code"), &config);

        assert_eq!(server_config.host, "127.0.0.1");
        assert_eq!(server_config.port, 3773);
        assert_eq!(
            server_config.base_dir,
            PathBuf::from("C:/Users/mauro/.t4code")
        );
        assert_eq!(
            server_config.desktop_bootstrap_token.as_deref(),
            Some("desktop-token")
        );
        assert_eq!(server_config.environment_id, "primary");
        assert_eq!(server_config.environment_label, "Local");
    }

    #[test]
    fn builds_wsl_launch_plan_with_explicit_binary() {
        let plan = BackendLaunchPlan::wsl(WslBackendLaunchPlanInput {
            environment_id: "wsl:Ubuntu".to_string(),
            label: "WSL (Ubuntu)".to_string(),
            running_distro: "Ubuntu".to_string(),
            port: 5050,
            renderer_host: "172.27.0.99".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            binary_path: "/tmp/t4code's launch/t4code".to_string(),
        })
        .with_log_path(PathBuf::from(
            "C:/Users/mauro/.t4code/dev/logs/server-child-wsl-Ubuntu.log",
        ));

        assert_eq!(plan.config.environment_id, "wsl:Ubuntu");
        assert_eq!(plan.config.label, "WSL (Ubuntu)");
        assert_eq!(plan.config.running_distro, Some("Ubuntu".to_string()));
        assert_eq!(plan.config.http_base_url(), "http://172.27.0.99:5050");
        assert_eq!(plan.config.bind_host, "0.0.0.0");
        assert!(matches!(
            plan.target,
            BackendLaunchTarget::ExternalProcess {
                ref program,
                ref args,
                ref bootstrap_line,
            } if program == "wsl.exe"
                && args == &vec![
                    "-d".to_string(),
                    "Ubuntu".to_string(),
                    "--exec".to_string(),
                    "env".to_string(),
                    format!("PATH={WSL_SERVER_SYSTEM_PATH}"),
                    "/tmp/t4code's launch/t4code".to_string(),
                    "serve".to_string(),
                    "--bootstrap-fd".to_string(),
                    "0".to_string(),
                ]
                && serde_json::from_str::<Value>(bootstrap_line).expect("bootstrap JSON")
                    == json!({
                        "mode": "desktop",
                        "noBrowser": true,
                        "port": 5050,
                        "host": "0.0.0.0",
                        "desktopBootstrapToken": "desktop-token",
                        "tailscaleServeEnabled": false,
                        "tailscaleServePort": 443,
                    })
        ));

        let bootstrap = plan.config.to_environment_bootstrap();
        assert_eq!(bootstrap["id"], "wsl:Ubuntu");
        assert_eq!(bootstrap["label"], "WSL (Ubuntu)");
        assert_eq!(bootstrap["runningDistro"], "Ubuntu");
        assert_eq!(
            plan.log_path,
            Some(PathBuf::from(
                "C:/Users/mauro/.t4code/dev/logs/server-child-wsl-Ubuntu.log"
            ))
        );
    }

    #[test]
    fn sanitizes_backend_log_file_segments_for_wsl_slots() {
        assert_eq!(
            sanitize_backend_log_file_segment("Ubuntu-22.04"),
            "Ubuntu-22.04"
        );
        assert_eq!(
            sanitize_backend_log_file_segment("my org/Ubuntu LTS"),
            "my_org_Ubuntu_LTS"
        );
        assert_eq!(sanitize_backend_log_file_segment(""), "default");
    }

    #[test]
    fn local_environment_bootstraps_include_parallel_primary_and_wsl_slots() {
        let supervisor = BackendSupervisor::new();
        let primary = BackendLaunchPlan::local(
            PathBuf::from("C:/Users/mauro/.t4code"),
            local_test_config(3773),
        );
        let wsl = BackendLaunchPlan::wsl(WslBackendLaunchPlanInput {
            environment_id: "wsl:Ubuntu".to_string(),
            label: "WSL (Ubuntu)".to_string(),
            running_distro: "Ubuntu".to_string(),
            port: 3774,
            renderer_host: "172.27.0.99".to_string(),
            desktop_bootstrap_token: "wsl-token".to_string(),
            binary_path: "/home/test/t4code".to_string(),
        });

        {
            let mut state = supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state.slots.insert(
                PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
                BackendSlotState {
                    launch_plan: Some(primary),
                    ..BackendSlotState::default()
                },
            );
            state.slots.insert(
                "wsl:Ubuntu".to_string(),
                BackendSlotState {
                    launch_plan: Some(wsl),
                    ..BackendSlotState::default()
                },
            );
        }

        let bootstraps = supervisor.local_environment_bootstraps();

        assert_eq!(bootstraps.len(), 2);
        assert_eq!(bootstraps[0]["id"], "primary");
        assert_eq!(bootstraps[1]["id"], "wsl:Ubuntu");
        assert_eq!(bootstraps[1]["label"], "WSL (Ubuntu)");
        assert_eq!(bootstraps[1]["httpBaseUrl"], "http://172.27.0.99:3774");
    }

    #[test]
    fn current_run_config_prefers_primary_slot_when_secondary_exists() {
        let supervisor = BackendSupervisor::new();
        let primary = BackendLaunchPlan::local(
            PathBuf::from("C:/Users/mauro/.t4code"),
            local_test_config(3773),
        );
        let wsl = BackendLaunchPlan::wsl(WslBackendLaunchPlanInput {
            environment_id: "wsl:Ubuntu".to_string(),
            label: "WSL (Ubuntu)".to_string(),
            running_distro: "Ubuntu".to_string(),
            port: 3774,
            renderer_host: "172.27.0.99".to_string(),
            desktop_bootstrap_token: "wsl-token".to_string(),
            binary_path: "/home/test/t4code".to_string(),
        });

        {
            let mut state = supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state.slots.insert(
                "wsl:Ubuntu".to_string(),
                BackendSlotState {
                    launch_plan: Some(wsl),
                    ..BackendSlotState::default()
                },
            );
            state.slots.insert(
                PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
                BackendSlotState {
                    launch_plan: Some(primary),
                    ..BackendSlotState::default()
                },
            );
        }

        let config = supervisor
            .current_run_config()
            .expect("primary config should be selected");

        assert_eq!(config.environment_id, "primary");
        assert_eq!(config.running_distro, None);
    }

    #[test]
    fn supervisor_state_queries_handle_empty_error_and_secondary_slots() {
        let supervisor = BackendSupervisor::new();
        assert_eq!(supervisor.current_run_config(), None);
        assert!(supervisor.local_environment_bootstraps().is_empty());

        let secondary = BackendLaunchPlan::wsl(WslBackendLaunchPlanInput {
            environment_id: "wsl:Debian".to_string(),
            label: "WSL (Debian)".to_string(),
            running_distro: "Debian".to_string(),
            port: 4_101,
            renderer_host: "172.20.0.2".to_string(),
            desktop_bootstrap_token: "secondary-token".to_string(),
            binary_path: "/usr/local/bin/t4code".to_string(),
        });
        {
            let mut state = supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state.slots.insert(
                PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
                BackendSlotState {
                    launch_plan: Some(BackendLaunchPlan::local(
                        PathBuf::from("C:/state"),
                        local_test_config(4_100),
                    )),
                    ..BackendSlotState::default()
                },
            );
            state.slots.insert(
                "wsl:Debian".to_string(),
                BackendSlotState {
                    launch_plan: Some(secondary.clone()),
                    ..BackendSlotState::default()
                },
            );
        }

        supervisor.record_error("primary failed");
        let bootstraps = supervisor.local_environment_bootstraps();
        assert_eq!(bootstraps.len(), 1);
        assert_eq!(bootstraps[0]["id"], "wsl:Debian");

        {
            let mut state = supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            state.slots.remove(PRIMARY_LOCAL_ENVIRONMENT_ID);
        }
        assert_eq!(supervisor.current_run_config(), Some(secondary.config));
    }

    #[test]
    fn record_plan_error_resets_runtime_state_and_hides_bootstrap() {
        let supervisor = BackendSupervisor::new();
        let plan = BackendLaunchPlan::local(PathBuf::from("C:/state"), local_test_config(4_200));

        supervisor.record_plan_error(&plan, "launch failed".to_string());

        assert!(supervisor.local_environment_bootstraps().is_empty());
        let state = supervisor
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        let slot = state
            .slots
            .get(PRIMARY_LOCAL_ENVIRONMENT_ID)
            .expect("primary slot should be recorded");
        assert_eq!(slot.launch_plan.as_ref(), Some(&plan));
        assert!(slot.backend.is_none());
        assert_eq!(slot.pid, None);
        assert_eq!(slot.last_error.as_deref(), Some("launch failed"));
        assert!(!slot.restart_scheduled);
    }

    #[test]
    fn supervisor_run_ids_increment_and_saturate() {
        let supervisor = BackendSupervisor::new();
        assert_eq!(supervisor.next_run_id(), Ok(0));
        assert_eq!(supervisor.next_run_id(), Ok(1));

        supervisor
            .state
            .lock()
            .expect("backend supervisor mutex poisoned")
            .next_run_id = u64::MAX;
        assert_eq!(supervisor.next_run_id(), Ok(u64::MAX));
        assert_eq!(supervisor.next_run_id(), Ok(u64::MAX));
    }

    #[test]
    fn restart_desire_requires_a_scheduled_plan_without_a_backend() {
        let supervisor = BackendSupervisor::new();
        assert!(!supervisor.restart_still_desired("missing"));

        let plan = BackendLaunchPlan::local(PathBuf::from("C:/state"), local_test_config(4_250));
        supervisor.schedule_restart(
            plan.clone(),
            BackendReadinessConfig::default(),
            BackendRestartConfig::default(),
            "missing slot".to_string(),
        );
        assert!(
            supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned")
                .slots
                .is_empty()
        );
        let mut state = supervisor
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        state.slots.insert(
            PRIMARY_LOCAL_ENVIRONMENT_ID.to_string(),
            BackendSlotState {
                launch_plan: Some(plan),
                restart_scheduled: true,
                ..BackendSlotState::default()
            },
        );
        drop(state);
        assert!(supervisor.restart_still_desired(PRIMARY_LOCAL_ENVIRONMENT_ID));

        let mut state = supervisor
            .state
            .lock()
            .expect("backend supervisor mutex poisoned");
        state
            .slots
            .get_mut(PRIMARY_LOCAL_ENVIRONMENT_ID)
            .expect("primary slot")
            .restart_scheduled = false;
        drop(state);
        assert!(!supervisor.restart_still_desired(PRIMARY_LOCAL_ENVIRONMENT_ID));
    }

    #[tokio::test]
    async fn stopping_an_empty_supervisor_is_idempotent() {
        let supervisor = BackendSupervisor::new();

        supervisor
            .stop(BackendShutdownConfig {
                timeout: Duration::ZERO,
            })
            .await
            .expect("empty supervisor should stop");
        supervisor
            .stop(BackendShutdownConfig {
                timeout: Duration::ZERO,
            })
            .await
            .expect("repeated empty stop should succeed");
    }

    #[test]
    fn parses_wsl_distribution_list_with_default_marker() {
        let entries = parse_wsl_distro_entries(
            "\
  NAME            STATE           VERSION
* Ubuntu-24.04    Running         2
  Debian          Stopped         2
",
        );

        assert_eq!(
            entries,
            vec![
                WslDistroEntry {
                    name: "Ubuntu-24.04".to_string(),
                    is_default: true,
                },
                WslDistroEntry {
                    name: "Debian".to_string(),
                    is_default: false,
                },
            ],
        );
    }

    #[test]
    fn wsl_parser_ignores_headers_blank_rows_and_embedded_nuls() {
        assert_eq!(
            parse_wsl_distro_entries(
                "\0NAME STATE VERSION\0\n\n name Stopped 2\n*\0Fedora\0 Running 2\n"
            ),
            vec![WslDistroEntry {
                name: "Fedora".to_string(),
                is_default: true,
            }]
        );
        assert!(parse_wsl_distro_entries("\n\0\nNAME STATE VERSION\n").is_empty());
    }

    #[test]
    fn decodes_utf16_little_endian_wsl_output() {
        let text = "NAME\0\n*\0 Ubuntu\0\n";
        let mut bytes = vec![0xff, 0xfe];
        for value in text.encode_utf16() {
            bytes.extend_from_slice(&value.to_le_bytes());
        }

        assert_eq!(decode_wsl_command_output(&bytes), text);
    }

    #[test]
    fn decodes_plain_and_lossy_wsl_output() {
        assert_eq!(decode_wsl_command_output(b"Ubuntu\n"), "Ubuntu\n");
        assert_eq!(decode_wsl_command_output(&[b'a', 0xff]), "a\u{fffd}");

        let mut odd_utf16 = vec![0xff, 0xfe];
        odd_utf16.extend_from_slice(&u16::from(b'A').to_le_bytes());
        odd_utf16.push(0xff);
        assert_eq!(decode_wsl_command_output(&odd_utf16), "A");
    }

    #[test]
    fn normalizes_wsl_distro_names_for_command_arguments() {
        assert_eq!(
            normalize_wsl_distro(Some("  Ubuntu-24.04  ".to_string())),
            Some("Ubuntu-24.04".to_string()),
        );
        assert_eq!(normalize_wsl_distro(Some("".to_string())), None);
        assert_eq!(
            normalize_wsl_distro(Some("Ubuntu; rm -rf /".to_string())),
            None
        );
        assert_eq!(normalize_wsl_distro(None), None);
        assert_eq!(
            normalize_wsl_distro(Some("Fedora_41.test".to_string())),
            Some("Fedora_41.test".to_string())
        );
    }

    #[test]
    fn configured_wsl_distro_does_not_require_discovery() {
        let settings = BackendDesktopSettings {
            server_exposure_mode: "local-only".to_string(),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
            wsl_backend_enabled: true,
            wsl_only: false,
            wsl_distro: Some("Debian".to_string()),
        };

        assert_eq!(resolve_wsl_distro(&settings), Ok("Debian".to_string()));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unavailable_wsl_commands_fail_through_native_resolution_helpers() {
        let settings = BackendDesktopSettings {
            server_exposure_mode: "local-only".to_string(),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
            wsl_backend_enabled: true,
            wsl_only: true,
            wsl_distro: Some("Missing".to_string()),
        };

        assert!(
            list_wsl_distros()
                .unwrap_err()
                .contains("Could not list WSL")
        );
        assert!(
            resolve_wsl_path("Missing", Path::new("/tmp/repository"))
                .unwrap_err()
                .contains("Could not run wsl.exe")
        );
        assert_eq!(resolve_wsl_renderer_host("Missing"), None);
        assert!(resolve_wsl_server_binary("Missing").is_err());
        assert!(
            resolve_wsl_launch_plan_for_distro(
                "Missing".to_string(),
                3773,
                "token".to_string(),
                PathBuf::from("backend.log"),
                "wsl:Missing".to_string(),
                "WSL Missing".to_string(),
            )
            .is_err()
        );
        assert!(
            resolve_wsl_primary_launch_plan(
                &settings,
                3773,
                "token".to_string(),
                PathBuf::from("backend.log"),
            )
            .is_err()
        );
        let _ = select_desktop_backend_port();
        let _ = resolve_lan_advertised_host();
    }

    #[test]
    fn normalizes_tailscale_ports_and_local_only_exposure() {
        assert_eq!(normalize_tailscale_serve_port(None), 443);
        assert_eq!(normalize_tailscale_serve_port(Some(0)), 443);
        assert_eq!(normalize_tailscale_serve_port(Some(1)), 1);
        assert_eq!(normalize_tailscale_serve_port(Some(65_535)), 65_535);
        assert_eq!(normalize_tailscale_serve_port(Some(65_536)), 443);

        let settings = BackendDesktopSettings {
            server_exposure_mode: "unsupported".to_string(),
            tailscale_serve_enabled: true,
            tailscale_serve_port: 8_443,
            wsl_backend_enabled: false,
            wsl_only: false,
            wsl_distro: None,
        };
        assert_eq!(
            resolve_backend_exposure(&settings, 3_773),
            ResolvedBackendExposure {
                mode: "local-only".to_string(),
                bind_host: "127.0.0.1".to_string(),
                endpoint_url: None,
                advertised_host: None,
            }
        );
    }

    #[test]
    fn desktop_settings_decode_defaults_malformed_input_and_valid_fields() {
        let defaults = decode_backend_desktop_settings(None);
        assert_eq!(
            defaults,
            BackendDesktopSettings {
                server_exposure_mode: "local-only".to_string(),
                tailscale_serve_enabled: false,
                tailscale_serve_port: 443,
                wsl_backend_enabled: false,
                wsl_only: false,
                wsl_distro: None,
            }
        );
        assert_eq!(decode_backend_desktop_settings(Some("not-json")), defaults);

        assert_eq!(
            decode_backend_desktop_settings(Some(
                r#"{
                    "serverExposureMode": "network-accessible",
                    "tailscaleServeEnabled": true,
                    "tailscaleServePort": 8443,
                    "wslBackendEnabled": true,
                    "wslOnly": true,
                    "wslDistro": "  Ubuntu-24.04  "
                }"#,
            )),
            BackendDesktopSettings {
                server_exposure_mode: "network-accessible".to_string(),
                tailscale_serve_enabled: true,
                tailscale_serve_port: 8_443,
                wsl_backend_enabled: true,
                wsl_only: true,
                wsl_distro: Some("Ubuntu-24.04".to_string()),
            }
        );

        let invalid = decode_backend_desktop_settings(Some(
            r#"{
                "serverExposureMode": "public",
                "tailscaleServePort": 70000,
                "wslDistro": "Ubuntu;rm"
            }"#,
        ));
        assert_eq!(invalid.server_exposure_mode, "local-only");
        assert_eq!(invalid.tailscale_serve_port, 443);
        assert_eq!(invalid.wsl_distro, None);
    }

    #[test]
    fn network_exposure_uses_resolved_host_or_falls_back_closed() {
        let settings = BackendDesktopSettings {
            server_exposure_mode: "network-accessible".to_string(),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
            wsl_backend_enabled: false,
            wsl_only: false,
            wsl_distro: None,
        };

        assert_eq!(
            resolve_backend_exposure_with(&settings, 3_773, || Some("10.0.0.8".to_string())),
            ResolvedBackendExposure {
                mode: "network-accessible".to_string(),
                bind_host: "0.0.0.0".to_string(),
                endpoint_url: Some("http://10.0.0.8:3773".to_string()),
                advertised_host: Some("10.0.0.8".to_string()),
            }
        );
        assert_eq!(
            resolve_backend_exposure_with(&settings, 3_773, || None),
            ResolvedBackendExposure {
                mode: "local-only".to_string(),
                bind_host: "127.0.0.1".to_string(),
                endpoint_url: None,
                advertised_host: None,
            }
        );
    }

    #[test]
    fn local_only_exposure_does_not_resolve_lan_route() {
        let settings = BackendDesktopSettings {
            server_exposure_mode: "local-only".to_string(),
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
            wsl_backend_enabled: false,
            wsl_only: false,
            wsl_distro: None,
        };
        let resolver_called = Cell::new(false);

        let exposure = resolve_backend_exposure_with(&settings, 3_773, || {
            resolver_called.set(true);
            Some("10.0.0.8".to_string())
        });

        assert!(!resolver_called.get());
        assert_eq!(
            exposure,
            ResolvedBackendExposure {
                mode: "local-only".to_string(),
                bind_host: "127.0.0.1".to_string(),
                endpoint_url: None,
                advertised_host: None,
            }
        );
    }

    #[test]
    fn mock_runtime_resolves_default_backend_paths_and_launch_plan() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app");
        let handle = app.handle();
        assert!(desktop_base_dir(handle).unwrap().is_absolute());
        assert!(
            primary_backend_log_path(handle)
                .unwrap()
                .ends_with(PRIMARY_BACKEND_LOG_FILE_NAME)
        );
        assert!(
            wsl_backend_log_path(handle, "Ubuntu Test")
                .unwrap()
                .ends_with("server-child-wsl-Ubuntu_Test.log")
        );
        assert!(!default_launch_plans(handle).unwrap().is_empty());
    }

    #[tokio::test]
    async fn mock_runtime_starts_restarts_and_stops_the_default_backend() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let mut context = mock_context(noop_assets());
        context.config_mut().identifier =
            format!("com.t4code.backend-tests-{}", std::process::id());
        let app = mock_builder().build(context).expect("mock Tauri app");
        let base_dir = desktop_base_dir(app.handle()).expect("desktop base directory");
        let _ = fs::remove_dir_all(&base_dir);
        let supervisor = BackendSupervisor::new();

        let started = supervisor
            .start_default(app.handle().clone())
            .await
            .expect("default backend should start");
        assert_ne!(started.port, 0);

        let restarted = supervisor
            .restart_default_if_active(app.handle().clone())
            .await
            .expect("default backend should restart")
            .expect("active backend should produce a replacement config");
        assert_ne!(restarted.port, 0);

        supervisor
            .stop(BackendShutdownConfig::default())
            .await
            .expect("default backend should stop");
        let _ = fs::remove_dir_all(base_dir);
    }

    #[test]
    fn writes_backend_log_chunks_with_stream_prefixes() {
        let path = std::env::temp_dir().join(format!(
            "t4code-tauri-backend-log-{}-{}.log",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .expect("test log should open");

            write_backend_log_chunk(&mut file, "stdout", b"ready").expect("stdout should write");
            write_backend_log_chunk(&mut file, "stderr", b"warn\n").expect("stderr should write");
        }

        let contents = fs::read_to_string(&path).expect("test log should read");
        assert!(contents.contains("[stdout] ready\n"));
        assert!(contents.contains("[stderr] warn\n"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn backend_log_open_creates_parents_and_rejects_invalid_targets() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let nested = temp.path().join("nested").join("backend.log");
        let mut file = open_backend_log_file(&nested).expect("nested log should open");
        write_backend_log_chunk(&mut file, "stdout", b"").expect("empty chunk should write");
        drop(file);
        assert_eq!(
            fs::read_to_string(&nested).expect("nested log should read"),
            "[stdout] \n"
        );

        let parent_file = temp.path().join("not-a-directory");
        fs::write(&parent_file, b"file").expect("parent fixture should write");
        assert!(open_backend_log_file(&parent_file.join("backend.log")).is_none());
        assert!(open_backend_log_file(temp.path()).is_none());
    }

    #[tokio::test]
    async fn drain_output_persists_chunks_and_stops_on_end_or_read_error() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let log_path = temp.path().join("backend.log");
        let (completion, completed) = oneshot::channel();
        drain_output(
            "stdout",
            Some(ScriptedReader {
                steps: VecDeque::from([Ok(b"first".to_vec()), Ok(b"second\n".to_vec())]),
                completion: Some(completion),
            }),
            Some(log_path.clone()),
        );
        completed.await.expect("output drain should reach EOF");
        assert_eq!(
            fs::read_to_string(&log_path).expect("drained log should read"),
            "[stdout] first\n[stdout] second\n"
        );

        let (completion, completed) = oneshot::channel();
        drain_output(
            "stderr",
            Some(ScriptedReader {
                steps: VecDeque::from([Err(io::Error::other("read failed"))]),
                completion: Some(completion),
            }),
            None,
        );
        completed
            .await
            .expect("output drain should observe read error");
    }

    #[test]
    fn drain_output_without_a_stream_is_a_noop() {
        let stream: Option<tokio::io::Empty> = None;
        drain_output("stdout", stream, None);
    }

    #[tokio::test]
    async fn wait_for_http_ready_accepts_environment_endpoint_success() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let port = listener.local_addr().expect("listener address").port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("listener should accept one request");
            let mut buffer = [0_u8; 1024];
            let count = stream.read(&mut buffer).expect("request should read");
            let request = String::from_utf8_lossy(&buffer[..count]);
            assert!(request.starts_with("GET /.well-known/t4code/environment "));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}")
                .expect("response should write");
        });

        let readiness = BackendReadinessConfig {
            timeout: Duration::from_secs(2),
            interval: Duration::from_millis(10),
            request_timeout: Duration::from_secs(1),
        };

        wait_for_http_ready(&format!("http://127.0.0.1:{port}"), &readiness)
            .await
            .expect("environment endpoint should become ready");
    }

    #[tokio::test]
    async fn readiness_probe_accepts_http_10_and_rejects_non_success_or_malformed_status() {
        for (response, expected) in [
            (
                b"HTTP/1.0 204 No Content\r\ncontent-length: 0\r\n\r\n" as &'static [u8],
                true,
            ),
            (
                b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n" as &'static [u8],
                false,
            ),
            (b"not-http\r\n\r\n" as &'static [u8], false),
        ] {
            let (base_url, request, server) = spawn_http_response(response);
            assert_eq!(
                probe_http_ready(&base_url, Duration::from_secs(1)).await,
                Ok(expected)
            );
            let request = request.recv().expect("request should be captured");
            assert!(request.starts_with("GET /.well-known/t4code/environment HTTP/1.1"));
            server.join().expect("server should finish");
        }
    }

    #[test]
    fn readiness_probe_rejects_invalid_and_unsupported_urls() {
        let invalid = probe_http_ready_blocking("not a URL", Duration::from_millis(10))
            .expect_err("invalid URL should fail");
        assert!(invalid.contains("Invalid backend URL"));

        let unsupported = probe_http_ready_blocking("https://localhost", Duration::from_millis(10))
            .expect_err("HTTPS should fail closed");
        assert_eq!(
            unsupported,
            "Unsupported backend readiness URL scheme: https"
        );
    }

    #[tokio::test]
    async fn readiness_wait_reports_the_last_non_success_status_at_deadline() {
        let (base_url, _request, server) =
            spawn_http_response(b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
        let error = wait_for_http_ready(
            &base_url,
            &BackendReadinessConfig {
                timeout: Duration::ZERO,
                interval: Duration::ZERO,
                request_timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect_err("non-success should miss readiness deadline");

        assert!(error.contains(&format!("{base_url}{BACKEND_READINESS_PATH}")));
        assert!(error.contains("readiness endpoint returned a non-success status"));
        server.join().expect("server should finish");
    }

    #[tokio::test]
    async fn readiness_wait_retries_after_non_success_until_endpoint_is_ready() {
        let (base_url, requests, server) = spawn_http_responses(vec![
            b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}",
        ]);

        wait_for_http_ready(
            &base_url,
            &BackendReadinessConfig {
                timeout: Duration::from_secs(2),
                interval: Duration::ZERO,
                request_timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect("second readiness response should succeed");

        assert!(requests.recv().expect("first request").starts_with("GET "));
        assert!(requests.recv().expect("second request").starts_with("GET "));
        server.join().expect("server should finish");
    }

    #[tokio::test]
    async fn requests_soft_shutdown_endpoint_with_desktop_bootstrap_token() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let port = listener.local_addr().expect("listener address").port();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("listener should accept one request");
            let mut buffer = [0_u8; 2048];
            let count = stream.read(&mut buffer).expect("request should read");
            let request = String::from_utf8_lossy(&buffer[..count]).to_string();
            sender.send(request).expect("request should be captured");
            stream
                .write_all(
                    b"HTTP/1.1 202 Accepted\r\ncontent-length: 22\r\n\r\n{\"shuttingDown\":true}",
                )
                .expect("response should write");
        });
        let config = local_test_config(port);

        request_backend_soft_shutdown(&config, Duration::from_secs(1))
            .await
            .expect("soft shutdown should be requested");

        let request = receiver.recv().expect("request should be captured");
        assert!(request.starts_with("POST /.well-known/t4code/desktop/shutdown HTTP/1.1"));
        assert!(request.contains("x-t4code-desktop-bootstrap-token: desktop-token"));
    }

    #[tokio::test]
    async fn soft_shutdown_rejects_non_success_status() {
        let (base_url, request, server) =
            spawn_http_response(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        let port = url::Url::parse(&base_url)
            .expect("base URL should parse")
            .port()
            .expect("base URL should have port");
        let error = request_backend_soft_shutdown(&local_test_config(port), Duration::from_secs(1))
            .await
            .expect_err("non-success shutdown should fail");

        assert_eq!(error, "Desktop backend shutdown endpoint returned 403.");
        assert!(
            request
                .recv()
                .expect("request should be captured")
                .starts_with("POST /.well-known/t4code/desktop/shutdown HTTP/1.1")
        );
        server.join().expect("server should finish");
    }

    #[tokio::test]
    async fn managed_backend_reports_process_spawn_and_local_bind_failures() {
        let missing = BackendLaunchPlan {
            target: BackendLaunchTarget::ExternalProcess {
                program: format!("missing-t4code-backend-{}", Uuid::new_v4().simple()),
                args: Vec::new(),
                bootstrap_line: "{}\n".to_string(),
            },
            log_path: None,
            config: local_test_config(4_300),
        };
        let error = start_managed_backend(
            missing,
            BackendReadinessConfig {
                timeout: Duration::ZERO,
                interval: Duration::ZERO,
                request_timeout: Duration::ZERO,
            },
            0,
        )
        .await
        .expect_err("missing executable should fail");
        assert!(error.contains("Could not start desktop backend using"));

        let temp = tempfile::tempdir().expect("tempdir should open");
        let occupied = TcpListener::bind(("127.0.0.1", 0)).expect("port fixture should bind");
        let port = occupied.local_addr().expect("listener address").port();
        let error = start_managed_backend(
            BackendLaunchPlan::local(temp.path().to_path_buf(), local_test_config(port)),
            BackendReadinessConfig {
                timeout: Duration::ZERO,
                interval: Duration::ZERO,
                request_timeout: Duration::ZERO,
            },
            1,
        )
        .await
        .expect_err("occupied local port should fail");
        assert!(error.contains("Could not start in-process desktop backend"));
    }

    #[tokio::test]
    async fn in_process_start_cleans_up_when_renderer_readiness_is_unreachable() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let mut config = local_test_config(0);
        config.local_host = "127.0.0.2".to_string();
        let error = start_managed_backend(
            BackendLaunchPlan::local(temp.path().to_path_buf(), config),
            BackendReadinessConfig {
                timeout: Duration::ZERO,
                interval: Duration::ZERO,
                request_timeout: Duration::from_millis(20),
            },
            8,
        )
        .await
        .expect_err("unreachable renderer address should fail readiness");

        assert!(error.contains("Desktop backend did not become ready"));
        assert!(error.contains(BACKEND_READINESS_PATH));
    }

    #[tokio::test]
    async fn managed_runtime_stop_is_idempotent_and_waits_for_server_completion() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let (handle, _config) = start_test_server(temp.path()).await;
        let runtime = ManagedBackendRuntime::new(41, handle);
        assert_eq!(
            format!("{runtime:?}"),
            "ManagedBackendRuntime { run_id: 41, .. }"
        );
        assert!(!runtime.stop_requested.load(Ordering::SeqCst));

        runtime.request_stop();
        runtime.request_stop();
        assert!(runtime.stop_requested.load(Ordering::SeqCst));
        runtime
            .wait_for_completion()
            .await
            .expect("runtime should join cleanly");
        runtime
            .wait_for_completion()
            .await
            .expect("completed runtime result should remain available");
    }

    #[tokio::test]
    async fn stop_managed_backend_shuts_down_an_in_process_runtime() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let (handle, _config) = start_test_server(temp.path()).await;
        let runtime = ManagedBackendRuntime::new(42, handle);

        stop_managed_backend(
            ManagedBackend::Runtime(Box::new(runtime)),
            BackendShutdownConfig {
                timeout: Duration::from_secs(2),
            },
        )
        .await
        .expect("managed runtime should stop");
    }

    #[tokio::test]
    async fn public_start_persists_the_os_assigned_in_process_port() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let supervisor = BackendSupervisor::new();

        let started = supervisor
            .start(BackendLaunchPlan::local(
                temp.path().to_path_buf(),
                local_test_config(0),
            ))
            .await
            .expect("ephemeral-port runtime should start");

        assert_ne!(started.port, 0);
        assert_eq!(supervisor.current_run_config(), Some(started.clone()));
        assert_eq!(
            supervisor.local_environment_bootstraps()[0]["httpBaseUrl"],
            started.http_base_url()
        );
        supervisor
            .stop(BackendShutdownConfig {
                timeout: Duration::from_secs(2),
            })
            .await
            .expect("ephemeral-port runtime should stop");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stop_managed_backend_accepts_an_already_exited_child() {
        let mut process = Command::new("cmd.exe")
            .args(["/D", "/C", "exit", "0"])
            .spawn()
            .expect("fixture child should start");
        process.wait().await.expect("fixture child should exit");
        let mut config = local_test_config(4_350);
        config.local_host = "invalid host".to_string();
        let child = ManagedBackendChild::new(9, config, process);
        assert_eq!(
            format!("{child:?}"),
            "ManagedBackendChild { run_id: 9, .. }"
        );

        stop_managed_backend(
            ManagedBackend::Child(Box::new(child)),
            BackendShutdownConfig {
                timeout: Duration::ZERO,
            },
        )
        .await
        .expect("already exited child should be accepted");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_managed_backend_terminates_a_live_child() {
        let process = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .spawn()
            .expect("fixture child should start");
        let child = ManagedBackendChild::new(9, local_test_config(1), process);
        let observed_child = child.clone();
        assert_eq!(
            format!("{child:?}"),
            "ManagedBackendChild { run_id: 9, .. }"
        );

        stop_managed_backend(
            ManagedBackend::Child(Box::new(child)),
            BackendShutdownConfig {
                timeout: Duration::from_secs(2),
            },
        )
        .await
        .expect("live child should stop after soft termination");

        assert!(observed_child.stop_requested.load(Ordering::SeqCst));
        assert!(
            observed_child
                .child
                .lock()
                .await
                .try_wait()
                .expect("child status should remain inspectable")
                .is_some()
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn external_backend_receives_bootstrap_serves_readiness_and_shuts_down() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let bootstrap_path = temp.path().join("bootstrap.txt");
        let shutdown_signal_path = temp.path().join("shutdown.signal");
        let shutdown_observed_path = temp.path().join("shutdown-observed.txt");
        let shutdown_signal_name = PathBuf::from(
            shutdown_signal_path
                .file_name()
                .expect("shutdown signal should have a file name"),
        );
        let (port, requests, server) =
            spawn_external_backend_http_server(shutdown_signal_path.clone());
        let script = format!(
            r#"
$watcher = [IO.FileSystemWatcher]::new({}, {})
$sourceIdentifier = 't4code-shutdown-' + [Guid]::NewGuid().ToString('N')
[void](Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $sourceIdentifier)
$watcher.EnableRaisingEvents = $true
try {{
  $bootstrap = [Console]::In.ReadToEnd()
  [IO.File]::WriteAllText({}, $bootstrap)
  if (-not [IO.File]::Exists({})) {{
    [void](Wait-Event -SourceIdentifier $sourceIdentifier)
  }}
  [IO.File]::WriteAllText({}, 'shutdown-observed')
}} finally {{
  $watcher.EnableRaisingEvents = $false
  Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue
  $watcher.Dispose()
}}
"#,
            powershell_string_literal(temp.path()),
            powershell_string_literal(&shutdown_signal_name),
            powershell_string_literal(&bootstrap_path),
            powershell_string_literal(&shutdown_signal_path),
            powershell_string_literal(&shutdown_observed_path),
        );
        let bootstrap_line = "{\"mode\":\"desktop-test\"}\n".to_string();
        let plan = BackendLaunchPlan {
            target: BackendLaunchTarget::ExternalProcess {
                program: "powershell.exe".to_string(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    script,
                ],
                bootstrap_line: bootstrap_line.clone(),
            },
            log_path: Some(temp.path().join("child.log")),
            config: local_test_config(port),
        };

        let (config, backend, pid) = start_managed_backend(
            plan,
            BackendReadinessConfig {
                timeout: Duration::from_secs(5),
                interval: Duration::from_millis(10),
                request_timeout: Duration::from_secs(1),
            },
            10,
        )
        .await
        .expect("external backend should become ready");
        assert_eq!(config.port, port);
        assert!(pid.is_some());
        assert!(matches!(backend, ManagedBackend::Child(_)));
        let readiness = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("readiness request should be captured")
            .to_ascii_lowercase();
        assert!(readiness.starts_with(&format!("get {BACKEND_READINESS_PATH} http/1.1")));

        stop_managed_backend(
            backend,
            BackendShutdownConfig {
                timeout: Duration::from_secs(3),
            },
        )
        .await
        .expect("external backend should shut down gracefully");

        assert_eq!(
            fs::read_to_string(&bootstrap_path).expect("bootstrap should be captured"),
            bootstrap_line
        );
        let shutdown = requests
            .recv_timeout(Duration::from_secs(1))
            .expect("shutdown request should be captured")
            .to_ascii_lowercase();
        assert!(shutdown.starts_with("post /.well-known/t4code/desktop/shutdown http/1.1"));
        assert!(shutdown.contains("x-t4code-desktop-bootstrap-token: desktop-token"));
        server.join().expect("test HTTP server should finish");
        assert!(shutdown_signal_path.is_file());
        assert_eq!(
            fs::read_to_string(&shutdown_observed_path)
                .expect("child should record observing shutdown"),
            "shutdown-observed"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn child_that_ignores_soft_shutdown_is_force_killed_after_timeout() {
        let (base_url, requests, server) = spawn_http_responses(vec![
            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}",
            b"HTTP/1.1 202 Accepted\r\ncontent-length: 2\r\n\r\n{}",
        ]);
        let port = url::Url::parse(&base_url)
            .expect("base URL should parse")
            .port()
            .expect("base URL should have port");
        let plan = BackendLaunchPlan {
            target: BackendLaunchTarget::ExternalProcess {
                program: "powershell.exe".to_string(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Wait-Event".to_string(),
                ],
                bootstrap_line: "{}\n".to_string(),
            },
            log_path: None,
            config: local_test_config(port),
        };
        let (_config, backend, _pid) = start_managed_backend(
            plan,
            BackendReadinessConfig {
                timeout: Duration::from_secs(2),
                interval: Duration::ZERO,
                request_timeout: Duration::from_secs(1),
            },
            11,
        )
        .await
        .expect("independent readiness endpoint should accept child");

        stop_managed_backend(
            backend,
            BackendShutdownConfig {
                timeout: Duration::from_millis(250),
            },
        )
        .await
        .expect("unresponsive child should be force-killed");

        assert!(
            requests
                .recv()
                .expect("readiness request")
                .starts_with("GET ")
        );
        assert!(
            requests
                .recv()
                .expect("shutdown request")
                .starts_with("POST ")
        );
        server.join().expect("server should finish");
    }

    #[tokio::test]
    async fn soft_shutdown_reports_connection_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("port fixture should bind");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);

        let error =
            request_backend_soft_shutdown(&local_test_config(port), Duration::from_millis(250))
                .await
                .expect_err("closed endpoint should reject shutdown request");
        assert!(error.contains("Could not request desktop backend shutdown"));
    }

    #[test]
    fn port_selection_excludes_requested_ports_and_wsl_candidates_cover_both_architectures() {
        let selected = pick_desktop_backend_port_excluding(&[DEFAULT_BACKEND_PORT])
            .expect("an alternate backend port should be available");
        assert_ne!(selected, DEFAULT_BACKEND_PORT);
        assert_ne!(selected, 0);
        assert!(can_listen_on_host(0, "127.0.0.1"));
        assert!(!can_listen_on_host(0, "127.0.0.1\0"));

        let candidates = wsl_server_binary_candidates().expect("candidate discovery should work");
        for suffix in [
            PathBuf::from("target/x86_64-unknown-linux-gnu/debug/t4code"),
            PathBuf::from("target/x86_64-unknown-linux-gnu/release/t4code"),
            PathBuf::from("target/aarch64-unknown-linux-gnu/debug/t4code"),
            PathBuf::from("target/aarch64-unknown-linux-gnu/release/t4code"),
        ] {
            assert!(
                candidates
                    .iter()
                    .any(|candidate| candidate.ends_with(&suffix)),
                "missing WSL candidate ending in {}",
                suffix.display()
            );
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_child_soft_termination_is_not_reported_as_available() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit", "0"])
            .spawn()
            .expect("fixture child should start");

        assert!(!request_child_soft_termination(&mut child));
        child.wait().await.expect("fixture child should exit");
    }

    #[tokio::test]
    async fn local_runtime_starts_without_child_process_and_clears_state_on_stop() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let port = portpicker::pick_unused_port().expect("test port should be available");
        let plan = BackendLaunchPlan::local(temp.path().to_path_buf(), local_test_config(port));
        let supervisor = BackendSupervisor::new();

        supervisor
            .start_with_options(
                plan,
                BackendReadinessConfig {
                    timeout: Duration::from_secs(2),
                    interval: Duration::from_millis(10),
                    request_timeout: Duration::from_millis(500),
                },
                BackendRestartConfig {
                    initial_delay: Duration::from_millis(20),
                    max_delay: Duration::from_millis(20),
                    monitor_interval: Duration::from_millis(10),
                },
            )
            .await
            .expect("local runtime should start");

        assert_eq!(supervisor.local_environment_bootstraps().len(), 1);

        {
            let state = supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned");
            let slot = state
                .slots
                .get(PRIMARY_LOCAL_ENVIRONMENT_ID)
                .expect("primary slot should exist");
            assert!(matches!(slot.backend, Some(ManagedBackend::Runtime(_))));
            assert_eq!(slot.pid, None);
        }

        supervisor
            .stop(BackendShutdownConfig {
                timeout: Duration::from_secs(2),
            })
            .await
            .expect("supervisor should stop runtime");

        assert!(supervisor.local_environment_bootstraps().is_empty());
        assert!(
            supervisor
                .state
                .lock()
                .expect("backend supervisor mutex poisoned")
                .slots
                .is_empty()
        );
    }

    #[test]
    fn restart_delay_uses_exponential_backoff_with_cap() {
        let restart = BackendRestartConfig {
            initial_delay: Duration::from_millis(50),
            max_delay: Duration::from_millis(180),
            monitor_interval: Duration::from_millis(10),
        };

        assert_eq!(
            restart_delay_for_attempt(1, &restart),
            Duration::from_millis(50)
        );
        assert_eq!(
            restart_delay_for_attempt(2, &restart),
            Duration::from_millis(100)
        );
        assert_eq!(
            restart_delay_for_attempt(3, &restart),
            Duration::from_millis(180)
        );
        assert_eq!(
            restart_delay_for_attempt(8, &restart),
            Duration::from_millis(180)
        );
    }

    #[tokio::test]
    async fn restarting_local_runtime_replaces_the_previous_in_process_server() {
        let temp = tempfile::tempdir().expect("tempdir should open");
        let first_port = portpicker::pick_unused_port().expect("first port should be available");
        let second_port = loop {
            let candidate =
                portpicker::pick_unused_port().expect("second port should be available");
            if candidate != first_port {
                break candidate;
            }
        };
        let supervisor = BackendSupervisor::new();

        supervisor
            .start_with_options(
                BackendLaunchPlan::local(temp.path().to_path_buf(), local_test_config(first_port)),
                BackendReadinessConfig {
                    timeout: Duration::from_secs(2),
                    interval: Duration::from_millis(10),
                    request_timeout: Duration::from_millis(500),
                },
                BackendRestartConfig {
                    initial_delay: Duration::from_millis(20),
                    max_delay: Duration::from_millis(20),
                    monitor_interval: Duration::from_millis(10),
                },
            )
            .await
            .expect("first local runtime should start");

        supervisor
            .start_with_options(
                BackendLaunchPlan::local(temp.path().to_path_buf(), local_test_config(second_port)),
                BackendReadinessConfig {
                    timeout: Duration::from_secs(2),
                    interval: Duration::from_millis(10),
                    request_timeout: Duration::from_millis(500),
                },
                BackendRestartConfig {
                    initial_delay: Duration::from_millis(20),
                    max_delay: Duration::from_millis(20),
                    monitor_interval: Duration::from_millis(10),
                },
            )
            .await
            .expect("second local runtime should restart in place");

        assert_eq!(
            supervisor
                .current_run_config()
                .expect("current config should exist")
                .port,
            second_port
        );
        let first_runtime_stopped = match probe_http_ready(
            &format!("http://127.0.0.1:{first_port}"),
            Duration::from_millis(250),
        )
        .await
        {
            Ok(ready) => !ready,
            Err(_) => true,
        };
        assert!(
            first_runtime_stopped,
            "first local runtime should be shut down before replacement"
        );
        assert!(
            probe_http_ready(
                &format!("http://127.0.0.1:{second_port}"),
                Duration::from_millis(250)
            )
            .await
            .expect("replacement runtime probe should complete"),
            "replacement local runtime should answer readiness checks"
        );

        supervisor
            .stop(BackendShutdownConfig {
                timeout: Duration::from_secs(2),
            })
            .await
            .expect("supervisor should stop replacement runtime");
    }
}
