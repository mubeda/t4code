use std::{net::SocketAddr, panic::AssertUnwindSafe, sync::Arc, time::Duration};

use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

use t4code_server::production::server_terminal::{
    JsonFuture, JsonStream, ProductionServerControl, ServerTerminalServices,
    register_server_terminal_rpc,
};
use t4code_server::{
    CauseItem, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime, cloud,
    diagnostics, provider_usage, terminal,
};

#[derive(Debug)]
struct FixtureControl;

impl ProductionServerControl for FixtureControl {
    fn call(
        &self,
        method: &'static str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> JsonFuture {
        Box::pin(async move {
            Ok(match method {
                "server.getConfig" => json!({ "source": "rust", "payload": payload }),
                "server.getSettings" => json!({ "automaticGitFetchInterval": 30000 }),
                _ => json!({ "method": method, "payload": payload }),
            })
        })
    }

    fn subscribe(&self, method: &'static str, _cancellation: CancellationToken) -> JsonStream {
        let (sender, receiver) = mpsc::channel(2);
        sender
            .try_send(Ok(vec![json!({ "source": "rust", "method": method })]))
            .expect("fixture stream has capacity");
        receiver
    }
}

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[tokio::test]
async fn registrar_serves_concrete_server_and_terminal_metadata_rpcs() {
    let temp = TempDir::new().expect("temporary directory");
    let services = fixture_services();
    let mut registry = RpcRegistry::empty();
    register_server_terminal_rpc(&mut registry, services);
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("Rust server starts");
    let mut socket = Some(open_socket(handle.local_addr()).await);
    let result = AssertUnwindSafe(async {
        let socket = socket.as_mut().expect("socket");

        send_request(socket, "1", "server.getConfig", json!({})).await;
        assert_eq!(
            success_value(next_message(socket).await),
            json!({
                "source": "rust",
                "payload": {}
            })
        );

        send_request(socket, "2", "server.getProviderUsage", json!({})).await;
        let usage = success_value(next_message(socket).await);
        assert_eq!(usage["isFetching"], false);
        assert_eq!(usage["providers"][0]["provider"], "claude");
        assert_eq!(usage["providers"][1]["provider"], "codex");

        send_request(socket, "3", "subscribeTerminalMetadata", json!({})).await;
        let chunk = next_message(socket).await;
        assert!(matches!(
            chunk,
            ServerMessage::Chunk { values, .. }
                if values == vec![json!({ "type": "snapshot", "terminals": [] })]
        ));
        send_ack(socket, "3").await;

        let terminal_payload = json!({
            "threadId": "thread-1",
            "terminalId": "term-1",
            "cwd": temp.path().to_string_lossy(),
            "cols": 120,
            "rows": 30,
            "env": {}
        });
        send_request(socket, "4", "terminal.open", terminal_payload.clone()).await;
        let first = next_message(socket).await;
        let second = next_message(socket).await;
        assert_terminal_open_and_metadata_upsert([first, second]);

        send_request(socket, "5", "terminal.open", terminal_payload).await;
        assert!(matches!(
            next_message(socket).await,
            ServerMessage::Exit {
                exit: RpcExit::Success { .. },
                ..
            }
        ));
    })
    .catch_unwind()
    .await;

    close_socket(&mut socket).await;
    handle.shutdown();
    handle.join().await.expect("server joins");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn terminal_rpc_attach_tracks_activity_and_cleans_up_running_child_processes() {
    let temp = TempDir::new().expect("temporary directory");
    let services = fixture_services();
    let mut registry = RpcRegistry::empty();
    register_server_terminal_rpc(&mut registry, services);
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("Rust server starts");

    let mut events = Some(open_socket(handle.local_addr()).await);
    let mut metadata = Some(open_socket(handle.local_addr()).await);
    let mut attach = Some(open_socket(handle.local_addr()).await);
    let mut control = Some(open_socket(handle.local_addr()).await);

    let result = AssertUnwindSafe(async {
        let events = events.as_mut().expect("events socket");
        let metadata = metadata.as_mut().expect("metadata socket");
        let attach = attach.as_mut().expect("attach socket");
        let control = control.as_mut().expect("control socket");

        send_request(events, "1", "subscribeTerminalEvents", json!({})).await;
        send_request(metadata, "1", "subscribeTerminalMetadata", json!({})).await;
        assert_eq!(
            next_chunk_and_ack(metadata, "1").await,
            vec![json!({ "type": "snapshot", "terminals": [] })]
        );

        send_request(
            attach,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-activity",
                "terminalId": "term-activity",
                "cwd": temp.path().to_string_lossy(),
                "cols": 120,
                "rows": 30,
                "env": {}
            }),
        )
        .await;
        let snapshot = next_chunk_and_ack(attach, "1").await;
        assert_eq!(snapshot[0]["type"], "snapshot");
        assert_eq!(snapshot[0]["snapshot"]["terminalId"], "term-activity");
        assert_eq!(snapshot[0]["snapshot"]["status"], "running");

        let started = next_terminal_event_and_ack(events, "1", "started", |value| {
            value["type"] == "started" && value["terminalId"] == "term-activity"
        })
        .await;
        assert_eq!(started["snapshot"]["status"], "running");

        let upsert = next_matching_chunk_value(metadata, "1", |value| {
            value["type"] == "upsert" && value["terminal"]["terminalId"] == "term-activity"
        })
        .await;
        assert_eq!(upsert["terminal"]["status"], "running");

        maybe_prime_terminal(control, "thread-activity", "term-activity").await;
        assert_success(
            request(
                control,
                "2",
                "terminal.write",
                json!({
                    "threadId": "thread-activity",
                    "terminalId": "term-activity",
                    "data": long_running_command(),
                }),
            )
            .await,
        );

        let output = next_terminal_event_and_ack(attach, "1", "marked output", |value| {
            value["type"] == "output"
                && value["data"]
                    .as_str()
                    .is_some_and(|data| data.contains(long_running_output_marker()))
        })
        .await;
        assert!(
            output["data"]
                .as_str()
                .is_some_and(|data| data.contains(long_running_output_marker())),
            "long-running child should emit observable output"
        );

        let activity = next_terminal_event_and_ack(events, "1", "running activity", |value| {
            value["type"] == "activity"
                && value["terminalId"] == "term-activity"
                && value["hasRunningSubprocess"] == true
                && value["label"] == long_running_label()
        })
        .await;
        assert_eq!(activity["label"].as_str(), Some(long_running_label()));

        let metadata_activity = next_matching_chunk_value(metadata, "1", |value| {
            value["type"] == "upsert"
                && value["terminal"]["terminalId"] == "term-activity"
                && value["terminal"]["hasRunningSubprocess"] == true
                && value["terminal"]["label"] == long_running_label()
        })
        .await;
        assert_eq!(
            metadata_activity["terminal"]["label"].as_str(),
            Some(long_running_label())
        );

        assert_success(
            request(
                control,
                "3",
                "terminal.close",
                json!({
                    "threadId": "thread-activity",
                    "terminalId": "term-activity",
                }),
            )
            .await,
        );

        let closed = next_terminal_event_and_ack(attach, "1", "closed", |value| {
            value["type"] == "closed" && value["terminalId"] == "term-activity"
        })
        .await;
        assert_eq!(closed["threadId"], "thread-activity");
        let removed =
            next_expected_chunk_value_and_ack(metadata, "1", "metadata remove", |value| {
                value["type"] == "remove" && value["terminalId"] == "term-activity"
            })
            .await;
        assert_eq!(removed["threadId"], "thread-activity");

        assert_error_tag(
            request(
                control,
                "4",
                "terminal.write",
                json!({
                    "threadId": "thread-activity",
                    "terminalId": "term-activity",
                    "data": "echo should-not-run\r\n",
                }),
            )
            .await,
            "TerminalSessionLookupError",
        );
    })
    .catch_unwind()
    .await;

    close_socket(&mut attach).await;
    close_socket(&mut metadata).await;
    close_socket(&mut events).await;
    close_socket(&mut control).await;
    handle.shutdown();
    handle.join().await.expect("server joins");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn terminal_rpc_clear_resize_restart_exit_and_restart_if_not_running_round_trip() {
    let temp = TempDir::new().expect("temporary directory");
    let services = fixture_services();
    let mut registry = RpcRegistry::empty();
    register_server_terminal_rpc(&mut registry, services);
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("Rust server starts");

    let mut events = Some(open_socket(handle.local_addr()).await);
    let mut metadata = Some(open_socket(handle.local_addr()).await);
    let mut attach = Some(open_socket(handle.local_addr()).await);
    let mut control = Some(open_socket(handle.local_addr()).await);
    let mut reattach = None;
    let mut post_restart_attach = None;
    let mut failing_attach = None;
    let mut restarting_attach = None;

    let result = AssertUnwindSafe(async {
        let events = events.as_mut().expect("events socket");
        let metadata = metadata.as_mut().expect("metadata socket");
        let attach = attach.as_mut().expect("attach socket");
        let control = control.as_mut().expect("control socket");

        send_request(events, "1", "subscribeTerminalEvents", json!({})).await;
        send_request(metadata, "1", "subscribeTerminalMetadata", json!({})).await;
        assert_eq!(
            next_chunk_and_ack(metadata, "1").await,
            vec![json!({ "type": "snapshot", "terminals": [] })]
        );

        let opened = success_value(
            request(
                control,
                "2",
                "terminal.open",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                    "cwd": temp.path().to_string_lossy(),
                    "env": {}
                }),
            )
            .await,
        );
        assert_eq!(opened["status"], "running");
        let first_pid = opened["pid"].as_u64().expect("terminal pid");

        let started = next_terminal_event_and_ack(events, "1", "started", |value| {
            value["type"] == "started" && value["terminalId"] == "term-restart"
        })
        .await;
        assert_eq!(started["snapshot"]["status"], "running");
        let running_metadata = next_matching_chunk_value(metadata, "1", |value| {
            value["type"] == "upsert" && value["terminal"]["terminalId"] == "term-restart"
        })
        .await;
        assert_eq!(running_metadata["terminal"]["status"], "running");

        send_request(
            attach,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-restart",
                "terminalId": "term-restart",
            }),
        )
        .await;
        let attached = next_chunk_and_ack(attach, "1").await;
        assert_eq!(attached[0]["snapshot"]["pid"].as_u64(), Some(first_pid));

        maybe_prime_terminal(control, "thread-restart", "term-restart").await;
        let token = "T4CODE_RPC_CLEAR_RESTART";
        assert_success(
            request(
                control,
                "3",
                "terminal.write",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                    "data": shell_echo_command(token),
                }),
            )
            .await,
        );
        let output = next_terminal_event_and_ack(attach, "1", "echo output", |value| {
            value["type"] == "output"
                && value["data"]
                    .as_str()
                    .is_some_and(|data| data.contains(token))
        })
        .await;
        assert!(
            output["data"]
                .as_str()
                .is_some_and(|data| data.contains(token))
        );

        assert_success(
            request(
                control,
                "4",
                "terminal.clear",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                }),
            )
            .await,
        );
        let cleared = next_terminal_event_and_ack(attach, "1", "cleared", |value| {
            value["type"] == "cleared" && value["terminalId"] == "term-restart"
        })
        .await;
        assert_eq!(cleared["threadId"], "thread-restart");
        let cleared_sequence = cleared["sequence"]
            .as_u64()
            .expect("cleared event sequence");
        let cleared_event = next_terminal_event_and_ack(events, "1", "cleared", |value| {
            value["type"] == "cleared" && value["terminalId"] == "term-restart"
        })
        .await;
        assert_eq!(cleared_event["threadId"], "thread-restart");

        reattach = Some(open_socket(handle.local_addr()).await);
        let reattach_socket = reattach.as_mut().expect("reattach socket");
        send_request(
            reattach_socket,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-restart",
                "terminalId": "term-restart",
            }),
        )
        .await;
        let cleared_snapshot = next_chunk_and_ack(reattach_socket, "1").await;
        let snapshot = &cleared_snapshot[0]["snapshot"];
        let snapshot_sequence = snapshot["sequence"]
            .as_u64()
            .expect("reattached snapshot sequence");
        assert!(snapshot_sequence >= cleared_sequence);
        if snapshot["history"] != "" {
            assert!(
                snapshot_sequence > cleared_sequence,
                "non-empty history must contain output received after terminal.clear"
            );
        }

        assert_success(
            request(
                control,
                "5",
                "terminal.resize",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                    "cols": 100,
                    "rows": 24,
                }),
            )
            .await,
        );
        assert_error_tag(
            request(
                control,
                "6",
                "terminal.restart",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                    "cwd": temp.path().to_string_lossy(),
                    "rows": 24,
                    "env": {}
                }),
            )
            .await,
            "RpcRequestInvalid",
        );

        let restarted = success_value(
            request(
                control,
                "7",
                "terminal.restart",
                json!({
                    "threadId": "thread-restart",
                    "terminalId": "term-restart",
                    "cwd": temp.path().to_string_lossy(),
                    "cols": 80,
                    "rows": 20,
                    "env": {}
                }),
            )
            .await,
        );
        assert_eq!(restarted["status"], "running");
        assert_ne!(restarted["pid"].as_u64(), Some(first_pid));

        let (closed_for_restart, attach_saw_exit) =
            next_restart_close_sequence(attach, "1", "thread-restart", "term-restart").await;
        assert_eq!(closed_for_restart["threadId"], "thread-restart");
        let (closed_event, events_saw_exit) =
            next_restart_close_sequence(events, "1", "thread-restart", "term-restart").await;
        assert_eq!(closed_event["threadId"], "thread-restart");
        assert_eq!(events_saw_exit, attach_saw_exit);
        let restarted_event = next_terminal_event_and_ack(events, "1", "restarted", |value| {
            value["type"] == "restarted" && value["terminalId"] == "term-restart"
        })
        .await;
        assert_eq!(restarted_event["snapshot"]["status"], "running");
        let (removed, metadata_saw_exit) =
            next_restart_metadata_remove(metadata, "1", "thread-restart", "term-restart").await;
        assert_eq!(removed["threadId"], "thread-restart");
        assert_eq!(metadata_saw_exit, events_saw_exit);
        let restarted_metadata =
            next_expected_chunk_value_and_ack(metadata, "1", "running metadata upsert", |value| {
                value["type"] == "upsert"
                    && value["terminal"]["terminalId"] == "term-restart"
                    && value["terminal"]["status"] == "running"
            })
            .await;
        assert_eq!(restarted_metadata["terminal"]["status"], "running");

        post_restart_attach = Some(open_socket(handle.local_addr()).await);
        let post_restart_attach_socket = post_restart_attach
            .as_mut()
            .expect("post-restart attach socket");
        send_request(
            post_restart_attach_socket,
            "2",
            "terminal.attach",
            json!({
                "threadId": "thread-restart",
                "terminalId": "term-restart",
            }),
        )
        .await;
        let restarted_snapshot = next_chunk_and_ack(post_restart_attach_socket, "2").await;
        let restarted_pid = restarted["pid"].as_u64().expect("restarted terminal pid");
        assert_eq!(
            restarted_snapshot[0]["snapshot"]["pid"].as_u64(),
            Some(restarted_pid)
        );
        let diagnostics =
            success_value(request(control, "8", "server.getProcessDiagnostics", json!({})).await);
        let restarted_process_key = diagnostics["processes"]
            .as_array()
            .expect("diagnostic processes")
            .iter()
            .find(|process| process["pid"].as_u64() == Some(restarted_pid))
            .and_then(|process| process["processKey"].as_str())
            .expect("restarted terminal process key");

        let signal_result = success_value(
            request(
                control,
                "9",
                "server.signalProcess",
                json!({
                    "pid": restarted_pid,
                    "processKey": restarted_process_key,
                    "signal": "SIGKILL",
                }),
            )
            .await,
        );
        let signal_supported = signal_result["signaled"] == true;
        assert_eq!(
            signal_supported,
            cfg!(any(target_os = "linux", windows)),
            "only identity-bound platform signal implementations may report success"
        );
        if !signal_supported {
            assert_success(
                request(
                    control,
                    "10",
                    "terminal.write",
                    json!({
                        "threadId": "thread-restart",
                        "terminalId": "term-restart",
                        "data": "exit\r\n",
                    }),
                )
                .await,
            );
        }
        let expected_exit_code = if signal_supported {
            expected_killed_exit_code()
        } else {
            json!(0)
        };

        let exited =
            next_terminal_event_and_ack(post_restart_attach_socket, "2", "exited", |value| {
                value["type"] == "exited" && value["terminalId"] == "term-restart"
            })
            .await;
        assert_eq!(exited["exitCode"], expected_exit_code);
        assert_eq!(exited["exitSignal"], expected_killed_exit_signal());
        let exited_metadata = next_matching_chunk_value(metadata, "1", |value| {
            value["type"] == "upsert"
                && value["terminal"]["terminalId"] == "term-restart"
                && value["terminal"]["status"] == "exited"
        })
        .await;
        assert_eq!(exited_metadata["terminal"]["pid"], Value::Null);
        assert_eq!(exited_metadata["terminal"]["exitCode"], expected_exit_code);

        failing_attach = Some(open_socket(handle.local_addr()).await);
        let failing_attach_socket = failing_attach.as_mut().expect("failing attach socket");
        send_request(
            failing_attach_socket,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-restart",
                "terminalId": "term-restart",
                "restartIfNotRunning": true,
            }),
        )
        .await;
        assert_error_tag(
            next_message(failing_attach_socket).await,
            "TerminalNotRunningError",
        );

        restarting_attach = Some(open_socket(handle.local_addr()).await);
        let restarting_attach_socket = restarting_attach
            .as_mut()
            .expect("restarting attach socket");
        send_request(
            restarting_attach_socket,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-restart",
                "terminalId": "term-restart",
                "cwd": temp.path().to_string_lossy(),
                "restartIfNotRunning": true,
                "cols": 90,
                "rows": 25,
            }),
        )
        .await;
        let attach_restart_snapshot = next_chunk_and_ack(restarting_attach_socket, "1").await;
        assert_eq!(attach_restart_snapshot[0]["snapshot"]["status"], "running");
        let (closed_exited_session, _) =
            next_restart_close_sequence(events, "1", "thread-restart", "term-restart").await;
        assert_eq!(closed_exited_session["threadId"], "thread-restart");
        let attach_restart = next_terminal_event_and_ack(events, "1", "restarted", |value| {
            value["type"] == "restarted"
                && value["terminalId"] == "term-restart"
                && value["snapshot"]["pid"] == attach_restart_snapshot[0]["snapshot"]["pid"]
        })
        .await;
        assert_eq!(attach_restart["snapshot"]["status"], "running");
        let removed_exited_metadata =
            next_expected_chunk_value_and_ack(metadata, "1", "metadata remove", |value| {
                value["type"] == "remove" && value["terminalId"] == "term-restart"
            })
            .await;
        assert_eq!(removed_exited_metadata["threadId"], "thread-restart");
        let attach_restart_metadata =
            next_expected_chunk_value_and_ack(metadata, "1", "running metadata upsert", |value| {
                value["type"] == "upsert"
                    && value["terminal"]["terminalId"] == "term-restart"
                    && value["terminal"]["status"] == "running"
                    && value["terminal"]["pid"] == attach_restart_snapshot[0]["snapshot"]["pid"]
            })
            .await;
        assert_eq!(attach_restart_metadata["terminal"]["status"], "running");
    })
    .catch_unwind()
    .await;

    close_socket(&mut reattach).await;
    close_socket(&mut post_restart_attach).await;
    close_socket(&mut restarting_attach).await;
    close_socket(&mut failing_attach).await;
    close_socket(&mut attach).await;
    close_socket(&mut metadata).await;
    close_socket(&mut events).await;
    close_socket(&mut control).await;
    handle.shutdown();
    handle.join().await.expect("server joins");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
