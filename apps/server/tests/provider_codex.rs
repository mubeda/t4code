use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};
use t4code_server::provider::codex::{
    BuildTurnStartInput, CodexRuntimeMode, CodexSessionOptions, CodexSessionRuntime,
    ConnectionConfig, IncomingEvent, JsonRpcConnection, RuntimeEvent, RuntimeEventStableView,
    build_initialize_params, build_turn_start_params, is_recoverable_thread_resume_error,
    parse_model_list_response, parse_skills_list_response, probe_provider,
};

#[test]
fn missing_codex_rollout_is_a_recoverable_resume_failure() {
    assert!(is_recoverable_thread_resume_error(
        "no rollout found for thread id 019f5662-6e5e-70d1-9074-06a0ba8761d0"
    ));
}

#[test]
fn automatic_codex_model_resolves_to_the_supported_default() {
    let payload = build_turn_start_params(&BuildTurnStartInput {
        thread_id: "provider-thread-1".to_owned(),
        runtime_mode: CodexRuntimeMode::FullAccess,
        prompt: Some("hello".to_owned()),
        attachments: vec![],
        model: Some("auto".to_owned()),
        service_tier: None,
        effort: None,
        interaction_mode: Some("default".to_owned()),
    });
    assert_eq!(payload["model"], "gpt-5.4");
    assert_eq!(payload["collaborationMode"]["settings"]["model"], "gpt-5.4");
}
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, duplex},
    sync::mpsc,
    time::timeout,
};

#[tokio::test]
async fn helper_outputs_match_canonical_codex_fixtures() {
    let initialize_fixture = fixture("initialize-params.json");
    assert_eq!(build_initialize_params("0.1.1"), initialize_fixture);

    let default_turn_fixture = fixture("turn-start-default.json");
    assert_eq!(
        build_turn_start_params(&BuildTurnStartInput {
            thread_id: "provider-thread-1".to_owned(),
            runtime_mode: CodexRuntimeMode::AutoAcceptEdits,
            prompt: Some("Implement it".to_owned()),
            attachments: vec![json!({
                "type": "image",
                "url": "data:image/png;base64,abc",
            })],
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            interaction_mode: Some("default".to_owned()),
        }),
        default_turn_fixture
    );

    let plan_turn_fixture = fixture("turn-start-plan.json");
    assert_eq!(
        build_turn_start_params(&BuildTurnStartInput {
            thread_id: "provider-thread-1".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            prompt: Some("Make a plan".to_owned()),
            attachments: vec![],
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: Some("medium".to_owned()),
            interaction_mode: Some("plan".to_owned()),
        }),
        plan_turn_fixture
    );

    let model_fixture = fixture("model-discovery.json");
    let parsed_models = parse_model_list_response(
        &model_fixture["response"],
        &["custom-alpha".to_owned(), "gpt-5.3-codex".to_owned()],
    )
    .expect("models parse");
    assert_eq!(
        serde_json::to_value(parsed_models).expect("models json"),
        model_fixture["parsed"]
    );

    let skills_fixture = fixture("skill-discovery.json");
    let parsed_skills = parse_skills_list_response(
        &skills_fixture["response"],
        skills_fixture["cwd"].as_str().expect("fixture cwd"),
    )
    .expect("skills parse");
    assert_eq!(
        serde_json::to_value(parsed_skills).expect("skills json"),
        skills_fixture["parsed"]
    );
}

