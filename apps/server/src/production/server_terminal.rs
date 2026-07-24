use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus},
    diagnostics::{
        AttributedProcess, AttributionConfidence, AttributionKind, AttributionScope, BucketMetric,
        CurrentProcessDiagnostics, DiagnosticsMonitor, NativeProcessSampler, NativeResourceSampler,
        ProcessAttributionTotals, ProcessIdentity, ProcessResourceHistory, ProcessResourceTotals,
        ProcessRow, ProcessSignal, SplitMetric, UiCoverage, UiCoverageStatus,
        bound_diagnostic_string, process_tree_metadata,
    },
    production::orchestration_effects::SetupScriptLaunch,
    provider_usage::{
        CodexRateLimitResetOutcome, ConsumeCodexRateLimitResetResult, ProviderUsageProvider,
        ProviderUsageCommandError, ProviderUsageResult, ProviderUsageService,
        ProviderUsageSnapshot, ProviderUsageStatus, ProviderUsageWindow, RateLimitResetCredits,
    },
    rpc::{RpcRegistry, RpcResult, RpcStreamChunk},
    terminal::{
        TerminalAttachInput, TerminalError, TerminalLaunchCommand, TerminalManager,
        TerminalMetadataEvent, TerminalOpenInput,
    },
};

const PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS: usize = 160;

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
    resource_sampler: Arc<NativeResourceSampler>,
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
        resource_sampler: Arc<NativeResourceSampler>,
        process_monitor: Arc<DiagnosticsMonitor<NativeResourceSampler>>,
        provider_usage: ProviderUsageService,
        relay: RelayClientService,
        control: Arc<dyn ProductionServerControl>,
    ) -> Self {
        Self {
            terminal,
            process_sampler,
            resource_sampler,
            process_monitor,
            provider_usage,
            relay,
            control,
        }
    }

    pub async fn shutdown(&self) {
        self.terminal.shutdown().await;
        match self
            .process_sampler
            .cleanup_descendants(std::process::id())
            .await
        {
            Ok(report) if report.failure_count > 0 => {
                tracing::warn!(
                    attempted = report.attempted,
                    succeeded = report.succeeded,
                    failed = report.failure_count,
                    failures = ?report.failures,
                    "identity-bound descendant cleanup completed with failures"
                );
            }
            Ok(report) if report.attempted > 0 => {
                tracing::debug!(
                    attempted = report.attempted,
                    succeeded = report.succeeded,
                    "identity-bound descendant cleanup completed"
                );
            }
            Ok(_) => {}
            Err(error) => {
                let error = bound_diagnostic_string(
                    &error.to_string(),
                    PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS,
                );
                tracing::warn!(%error, "failed to inspect remaining descendants during shutdown");
            }
        }
    }

    pub async fn close_thread_terminals(&self, thread_id: &str) {
        let _ = self.terminal.close(thread_id, None).await;
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
            let _ = self
                .terminal
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

    let sampler = services.resource_sampler.clone();
    registry.register_unary("server.signalProcess", move |request, _cancellation| {
        let sampler = sampler.clone();
        async move {
            let input: SignalProcessInput = decode_payload(&request.payload)?;
            let expected_identity = decode_process_identity(input.pid, &input.process_key)?;
            let signal = decode_process_signal(&input.signal)?;
            match sampler
                .signal_external_descendant(expected_identity, signal)
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
                    "message": effect_some(Value::String(bound_diagnostic_string(
                        &error.to_string(),
                        PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS,
                    ))),
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

    let usage = services.provider_usage.clone();
    registry.register_unary(
        "server.consumeCodexRateLimitReset",
        move |request, _cancellation| {
            let usage = usage.clone();
            async move {
                let input: ConsumeCodexRateLimitResetInput = decode_payload(&request.payload)?;
                usage
                    .consume_codex_rate_limit_reset(&input.request_id)
                    .await
                    .map(consume_codex_rate_limit_reset_to_wire)
                    .map_err(provider_usage_reset_error_to_wire)
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
            let input = match input.into_attach() {
                Ok(input) => input,
                Err(error) => { let _ = sender.send(Err(error)).await; return; }
            };
            let mut attachment = match terminal.attach(input).await {
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
                    .await
                    .map_err(terminal_error)?;
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

const TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH: usize = 4_096;
const TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH: usize = 8_192;
const TERMINAL_LAUNCH_ARGUMENT_MAX_COUNT: usize = 64;
const TERMINAL_LAUNCH_LABEL_MAX_LENGTH: usize = 128;

fn is_ecmascript_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn trim_ecmascript(value: &str) -> &str {
    value.trim_matches(is_ecmascript_trim_character)
}

fn validate_terminal_launch_command(
    command: Option<TerminalLaunchCommand>,
) -> Result<Option<TerminalLaunchCommand>, Value> {
    let Some(mut command) = command else {
        return Ok(None);
    };

    command.executable = trim_ecmascript(&command.executable).to_owned();
    if command.executable.is_empty() {
        return Err(invalid_request("command executable must not be empty"));
    }
    if command.executable.encode_utf16().count() > TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH {
        return Err(invalid_request("command executable is too long"));
    }
    if command.args.len() > TERMINAL_LAUNCH_ARGUMENT_MAX_COUNT {
        return Err(invalid_request("command has too many arguments"));
    }
    if command
        .args
        .iter()
        .any(|argument| argument.encode_utf16().count() > TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH)
    {
        return Err(invalid_request("command argument is too long"));
    }
    if let Some(label) = command.label.as_mut() {
        *label = trim_ecmascript(label).to_owned();
        if label.is_empty() {
            return Err(invalid_request("command label must not be empty"));
        }
        if label.encode_utf16().count() > TERMINAL_LAUNCH_LABEL_MAX_LENGTH {
            return Err(invalid_request("command label is too long"));
        }
    }

    Ok(Some(command))
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
    command: Option<TerminalLaunchCommand>,
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
            command: validate_terminal_launch_command(self.command)?,
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
    command: Option<TerminalLaunchCommand>,
}

impl TerminalAttachPayload {
    fn into_attach(self) -> Result<TerminalAttachInput, Value> {
        Ok(TerminalAttachInput {
            thread_id: self.thread_id,
            terminal_id: self.terminal_id,
            cwd: self.cwd.map(PathBuf::from),
            worktree_path: self.worktree_path.map(PathBuf::from),
            cols: self.cols,
            rows: self.rows,
            env: self.env,
            restart_if_not_running: self.restart_if_not_running,
            command: validate_terminal_launch_command(self.command)?,
        })
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
    #[serde(rename = "processKey")]
    process_key: String,
    signal: String,
}
#[derive(Deserialize)]
struct RefreshProviderUsageInput {
    providers: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsumeCodexRateLimitResetInput {
    request_id: String,
}

fn decode_payload<T: for<'de> Deserialize<'de>>(payload: &Value) -> Result<T, Value> {
    serde_json::from_value(payload.clone()).map_err(|error| invalid_request(&error.to_string()))
}

fn decode_process_identity(pid: u32, process_key: &str) -> Result<ProcessIdentity, Value> {
    let (key_pid, started_at) = process_key
        .split_once(':')
        .ok_or_else(|| invalid_request("processKey must contain pid and start identity"))?;
    let key_pid = key_pid
        .parse::<u32>()
        .map_err(|_| invalid_request("processKey contains an invalid pid"))?;
    let started_at = started_at
        .parse::<u64>()
        .map_err(|_| invalid_request("processKey contains an invalid start identity"))?;
    if key_pid != pid {
        return Err(invalid_request("processKey pid does not match pid"));
    }
    Ok(ProcessIdentity { pid, started_at })
}

fn decode_process_signal(signal: &str) -> Result<ProcessSignal, Value> {
    match signal {
        "SIGINT" => Ok(ProcessSignal::Interrupt),
        "SIGKILL" => Ok(ProcessSignal::Kill),
        _ => Err(invalid_request("signal must be SIGINT or SIGKILL")),
    }
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
        "fableWeekly": snapshot.fable_weekly.map(provider_usage_window_to_wire),
        "planType": snapshot.plan_type,
        "rateLimitResetCredits": snapshot.rate_limit_reset_credits.map(rate_limit_reset_credits_to_wire),
        "updatedAt": format_time(snapshot.updated_at),
        "error": snapshot.error,
        "metadata": snapshot.metadata,
    })
}

fn rate_limit_reset_credits_to_wire(credits: RateLimitResetCredits) -> Value {
    json!({
        "availableCount": credits.available_count,
        "totalEarnedCount": credits.total_earned_count,
        "nextExpiresAt": credits.next_expires_at.map(format_time),
    })
}

fn consume_codex_rate_limit_reset_to_wire(result: ConsumeCodexRateLimitResetResult) -> Value {
    json!({
        "outcome": match result.outcome {
            CodexRateLimitResetOutcome::Reset => "reset",
            CodexRateLimitResetOutcome::NothingToReset => "nothingToReset",
            CodexRateLimitResetOutcome::NoCredit => "noCredit",
            CodexRateLimitResetOutcome::AlreadyRedeemed => "alreadyRedeemed",
        },
        "usage": provider_usage_to_wire(result.usage),
    })
}

fn provider_usage_reset_error_to_wire(error: ProviderUsageCommandError) -> Value {
    json!({
        "_tag": "ServerProviderUsageResetError",
        "message": error.message,
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
        effect_some(json!({
            "message": bound_diagnostic_string(
                &message,
                PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS,
            ),
        }))
    });
    let Some(snapshot) = current.snapshot else {
        return json!({
            "serverPid": std::process::id(),
            "readAt": format_epoch_ms(read_at_ms),
            "totals": attribution_totals_to_wire(ProcessAttributionTotals::default()),
            "uiCoverage": ui_coverage_to_wire(&UiCoverage::default()),
            "processes": [],
            "error": error,
        });
    };
    let server_pid = snapshot.server_identity.pid;

    json!({
        "serverPid": server_pid,
        "readAt": format_epoch_ms(read_at_ms),
        "totals": attribution_totals_to_wire(snapshot.totals),
        "uiCoverage": ui_coverage_to_wire(&snapshot.ui_coverage),
        "processes": attributed_processes_to_wire(&snapshot.processes, &snapshot.native_rows),
        "error": error,
    })
}

fn resource_history_to_wire(history: ProcessResourceHistory) -> Value {
    json!({
        "readAt": format_epoch_ms(history.read_at_ms),
        "windowMs": history.window_ms,
        "bucketMs": history.bucket_ms,
        "sampleIntervalMs": history.sample_interval_ms,
        "retainedSampleCount": history.retained_sample_count,
        "cpuSecondsApprox": split_f64_to_wire(history.total_cpu_seconds_approx),
        "uiCoverage": ui_coverage_to_wire(&history.ui_coverage),
        "buckets": history.buckets.into_iter().map(|bucket| json!({
            "startedAt": format_epoch_ms(bucket.started_at_ms),
            "endedAt": format_epoch_ms(bucket.ended_at_ms),
            "cpuPercent": bucket_f64_to_wire(bucket.cpu_percent),
            "rssBytes": bucket_u64_to_wire(bucket.rss_bytes),
            "maxProcessCount": split_usize_to_wire(bucket.max_process_count),
        })).collect::<Vec<_>>(),
        "processes": history.processes.into_iter().map(|process| json!({
            "processKey": process.process_key, "pid": process.pid,
            "ppid": process.ppid,
            "command": process.command,
            "depth": process.depth,
            "scope": attribution_scope_to_wire(process.scope),
            "kind": attribution_kind_to_wire(process.kind),
            "label": process.label,
            "confidence": attribution_confidence_to_wire(process.confidence),
            "firstSeenAt": format_epoch_ms(process.first_seen_at_ms), "lastSeenAt": format_epoch_ms(process.last_seen_at_ms),
            "currentCpuPercent": process.current_cpu_percent, "avgCpuPercent": process.avg_cpu_percent,
            "maxCpuPercent": process.max_cpu_percent, "cpuSecondsApprox": process.cpu_seconds_approx,
            "currentRssBytes": process.current_rss_bytes, "maxRssBytes": process.max_rss_bytes,
            "sampleCount": process.sample_count,
        })).collect::<Vec<_>>(),
        "error": history.error.map_or_else(effect_none, |message| effect_some(json!({
            "failureTag": "ProcessDiagnosticsQueryFailedError",
            "message": bound_diagnostic_string(
                &message,
                PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS,
            ),
        }))),
    })
}

fn attributed_processes_to_wire(
    processes: &[AttributedProcess],
    native_rows: &[ProcessRow],
) -> Vec<Value> {
    let metadata = process_tree_metadata(
        native_rows,
        processes.iter().map(|process| process.identity),
    );

    processes
        .iter()
        .filter_map(|process| {
            let metadata = metadata.get(&process.identity)?;
            Some(json!({
                "pid": process.identity.pid,
                "ppid": metadata.ppid,
                "pgid": metadata.pgid.map_or_else(effect_none, |pgid| effect_some(json!(pgid))),
                "status": metadata.status,
                "cpuPercent": process.cpu_percent,
                "rssBytes": process.rss_bytes,
                "elapsed": metadata.elapsed,
                "command": metadata.command,
                "depth": metadata.depth,
                "childPids": metadata.child_pids,
                "processKey": process.process_key,
                "scope": attribution_scope_to_wire(process.scope),
                "kind": attribution_kind_to_wire(process.kind),
                "label": process.label,
                "confidence": attribution_confidence_to_wire(process.confidence),
            }))
        })
        .collect()
}

fn attribution_totals_to_wire(totals: ProcessAttributionTotals) -> Value {
    json!({
        "combined": resource_totals_to_wire(totals.combined),
        "core": resource_totals_to_wire(totals.core),
        "external": resource_totals_to_wire(totals.external),
    })
}

fn resource_totals_to_wire(totals: ProcessResourceTotals) -> Value {
    json!({
        "cpuPercent": totals.cpu_percent,
        "rssBytes": totals.rss_bytes,
        "processCount": totals.process_count,
    })
}

fn attribution_scope_to_wire(scope: AttributionScope) -> &'static str {
    match scope {
        AttributionScope::Core => "core",
        AttributionScope::External => "external",
    }
}

fn attribution_kind_to_wire(kind: AttributionKind) -> &'static str {
    match kind {
        AttributionKind::Server => "server",
        AttributionKind::Ui => "ui",
        AttributionKind::Provider => "provider",
        AttributionKind::Terminal => "terminal",
        AttributionKind::Helper => "helper",
        AttributionKind::Unknown => "unknown",
    }
}

fn attribution_confidence_to_wire(confidence: AttributionConfidence) -> &'static str {
    match confidence {
        AttributionConfidence::Exact => "exact",
        AttributionConfidence::Inherited => "inherited",
        AttributionConfidence::Fallback => "fallback",
    }
}

fn ui_coverage_to_wire(coverage: &UiCoverage) -> Value {
    json!({
        "status": match coverage.status {
            UiCoverageStatus::Available => "available",
            UiCoverageStatus::Partial => "partial",
            UiCoverageStatus::Unavailable => "unavailable",
            UiCoverageStatus::NotApplicable => "notApplicable",
        },
        "message": coverage.message.as_ref().map_or_else(effect_none, |message| {
            effect_some(json!(bound_diagnostic_string(
                message,
                PROCESS_DIAGNOSTIC_MESSAGE_MAX_SCALARS,
            )))
        }),
    })
}

fn split_f64_to_wire(metric: SplitMetric<f64>) -> Value {
    json!({
        "combined": metric.combined,
        "core": metric.core,
        "external": metric.external,
    })
}

fn split_u64_to_wire(metric: SplitMetric<u64>) -> Value {
    json!({
        "combined": metric.combined,
        "core": metric.core,
        "external": metric.external,
    })
}

fn split_usize_to_wire(metric: SplitMetric<usize>) -> Value {
    json!({
        "combined": metric.combined,
        "core": metric.core,
        "external": metric.external,
    })
}

fn bucket_f64_to_wire(metric: BucketMetric<f64>) -> Value {
    json!({
        "average": split_f64_to_wire(metric.average),
        "peak": split_f64_to_wire(metric.peak),
    })
}

fn bucket_u64_to_wire(metric: BucketMetric<u64>) -> Value {
    json!({
        "average": split_u64_to_wire(metric.average),
        "peak": split_u64_to_wire(metric.peak),
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

fn terminal_error(error: TerminalError) -> Value {
    match error {
        TerminalError::Shutdown => json!({
            "_tag": "TerminalSpawnError",
            "reason": "Terminal manager is shut down.",
        }),
        TerminalError::CwdNotFound(cwd) => {
            json!({ "_tag": "TerminalCwdNotFoundError", "cwd": cwd })
        }
        TerminalError::CwdNotDirectory(cwd) => {
            json!({ "_tag": "TerminalCwdNotDirectoryError", "cwd": cwd })
        }
        TerminalError::NotFound {
            thread_id,
            terminal_id,
        } => json!({
            "_tag": "TerminalSessionLookupError",
            "threadId": thread_id,
            "terminalId": terminal_id,
        }),
        TerminalError::NotRunning {
            thread_id,
            terminal_id,
        } => json!({
            "_tag": "TerminalNotRunningError",
            "threadId": thread_id,
            "terminalId": terminal_id,
        }),
        TerminalError::Spawn { .. } => json!({
            "_tag": "TerminalSpawnError",
            "reason": "Terminal process could not be started.",
        }),
        TerminalError::Io(message) => json!({
            "_tag": "TerminalCwdStatError",
            "cwd": "",
            "cause": message,
        }),
        TerminalError::Close => json!({
            "_tag": "TerminalCloseError",
            "reason": "Terminal processes did not exit before cleanup timed out.",
        }),
    }
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
    use std::{future::Future, pin::Pin, time::Duration};

    use crate::{
        ServerConfig,
        diagnostics::{
            AttributedProcess, AttributedProcessSnapshot, AttributionConfidence, AttributionKind,
            AttributionScope, BucketMetric, NativeResourceSampler, NotApplicableUiProcessObserver,
            ProcessAttributionRegistry, ProcessAttributionTotals, ProcessIdentity,
            ProcessResourceBucket, ProcessResourceSummary, ProcessResourceTotals, ProcessRow,
            ResourceSampler, SamplingError, SplitMetric, UiCoverage, UiCoverageStatus,
        },
        production::control::NativeServerControl,
        terminal::{PortablePtyBackend, TerminalLaunchCommand, TerminalManagerOptions},
    };

    use super::*;

    fn terminal_start_payload(command: Value) -> TerminalStartPayload {
        decode_payload(&json!({
            "threadId": "thread-validation",
            "terminalId": "term-validation",
            "cwd": "/tmp",
            "cols": 120,
            "rows": 30,
            "command": command,
        }))
        .expect("terminal start payload decodes")
    }

    fn terminal_attach_payload(command: Value) -> TerminalAttachPayload {
        decode_payload(&json!({
            "threadId": "thread-validation",
            "terminalId": "term-validation",
            "command": command,
        }))
        .expect("terminal attach payload decodes")
    }

    fn assert_invalid_terminal_launch_command(command: Value) {
        for dimensions_required in [false, true] {
            let error = terminal_start_payload(command.clone())
                .into_open(dimensions_required)
                .expect_err("start and restart must reject invalid commands");
            assert_eq!(error["_tag"], "RpcRequestInvalid");
        }

        let error = terminal_attach_payload(command)
            .into_attach()
            .expect_err("attach must reject invalid commands");
        assert_eq!(error["_tag"], "RpcRequestInvalid");
    }

    #[test]
    fn terminal_spawn_errors_are_explicit_bounded_and_redacted() {
        let error = terminal_error(TerminalError::Spawn {
            attempted: vec!["/secret/provider".to_owned()],
            message: "token=secret".to_owned(),
        });

        assert_eq!(
            error,
            json!({
                "_tag": "TerminalSpawnError",
                "reason": "Terminal process could not be started.",
            })
        );
        let encoded = error.to_string();
        assert!(!encoded.contains("/secret/provider"));
        assert!(!encoded.contains("token=secret"));
        assert!(error["reason"].as_str().unwrap().encode_utf16().count() <= 512);
    }

    #[test]
    fn terminal_close_errors_are_explicit() {
        assert_eq!(
            terminal_error(TerminalError::Close),
            json!({
                "_tag": "TerminalCloseError",
                "reason": "Terminal processes did not exit before cleanup timed out.",
            })
        );
    }

    #[test]
    fn terminal_payload_conversions_reject_commands_outside_contract_bounds() {
        for command in [
            json!({ "executable": " \t ", "args": [] }),
            json!({ "executable": "x".repeat(4_097), "args": [] }),
            json!({ "executable": "codex", "args": vec!["x"; 65] }),
            json!({ "executable": "codex", "args": ["x".repeat(8_193)] }),
            json!({ "executable": "codex", "args": [], "label": " \n " }),
            json!({
                "executable": "codex",
                "args": [],
                "label": "x".repeat(129),
            }),
        ] {
            assert_invalid_terminal_launch_command(command);
        }
    }

    #[test]
    fn terminal_payload_conversions_trim_command_names_without_trimming_arguments() {
        let command = json!({
            "executable": "  /opt/codex  ",
            "args": ["  --dangerously-bypass-approvals-and-sandbox  "],
            "label": "  Codex Terminal  ",
        });

        for dimensions_required in [false, true] {
            let open = terminal_start_payload(command.clone())
                .into_open(dimensions_required)
                .expect("valid start and restart commands");
            assert_eq!(
                open.command,
                Some(TerminalLaunchCommand {
                    executable: "/opt/codex".to_owned(),
                    args: vec!["  --dangerously-bypass-approvals-and-sandbox  ".to_owned()],
                    label: Some("Codex Terminal".to_owned()),
                })
            );
        }

        let attach = terminal_attach_payload(command)
            .into_attach()
            .expect("valid attach command");
        assert_eq!(
            attach.command,
            Some(TerminalLaunchCommand {
                executable: "/opt/codex".to_owned(),
                args: vec!["  --dangerously-bypass-approvals-and-sandbox  ".to_owned()],
                label: Some("Codex Terminal".to_owned()),
            })
        );
    }

    #[test]
    fn terminal_payload_conversions_measure_command_bounds_in_utf16_code_units() {
        let astral = "😀";
        let at_boundary = json!({
            "executable": astral.repeat(TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH / 2),
            "args": [astral.repeat(TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH / 2)],
            "label": astral.repeat(TERMINAL_LAUNCH_LABEL_MAX_LENGTH / 2),
        });
        assert!(
            terminal_start_payload(at_boundary).into_open(false).is_ok(),
            "astral strings at the UTF-16 contract limits must be accepted"
        );

        for command in [
            json!({
                "executable": astral.repeat(TERMINAL_LAUNCH_EXECUTABLE_MAX_LENGTH / 2 + 1),
                "args": [],
            }),
            json!({
                "executable": "codex",
                "args": [astral.repeat(TERMINAL_LAUNCH_ARGUMENT_MAX_LENGTH / 2 + 1)],
            }),
            json!({
                "executable": "codex",
                "args": [],
                "label": astral.repeat(TERMINAL_LAUNCH_LABEL_MAX_LENGTH / 2 + 1),
            }),
        ] {
            assert_invalid_terminal_launch_command(command);
        }
    }

    #[test]
    fn terminal_payload_conversions_use_ecmascript_trim_semantics() {
        let command = json!({
            "executable": "\u{feff}codex\u{feff}",
            "args": ["\u{feff}--model\u{feff}"],
            "label": "\u{feff}Codex Terminal\u{feff}",
        });
        let open = terminal_start_payload(command)
            .into_open(false)
            .expect("ECMAScript whitespace is trimmed from command names");
        assert_eq!(
            open.command,
            Some(TerminalLaunchCommand {
                executable: "codex".to_owned(),
                args: vec!["\u{feff}--model\u{feff}".to_owned()],
                label: Some("Codex Terminal".to_owned()),
            })
        );

        let non_ecmascript_whitespace = json!({
            "executable": "\u{85}codex\u{85}",
            "args": [],
            "label": "\u{85}Codex Terminal\u{85}",
        });
        let open = terminal_start_payload(non_ecmascript_whitespace)
            .into_open(false)
            .expect("non-ECMAScript whitespace is retained");
        assert_eq!(
            open.command,
            Some(TerminalLaunchCommand {
                executable: "\u{85}codex\u{85}".to_owned(),
                args: Vec::new(),
                label: Some("\u{85}Codex Terminal\u{85}".to_owned()),
            })
        );

        assert_invalid_terminal_launch_command(json!({
            "executable": "\u{feff}",
            "args": [],
        }));
    }

    #[derive(Debug)]
    struct StaticResourceSampler {
        snapshot: AttributedProcessSnapshot,
    }

    impl ResourceSampler for StaticResourceSampler {
        fn sample(
            &self,
        ) -> Pin<
            Box<dyn Future<Output = Result<AttributedProcessSnapshot, SamplingError>> + Send + '_>,
        > {
            Box::pin(async { Ok(self.snapshot.clone()) })
        }
    }

    #[test]
    fn attributed_current_wire_maps_every_variant_and_bounds_failures() {
        let kinds = [
            AttributionKind::Server,
            AttributionKind::Ui,
            AttributionKind::Provider,
            AttributionKind::Terminal,
            AttributionKind::Helper,
            AttributionKind::Unknown,
        ];
        let scopes = [
            AttributionScope::Core,
            AttributionScope::External,
            AttributionScope::External,
            AttributionScope::External,
            AttributionScope::External,
            AttributionScope::External,
        ];
        let confidences = [
            AttributionConfidence::Exact,
            AttributionConfidence::Inherited,
            AttributionConfidence::Fallback,
            AttributionConfidence::Exact,
            AttributionConfidence::Inherited,
            AttributionConfidence::Fallback,
        ];
        let processes = kinds
            .into_iter()
            .zip(scopes)
            .zip(confidences)
            .enumerate()
            .map(|(index, ((kind, scope), confidence))| {
                let pid = u32::try_from(index).expect("fixture index") + 10;
                let identity = ProcessIdentity {
                    pid,
                    started_at: u64::from(pid) * 10,
                };
                AttributedProcess {
                    identity,
                    process_key: identity.key(),
                    scope,
                    kind,
                    label: format!("process-{pid}"),
                    confidence,
                    cpu_percent: f64::from(pid),
                    rss_bytes: u64::from(pid) * 100,
                }
            })
            .collect::<Vec<_>>();
        let rows = processes
            .iter()
            .map(|process| {
                let mut row = ProcessRow::fixture(
                    process.identity.pid,
                    if process.identity.pid == 10 { 1 } else { 10 },
                    format!("command-{}", process.identity.pid),
                );
                row.started_at = process.identity.started_at;
                row
            })
            .collect::<Vec<_>>();
        let totals = ProcessAttributionTotals {
            combined: ProcessResourceTotals {
                cpu_percent: 75.0,
                rss_bytes: 7_500,
                process_count: 6,
            },
            core: ProcessResourceTotals {
                cpu_percent: 10.0,
                rss_bytes: 1_000,
                process_count: 1,
            },
            external: ProcessResourceTotals {
                cpu_percent: 65.0,
                rss_bytes: 6_500,
                process_count: 5,
            },
        };

        for (status, expected_status, coverage_message) in [
            (UiCoverageStatus::Available, "available", None),
            (UiCoverageStatus::Partial, "partial", Some("界".repeat(500))),
            (UiCoverageStatus::Unavailable, "unavailable", None),
            (UiCoverageStatus::NotApplicable, "notApplicable", None),
        ] {
            let wire = process_diagnostics_to_wire(CurrentProcessDiagnostics {
                snapshot: Some(Arc::new(AttributedProcessSnapshot {
                    sampled_at_ms: 1_000,
                    server_identity: ProcessIdentity {
                        pid: 10,
                        started_at: 100,
                    },
                    native_rows: rows.clone().into(),
                    processes: processes.clone(),
                    totals,
                    ui_coverage: UiCoverage {
                        status,
                        message: coverage_message,
                    },
                })),
                error: Some("é".repeat(500)),
            });

            assert_eq!(wire["totals"]["combined"]["cpuPercent"], 75.0);
            assert_eq!(
                wire["totals"]["combined"]["cpuPercent"]
                    .as_f64()
                    .expect("combined CPU percent"),
                wire["totals"]["core"]["cpuPercent"]
                    .as_f64()
                    .expect("core CPU percent")
                    + wire["totals"]["external"]["cpuPercent"]
                        .as_f64()
                        .expect("external CPU percent")
            );
            assert_eq!(
                wire["totals"]["combined"]["rssBytes"]
                    .as_u64()
                    .expect("combined RSS"),
                wire["totals"]["core"]["rssBytes"]
                    .as_u64()
                    .expect("core RSS")
                    + wire["totals"]["external"]["rssBytes"]
                        .as_u64()
                        .expect("external RSS")
            );
            assert_eq!(
                wire["totals"]["combined"]["processCount"]
                    .as_u64()
                    .expect("combined process count"),
                wire["totals"]["core"]["processCount"]
                    .as_u64()
                    .expect("core process count")
                    + wire["totals"]["external"]["processCount"]
                        .as_u64()
                        .expect("external process count")
            );
            assert_eq!(wire["uiCoverage"]["status"], expected_status);
            if status == UiCoverageStatus::Partial {
                assert_eq!(wire["uiCoverage"]["message"]["_tag"], "Some");
                assert_eq!(
                    wire["uiCoverage"]["message"]["value"]
                        .as_str()
                        .expect("bounded Unicode coverage message")
                        .chars()
                        .count(),
                    160
                );
            } else {
                assert_eq!(wire["uiCoverage"]["message"]["_tag"], "None");
            }
            assert!(
                wire["error"]["value"]["message"]
                    .as_str()
                    .expect("bounded failure message")
                    .chars()
                    .count()
                    <= 160
            );
            assert_eq!(
                wire["processes"]
                    .as_array()
                    .expect("attributed processes")
                    .iter()
                    .map(|process| process["kind"].as_str().expect("kind"))
                    .collect::<Vec<_>>(),
                ["server", "ui", "provider", "terminal", "helper", "unknown"]
            );
            assert_eq!(
                wire["processes"][0]["scope"].as_str().expect("scope"),
                "core"
            );
            assert_eq!(
                wire["processes"][1]["scope"].as_str().expect("scope"),
                "external"
            );
            assert_eq!(
                wire["processes"]
                    .as_array()
                    .expect("attributed processes")
                    .iter()
                    .map(|process| process["confidence"].as_str().expect("confidence"))
                    .collect::<Vec<_>>(),
                [
                    "exact",
                    "inherited",
                    "fallback",
                    "exact",
                    "inherited",
                    "fallback"
                ]
            );
        }
    }

    #[test]
    fn typed_payload_decoders_reject_non_object_wire_values() {
        let invalid = json!("not-an-object");
        assert!(decode_payload::<RefreshProviderUsageInput>(&invalid).is_err());
        assert!(decode_payload::<ResourceHistoryInput>(&invalid).is_err());
        assert!(decode_payload::<SignalProcessInput>(&invalid).is_err());
        assert!(
            decode_payload::<SignalProcessInput>(&json!({
                "pid": 42,
                "signal": "SIGINT",
            }))
            .is_err()
        );
        let signal_input: SignalProcessInput = decode_payload(&json!({
            "pid": 42,
            "processKey": "42:100",
            "signal": "SIGINT",
        }))
        .expect("identity-bound signal input");
        assert_eq!(
            decode_process_identity(signal_input.pid, &signal_input.process_key)
                .expect("process identity"),
            ProcessIdentity {
                pid: 42,
                started_at: 100,
            }
        );
        assert!(decode_process_identity(42, "43:100").is_err());
        assert!(decode_process_identity(42, "invalid").is_err());
        assert!(matches!(
            decode_process_signal(&signal_input.signal),
            Ok(ProcessSignal::Interrupt)
        ));
        assert!(decode_process_signal("SIGHUP").is_err());
        assert!(decode_payload::<TerminalAttachPayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalClosePayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalResizePayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalSessionPayload>(&invalid).is_err());
        assert!(decode_payload::<TerminalWritePayload>(&invalid).is_err());
        assert_eq!(format_epoch_ms(i128::MAX), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn attributed_history_wire_preserves_the_complete_process_order() {
        fn summary(
            process_key: &str,
            last_seen_at_ms: i128,
            cpu_seconds_approx: f64,
        ) -> ProcessResourceSummary {
            ProcessResourceSummary {
                process_key: process_key.to_owned(),
                pid: 1,
                ppid: 0,
                command: process_key.to_owned(),
                depth: 0,
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
            wire["processes"]
                .as_array()
                .expect("processes")
                .iter()
                .map(|process| process["processKey"].as_str().expect("process key"))
                .collect::<Vec<_>>(),
            ["exited:high-cpu", "active:z", "active:b", "active:a"]
        );
        assert_eq!(wire["retainedSampleCount"], 2);
    }

    #[tokio::test]
    async fn attributed_history_wire_includes_independent_claimed_roots() {
        let sampled_at_ms = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
        let mut server = ProcessRow::fixture(10, 1, "/native/t4code --serve");
        server.started_at = 100;
        server.cpu_percent = 10.0;
        server.cpu_core_percent = Some(5.0);
        server.rss_bytes = 100;
        let mut child = ProcessRow::fixture(11, 10, "/native/codex --model gpt");
        child.started_at = 110;
        child.cpu_percent = 20.0;
        child.cpu_core_percent = Some(10.0);
        child.rss_bytes = 200;
        let mut claimed_root = ProcessRow::fixture(20, 1, "/native/claimed-provider");
        claimed_root.started_at = 200;
        claimed_root.cpu_percent = 100.0;
        claimed_root.cpu_core_percent = Some(50.0);
        claimed_root.rss_bytes = 10_000;
        let server_identity = ProcessIdentity {
            pid: 10,
            started_at: 100,
        };
        let child_identity = ProcessIdentity {
            pid: 11,
            started_at: 110,
        };
        let claimed_identity = ProcessIdentity {
            pid: 20,
            started_at: 200,
        };
        let attributed = |identity: ProcessIdentity,
                          scope: AttributionScope,
                          kind: AttributionKind,
                          label: &str,
                          cpu_percent: f64,
                          rss_bytes: u64| AttributedProcess {
            identity,
            process_key: identity.key(),
            scope,
            kind,
            label: label.to_owned(),
            confidence: AttributionConfidence::Exact,
            cpu_percent,
            rss_bytes,
        };
        let monitor = DiagnosticsMonitor::new(
            Arc::new(StaticResourceSampler {
                snapshot: AttributedProcessSnapshot {
                    sampled_at_ms,
                    server_identity,
                    native_rows: Arc::from([server, child, claimed_root]),
                    processes: vec![
                        attributed(
                            server_identity,
                            AttributionScope::Core,
                            AttributionKind::Server,
                            "attributed/server-label",
                            10.0,
                            100,
                        ),
                        attributed(
                            child_identity,
                            AttributionScope::Core,
                            AttributionKind::Provider,
                            "attributed/child-label",
                            20.0,
                            200,
                        ),
                        attributed(
                            claimed_identity,
                            AttributionScope::External,
                            AttributionKind::Provider,
                            "attributed/claimed-label",
                            100.0,
                            10_000,
                        ),
                    ],
                    totals: ProcessAttributionTotals {
                        combined: ProcessResourceTotals {
                            cpu_percent: 130.0,
                            rss_bytes: 10_300,
                            process_count: 3,
                        },
                        core: ProcessResourceTotals {
                            cpu_percent: 30.0,
                            rss_bytes: 300,
                            process_count: 2,
                        },
                        external: ProcessResourceTotals {
                            cpu_percent: 100.0,
                            rss_bytes: 10_000,
                            process_count: 1,
                        },
                    },
                    ui_coverage: UiCoverage::default(),
                },
            }),
            Duration::from_secs(2),
        );

        let history = monitor.read_history(1_000, 1_000).await;
        assert_eq!(
            history
                .processes
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            [10, 11, 20]
        );
        let wire = resource_history_to_wire(history);
        let bucket = &wire["buckets"][0];
        let processes = wire["processes"].as_array().expect("processes");

        assert!(
            (wire["cpuSecondsApprox"]["combined"]
                .as_f64()
                .expect("total CPU seconds")
                - 2.6)
                .abs()
                < 1e-9
        );
        assert_eq!(wire["retainedSampleCount"], 1);
        assert_eq!(bucket["cpuPercent"]["average"]["combined"], 130.0);
        assert_eq!(bucket["cpuPercent"]["peak"]["combined"], 130.0);
        assert_eq!(bucket["rssBytes"]["peak"]["combined"], 10_300);
        assert_eq!(bucket["maxProcessCount"]["combined"], 3);
        assert_eq!(
            processes
                .iter()
                .map(|process| process["pid"].as_u64().expect("pid"))
                .collect::<Vec<_>>(),
            [10, 11, 20]
        );
        assert_eq!(processes[0]["scope"], "core");
        assert_eq!(processes[1]["label"], "attributed/child-label");
        assert_eq!(processes[2]["scope"], "external");
        assert_eq!(processes[2]["command"], "/native/claimed-provider");
    }

    #[test]
    fn attributed_current_wire_reproduces_native_metadata() {
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
        let server_identity = ProcessIdentity {
            pid: 10,
            started_at: 100,
        };
        let child_identity = ProcessIdentity {
            pid: 11,
            started_at: 110,
        };
        let grandchild_identity = ProcessIdentity {
            pid: 12,
            started_at: 120,
        };

        let wire = process_diagnostics_to_wire(CurrentProcessDiagnostics {
            snapshot: Some(Arc::new(AttributedProcessSnapshot {
                sampled_at_ms: 1_000,
                server_identity,
                native_rows: Arc::from([server, child, grandchild]),
                processes: [
                    (
                        &server_identity,
                        AttributionKind::Server,
                        AttributionConfidence::Exact,
                    ),
                    (
                        &child_identity,
                        AttributionKind::Unknown,
                        AttributionConfidence::Fallback,
                    ),
                    (
                        &grandchild_identity,
                        AttributionKind::Unknown,
                        AttributionConfidence::Fallback,
                    ),
                ]
                .into_iter()
                .map(|(identity, kind, confidence)| AttributedProcess {
                    identity: *identity,
                    process_key: identity.key(),
                    scope: if kind == AttributionKind::Server {
                        AttributionScope::Core
                    } else {
                        AttributionScope::External
                    },
                    kind,
                    label: format!("process-{}", identity.pid),
                    confidence,
                    cpu_percent: match identity.pid {
                        10 => 1.5,
                        11 => 2.5,
                        _ => 3.5,
                    },
                    rss_bytes: match identity.pid {
                        10 => 100,
                        11 => 200,
                        _ => 300,
                    },
                })
                .collect(),
                totals: ProcessAttributionTotals {
                    combined: ProcessResourceTotals {
                        cpu_percent: 7.5,
                        rss_bytes: 600,
                        process_count: 3,
                    },
                    core: ProcessResourceTotals {
                        cpu_percent: 1.5,
                        rss_bytes: 100,
                        process_count: 1,
                    },
                    external: ProcessResourceTotals {
                        cpu_percent: 6.0,
                        rss_bytes: 500,
                        process_count: 2,
                    },
                },
                ui_coverage: UiCoverage::default(),
            })),
            error: None,
        });
        let processes = wire["processes"].as_array().expect("processes");

        assert_eq!(wire["totals"]["combined"]["processCount"], 3);
        assert_eq!(wire["totals"]["combined"]["rssBytes"], 600);
        assert_eq!(wire["totals"]["combined"]["cpuPercent"], 7.5);
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
    fn attributed_current_wire_includes_independently_claimed_roots() {
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
                totals: ProcessAttributionTotals {
                    combined: ProcessResourceTotals {
                        cpu_percent: 99.0,
                        rss_bytes: 9_999,
                        process_count: 1,
                    },
                    core: ProcessResourceTotals::default(),
                    external: ProcessResourceTotals {
                        cpu_percent: 99.0,
                        rss_bytes: 9_999,
                        process_count: 1,
                    },
                },
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
            [20]
        );
        assert_eq!(wire["totals"]["combined"]["processCount"], 1);
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
            resource_sampler.clone(),
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
        let services = ServerTerminalServices::new(
            terminal,
            sampler,
            resource_sampler,
            monitor,
            usage,
            relay,
            control,
        );

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
            "env":{},
            "command": {
                "executable": "/opt/codex",
                "args": ["--dangerously-bypass-approvals-and-sandbox"],
                "label": "Codex Terminal"
            }
        }))
        .expect("terminal start payload");
        let open = start.into_open(false).expect("default dimensions");
        assert_eq!((open.cols, open.rows), (120, 30));
        assert_eq!(
            open.command,
            Some(TerminalLaunchCommand {
                executable: "/opt/codex".to_owned(),
                args: vec!["--dangerously-bypass-approvals-and-sandbox".to_owned()],
                label: Some("Codex Terminal".to_owned()),
            })
        );
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
            "restartIfNotRunning":true,
            "command": {
                "executable": "/opt/codex",
                "args": ["--dangerously-bypass-approvals-and-sandbox"],
                "label": "Codex Terminal"
            }
        }))
        .expect("terminal attach payload");
        let attach = attach.into_attach().expect("valid terminal attach payload");
        assert_eq!(attach.cols, Some(80));
        assert!(attach.restart_if_not_running);
        assert_eq!(
            attach.command,
            Some(TerminalLaunchCommand {
                executable: "/opt/codex".to_owned(),
                args: vec!["--dangerously-bypass-approvals-and-sandbox".to_owned()],
                label: Some("Codex Terminal".to_owned()),
            })
        );
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
                    fable_weekly: None,
                    plan_type: None,
                    rate_limit_reset_credits: None,
                    updated_at: now,
                    error: None,
                    metadata: BTreeMap::new(),
                },
                ProviderUsageSnapshot {
                    provider: ProviderUsageProvider::Codex,
                    status: ProviderUsageStatus::Error,
                    session: None,
                    weekly: None,
                    fable_weekly: None,
                    plan_type: None,
                    rate_limit_reset_credits: None,
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
                ppid: 0,
                command: "server".to_owned(),
                depth: 0,
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
        assert_eq!(
            history["buckets"][0]["maxProcessCount"],
            json!({ "combined": 2, "core": 1, "external": 1 })
        );
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

    #[test]
    fn codex_reset_wire_serializes_outcomes_complete_snapshots_and_typed_errors() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let usage = ProviderUsageResult {
            read_at: now,
            is_fetching: false,
            providers: vec![
                ProviderUsageSnapshot {
                    provider: ProviderUsageProvider::Claude,
                    status: ProviderUsageStatus::Unavailable,
                    session: None,
                    weekly: None,
                    fable_weekly: None,
                    plan_type: None,
                    rate_limit_reset_credits: None,
                    updated_at: now,
                    error: None,
                    metadata: BTreeMap::new(),
                },
                ProviderUsageSnapshot {
                    provider: ProviderUsageProvider::Codex,
                    status: ProviderUsageStatus::Ok,
                    session: None,
                    weekly: None,
                    fable_weekly: Some(ProviderUsageWindow {
                        used_percent: 40,
                        window_minutes: 10_080,
                        resets_at: None,
                        reset_description: None,
                    }),
                    plan_type: Some("pro".to_owned()),
                    rate_limit_reset_credits: Some(RateLimitResetCredits {
                        available_count: 2,
                        total_earned_count: None,
                        next_expires_at: None,
                    }),
                    updated_at: now,
                    error: None,
                    metadata: BTreeMap::new(),
                },
            ],
        };

        for (outcome, expected) in [
            (CodexRateLimitResetOutcome::Reset, "reset"),
            (
                CodexRateLimitResetOutcome::NothingToReset,
                "nothingToReset",
            ),
            (CodexRateLimitResetOutcome::NoCredit, "noCredit"),
            (
                CodexRateLimitResetOutcome::AlreadyRedeemed,
                "alreadyRedeemed",
            ),
        ] {
            let wire = consume_codex_rate_limit_reset_to_wire(
                ConsumeCodexRateLimitResetResult {
                    outcome,
                    usage: usage.clone(),
                },
            );
            assert_eq!(wire["outcome"], expected);
            let absent = &wire["usage"]["providers"][0];
            assert_eq!(absent["fableWeekly"], Value::Null);
            assert_eq!(absent["planType"], Value::Null);
            assert_eq!(absent["rateLimitResetCredits"], Value::Null);
            let codex = &wire["usage"]["providers"][1];
            assert_eq!(codex["fableWeekly"]["usedPercent"], 40);
            assert_eq!(codex["planType"], "pro");
            assert_eq!(codex["rateLimitResetCredits"]["availableCount"], 2);
            assert_eq!(
                codex["rateLimitResetCredits"]["totalEarnedCount"],
                Value::Null
            );
            assert_eq!(
                codex["rateLimitResetCredits"]["nextExpiresAt"],
                Value::Null
            );
        }

        assert_eq!(
            provider_usage_reset_error_to_wire(ProviderUsageCommandError::new(
                "Codex reset request failed."
            )),
            json!({
                "_tag": "ServerProviderUsageResetError",
                "message": "Codex reset request failed.",
            })
        );
    }
}