async fn server_terminal_auxiliary_rpcs_surface_runtime_state_validation_and_interrupts() {
    let temp = TempDir::new().expect("temporary directory");
    let services = fixture_services();
    let mut registry = RpcRegistry::empty();
    register_server_terminal_rpc(&mut registry, services);
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("Rust server starts");

    let mut control = Some(open_socket(handle.local_addr()).await);
    let mut cloud_install = Some(open_socket(handle.local_addr()).await);
    let mut interruptible_attach = Some(open_socket(handle.local_addr()).await);

    let result = AssertUnwindSafe(async {
        let control = control.as_mut().expect("control socket");
        let cloud_install = cloud_install.as_mut().expect("cloud install socket");
        let interruptible_attach = interruptible_attach
            .as_mut()
            .expect("interruptible attach socket");

        let settings = success_value(request(control, "1", "server.getSettings", json!({})).await);
        assert_eq!(settings["automaticGitFetchInterval"], 30000);

        let diagnostics =
            success_value(request(control, "2", "server.getProcessDiagnostics", json!({})).await);
        assert_eq!(
            diagnostics["serverPid"].as_u64(),
            Some(u64::from(std::process::id()))
        );
        assert!(
            diagnostics["totals"]["combined"]["processCount"]
                .as_u64()
                .is_some()
        );

        let history = success_value(
            request(
                control,
                "3",
                "server.getProcessResourceHistory",
                json!({
                    "windowMs": 5_000,
                    "bucketMs": 1_000,
                }),
            )
            .await,
        );
        assert_eq!(history["windowMs"], 5_000);
        assert_eq!(history["bucketMs"], 1_000);

        let refreshed = success_value(
            request(
                control,
                "4",
                "server.refreshProviderUsage",
                json!({
                    "providers": ["claude"],
                }),
            )
            .await,
        );
        assert_eq!(refreshed["providers"][0]["provider"], "claude");
        assert_error_tag(
            request(
                control,
                "5",
                "server.refreshProviderUsage",
                json!({
                    "providers": ["invalid-provider"],
                }),
            )
            .await,
            "RpcRequestInvalid",
        );

        let relay_status =
            success_value(request(control, "6", "cloud.getRelayClientStatus", json!({})).await);
        assert_eq!(relay_status["status"], "missing");
        assert_eq!(relay_status["version"], "1.0.0");

        send_request(cloud_install, "1", "cloud.installRelayClient", json!({})).await;
        let progress = next_chunk_and_ack(cloud_install, "1").await;
        assert_eq!(
            progress,
            vec![json!({ "type": "progress", "stage": "download" })]
        );
        let complete = next_chunk_and_ack(cloud_install, "1").await;
        assert_eq!(
            complete,
            vec![json!({
                "type": "complete",
                "status": { "status": "missing", "version": "1.0.0" }
            })]
        );
        assert!(matches!(
            next_message(cloud_install).await,
            ServerMessage::Exit {
                exit: RpcExit::Success { value: None },
                ..
            }
        ));

        send_request(
            interruptible_attach,
            "1",
            "terminal.attach",
            json!({
                "threadId": "thread-interrupt",
                "terminalId": "term-interrupt",
                "cwd": temp.path().to_string_lossy(),
                "cols": 120,
                "rows": 30,
                "env": {}
            }),
        )
        .await;
        let snapshot = next_chunk(interruptible_attach, "1").await;
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0]["type"], "snapshot");
        send_interrupt(interruptible_attach, "1").await;
        assert!(matches!(
            next_message(interruptible_attach).await,
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Failure { cause },
            } if request_id.as_str() == "1"
                && cause == vec![CauseItem::Interrupt { fiber_id: None }]
        ));

        assert_error_tag(
            request(
                control,
                "7",
                "server.signalProcess",
                json!({
                    "pid": std::process::id(),
                    "processKey": format!("{}:0", std::process::id()),
                    "signal": "SIGHUP",
                }),
            )
            .await,
            "RpcRequestInvalid",
        );
        let not_signaled = success_value(
            request(
                control,
                "8",
                "server.signalProcess",
                json!({
                    "pid": u32::MAX,
                    "processKey": format!("{}:999", u32::MAX),
                    "signal": "SIGINT",
                }),
            )
            .await,
        );
        assert_eq!(not_signaled["signaled"], false);
        assert_eq!(not_signaled["pid"], u32::MAX);
        let server_process_key = diagnostics["processes"]
            .as_array()
            .expect("diagnostic processes")
            .iter()
            .find(|process| process["pid"].as_u64() == Some(u64::from(std::process::id())))
            .and_then(|process| process["processKey"].as_str())
            .expect("server process key");
        let core_not_signaled = success_value(
            request(
                control,
                "9",
                "server.signalProcess",
                json!({
                    "pid": std::process::id(),
                    "processKey": server_process_key,
                    "signal": "SIGINT",
                }),
            )
            .await,
        );
        assert_eq!(core_not_signaled["signaled"], false);
    })
    .catch_unwind()
    .await;

    close_socket(&mut interruptible_attach).await;
    close_socket(&mut cloud_install).await;
    close_socket(&mut control).await;
    handle.shutdown();
    handle.join().await.expect("server joins");
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn assert_terminal_open_and_metadata_upsert(messages: [ServerMessage; 2]) {
    assert!(messages.iter().any(|message| matches!(
        message,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    )));
    assert!(messages.iter().any(|message| matches!(
        message,
        ServerMessage::Chunk { values, .. }
            if values.iter().any(|value|
                value["type"] == "upsert"
                    && value["terminal"]["terminalId"] == "term-1"
                    && value["terminal"]["status"] == "running"
            )
    )));
}