#[tokio::test]
async fn probe_matches_fixture_corpus() {
    let scenario = fixture("probe-scenario.json");
    let (connection, _incoming, mut peer) = scripted_peer();
    peer.expect_request("initialize", scenario["initializeRequest"].clone())
        .respond(scenario["initializeResponse"].clone());
    peer.expect_notification("initialized");
    peer.expect_request("account/read", json!({}))
        .respond(scenario["accountResponse"].clone());
    peer.expect_request("model/list", json!({}))
        .respond(scenario["modelListFirst"].clone());
    peer.expect_request("model/list", json!({ "cursor": "cursor-2" }))
        .respond(scenario["modelListSecond"].clone());
    peer.expect_request(
        "skills/list",
        json!({ "cwds": [scenario["cwd"].as_str().expect("cwd")] }),
    )
    .respond(scenario["skillsResponse"].clone());

    let peer_task = tokio::spawn(peer.run());
    let snapshot = probe_provider(
        &connection,
        "0.1.1",
        scenario["cwd"].as_str().expect("cwd"),
        &["custom-alpha".to_owned()],
    )
    .await
    .expect("probe succeeds");
    let expected = scenario["expectedSnapshot"].clone();
    assert_eq!(
        serde_json::to_value(snapshot).expect("snapshot json"),
        expected
    );
    peer_task.await.expect("peer task");
}

#[tokio::test]
async fn session_runtime_matches_text_tool_and_approval_traces() {
    let (connection, incoming, mut peer) = scripted_peer();
    let runtime = CodexSessionRuntime::new(
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "fixture-thread".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            resume_cursor: None,
        },
        connection.clone(),
        incoming,
    );

    peer.expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({
            "userAgent": "mock-codex-app-server",
            "codexHome": "/tmp/codex-home",
            "platformFamily": "unix",
            "platformOs": "linux",
        }));
    peer.expect_notification("initialized");
    peer.expect_request(
        "thread/start",
        json!({
            "cwd": "/tmp/project",
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
            "model": "gpt-5.3-codex",
            "serviceTier": null,
        }),
    )
    .respond(json!({
        "cwd": "/tmp/project",
        "model": "gpt-5.3-codex",
        "thread": { "id": "provider-thread-1" }
    }));
    peer.expect_request(
        "thread/goal/set",
        json!({
            "threadId": "provider-thread-1",
            "objective": "Finish the provider parity work",
            "status": "active",
        }),
    )
    .respond(json!({ "goal": { "status": "active" } }));
    peer.expect_request("turn/start", fixture("turn-start-text.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-1",
                "delta": "I will make a small update.\n"
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-1",
                "delta": "Done.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));
    peer.expect_request("turn/start", fixture("turn-start-tool.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_notification(json!({
            "method": "item/started",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo integration"
                }
            }
        }))
        .emit_notification(json!({
            "method": "item/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo integration"
                }
            }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-2",
                "delta": "Applied the requested edit.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));
    peer.expect_request("turn/start", fixture("turn-start-approval.json"))
        .respond(json!({
            "turn": { "id": "fixture-turn" }
        }))
        .emit_notification(json!({
            "method": "turn/started",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn" }
            }
        }))
        .emit_request(json!({
            "id": 1001,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-approval-1",
                "reason": "Please approve command"
            }
        }))
        .expect_response(json!({
            "id": 1001,
            "result": { "decision": "accept" }
        }))
        .emit_notification(json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "provider-thread-1",
                "turnId": "fixture-turn",
                "itemId": "item-3",
                "delta": "Approval received and command executed.\n"
            }
        }))
        .emit_notification(json!({
            "method": "turn/completed",
            "params": {
                "threadId": "provider-thread-1",
                "turn": { "id": "fixture-turn", "status": "completed" }
            }
        }));

    let peer_task = tokio::spawn(peer.run());

    runtime.start().await.expect("runtime starts");
    let startup_events = runtime.collect_events(2).await;
    assert_eq!(startup_events[0].event_type, "session.connecting");
    assert_eq!(startup_events[1].event_type, "session.ready");

    runtime
        .set_goal("Finish the provider parity work")
        .await
        .expect("goal is set through app-server");

    runtime
        .send_turn(Some("Small text turn".to_owned()), vec![], None)
        .await
        .expect("text turn");
    let text_events = runtime.collect_events(4).await;
    assert_eq!(text_events, stable_fixture("trace-text.json"));

    runtime
        .send_turn(Some("Run a tool".to_owned()), vec![], None)
        .await
        .expect("tool turn");
    let tool_events = runtime.collect_events(5).await;
    assert_eq!(tool_events, stable_fixture("trace-tool.json"));

    runtime
        .send_turn(Some("Needs approval".to_owned()), vec![], None)
        .await
        .expect("approval turn");
    let mut approval_events = runtime.collect_events(2).await;
    assert_eq!(
        &approval_events[..2],
        &stable_fixture("trace-approval-prefix.json")[..2]
    );
    runtime
        .respond_to_request("approval:1001", "accept")
        .await
        .expect("approval response");
    approval_events.extend(runtime.collect_events(3).await);
    assert_eq!(approval_events, stable_fixture("trace-approval.json"));

    peer_task.await.expect("peer task");
}

