use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus},
    diagnostics::{
        DiagnosticsMonitor, NativeProcessSampler, ProcessResourceHistory, ProcessSampler,
        ProcessSignal, SamplingLease, build_process_tree_entries,
    },
    production::orchestration_effects::SetupScriptLaunch,
    provider_usage::{
        ProviderUsageProvider, ProviderUsageResult, ProviderUsageService, ProviderUsageSnapshot,
        ProviderUsageStatus, ProviderUsageWindow,
    },
    rpc::{RpcRegistry, RpcResult, RpcStreamChunk},
    terminal::{TerminalAttachInput, TerminalManager, TerminalMetadataEvent, TerminalOpenInput},
};

pub type JsonFuture = Pin<Box<dyn Future<Output = RpcResult> + Send + 'static>>;
pub type JsonStream = mpsc::Receiver<RpcStreamChunk>;

/// Required bridge to Rust domains whose registries are assembled by the production runtime.
/// Implementations return contract-encoded JSON from the in-process native runtime.
pub trait ProductionServerControl: std::fmt::Debug + Send + Sync + 'static {
    fn call(
        &self,
        method: &'static str,
        payload: Value,
        cancellation: CancellationToken,
    ) -> JsonFuture;

    fn subscribe(&self, method: &'static str, cancellation: CancellationToken) -> JsonStream;
}

#[derive(Clone)]
pub struct ServerTerminalServices {
    terminal: TerminalManager,
    process_sampler: Arc<NativeProcessSampler>,
    process_monitor: Arc<DiagnosticsMonitor<NativeProcessSampler>>,
    _process_history_lease: Arc<SamplingLease>,
    provider_usage: ProviderUsageService,
    relay: RelayClientService,
    control: Arc<dyn ProductionServerControl>,
}

impl ServerTerminalServices {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        terminal: TerminalManager,
        process_sampler: Arc<NativeProcessSampler>,
        process_monitor: Arc<DiagnosticsMonitor<NativeProcessSampler>>,
        provider_usage: ProviderUsageService,
        relay: RelayClientService,
        control: Arc<dyn ProductionServerControl>,
    ) -> Self {
        let process_history_lease = Arc::new(process_monitor.retain_history());
        Self {
            terminal,
            process_sampler,
            process_monitor,
            _process_history_lease: process_history_lease,
            provider_usage,
            relay,
            control,
        }
    }

    pub async fn shutdown(&self) {
        self.process_monitor.shutdown();
        self.terminal.shutdown().await;
        let _ = self
            .process_sampler
            .cleanup_descendants(std::process::id())
            .await;
    }

    pub async fn close_thread_terminals(&self, thread_id: &str) {
        self.terminal.close(thread_id, None).await;
    }

    pub async fn launch_setup_script(&self, input: SetupScriptLaunch) -> Result<(), String> {
        let mut terminal_input = TerminalOpenInput::new(
            input.thread_id.clone(),
            input.terminal_id.clone(),
            input.cwd,
            120,
            30,
        );
        terminal_input.worktree_path = Some(input.worktree_path);
        terminal_input.env = input.env;
        self.terminal
            .open(terminal_input)
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = self
            .terminal
            .write(
                &input.thread_id,
                &input.terminal_id,
                &format!("{}\r", input.command),
            )
            .await
        {
            self.terminal
                .close(&input.thread_id, Some(&input.terminal_id))
                .await;
            return Err(error.to_string());
        }
        Ok(())
    }
}

pub fn register_server_terminal_rpc(registry: &mut RpcRegistry, services: ServerTerminalServices) {
    register_control_rpcs(registry, &services);
    register_diagnostics_rpcs(registry, &services);
    register_provider_usage_rpcs(registry, &services);
    register_cloud_rpcs(registry, &services);
    register_terminal_rpcs(registry, &services);
}