#[test]
fn registrar_source_contains_every_owned_rpc_name() {
    let source = include_str!("../src/production/server_terminal.rs");
    for method in [
        "terminal.open",
        "terminal.attach",
        "terminal.write",
        "terminal.resize",
        "terminal.clear",
        "terminal.restart",
        "terminal.close",
        "subscribeTerminalEvents",
        "subscribeTerminalMetadata",
        "server.getConfig",
        "server.getProcessDiagnostics",
        "server.getProcessResourceHistory",
        "server.getProviderUsage",
        "server.getSettings",
        "server.getTraceDiagnostics",
        "server.refreshProviders",
        "server.refreshProviderUsage",
        "server.removeKeybinding",
        "server.signalProcess",
        "server.updateProvider",
        "server.updateSettings",
        "server.upsertKeybinding",
        "subscribeServerConfig",
        "subscribeServerLifecycle",
        "subscribeDiscoveredLocalServers",
        "cloud.getRelayClientStatus",
        "cloud.installRelayClient",
    ] {
        assert!(source.contains(method), "registrar is missing {method}");
    }
}

fn fixture_services() -> ServerTerminalServices {
    let sampler = Arc::new(diagnostics::NativeProcessSampler::default());
    let resource_sampler = Arc::new(diagnostics::NativeResourceSampler::new(
        sampler.clone(),
        diagnostics::ProcessAttributionRegistry::new(),
        Arc::new(diagnostics::NotApplicableUiProcessObserver),
    ));
    let monitor = Arc::new(diagnostics::DiagnosticsMonitor::new(
        resource_sampler.clone(),
        Duration::from_secs(60),
    ));
    let usage = provider_usage::ProviderUsageService::new(
        Vec::new(),
        Arc::new(time::OffsetDateTime::now_utc),
    );
    let relay = cloud::RelayClientService::new(
        || async {
            cloud::RelayClientStatus::Missing {
                version: "1.0.0".into(),
            }
        },
        |report| async move {
            report(cloud::RelayClientInstallEvent::Progress {
                stage: "download".into(),
            })
            .await?;
            Ok(cloud::RelayClientStatus::Missing {
                version: "1.0.0".into(),
            })
        },
    );
    ServerTerminalServices::new(
        terminal::TerminalManager::new(
            Arc::new(terminal::PortablePtyBackend),
            terminal::TerminalManagerOptions {
                subprocess_poll_interval: Duration::from_millis(100),
                ..terminal::TerminalManagerOptions::default()
            },
        ),
        sampler,
        resource_sampler,
        monitor,
        usage,
        relay,
        Arc::new(FixtureControl),
    )
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

async fn send_request(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: &str,
    tag: &str,
    payload: Value,
) {
    let message =
        json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] });
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("request sends");
}