#[tokio::test]
async fn reconnect_resume_fallback_and_shutdown_stay_correlated() {
    let reconnect_fixture = fixture("reconnect-scenario.json");

    let (connection_a, incoming_a, mut peer_a) = scripted_peer();
    let runtime = CodexSessionRuntime::new(
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "fixture-thread".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            resume_cursor: None,
        },
        connection_a.clone(),
        incoming_a,
    );
    peer_a
        .expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({ "userAgent": "mock-a" }));
    peer_a.expect_notification("initialized");
    peer_a
        .expect_request(
            "thread/start",
            reconnect_fixture["initialThreadStartRequest"].clone(),
        )
        .respond(reconnect_fixture["initialThreadStartResponse"].clone());
    let peer_a_task = tokio::spawn(peer_a.run());
    runtime.start().await.expect("initial start");
    peer_a_task.await.expect("peer a");

    let (connection_b, incoming_b, mut peer_b) = scripted_peer();
    peer_b
        .expect_request("initialize", fixture("initialize-params.json"))
        .respond(json!({ "userAgent": "mock-b" }));
    peer_b.expect_notification("initialized");
    peer_b
        .expect_request("thread/resume", reconnect_fixture["resumeRequest"].clone())
        .respond_error(json!({
            "code": -32603,
            "message": "Thread does not exist"
        }));
    peer_b
        .expect_request(
            "thread/start",
            reconnect_fixture["fallbackThreadStartRequest"].clone(),
        )
        .respond(reconnect_fixture["fallbackThreadStartResponse"].clone());
    peer_b
        .expect_request(
            "thread/rollback",
            json!({
                "threadId": "provider-thread-2",
                "numTurns": 1
            }),
        )
        .respond(json!({
            "thread": {
                "id": "provider-thread-2",
                "turns": [
                    { "id": "fixture-turn", "items": [] }
                ]
            }
        }));
    peer_b
        .expect_request("shutdown", Value::Null)
        .respond(Value::Null);
    let peer_b_task = tokio::spawn(peer_b.run());

    runtime
        .reconnect(connection_b.clone(), incoming_b)
        .await
        .expect("reconnect");
    let rollback = runtime.rollback_thread(1).await.expect("rollback");
    assert_eq!(rollback.thread_id, "provider-thread-2");
    runtime.shutdown().await.expect("shutdown");
    peer_b_task.await.expect("peer b");
}