fn register_control_rpcs(registry: &mut RpcRegistry, services: &ServerTerminalServices) {
    for method in [
        "server.getConfig",
        "server.getSettings",
        "server.getTraceDiagnostics",
        "server.refreshProviders",
        "server.removeKeybinding",
        "server.updateProvider",
        "server.updateSettings",
        "server.upsertKeybinding",
    ] {
        let control = services.control.clone();
        registry.register_unary(method, move |request, cancellation| {
            control.call(method, request.payload, cancellation)
        });
    }
    for method in [
        "subscribeServerConfig",
        "subscribeServerLifecycle",
        "subscribeDiscoveredLocalServers",
    ] {
        let control = services.control.clone();
        registry.register_stream(method, move |_request, cancellation| {
            control.subscribe(method, cancellation)
        });
    }
}

fn register_diagnostics_rpcs(registry: &mut RpcRegistry, services: &ServerTerminalServices) {
    let sampler = services.process_sampler.clone();
    registry.register_unary(
        "server.getProcessDiagnostics",
        move |_request, _cancellation| {
            let sampler = sampler.clone();
            async move {
                let read_at = OffsetDateTime::now_utc();
                match sampler.sample().await {
                    Ok(rows) => {
                        let server_pid = std::process::id();
                        let processes = build_process_tree_entries(&rows, server_pid);
                        let total_rss_bytes =
                            processes.iter().map(|row| row.rss_bytes).sum::<u64>();
                        let total_cpu_percent = processes
                            .iter()
                            .map(|row| f64::from(row.cpu_percent))
                            .sum::<f64>();
                        Ok(json!({
                            "serverPid": server_pid,
                            "readAt": format_time(read_at),
                            "processCount": processes.len(),
                            "totalRssBytes": total_rss_bytes,
                            "totalCpuPercent": total_cpu_percent,
                            "processes": processes.into_iter().map(|row| json!({
                                "pid": row.pid,
                                "ppid": row.ppid,
                                "pgid": effect_option(row.pgid),
                                "status": row.status,
                                "cpuPercent": row.cpu_percent,
                                "rssBytes": row.rss_bytes,
                                "elapsed": row.elapsed,
                                "command": row.command,
                                "depth": row.depth,
                                "childPids": row.child_pids,
                            })).collect::<Vec<_>>(),
                            "error": effect_none(),
                        }))
                    }
                    Err(error) => Ok(json!({
                        "serverPid": std::process::id(),
                        "readAt": format_time(read_at),
                        "processCount": 0,
                        "totalRssBytes": 0,
                        "totalCpuPercent": 0.0,
                        "processes": [],
                        "error": effect_some(json!({ "message": error.to_string() })),
                    })),
                }
            }
        },
    );

    let monitor = services.process_monitor.clone();
    registry.register_unary(
        "server.getProcessResourceHistory",
        move |request, _cancellation| {
            let monitor = monitor.clone();
            async move {
                let input: ResourceHistoryInput = decode_payload(&request.payload)?;
                Ok(resource_history_to_wire(
                    monitor.read_history(input.window_ms, input.bucket_ms).await,
                ))
            }
        },
    );

    let sampler = services.process_sampler.clone();
    registry.register_unary("server.signalProcess", move |request, _cancellation| {
        let sampler = sampler.clone();
        async move {
            let input: SignalProcessInput = decode_payload(&request.payload)?;
            let signal = match input.signal.as_str() {
                "SIGINT" => ProcessSignal::Interrupt,
                "SIGKILL" => ProcessSignal::Kill,
                _ => return Err(invalid_request("signal must be SIGINT or SIGKILL")),
            };
            match sampler
                .signal_descendant(std::process::id(), input.pid, signal)
                .await
            {
                Ok(()) => Ok(json!({
                    "pid": input.pid,
                    "signal": input.signal,
                    "signaled": true,
                    "message": effect_none(),
                })),
                Err(error) => Ok(json!({
                    "pid": input.pid,
                    "signal": input.signal,
                    "signaled": false,
                    "message": effect_some(Value::String(error.to_string())),
                })),
            }
        }
    });
}