async fn send_ack(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    request_id: &str,
) {
    let message = json!({ "_tag": "Ack", "requestId": request_id });
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("acknowledgement sends");
}

async fn send_interrupt(socket: &mut TestSocket, request_id: &str) {
    let message = json!({ "_tag": "Interrupt", "requestId": request_id });
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("interrupt sends");
}

async fn next_message(socket: &mut TestSocket) -> ServerMessage {
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("response timeout")
        .expect("socket remains open")
        .expect("valid socket message");
    let Message::Text(text) = message else {
        panic!("expected text message")
    };
    serde_json::from_str(&text).expect("valid server message")
}

fn success_value(message: ServerMessage) -> Value {
    match message {
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } => value,
        other => panic!("expected successful RPC response, got {other:?}"),
    }
}

async fn open_socket(local_addr: SocketAddr) -> TestSocket {
    connect_async(format!("ws://{local_addr}/ws"))
        .await
        .expect("WebSocket connects")
        .0
}

async fn close_socket(socket: &mut Option<TestSocket>) {
    if let Some(socket) = socket.as_mut() {
        let _ = socket.close(None).await;
    }
}

async fn request(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) -> ServerMessage {
    send_request(socket, id, tag, payload).await;
    next_message(socket).await
}

fn assert_success(message: ServerMessage) {
    assert!(matches!(
        message,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));
}