#[tokio::test]
async fn codex_runtime_covers_auto_edit_resume_requests_and_stream_edges() {
    let (connection, incoming, mut peer) = scripted_peer();
    let runtime = CodexSessionRuntime::new(
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "codex-edge-thread".to_owned(),
            cwd: "/tmp/codex-edge".to_owned(),
            runtime_mode: CodexRuntimeMode::AutoAcceptEdits,
            model: None,
            service_tier: Some("fast".to_owned()),
            effort: Some("high".to_owned()),
            resume_cursor: Some("resume-edge".to_owned()),
        },
        connection,
        incoming,
    );
    assert!(
        runtime
            .set_goal("  ")
            .await
            .expect_err("empty goals must fail")
            .to_string()
            .contains("between 1 and 4000")
    );
    assert!(
        runtime
            .set_goal(&"x".repeat(4_001))
            .await
            .expect_err("oversized goals must fail")
            .to_string()
            .contains("between 1 and 4000")
    );
    assert!(
        runtime
            .respond_to_request("missing", "accept")
            .await
            .expect_err("unknown approvals must fail")
            .to_string()
            .contains("Unknown pending request id missing")
    );
    assert!(
        runtime
            .respond_to_user_input("missing-input", json!({}))
            .await
            .expect_err("unknown prompts must fail")
            .to_string()
            .contains("Unknown pending request id missing-input")
    );

    peer.expect_request("initialize", build_initialize_params("0.1.1"))
        .respond(json!({}));
    peer.expect_notification("initialized");
    peer.expect_request(
        "thread/resume",
        json!({
            "threadId": "resume-edge",
            "cwd": "/tmp/codex-edge",
            "approvalPolicy": "on-request",
            "sandbox": "workspace-write",
            "model": null,
            "serviceTier": "fast",
        }),
    )
    .respond(json!({ "thread": { "id": "provider-edge" } }));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-edge", "invalid turn"),
    )
    .respond(json!({}));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-edge", "file approval"),
    )
    .respond(json!({ "turn": { "id": "file-turn" } }))
    .emit_notification(json!({
        "method": "thread/started",
        "params": { "thread": { "id": "provider-updated" } }
    }))
    .emit_notification(json!({
        "method": "turn/started",
        "params": { "turn": {} }
    }))
    .emit_notification(json!({
        "method": "turn/started",
        "params": { "turn": { "id": "file-turn" } }
    }))
    .emit_notification(json!({
        "method": "item/started",
        "params": {
            "turnId": "file-turn",
            "item": { "type": "fileChange", "id": "not-command" }
        }
    }))
    .emit_notification(json!({
        "method": "item/started",
        "params": {
            "turnId": "file-turn",
            "item": { "type": "commandExecution", "id": "command-without-detail" }
        }
    }))
    .emit_request(json!({
        "id": 6001,
        "method": "item/fileChange/requestApproval",
        "params": { "turnId": "file-turn" }
    }))
    .expect_response(json!({
        "id": 6001,
        "result": { "decision": "decline" }
    }))
    .emit_notification(json!({
        "method": "turn/completed",
        "params": {
            "turn": {
                "id": "file-turn",
                "status": "failed",
                "error": { "message": "provider failed" }
            }
        }
    }));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-updated", "user input"),
    )
    .respond(json!({ "turn": { "id": "input-turn" } }))
    .emit_request(json!({
        "id": 6002,
        "method": "item/tool/requestUserInput",
        "params": {
            "turnId": "input-turn",
            "questions": [
                {
                    "id": "single",
                    "header": "Single",
                    "question": "Choose one",
                    "options": [{ "label": "yes" }]
                },
                { "id": "invalid" }
            ]
        }
    }))
    .expect_response(json!({
        "id": 6002,
        "result": {
            "answers": {
                "single": { "answers": ["yes"] },
                "many": { "answers": ["a", "b"] },
                "ignored": { "answers": [] }
            }
        }
    }))
    .emit_notification(json!({
        "method": "turn/completed",
        "params": { "turn": { "id": "input-turn" } }
    }));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-updated", "generic cancellation"),
    )
    .respond(json!({ "turn": { "id": "cancel-input-turn" } }))
    .emit_request(json!({
        "id": 6003,
        "method": "item/tool/requestUserInput",
        "params": { "turnId": "cancel-input-turn", "questions": null }
    }))
    .expect_response(json!({
        "id": 6003,
        "result": { "decision": "cancel" }
    }))
    .emit_notification(json!({
        "method": "turn/completed",
        "params": { "turn": { "id": "cancel-input-turn", "status": "completed" } }
    }));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-updated", "unknown request"),
    )
    .respond(json!({ "turn": { "id": "unknown-turn" } }))
    .emit_request(json!({
        "id": 6004,
        "method": "unsupported/request",
        "params": {}
    }))
    .expect_response(json!({
        "id": 6004,
        "error": {
            "code": -32601,
            "message": "Method not found: unsupported/request",
            "data": null
        }
    }))
    .emit_notification(json!({
        "method": "ignored/notification",
        "params": {}
    }))
    .emit_notification(json!({
        "method": "turn/completed",
        "params": { "turn": { "id": "unknown-turn", "status": "completed" } }
    }));

    peer.expect_request(
        "turn/start",
        codex_edge_turn_params("provider-updated", "interrupt"),
    )
    .emit_stderr("ordinary provider warning")
    .emit_stderr("FAILED TO CONNECT TO WEBSOCKET while streaming")
    .respond(json!({ "turn": { "id": "interrupt-turn" } }));
    peer.expect_request(
        "turn/interrupt",
        json!({ "threadId": "provider-updated", "turnId": "explicit-turn" }),
    )
    .respond(json!({}));

    let peer_task = tokio::spawn(peer.run());
    let session = runtime.start().await.expect("resumed session");
    assert_eq!(session.resume_cursor.as_deref(), Some("provider-edge"));
    assert_eq!(session.cwd, "/tmp/codex-edge");
    runtime.collect_events(2).await;
    runtime
        .interrupt_turn(None)
        .await
        .expect("no active turn is a no-op");

    assert!(
        runtime
            .send_turn(Some("invalid turn".to_owned()), Vec::new(), None)
            .await
            .expect_err("missing turn ids must fail")
            .to_string()
            .contains("missing turn.id")
    );

    runtime
        .send_turn(Some("file approval".to_owned()), Vec::new(), None)
        .await
        .expect("file turn");
    let file_request = next_codex_event_matching(&runtime, |event| {
        event.request_id.as_deref() == Some("approval:6001")
    })
    .await;
    assert_eq!(
        file_request.payload["requestType"],
        json!("file_change_approval")
    );
    assert_eq!(file_request.payload["detail"], "");
    runtime
        .respond_to_request("approval:6001", "decline")
        .await
        .expect("file decision");
    let failed = next_codex_event_matching(&runtime, |event| {
        event.event_type == "turn.completed" && event.turn_id.as_deref() == Some("file-turn")
    })
    .await;
    assert_eq!(failed.payload["state"], "failed");
    assert_eq!(failed.payload["error"]["message"], "provider failed");

    runtime
        .send_turn(Some("user input".to_owned()), Vec::new(), None)
        .await
        .expect("input turn");
    let input_request = next_codex_event_matching(&runtime, |event| {
        event.request_id.as_deref() == Some("user-input:6002")
    })
    .await;
    assert_eq!(
        input_request.payload["questions"].as_array().unwrap().len(),
        1
    );
    runtime
        .respond_to_user_input(
            "user-input:6002",
            json!({
                "single": "yes",
                "many": ["a", "b"],
                "ignored": 42,
            }),
        )
        .await
        .expect("input response");
    let resolved = next_codex_event_matching(&runtime, |event| {
        event.request_id.as_deref() == Some("user-input:6002")
            && event.event_type == "user-input.resolved"
    })
    .await;
    assert_eq!(resolved.payload["answers"]["single"], "yes");
    assert_eq!(resolved.payload["answers"]["many"], json!(["a", "b"]));

    runtime
        .send_turn(Some("generic cancellation".to_owned()), Vec::new(), None)
        .await
        .expect("generic cancellation turn");
    next_codex_event_matching(&runtime, |event| {
        event.request_id.as_deref() == Some("user-input:6003")
    })
    .await;
    runtime
        .respond_to_request("user-input:6003", "cancel")
        .await
        .expect("generic cancellation");

    runtime
        .send_turn(Some("unknown request".to_owned()), Vec::new(), None)
        .await
        .expect("unknown request turn");
    next_codex_event_matching(&runtime, |event| {
        event.event_type == "turn.completed" && event.turn_id.as_deref() == Some("unknown-turn")
    })
    .await;

    runtime
        .send_turn(Some("interrupt".to_owned()), Vec::new(), None)
        .await
        .expect("interrupt turn");
    runtime
        .interrupt_turn(Some("explicit-turn".to_owned()))
        .await
        .expect("explicit interrupt");
    peer_task.await.expect("peer");

    let mut saw_warning = false;
    let mut saw_fatal = false;
    let mut saw_exit = false;
    for _ in 0..12 {
        let event = timeout(Duration::from_secs(2), runtime.next_event())
            .await
            .expect("edge event timeout")
            .expect("edge event");
        saw_warning |= event.event_type == "runtime.warning";
        saw_fatal |= event.event_type == "runtime.error"
            && event.payload["class"] == json!("provider_error");
        saw_exit |= event.event_type == "session.exited";
        if saw_warning && saw_fatal && saw_exit {
            break;
        }
    }
    assert!(saw_warning && saw_fatal && saw_exit);
}

