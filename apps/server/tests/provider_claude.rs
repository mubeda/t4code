use t4code_server::provider::claude;

use std::{fs, path::PathBuf};

use claude::{
    canonical::{CanonicalEvent, CanonicalEventTrace},
    protocol::{AssistantMessage, ClaudeMessage},
    runtime::{
        ClaudeControlRequest, ClaudeProviderRuntime, Decision, LaunchRequestInput,
        PermissionRequestInput, ReconnectSnapshot, RuntimeMode, TurnInput, UserInputRequestInput,
    },
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("claude-provider")
}

fn load_fixture<T: DeserializeOwned>(name: &str) -> T {
    let path = fixture_dir().join(name);
    let text = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("failed to read fixture {}: {error}", path.display());
    });
    serde_json::from_str(&text).unwrap_or_else(|error| {
        panic!("failed to decode fixture {}: {error}", path.display());
    })
}

fn assert_trace_eq(actual: &[CanonicalEvent], expected: &[CanonicalEventTrace]) {
    let actual_trace = actual
        .iter()
        .map(CanonicalEventTrace::from)
        .collect::<Vec<_>>();
    assert_eq!(actual_trace, expected);
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchFixture {
    thread_id: String,
    runtime_mode: RuntimeMode,
    cwd: Option<String>,
    claude_path: String,
    resume_session_id: Option<String>,
    new_session_id: Option<String>,
    expected: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlFixture {
    interrupt: Value,
    set_permission_mode: Value,
    cancel_tool_call: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupFixture {
    session_id: String,
    runtime_mode: RuntimeMode,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceFixture {
    thread_id: String,
    turn_id: String,
    startup: StartupFixture,
    messages: Vec<ClaudeMessage>,
    expected_events: Vec<CanonicalEventTrace>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionFixture {
    thread_id: String,
    turn_id: String,
    startup: StartupFixture,
    message: ClaudeMessage,
    request: PermissionRequestInput,
    resolution: PermissionResolutionFixture,
    expected_events: Vec<CanonicalEventTrace>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionResolutionFixture {
    decision: Decision,
    request_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInputFixture {
    thread_id: String,
    turn_id: String,
    startup: StartupFixture,
    message: ClaudeMessage,
    request: UserInputRequestInput,
    resolution: UserInputResolutionFixture,
    expected_events: Vec<CanonicalEventTrace>,
    expected_updated_input: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInputResolutionFixture {
    request_id: String,
    answers: Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitPlanFixture {
    thread_id: String,
    turn_id: String,
    startup: StartupFixture,
    message: AssistantMessage,
    expected_event: CanonicalEventTrace,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamInterruptFixture {
    thread_id: String,
    turn_id: String,
    startup: StartupFixture,
    error: String,
    expected_events: Vec<CanonicalEventTrace>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReconnectFixture {
    thread_id: String,
    session_id: String,
    turn_id: String,
    runtime_mode: RuntimeMode,
    pending_approval: Value,
    pending_user_input: Value,
}

#[test]
fn launch_request_maps_runtime_modes_to_direct_cli_protocol_options() {
    let full_access: LaunchFixture = load_fixture("launch-full-access.json");
    let request = ClaudeProviderRuntime::build_launch_request(LaunchRequestInput {
        thread_id: full_access.thread_id,
        runtime_mode: full_access.runtime_mode,
        cwd: full_access.cwd,
        claude_path: full_access.claude_path,
        resume_session_id: full_access.resume_session_id,
        new_session_id: full_access.new_session_id,
    });
    assert_eq!(
        serde_json::to_value(request).expect("launch request json"),
        full_access.expected
    );

    let plan_mode: LaunchFixture = load_fixture("launch-plan-mode.json");
    let request = ClaudeProviderRuntime::build_launch_request(LaunchRequestInput {
        thread_id: plan_mode.thread_id,
        runtime_mode: plan_mode.runtime_mode,
        cwd: plan_mode.cwd,
        claude_path: plan_mode.claude_path,
        resume_session_id: plan_mode.resume_session_id,
        new_session_id: plan_mode.new_session_id,
    });
    assert_eq!(
        serde_json::to_value(request).expect("launch request json"),
        plan_mode.expected
    );
}

#[test]
fn control_requests_encode_interrupt_permission_mode_and_cancel_frames() {
    let fixture: ControlFixture = load_fixture("control-requests.json");
    assert_eq!(
        serde_json::to_value(ClaudeControlRequest::interrupt(17)).expect("interrupt json"),
        fixture.interrupt
    );
    assert_eq!(
        serde_json::to_value(ClaudeControlRequest::set_permission_mode(
            18,
            RuntimeMode::AutoAcceptEdits.permission_mode()
        ))
        .expect("permission mode json"),
        fixture.set_permission_mode
    );
    assert_eq!(
        serde_json::to_value(ClaudeControlRequest::cancel_request(19, "approval:1001"))
            .expect("cancel json"),
        fixture.cancel_tool_call
    );
}

#[test]
fn fixture_tool_streams_decode_to_canonical_events() {
    let fixture: TraceFixture = load_fixture("trace-tool-streams.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    let mut events = runtime.start_session(fixture.startup.runtime_mode, None);
    events.extend(runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "search the repo".to_owned(),
    }));
    for message in fixture.messages {
        events.extend(runtime.handle_message(message));
    }
    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn todo_write_streams_emit_plan_updates() {
    let fixture: TraceFixture = load_fixture("trace-todo-plan.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    let mut events = runtime.start_session(fixture.startup.runtime_mode, None);
    events.extend(runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "make a plan".to_owned(),
    }));
    for message in fixture.messages {
        events.extend(runtime.handle_message(message));
    }
    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn task_tool_is_classified_as_collaboration_work() {
    let fixture: TraceFixture = load_fixture("trace-task-tool.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    let mut events = runtime.start_session(fixture.startup.runtime_mode, None);
    events.extend(runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "delegate this".to_owned(),
    }));
    for message in fixture.messages {
        events.extend(runtime.handle_message(message));
    }
    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn aborted_results_map_to_interrupted_turn_completion() {
    let fixture: TraceFixture = load_fixture("trace-abort-result.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    let mut events = runtime.start_session(fixture.startup.runtime_mode, None);
    events.extend(runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "hello".to_owned(),
    }));
    for message in fixture.messages {
        events.extend(runtime.handle_message(message));
    }
    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn permission_requests_round_trip_through_open_and_resolved_events() {
    let fixture: PermissionFixture = load_fixture("permission-flow.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    runtime.start_session(fixture.startup.runtime_mode, None);
    runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id.clone(),
        input: "approve a command".to_owned(),
    });

    let mut events = runtime.handle_message(fixture.message);
    let request_event =
        runtime.open_permission_request(fixture.request, &fixture.resolution.request_id);
    events.extend(request_event);
    events.extend(
        runtime.resolve_permission_request(
            &fixture.resolution.request_id,
            fixture.resolution.decision,
        ),
    );

    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn ask_user_question_round_trips_structured_answers() {
    let fixture: UserInputFixture = load_fixture("user-input-flow.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    runtime.start_session(fixture.startup.runtime_mode, None);
    runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id.clone(),
        input: "question turn".to_owned(),
    });

    let mut events = runtime.handle_message(fixture.message);
    let opened = runtime.open_user_input_request(fixture.request, &fixture.resolution.request_id);
    events.extend(opened);
    let resolved = runtime.resolve_user_input_request(
        &fixture.resolution.request_id,
        fixture.resolution.answers.clone(),
    );
    assert_eq!(resolved.updated_input, fixture.expected_updated_input);
    events.extend(resolved.events);

    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn assistant_exit_plan_snapshots_emit_proposed_plan_completion() {
    let fixture: ExitPlanFixture = load_fixture("exit-plan-message.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    runtime.start_session(fixture.startup.runtime_mode, None);
    runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "make a plan".to_owned(),
    });

    let event = runtime
        .handle_assistant_message(fixture.message)
        .into_iter()
        .find(|event| event.event_type == "turn.proposed.completed")
        .expect("turn.proposed.completed event");
    assert_eq!(CanonicalEventTrace::from(&event), fixture.expected_event);
}

#[test]
fn stream_interrupts_teardown_the_session_structurally() {
    let fixture: StreamInterruptFixture = load_fixture("stream-interrupt.json");
    let mut runtime = ClaudeProviderRuntime::new(fixture.thread_id, fixture.startup.session_id);
    let mut events = runtime.start_session(fixture.startup.runtime_mode, None);
    events.extend(runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id,
        input: "hello".to_owned(),
    }));
    events.extend(runtime.handle_stream_failure(&fixture.error));
    assert_trace_eq(&events, &fixture.expected_events);
}

#[test]
fn reconnect_snapshots_preserve_pending_requests_and_user_dialogs() {
    let fixture: ReconnectFixture = load_fixture("reconnect-state.json");
    let mut runtime =
        ClaudeProviderRuntime::new(fixture.thread_id.clone(), fixture.session_id.clone());
    runtime.start_session(fixture.runtime_mode, None);
    runtime.start_turn(TurnInput {
        turn_id: fixture.turn_id.clone(),
        input: "resume this".to_owned(),
    });
    runtime.restore_from_snapshot(ReconnectSnapshot {
        session_id: fixture.session_id.clone(),
        thread_id: fixture.thread_id.clone(),
        turn_id: Some(fixture.turn_id.clone()),
        runtime_mode: fixture.runtime_mode,
        pending_approvals: vec![fixture.pending_approval.clone()],
        pending_user_inputs: vec![fixture.pending_user_input.clone()],
    });

    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.session_id, fixture.session_id);
    assert_eq!(snapshot.thread_id, fixture.thread_id);
    assert_eq!(snapshot.turn_id, Some(fixture.turn_id));
    assert_eq!(snapshot.pending_approvals, vec![fixture.pending_approval]);
    assert_eq!(
        snapshot.pending_user_inputs,
        vec![fixture.pending_user_input]
    );
    assert_eq!(
        serde_json::to_value(snapshot.runtime_mode).expect("runtime mode"),
        json!("approval-required")
    );
}