fn assert_error_tag(message: ServerMessage, expected_tag: &str) {
    match message {
        ServerMessage::Exit {
            exit: RpcExit::Failure { cause: ref items },
            ..
        } => {
            let [CauseItem::Fail { error }] = items.as_slice() else {
                panic!("expected a single failure cause, got {items:?}");
            };
            assert_eq!(error["_tag"], expected_tag);
        }
        other => panic!("expected failure response, got {other:?}"),
    }
}

async fn next_chunk_and_ack(socket: &mut TestSocket, request_id: &str) -> Vec<Value> {
    let values = next_chunk(socket, request_id).await;
    send_ack(socket, request_id).await;
    values
}

async fn next_matching_chunk_value<F>(
    socket: &mut TestSocket,
    request_id: &str,
    matches: F,
) -> Value
where
    F: Fn(&Value) -> bool,
{
    loop {
        let values = next_chunk_and_ack(socket, request_id).await;
        if let Some(value) = values.into_iter().find(&matches) {
            return value;
        }
    }
}

async fn next_expected_chunk_value_and_ack<F>(
    socket: &mut TestSocket,
    request_id: &str,
    expected: &str,
    matches: F,
) -> Value
where
    F: Fn(&Value) -> bool,
{
    let values = next_chunk(socket, request_id).await;
    let [value] = values.as_slice() else {
        panic!("expected one {expected} chunk value, got {values:?}");
    };
    assert!(matches(value), "expected {expected}, got {value:?}");
    let value = value.clone();
    send_ack(socket, request_id).await;
    value
}