#[tokio::test]
async fn codex_runtime_and_probe_reject_invalid_provider_payloads() {
    let (probe_connection, _probe_incoming, mut probe_peer) = scripted_peer();
    probe_peer
        .expect_request("initialize", build_initialize_params("0.1.1"))
        .respond(json!({}));
    probe_peer.expect_notification("initialized");
    probe_peer
        .expect_request("account/read", json!({}))
        .respond(json!({}));
    probe_peer
        .expect_request("model/list", json!({}))
        .respond(json!({ "nextCursor": null }));
    let probe_task = tokio::spawn(probe_peer.run());
    assert!(
        probe_provider(&probe_connection, "0.1.1", "/tmp", &[])
            .await
            .expect_err("model data is required")
            .to_string()
            .contains("missing data array")
    );
    probe_task.await.expect("probe peer");

    let (missing_connection, missing_incoming, mut missing_peer) = scripted_peer();
    let missing_runtime = CodexSessionRuntime::new(
        codex_invalid_options(None),
        missing_connection,
        missing_incoming,
    );
    assert!(
        missing_runtime
            .send_turn(Some("before start".to_owned()), Vec::new(), None)
            .await
            .expect_err("turns require a provider thread")
            .to_string()
            .contains("missing a provider thread id")
    );
    missing_peer
        .expect_request("initialize", build_initialize_params("0.1.1"))
        .respond(json!({}));
    missing_peer.expect_notification("initialized");
    missing_peer
        .expect_request(
            "thread/start",
            json!({
                "cwd": "/tmp/codex-invalid",
                "approvalPolicy": "untrusted",
                "sandbox": "read-only",
                "model": null,
                "serviceTier": null,
            }),
        )
        .respond(json!({}));
    let missing_task = tokio::spawn(missing_peer.run());
    assert!(
        missing_runtime
            .start()
            .await
            .expect_err("thread identifiers are required")
            .to_string()
            .contains("missing thread.id")
    );
    missing_task.await.expect("missing peer");

    let (resume_connection, resume_incoming, mut resume_peer) = scripted_peer();
    let resume_runtime = CodexSessionRuntime::new(
        codex_invalid_options(Some("unavailable-thread")),
        resume_connection,
        resume_incoming,
    );
    resume_peer
        .expect_request("initialize", build_initialize_params("0.1.1"))
        .respond(json!({}));
    resume_peer.expect_notification("initialized");
    resume_peer
        .expect_request(
            "thread/resume",
            json!({
                "threadId": "unavailable-thread",
                "cwd": "/tmp/codex-invalid",
                "approvalPolicy": "untrusted",
                "sandbox": "read-only",
                "model": null,
                "serviceTier": null,
            }),
        )
        .respond_error(json!({ "code": -32000, "message": "permission denied" }));
    let resume_task = tokio::spawn(resume_peer.run());
    assert!(
        resume_runtime
            .start()
            .await
            .expect_err("non-recoverable resume errors must propagate")
            .to_string()
            .contains("permission denied")
    );
    resume_task.await.expect("resume peer");
}