fn register_provider_usage_rpcs(registry: &mut RpcRegistry, services: &ServerTerminalServices) {
    let usage = services.provider_usage.clone();
    registry.register_unary("server.getProviderUsage", move |_request, _cancellation| {
        let usage = usage.clone();
        async move { Ok(provider_usage_to_wire(usage.read().await)) }
    });

    let usage = services.provider_usage.clone();
    registry.register_unary(
        "server.refreshProviderUsage",
        move |request, _cancellation| {
            let usage = usage.clone();
            async move {
                let input: RefreshProviderUsageInput = decode_payload(&request.payload)?;
                let providers = input
                    .providers
                    .map(|providers| {
                        providers
                            .into_iter()
                            .map(|provider| match provider.as_str() {
                                "claude" => Ok(ProviderUsageProvider::Claude),
                                "codex" => Ok(ProviderUsageProvider::Codex),
                                _ => Err(invalid_request("provider must be claude or codex")),
                            })
                            .collect::<Result<Vec<_>, Value>>()
                    })
                    .transpose()?;
                Ok(provider_usage_to_wire(usage.refresh(providers).await))
            }
        },
    );
}

fn register_cloud_rpcs(registry: &mut RpcRegistry, services: &ServerTerminalServices) {
    let relay = services.relay.clone();
    registry.register_unary(
        "cloud.getRelayClientStatus",
        move |_request, _cancellation| {
            let relay = relay.clone();
            async move { Ok(relay_status_to_wire(relay.resolve().await)) }
        },
    );

    let relay = services.relay.clone();
    registry.register_stream("cloud.installRelayClient", move |_request, cancellation| {
        let relay = relay.clone();
        spawn_stream(cancellation, move |sender, cancellation| async move {
            let result = tokio::select! {
                () = cancellation.cancelled() => return,
                result = relay.install() => result,
            };
            match result {
                Ok(events) => {
                    for event in events {
                        if sender
                            .send(Ok(vec![relay_event_to_wire(event)]))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                Err(message) => {
                    let _ = sender
                        .send(Err(json!({
                            "_tag": "RelayClientInstallFailedError",
                            "reason": "download_failed",
                            "message": message,
                        })))
                        .await;
                }
            }
        })
    });
}

fn register_terminal_rpcs(registry: &mut RpcRegistry, services: &ServerTerminalServices) {
    let terminal = services.terminal.clone();
    registry.register_unary("terminal.open", move |request, _cancellation| {
        let terminal = terminal.clone();
        async move {
            let input: TerminalStartPayload = decode_payload(&request.payload)?;
            terminal
                .open(input.into_open(false)?)
                .await
                .map(|snapshot| {
                    serde_json::to_value(snapshot).expect("terminal snapshot serializes")
                })
                .map_err(terminal_error)
        }
    });

    let terminal = services.terminal.clone();
    registry.register_stream("terminal.attach", move |request, cancellation| {
        let terminal = terminal.clone();
        spawn_stream(cancellation, move |sender, cancellation| async move {
            let input: TerminalAttachPayload = match decode_payload(&request.payload) {
                Ok(input) => input,
                Err(error) => { let _ = sender.send(Err(error)).await; return; }
            };
            let mut attachment = match terminal.attach(input.into_attach()).await {
                Ok(attachment) => attachment,
                Err(error) => { let _ = sender.send(Err(terminal_error(error))).await; return; }
            };
            if sender.send(Ok(vec![json!({
                "type": "snapshot",
                "snapshot": attachment.initial,
            })])).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    () = cancellation.cancelled() => return,
                    event = attachment.recv() => match event {
                        Some(event) => if sender.send(Ok(vec![serde_json::to_value(event).expect("terminal event serializes")])).await.is_err() { return; },
                        None => return,
                    }
                }
            }
        })
    });

    register_terminal_unary(
        registry,
        "terminal.write",
        services.terminal.clone(),
        |terminal, payload| {
            Box::pin(async move {
                let input: TerminalWritePayload = decode_payload(&payload)?;
                terminal
                    .write(&input.thread_id, &input.terminal_id, &input.data)
                    .await
                    .map_err(terminal_error)?;
                Ok(Value::Null)
            })
        },
    );
    register_terminal_unary(
        registry,
        "terminal.resize",
        services.terminal.clone(),
        |terminal, payload| {
            Box::pin(async move {
                let input: TerminalResizePayload = decode_payload(&payload)?;
                terminal
                    .resize(&input.thread_id, &input.terminal_id, input.cols, input.rows)
                    .await
                    .map_err(terminal_error)?;
                Ok(Value::Null)
            })
        },
    );
    register_terminal_unary(
        registry,
        "terminal.clear",
        services.terminal.clone(),
        |terminal, payload| {
            Box::pin(async move {
                let input: TerminalSessionPayload = decode_payload(&payload)?;
                terminal
                    .clear(&input.thread_id, &input.terminal_id)
                    .await
                    .map_err(terminal_error)?;
                Ok(Value::Null)
            })
        },
    );
    register_terminal_unary(
        registry,
        "terminal.restart",
        services.terminal.clone(),
        |terminal, payload| {
            Box::pin(async move {
                let input: TerminalStartPayload = decode_payload(&payload)?;
                terminal
                    .restart(input.into_open(true)?)
                    .await
                    .map(|snapshot| {
                        serde_json::to_value(snapshot).expect("terminal snapshot serializes")
                    })
                    .map_err(terminal_error)
            })
        },
    );
    register_terminal_unary(
        registry,
        "terminal.close",
        services.terminal.clone(),
        |terminal, payload| {
            Box::pin(async move {
                let input: TerminalClosePayload = decode_payload(&payload)?;
                terminal
                    .close(&input.thread_id, input.terminal_id.as_deref())
                    .await;
                Ok(Value::Null)
            })
        },
    );

    let terminal = services.terminal.clone();
    registry.register_stream("subscribeTerminalEvents", move |_request, cancellation| {
        let mut events = terminal.subscribe_events();
        spawn_stream(cancellation, move |sender, cancellation| async move {
            loop {
                tokio::select! {
                    () = cancellation.cancelled() => return,
                    event = events.recv() => match event {
                        Ok(event) => if sender.send(Ok(vec![serde_json::to_value(event).expect("terminal event serializes")])).await.is_err() { return; },
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        })
    });

    let terminal = services.terminal.clone();
    registry.register_stream("subscribeTerminalMetadata", move |_request, cancellation| {
        let terminal = terminal.clone();
        spawn_stream(cancellation, move |sender, cancellation| async move {
            let mut attachment = terminal.subscribe_metadata().await;
            if sender.send(Ok(vec![json!({ "type": "snapshot", "terminals": attachment.initial })])).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    () = cancellation.cancelled() => return,
                    event = attachment.recv() => match event {
                        Some(event) => if sender.send(Ok(vec![terminal_metadata_to_wire(event)])).await.is_err() { return; },
                        None => return,
                    }
                }
            }
        })
    });
}

type TerminalUnary = fn(TerminalManager, Value) -> JsonFuture;

fn register_terminal_unary(
    registry: &mut RpcRegistry,
    method: &'static str,
    terminal: TerminalManager,
    handler: TerminalUnary,
) {
    registry.register_unary(method, move |request, _cancellation| {
        handler(terminal.clone(), request.payload)
    });
}

fn spawn_stream<F, Fut>(cancellation: CancellationToken, task: F) -> JsonStream
where
    F: FnOnce(mpsc::Sender<RpcStreamChunk>, CancellationToken) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel(64);
    tokio::spawn(task(sender, cancellation));
    receiver
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStartPayload {
    thread_id: String,
    terminal_id: String,
    cwd: String,
    worktree_path: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

impl TerminalStartPayload {
    fn into_open(self, dimensions_required: bool) -> Result<TerminalOpenInput, Value> {
        let cols = self
            .cols
            .or((!dimensions_required).then_some(120))
            .ok_or_else(|| invalid_request("cols is required"))?;
        let rows = self
            .rows
            .or((!dimensions_required).then_some(30))
            .ok_or_else(|| invalid_request("rows is required"))?;
        Ok(TerminalOpenInput {
            thread_id: self.thread_id,
            terminal_id: self.terminal_id,
            cwd: PathBuf::from(self.cwd),
            worktree_path: self.worktree_path.map(PathBuf::from),
            cols,
            rows,
            env: self.env,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAttachPayload {
    thread_id: String,
    terminal_id: String,
    cwd: Option<String>,
    worktree_path: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    restart_if_not_running: bool,
}

impl TerminalAttachPayload {
    fn into_attach(self) -> TerminalAttachInput {
        TerminalAttachInput {
            thread_id: self.thread_id,
            terminal_id: self.terminal_id,
            cwd: self.cwd.map(PathBuf::from),
            worktree_path: self.worktree_path.map(PathBuf::from),
            cols: self.cols,
            rows: self.rows,
            env: self.env,
            restart_if_not_running: self.restart_if_not_running,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionPayload {
    thread_id: String,
    terminal_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWritePayload {
    thread_id: String,
    terminal_id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizePayload {
    thread_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalClosePayload {
    thread_id: String,
    terminal_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceHistoryInput {
    window_ms: u64,
    bucket_ms: u64,
}
#[derive(Deserialize)]
struct SignalProcessInput {
    pid: u32,
    signal: String,
}
#[derive(Deserialize)]
struct RefreshProviderUsageInput {
    providers: Option<Vec<String>>,
}

fn decode_payload<T: for<'de> Deserialize<'de>>(payload: &Value) -> Result<T, Value> {
    serde_json::from_value(payload.clone()).map_err(|error| invalid_request(&error.to_string()))
}

fn provider_usage_to_wire(result: ProviderUsageResult) -> Value {
    json!({
        "readAt": format_time(result.read_at),
        "isFetching": result.is_fetching,
        "providers": result.providers.into_iter().map(provider_usage_snapshot_to_wire).collect::<Vec<_>>(),
    })
}

fn provider_usage_snapshot_to_wire(snapshot: ProviderUsageSnapshot) -> Value {
    json!({
        "provider": match snapshot.provider { ProviderUsageProvider::Claude => "claude", ProviderUsageProvider::Codex => "codex" },
        "status": match snapshot.status {
            ProviderUsageStatus::Idle => "idle", ProviderUsageStatus::Fetching => "fetching",
            ProviderUsageStatus::Ok => "ok", ProviderUsageStatus::Error => "error",
            ProviderUsageStatus::Unavailable => "unavailable",
        },
        "session": snapshot.session.map(provider_usage_window_to_wire),
        "weekly": snapshot.weekly.map(provider_usage_window_to_wire),
        "updatedAt": format_time(snapshot.updated_at),
        "error": snapshot.error,
        "metadata": snapshot.metadata,
    })
}

fn provider_usage_window_to_wire(window: ProviderUsageWindow) -> Value {
    json!({
        "usedPercent": window.used_percent,
        "windowMinutes": window.window_minutes,
        "resetsAt": window.resets_at.map(format_time),
        "resetDescription": window.reset_description,
    })
}

fn resource_history_to_wire(history: ProcessResourceHistory) -> Value {
    json!({
        "readAt": format_epoch_ms(history.read_at_ms),
        "windowMs": history.window_ms,
        "bucketMs": history.bucket_ms,
        "sampleIntervalMs": history.sample_interval_ms,
        "retainedSampleCount": history.retained_sample_count,
        "totalCpuSecondsApprox": history.total_cpu_seconds_approx,
        "buckets": history.buckets.into_iter().map(|bucket| json!({
            "startedAt": format_epoch_ms(bucket.started_at_ms), "endedAt": format_epoch_ms(bucket.ended_at_ms),
            "avgCpuPercent": bucket.avg_cpu_percent, "maxCpuPercent": bucket.max_cpu_percent,
            "maxRssBytes": bucket.max_rss_bytes, "maxProcessCount": bucket.max_process_count,
        })).collect::<Vec<_>>(),
        "topProcesses": history.top_processes.into_iter().map(|process| json!({
            "processKey": process.process_key, "pid": process.pid, "ppid": process.ppid,
            "command": process.command, "depth": process.depth, "isServerRoot": process.is_server_root,
            "firstSeenAt": format_epoch_ms(process.first_seen_at_ms), "lastSeenAt": format_epoch_ms(process.last_seen_at_ms),
            "currentCpuPercent": process.current_cpu_percent, "avgCpuPercent": process.avg_cpu_percent,
            "maxCpuPercent": process.max_cpu_percent, "cpuSecondsApprox": process.cpu_seconds_approx,
            "currentRssBytes": process.current_rss_bytes, "maxRssBytes": process.max_rss_bytes,
            "sampleCount": process.sample_count,
        })).collect::<Vec<_>>(),
        "error": history.error.map_or_else(effect_none, |message| effect_some(json!({
            "failureTag": "ProcessDiagnosticsQueryFailedError", "message": message,
        }))),
    })
}

fn relay_status_to_wire(status: RelayClientStatus) -> Value {
    match status {
        RelayClientStatus::Available {
            executable_path,
            source,
            version,
        } => json!({
            "status": "available", "executablePath": executable_path, "source": source, "version": version,
        }),
        RelayClientStatus::Missing { version } => {
            json!({ "status": "missing", "version": version })
        }
        RelayClientStatus::Unsupported {
            platform,
            arch,
            version,
        } => json!({
            "status": "unsupported", "platform": platform, "arch": arch, "version": version,
        }),
    }
}

fn relay_event_to_wire(event: RelayClientInstallEvent) -> Value {
    match event {
        RelayClientInstallEvent::Progress { stage } => {
            json!({ "type": "progress", "stage": stage })
        }
        RelayClientInstallEvent::Complete { status } => {
            json!({ "type": "complete", "status": relay_status_to_wire(status) })
        }
    }
}

fn terminal_metadata_to_wire(event: TerminalMetadataEvent) -> Value {
    serde_json::to_value(event).expect("terminal metadata event serializes")
}

fn terminal_error(error: impl ToString) -> Value {
    let message = error.to_string();
    if let Some(cwd) = message.strip_prefix("terminal cwd does not exist: ") {
        return json!({ "_tag": "TerminalCwdNotFoundError", "cwd": cwd });
    }
    if let Some(cwd) = message.strip_prefix("terminal cwd is not a directory: ") {
        return json!({ "_tag": "TerminalCwdNotDirectoryError", "cwd": cwd });
    }
    for (prefix, tag) in [
        ("unknown terminal thread: ", "TerminalSessionLookupError"),
        (
            "terminal is not running for thread: ",
            "TerminalNotRunningError",
        ),
    ] {
        if let Some(details) = message.strip_prefix(prefix)
            && let Some((thread_id, terminal_id)) = details.split_once(", terminal: ")
        {
            return json!({
                "_tag": tag,
                "threadId": thread_id,
                "terminalId": terminal_id,
            });
        }
    }
    json!({
        "_tag": "TerminalCwdStatError", "cwd": "", "cause": message,
    })
}

fn invalid_request(message: &str) -> Value {
    json!({ "_tag": "RpcRequestInvalid", "message": message })
}

fn effect_none() -> Value {
    json!({ "_tag": "None" })
}
fn effect_some(value: Value) -> Value {
    json!({ "_tag": "Some", "value": value })
}
fn effect_option<T: serde::Serialize>(value: Option<T>) -> Value {
    value.map_or_else(effect_none, |value| effect_some(json!(value)))
}

fn format_time(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn format_epoch_ms(value: i128) -> String {
    let nanos = value.saturating_mul(1_000_000);
    i64::try_from(nanos)
        .ok()
        .and_then(|nanos| OffsetDateTime::from_unix_timestamp_nanos(i128::from(nanos)).ok())
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}