async fn next_terminal_event_and_ack<F>(
    socket: &mut TestSocket,
    request_id: &str,
    expected: &str,
    matches: F,
) -> Value
where
    F: Fn(&Value) -> bool,
{
    loop {
        let values = next_chunk(socket, request_id).await;
        let [value] = values.as_slice() else {
            panic!("expected one terminal event while waiting for {expected}, got {values:?}");
        };
        if matches(value) {
            let value = value.clone();
            send_ack(socket, request_id).await;
            return value;
        }
        assert!(
            matches!(value["type"].as_str(), Some("output" | "activity")),
            "expected {expected}, got unexpected terminal lifecycle event {value:?}"
        );
        send_ack(socket, request_id).await;
    }
}

async fn next_restart_close_sequence(
    socket: &mut TestSocket,
    request_id: &str,
    thread_id: &str,
    terminal_id: &str,
) -> (Value, bool) {
    let first = next_terminal_event_and_ack(socket, request_id, "exited or closed", |value| {
        matches!(value["type"].as_str(), Some("exited" | "closed"))
            && value["threadId"] == thread_id
            && value["terminalId"] == terminal_id
    })
    .await;
    if first["type"] == "closed" {
        return (first, false);
    }

    let closed = next_terminal_event_and_ack(socket, request_id, "closed", |value| {
        value["type"] == "closed"
            && value["threadId"] == thread_id
            && value["terminalId"] == terminal_id
    })
    .await;
    (closed, true)
}