fn codex_invalid_options(resume_cursor: Option<&str>) -> CodexSessionOptions {
    CodexSessionOptions {
        version: "0.1.1".to_owned(),
        thread_id: "codex-invalid-thread".to_owned(),
        cwd: "/tmp/codex-invalid".to_owned(),
        runtime_mode: CodexRuntimeMode::ApprovalRequired,
        model: None,
        service_tier: None,
        effort: None,
        resume_cursor: resume_cursor.map(str::to_owned),
    }
}

fn codex_edge_turn_params(provider_thread_id: &str, prompt: &str) -> Value {
    build_turn_start_params(&BuildTurnStartInput {
        thread_id: provider_thread_id.to_owned(),
        runtime_mode: CodexRuntimeMode::AutoAcceptEdits,
        prompt: Some(prompt.to_owned()),
        attachments: Vec::new(),
        model: None,
        service_tier: Some("fast".to_owned()),
        effort: Some("high".to_owned()),
        interaction_mode: None,
    })
}

async fn next_codex_event_matching(
    runtime: &CodexSessionRuntime,
    predicate: impl Fn(&RuntimeEvent) -> bool,
) -> RuntimeEvent {
    loop {
        let event = timeout(Duration::from_secs(5), runtime.next_event())
            .await
            .expect("Codex event timeout")
            .expect("Codex event");
        if predicate(&event) {
            return event;
        }
    }
}

fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(fixture_directory().join(name)).expect("fixture file"),
    )
    .expect("valid fixture json")
}

fn stable_fixture(name: &str) -> Vec<RuntimeEventStableView> {
    serde_json::from_value(fixture(name)).expect("stable trace fixture")
}

fn fixture_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/codex-provider")
}

fn scripted_peer() -> (
    JsonRpcConnection,
    mpsc::UnboundedReceiver<IncomingEvent>,
    ScriptedPeer,
) {
    let (runtime_stdout, peer_stdout) = duplex(16 * 1024);
    let (peer_stdin, runtime_stdin) = duplex(16 * 1024);
    let (peer_stderr, runtime_stderr) = duplex(16 * 1024);
    let (connection, incoming) = JsonRpcConnection::spawn(
        runtime_stdout,
        runtime_stdin,
        runtime_stderr,
        ConnectionConfig::default(),
    );
    (
        connection,
        incoming,
        ScriptedPeer::new(peer_stdout, peer_stdin, peer_stderr),
    )
}

struct ScriptedPeer {
    stdout: tokio::io::DuplexStream,
    stdin: tokio::io::DuplexStream,
    stderr: tokio::io::DuplexStream,
    steps: Vec<PeerStep>,
}

impl ScriptedPeer {
    fn new(
        stdout: tokio::io::DuplexStream,
        stdin: tokio::io::DuplexStream,
        stderr: tokio::io::DuplexStream,
    ) -> Self {
        Self {
            stdout,
            stdin,
            stderr,
            steps: Vec::new(),
        }
    }

    fn expect_request(&mut self, method: &str, params: Value) -> &mut PeerStep {
        self.steps.push(PeerStep::ExpectRequest {
            method: method.to_owned(),
            params,
            response: None,
            response_error: None,
            emits: Vec::new(),
            expected_follow_up_response: None,
            stderr_messages: Vec::new(),
        });
        self.steps.last_mut().expect("request step")
    }

    fn expect_notification(&mut self, method: &str) {
        self.steps.push(PeerStep::ExpectNotification {
            method: method.to_owned(),
        });
    }

