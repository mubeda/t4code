use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus},
    diagnostics::{
        AttributionKind, CurrentProcessDiagnostics, DiagnosticsMonitor, NativeProcessSampler,
        NativeResourceSampler, ProcessResourceHistory, ProcessSignal, build_process_tree_entries,
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
    process_monitor: Arc<DiagnosticsMonitor<NativeResourceSampler>>,
    provider_usage: ProviderUsageService,
    relay: RelayClientService,
    control: Arc<dyn ProductionServerControl>,
}

impl ServerTerminalServices {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        terminal: TerminalManager,
        process_sampler: Arc<NativeProcessSampler>,
        process_monitor: Arc<DiagnosticsMonitor<NativeResourceSampler>>,
        provider_usage: ProviderUsageService,
        relay: RelayClientService,
        control: Arc<dyn ProductionServerControl>,
    ) -> Self {
        Self {
            terminal,
            process_sampler,
            process_monitor,
            provider_usage,
            relay,
            control,
        }
    }

    pub async fn shutdown(&self) {
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
    let monitor = services.process_monitor.clone();
    registry.register_unary(
        "server.getProcessDiagnostics",
        move |_request, _cancellation| {
            let monitor = monitor.clone();
            async move { Ok(process_diagnostics_to_wire(monitor.sample_current().await)) }
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

fn process_diagnostics_to_wire(current: CurrentProcessDiagnostics) -> Value {
    let read_at_ms = current.snapshot.as_ref().map_or_else(
        || OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000,
        |snapshot| snapshot.sampled_at_ms,
    );
    let error = current.error.map_or_else(effect_none, |message| {
        effect_some(json!({ "message": message }))
    });
    let Some(snapshot) = current.snapshot else {
        return json!({
            "serverPid": std::process::id(),
            "readAt": format_epoch_ms(read_at_ms),
            "processCount": 0,
            "totalRssBytes": 0,
            "totalCpuPercent": 0.0,
            "processes": [],
            "error": error,
        });
    };
    let server_pid = snapshot.server_identity.pid;
    let processes = build_process_tree_entries(&snapshot.native_rows, server_pid);
    let total_rss_bytes = processes
        .iter()
        .map(|process| process.rss_bytes)
        .sum::<u64>();
    let total_cpu_percent = processes
        .iter()
        .map(|process| f64::from(process.cpu_percent))
        .sum::<f64>();

    json!({
        "serverPid": server_pid,
        "readAt": format_epoch_ms(read_at_ms),
        "processCount": processes.len(),
        "totalRssBytes": total_rss_bytes,
        "totalCpuPercent": total_cpu_percent,
        "processes": processes.into_iter().map(|process| {
            json!({
                "pid": process.pid,
                "ppid": process.ppid,
                "pgid": process.pgid.map_or_else(effect_none, |pgid| effect_some(json!(pgid))),
                "status": process.status,
                "cpuPercent": process.cpu_percent,
                "rssBytes": process.rss_bytes,
                "elapsed": process.elapsed,
                "command": process.command,
                "depth": process.depth,
                "childPids": process.child_pids,
            })
        }).collect::<Vec<_>>(),
        "error": error,
    })
}

fn resource_history_to_wire(history: ProcessResourceHistory) -> Value {
    let latest_sampled_at_ms = history.latest_sampled_at_ms;
    let mut top_processes = history
        .processes
        .into_iter()
        .filter(|process| Some(process.last_seen_at_ms) == latest_sampled_at_ms)
        .collect::<Vec<_>>();
    top_processes.sort_by(|left, right| {
        right
            .cpu_seconds_approx
            .total_cmp(&left.cpu_seconds_approx)
            .then_with(|| left.process_key.cmp(&right.process_key))
    });

    json!({
        "readAt": format_epoch_ms(history.read_at_ms),
        "windowMs": history.window_ms,
        "bucketMs": history.bucket_ms,
        "sampleIntervalMs": history.sample_interval_ms,
        "retainedSampleCount": history.retained_sample_count,
        "totalCpuSecondsApprox": history.total_cpu_seconds_approx.combined,
        "buckets": history.buckets.into_iter().map(|bucket| json!({
            "startedAt": format_epoch_ms(bucket.started_at_ms), "endedAt": format_epoch_ms(bucket.ended_at_ms),
            "avgCpuPercent": bucket.cpu_percent.average.combined,
            "maxCpuPercent": bucket.cpu_percent.peak.combined,
            "maxRssBytes": bucket.rss_bytes.peak.combined,
            "maxProcessCount": bucket.max_process_count.combined,
        })).collect::<Vec<_>>(),
        "topProcesses": top_processes.into_iter().map(|process| json!({
            "processKey": process.process_key, "pid": process.pid, "ppid": 0,
            "command": if process.label.trim().is_empty() { "unknown" } else { &process.label },
            "depth": 0, "isServerRoot": process.kind == AttributionKind::Server,
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::{
        ServerConfig,
        diagnostics::{
            AttributedProcess, AttributedProcessSnapshot, AttributionConfidence, AttributionKind,
            AttributionScope, BucketMetric, NativeResourceSampler, NotApplicableUiProcessObserver,
            ProcessAttributionRegistry, ProcessAttributionTotals, ProcessIdentity,
            ProcessResourceBucket, ProcessResourceSummary, ProcessRow, SplitMetric, UiCoverage,
        },
        production::control::NativeServerControl,
        terminal::{PortablePtyBackend, TerminalManagerOptions},
    };

    use super::*;

    #[test]
    fn typed_payload_decoders_reject_non_object_wire_values() {
        let invalid = json!("not-an-object");
        assert!(decode_payload::<RefreshProviderUsageInput>(&invalid).is_err());
        assert!(decode_payload::<ResourceHistoryInput>(&invalid).is_err());
        assert!(decode_payload::<SignalProcessInput>(&invalid).is_err());
        assert!(decode_payload::<TerminalAttachPayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalClosePayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalResizePayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalSessionPayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalWritePayload>(&invalid).is_err());
        assert_eq!(format_epoch_ms(i128::MAX), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn legacy_history_wire_only_ranks_processes_present_in_the_latest_sample() {
        fn summary(
            process_key: &str,
            last_seen_at_ms: i128,
            cpu_seconds_approx: f64,
        ) -> ProcessResourceSummary {
            ProcessResourceSummary {
                process_key: process_key.to_owned(),
                pid: 1,
                scope: AttributionScope::Core,
                kind: AttributionKind::Provider,
                label: process_key.to_owned(),
                confidence: AttributionConfidence::Exact,
                first_seen_at_ms: 0,
                last_seen_at_ms,
                current_cpu_percent: 1.0,
                avg_cpu_percent: 1.0,
                max_cpu_percent: 1.0,
                cpu_seconds_approx,
                current_rss_bytes: 1,
                max_rss_bytes: 1,
                sample_count: 1,
            }
        }

        let wire = resource_history_to_wire(ProcessResourceHistory {
            read_at_ms: 2_000,
            latest_sampled_at_ms: Some(2_000),
            window_ms: 60_000,
            bucket_ms: 1_000,
            sample_interval_ms: 500,
            retained_sample_count: 2,
            total_cpu_seconds_approx: SplitMetric::default(),
            ui_coverage: UiCoverage::default(),
            buckets: Vec::new(),
            processes: vec![
                summary("exited:high-cpu", 1_000, 100.0),
                summary("active:z", 2_000, 2.0),
                summary("active:b", 2_000, 4.0),
                summary("active:a", 2_000, 4.0),
            ],
            error: None,
        });

        assert_eq!(
            wire["topProcesses"]
                .as_array()
                .expect("top processes")
                .iter()
                .map(|process| process["processKey"].as_str().expect("process key"))
                .collect::<Vec<_>>(),
            ["active:a", "active:b", "active:z"]
        );
    }

    #[test]
    fn legacy_current_wire_reproduces_the_native_multilevel_server_tree() {
        let mut server = ProcessRow::fixture(10, 1, "/opt/t4code server");
        server.started_at = 100;
        server.pgid = Some(10);
        server.status = "Sleep".to_owned();
        server.cpu_percent = 1.5;
        server.rss_bytes = 100;
        server.elapsed = "01:02:03".to_owned();
        let mut child = ProcessRow::fixture(11, 10, "codex --model gpt");
        child.started_at = 110;
        child.pgid = Some(10);
        child.status = "Run".to_owned();
        child.cpu_percent = 2.5;
        child.rss_bytes = 200;
        child.elapsed = "00:02:00".to_owned();
        let mut grandchild = ProcessRow::fixture(12, 11, "git status");
        grandchild.started_at = 120;
        grandchild.pgid = Some(12);
        grandchild.status = "Stop".to_owned();
        grandchild.cpu_percent = 3.5;
        grandchild.rss_bytes = 300;
        grandchild.elapsed = "00:00:05".to_owned();

        let wire = process_diagnostics_to_wire(CurrentProcessDiagnostics {
            snapshot: Some(Arc::new(AttributedProcessSnapshot {
                sampled_at_ms: 1_000,
                server_identity: ProcessIdentity {
                    pid: 10,
                    started_at: 100,
                },
                native_rows: Arc::from([server, child, grandchild]),
                processes: Vec::new(),
                totals: ProcessAttributionTotals::default(),
                ui_coverage: UiCoverage::default(),
            })),
            error: None,
        });
        let processes = wire["processes"].as_array().expect("processes");

        assert_eq!(wire["processCount"], 3);
        assert_eq!(wire["totalRssBytes"], 600);
        assert_eq!(wire["totalCpuPercent"], 7.5);
        assert_eq!(
            processes
                .iter()
                .map(|process| process["pid"].as_u64().expect("pid"))
                .collect::<Vec<_>>(),
            [10, 11, 12]
        );
        assert_eq!(processes[0]["ppid"], 1);
        assert_eq!(processes[0]["pgid"]["value"], 10);
        assert_eq!(processes[0]["status"], "Sleep");
        assert_eq!(processes[0]["elapsed"], "01:02:03");
        assert_eq!(processes[0]["command"], "/opt/t4code server");
        assert_eq!(processes[0]["depth"], 0);
        assert_eq!(processes[0]["childPids"], json!([11]));
        assert_eq!(processes[1]["depth"], 1);
        assert_eq!(processes[1]["childPids"], json!([12]));
        assert_eq!(processes[2]["depth"], 2);
    }

    #[test]
    fn legacy_current_wire_excludes_independently_claimed_roots() {
        let server = ProcessRow::fixture(10, 1, "t4code");
        let server_child = ProcessRow::fixture(11, 10, "server child");
        let claimed_root = ProcessRow::fixture(20, 1, "claimed provider");
        let claimed_child = ProcessRow::fixture(21, 20, "claimed provider child");
        let claimed_identity = ProcessIdentity {
            pid: 20,
            started_at: 0,
        };

        let wire = process_diagnostics_to_wire(CurrentProcessDiagnostics {
            snapshot: Some(Arc::new(AttributedProcessSnapshot {
                sampled_at_ms: 1_000,
                server_identity: ProcessIdentity {
                    pid: 10,
                    started_at: 0,
                },
                native_rows: Arc::from([server, server_child, claimed_root, claimed_child]),
                processes: vec![AttributedProcess {
                    identity: claimed_identity,
                    process_key: claimed_identity.key(),
                    scope: AttributionScope::External,
                    kind: AttributionKind::Provider,
                    label: "claimed/provider".to_owned(),
                    confidence: AttributionConfidence::Exact,
                    cpu_percent: 99.0,
                    rss_bytes: 9_999,
                }],
                totals: ProcessAttributionTotals::default(),
                ui_coverage: UiCoverage::default(),
            })),
            error: None,
        });

        assert_eq!(
            wire["processes"]
                .as_array()
                .expect("processes")
                .iter()
                .map(|process| process["pid"].as_u64().expect("pid"))
                .collect::<Vec<_>>(),
            [10, 11]
        );
        assert_eq!(wire["processCount"], 2);
    }

    #[tokio::test]
    async fn unit_build_covers_server_terminal_callbacks_payloads_and_wire_adapters() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::tempdir().expect("terminal workspace");
        let terminal = TerminalManager::new(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::from_millis(20),
                ..TerminalManagerOptions::default()
            },
        );
        let sampler = Arc::new(NativeProcessSampler::default());
        let resource_sampler = Arc::new(NativeResourceSampler::new(
            sampler.clone(),
            ProcessAttributionRegistry::new(),
            Arc::new(NotApplicableUiProcessObserver),
        ));
        let monitor = Arc::new(DiagnosticsMonitor::new(
            resource_sampler,
            Duration::from_secs(60),
        ));
        let usage = ProviderUsageService::new(Vec::new(), Arc::new(OffsetDateTime::now_utc));
        let relay = RelayClientService::new(
            || async {
                RelayClientStatus::Missing {
                    version: "1.0.0".to_owned(),
                }
            },
            |report| async move {
                report(RelayClientInstallEvent::Progress {
                    stage: "checking".to_owned(),
                })
                .await?;
                Ok(RelayClientStatus::Missing {
                    version: "1.0.0".to_owned(),
                })
            },
        );
        let control = Arc::new(
            NativeServerControl::new(ServerConfig::new(temp.path()), json!({"policy":"test"}))
                .await,
        );
        let services =
            ServerTerminalServices::new(terminal, sampler, monitor, usage, relay, control);

        services
            .launch_setup_script(SetupScriptLaunch {
                thread_id: "thread-1".to_owned(),
                terminal_id: "setup-1".to_owned(),
                script_id: "script-1".to_owned(),
                script_name: "Setup".to_owned(),
                command: if cfg!(windows) {
                    "Write-Output setup".to_owned()
                } else {
                    "printf setup".to_owned()
                },
                cwd: temp.path().to_path_buf(),
                worktree_path: temp.path().to_path_buf(),
                env: BTreeMap::new(),
            })
            .await
            .expect("setup script launches");
        services.close_thread_terminals("thread-1").await;

        let start: TerminalStartPayload = decode_payload(&json!({
            "threadId":"thread-2",
            "terminalId":"terminal-2",
            "cwd":temp.path(),
            "env":{}
        }))
        .expect("terminal start payload");
        let open = start.into_open(false).expect("default dimensions");
        assert_eq!((open.cols, open.rows), (120, 30));
        let missing_dimensions: TerminalStartPayload = decode_payload(&json!({
            "threadId":"thread-2",
            "terminalId":"terminal-2",
            "cwd":temp.path(),
            "env":{}
        }))
        .expect("terminal restart payload");
        assert!(missing_dimensions.into_open(true).is_err());
        let attach: TerminalAttachPayload = decode_payload(&json!({
            "threadId":"thread-2",
            "terminalId":"terminal-2",
            "cwd":temp.path(),
            "cols":80,
            "rows":24,
            "env":{"UNIT":"1"},
            "restartIfNotRunning":true
        }))
        .expect("terminal attach payload");
        let attach = attach.into_attach();
        assert_eq!(attach.cols, Some(80));
        assert!(attach.restart_if_not_running);
        assert!(decode_payload::<TerminalStartPayload>(&json!({})).is_err());

        let now = OffsetDateTime::UNIX_EPOCH;
        let usage_value = provider_usage_to_wire(ProviderUsageResult {
            read_at: now,
            is_fetching: true,
            providers: vec![
                ProviderUsageSnapshot {
                    provider: ProviderUsageProvider::Claude,
                    status: ProviderUsageStatus::Ok,
                    session: Some(ProviderUsageWindow {
                        used_percent: 25,
                        window_minutes: 300,
                        resets_at: Some(now),
                        reset_description: Some("soon".to_owned()),
                    }),
                    weekly: None,
                    updated_at: now,
                    error: None,
                    metadata: BTreeMap::new(),
                },
                ProviderUsageSnapshot {
                    provider: ProviderUsageProvider::Codex,
                    status: ProviderUsageStatus::Error,
                    session: None,
                    weekly: None,
                    updated_at: now,
                    error: Some("unavailable".to_owned()),
                    metadata: BTreeMap::from([("source".to_owned(), "test".to_owned())]),
                },
            ],
        });
        assert_eq!(usage_value["providers"][0]["provider"], "claude");
        assert_eq!(usage_value["providers"][1]["status"], "error");

        let history = resource_history_to_wire(ProcessResourceHistory {
            read_at_ms: 0,
            latest_sampled_at_ms: Some(1_000),
            window_ms: 60_000,
            bucket_ms: 1_000,
            sample_interval_ms: 500,
            retained_sample_count: 2,
            total_cpu_seconds_approx: SplitMetric {
                combined: 1.5,
                core: 1.0,
                external: 0.5,
            },
            ui_coverage: UiCoverage::default(),
            buckets: vec![ProcessResourceBucket {
                started_at_ms: 0,
                ended_at_ms: 1_000,
                cpu_percent: BucketMetric {
                    average: SplitMetric {
                        combined: 5.0,
                        core: 3.0,
                        external: 2.0,
                    },
                    peak: SplitMetric {
                        combined: 10.0,
                        core: 6.0,
                        external: 4.0,
                    },
                },
                rss_bytes: BucketMetric {
                    average: SplitMetric {
                        combined: 768,
                        core: 512,
                        external: 256,
                    },
                    peak: SplitMetric {
                        combined: 1024,
                        core: 640,
                        external: 384,
                    },
                },
                max_process_count: SplitMetric {
                    combined: 2,
                    core: 1,
                    external: 1,
                },
            }],
            processes: vec![ProcessResourceSummary {
                process_key: "1:server".to_owned(),
                pid: 1,
                scope: AttributionScope::Core,
                kind: AttributionKind::Server,
                label: "server".to_owned(),
                confidence: AttributionConfidence::Exact,
                first_seen_at_ms: 0,
                last_seen_at_ms: 1_000,
                current_cpu_percent: 2.0,
                avg_cpu_percent: 3.0,
                max_cpu_percent: 4.0,
                cpu_seconds_approx: 1.0,
                current_rss_bytes: 512,
                max_rss_bytes: 1024,
                sample_count: 2,
            }],
            error: Some("sample failed".to_owned()),
        });
        assert_eq!(history["buckets"][0]["maxProcessCount"], 2);
        assert_eq!(history["error"]["_tag"], "Some");

        assert_eq!(
            relay_status_to_wire(RelayClientStatus::Available {
                executable_path: "/tmp/cloudflared".to_owned(),
                source: "managed".to_owned(),
                version: "1".to_owned(),
            })["status"],
            "available"
        );
        assert_eq!(
            relay_status_to_wire(RelayClientStatus::Unsupported {
                platform: "plan9".to_owned(),
                arch: "mips".to_owned(),
                version: "1".to_owned(),
            })["status"],
            "unsupported"
        );
        assert_eq!(
            relay_event_to_wire(RelayClientInstallEvent::Progress {
                stage: "download".to_owned()
            })["type"],
            "progress"
        );
        assert_eq!(
            relay_event_to_wire(RelayClientInstallEvent::Complete {
                status: RelayClientStatus::Missing {
                    version: "1".to_owned()
                }
            })["type"],
            "complete"
        );
        assert_eq!(
            terminal_metadata_to_wire(TerminalMetadataEvent::Remove {
                thread_id: "thread".to_owned(),
                terminal_id: "terminal".to_owned(),
            })["type"],
            "remove"
        );
        assert_eq!(effect_none()["_tag"], "None");
        assert_eq!(effect_some(json!(1))["value"], 1);
        assert_eq!(invalid_request("bad")["_tag"], "RpcRequestInvalid");
        assert_eq!(format_epoch_ms(i128::MAX), "1970-01-01T00:00:00Z");
        assert!(format_time(now).contains("1970-01-01"));

        assert!(matches!(
            services.relay.resolve().await,
            RelayClientStatus::Missing { .. }
        ));
        assert!(
            !services
                .relay
                .install()
                .await
                .expect("relay install events")
                .is_empty()
        );
        services.shutdown().await;
    }
}