async fn next_restart_metadata_remove(
    socket: &mut TestSocket,
    request_id: &str,
    thread_id: &str,
    terminal_id: &str,
) -> (Value, bool) {
    let first = next_expected_chunk_value_and_ack(
        socket,
        request_id,
        "exited metadata upsert or metadata remove",
        |value| {
            (value["type"] == "remove"
                && value["threadId"] == thread_id
                && value["terminalId"] == terminal_id)
                || (value["type"] == "upsert"
                    && value["terminal"]["threadId"] == thread_id
                    && value["terminal"]["terminalId"] == terminal_id
                    && value["terminal"]["status"] == "exited")
        },
    )
    .await;
    if first["type"] == "remove" {
        return (first, false);
    }

    let removed =
        next_expected_chunk_value_and_ack(socket, request_id, "metadata remove", |value| {
            value["type"] == "remove"
                && value["threadId"] == thread_id
                && value["terminalId"] == terminal_id
        })
        .await;
    (removed, true)
}

async fn next_chunk(socket: &mut TestSocket, request_id: &str) -> Vec<Value> {
    match next_message(socket).await {
        ServerMessage::Chunk {
            request_id: actual_request_id,
            values,
        } => {
            assert_eq!(actual_request_id.as_str(), request_id);
            values
        }
        other => panic!("expected chunk for request {request_id}, got {other:?}"),
    }
}