    async fn run(self) {
        let mut reader = BufReader::new(self.stdin);
        let mut writer = self.stdout;
        let mut stderr = self.stderr;
        for step in self.steps {
            match step {
                PeerStep::ExpectRequest {
                    method,
                    params,
                    response,
                    response_error,
                    emits,
                    expected_follow_up_response,
                    stderr_messages,
                } => {
                    let message = read_json_message(&mut reader).await;
                    assert_eq!(message["method"], method);
                    assert_eq!(message["params"], params);
                    for message in stderr_messages {
                        write_line(&mut stderr, &message).await;
                    }
                    if let Some(result) = response {
                        write_json(
                            &mut writer,
                            json!({
                                "id": message["id"].clone(),
                                "result": result,
                            }),
                        )
                        .await;
                    } else if let Some(error) = response_error {
                        write_json(
                            &mut writer,
                            json!({
                                "id": message["id"].clone(),
                                "error": error,
                            }),
                        )
                        .await;
                    }
                    let mut expected_follow_up_response = expected_follow_up_response;
                    for emit in emits {
                        let requires_response =
                            emit.get("id").is_some() && emit.get("method").is_some();
                        write_json(&mut writer, emit).await;
                        if requires_response
                            && let Some(expected_response) = expected_follow_up_response.take()
                        {
                            let follow_up = read_json_message(&mut reader).await;
                            assert_eq!(follow_up, expected_response);
                        }
                    }
                    if let Some(expected_response) = expected_follow_up_response {
                        let follow_up = read_json_message(&mut reader).await;
                        assert_eq!(follow_up, expected_response);
                    }
                }
                PeerStep::ExpectNotification { method } => {
                    let message = read_json_message(&mut reader).await;
                    assert_eq!(message["method"], method);
                    assert!(message.get("id").is_none());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

enum PeerStep {
    ExpectRequest {
        method: String,
        params: Value,
        response: Option<Value>,
        response_error: Option<Value>,
        emits: Vec<Value>,
        expected_follow_up_response: Option<Value>,
        stderr_messages: Vec<String>,
    },
    ExpectNotification {
        method: String,
    },
}

impl PeerStep {
    fn respond(&mut self, result: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { response, .. } = self {
            *response = Some(result);
        }
        self
    }

    fn respond_error(&mut self, error: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { response_error, .. } = self {
            *response_error = Some(error);
        }
        self
    }

    fn emit_notification(&mut self, notification: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { emits, .. } = self {
            emits.push(notification);
        }
        self
    }

    fn emit_request(&mut self, request: Value) -> &mut Self {
        if let PeerStep::ExpectRequest { emits, .. } = self {
            emits.push(request);
        }
        self
    }

    fn expect_response(&mut self, response: Value) -> &mut Self {
        if let PeerStep::ExpectRequest {
            expected_follow_up_response,
            ..
        } = self
        {
            *expected_follow_up_response = Some(response);
        }
        self
    }

    fn emit_stderr(&mut self, message: &str) -> &mut Self {
        if let PeerStep::ExpectRequest {
            stderr_messages, ..
        } = self
        {
            stderr_messages.push(message.to_owned());
        }
        self
    }
}

async fn read_json_message<R>(reader: &mut BufReader<R>) -> Value
where
    R: AsyncRead + Unpin,
{
    let line = timeout(Duration::from_secs(2), async {
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await.expect("read line");
        buffer
    })
    .await
    .expect("message timeout");
    serde_json::from_str(line.trim_end()).expect("valid json line")
}

async fn write_json<W>(writer: &mut W, value: Value)
where
    W: AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    writer
        .write_all(format!("{value}\n").as_bytes())
        .await
        .expect("write json");
    writer.flush().await.expect("flush json");
}

async fn write_line<W>(writer: &mut W, value: &str)
where
    W: AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    writer
        .write_all(format!("{value}\n").as_bytes())
        .await
        .expect("write line");
    writer.flush().await.expect("flush line");
}