async fn maybe_prime_terminal(socket: &mut TestSocket, thread_id: &str, terminal_id: &str) {
    if cfg!(windows) {
        assert_success(
            request(
                socket,
                "90",
                "terminal.write",
                json!({
                    "threadId": thread_id,
                    "terminalId": terminal_id,
                    "data": "\u{1b}[1;1R",
                }),
            )
            .await,
        );
    }
}

fn shell_echo_command(token: &str) -> String {
    if cfg!(windows) {
        format!("echo {token}\r\n")
    } else {
        format!("echo {token}\n")
    }
}

fn long_running_command() -> &'static str {
    if cfg!(windows) {
        "ping 127.0.0.1 -n 4\r\n"
    } else {
        "printf 'T4CODE_RPC_%s\\n' 'LONG_RUNNING_READY'; sleep 3\n"
    }
}

fn long_running_output_marker() -> &'static str {
    if cfg!(windows) {
        "Pinging"
    } else {
        "T4CODE_RPC_LONG_RUNNING_READY"
    }
}

fn long_running_label() -> &'static str {
    if cfg!(windows) { "PING" } else { "sleep" }
}

fn expected_killed_exit_code() -> Value {
    json!(1)
}

fn expected_killed_exit_signal() -> Value {
    Value::Null
}
