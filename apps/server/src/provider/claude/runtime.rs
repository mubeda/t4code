use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::canonical::CanonicalEvent;
use super::protocol::{
    AssistantContent, AssistantMessage, ClaudeMessage, ContentBlock, ContentBlockDelta,
    ResultMessage, StreamEvent, UserContent,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    FullAccess,
    ApprovalRequired,
    AutoAcceptEdits,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
}

impl RuntimeMode {
    pub fn permission_mode(self) -> ClaudePermissionMode {
        match self {
            Self::FullAccess => ClaudePermissionMode::BypassPermissions,
            Self::ApprovalRequired => ClaudePermissionMode::Default,
            Self::AutoAcceptEdits => ClaudePermissionMode::AcceptEdits,
            Self::Plan => ClaudePermissionMode::Plan,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequestInput {
    pub thread_id: String,
    pub runtime_mode: RuntimeMode,
    pub cwd: Option<String>,
    pub claude_path: String,
    pub resume_session_id: Option<String>,
    pub new_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub permission_mode: ClaudePermissionMode,
    pub allow_dangerously_skip_permissions: bool,
    pub include_partial_messages: bool,
    pub additional_directories: Vec<String>,
    pub resume: Option<String>,
    pub session_id: Option<String>,
    pub executable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeControlRequest {
    pub sequence: u64,
    pub request: ControlRequestBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequestBody {
    Interrupt,
    SetPermissionMode { mode: ClaudePermissionMode },
    CancelRequest { request_id: String },
}

impl ClaudeControlRequest {
    pub fn interrupt(sequence: u64) -> Self {
        Self {
            sequence,
            request: ControlRequestBody::Interrupt,
        }
    }

    pub fn set_permission_mode(sequence: u64, mode: ClaudePermissionMode) -> Self {
        Self {
            sequence,
            request: ControlRequestBody::SetPermissionMode { mode },
        }
    }

    pub fn cancel_request(sequence: u64, request_id: &str) -> Self {
        Self {
            sequence,
            request: ControlRequestBody::CancelRequest {
                request_id: request_id.to_owned(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Accept,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnInput {
    pub turn_id: String,
    pub input: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestInput {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
    #[serde(default)]
    pub suggestions: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequestInput {
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedUserInput {
    pub updated_input: Value,
    pub events: Vec<CanonicalEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectSnapshot {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub runtime_mode: RuntimeMode,
    #[serde(default)]
    pub pending_approvals: Vec<Value>,
    #[serde(default)]
    pub pending_user_inputs: Vec<Value>,
}

#[derive(Debug, Clone)]
struct InFlightTool {
    index: u64,
    tool_use_id: String,
    tool_name: String,
    input: Value,
    result: Option<Value>,
    stopped: bool,
    completed: bool,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    provider_item_id: String,
    raw: Value,
}

#[derive(Debug, Clone)]
struct PendingUserInput {
    provider_item_id: String,
    original_input: Value,
    raw: Value,
}

#[derive(Debug, Clone)]
pub struct ClaudeProviderRuntime {
    thread_id: String,
    session_id: String,
    runtime_mode: Option<RuntimeMode>,
    current_turn_id: Option<String>,
    pending_approvals: BTreeMap<String, PendingApproval>,
    pending_user_inputs: BTreeMap<String, PendingUserInput>,
    in_flight_tools: BTreeMap<String, InFlightTool>,
}

impl ClaudeProviderRuntime {
    pub fn new(thread_id: String, session_id: String) -> Self {
        Self {
            thread_id,
            session_id,
            runtime_mode: None,
            current_turn_id: None,
            pending_approvals: BTreeMap::new(),
            pending_user_inputs: BTreeMap::new(),
            in_flight_tools: BTreeMap::new(),
        }
    }

    pub fn build_launch_request(input: LaunchRequestInput) -> LaunchRequest {
        let permission_mode = input.runtime_mode.permission_mode();
        LaunchRequest {
            permission_mode,
            allow_dangerously_skip_permissions: permission_mode
                == ClaudePermissionMode::BypassPermissions,
            include_partial_messages: true,
            additional_directories: input.cwd.into_iter().collect(),
            resume: input.resume_session_id,
            session_id: input.new_session_id,
            executable: input.claude_path,
        }
    }

    pub fn start_session(
        &mut self,
        runtime_mode: RuntimeMode,
        cwd: Option<String>,
    ) -> Vec<CanonicalEvent> {
        self.runtime_mode = Some(runtime_mode);
        vec![
            self.event(
                "session.started",
                None,
                None,
                None,
                json!({
                    "message": "Claude session started.",
                    "resume": { "sessionId": self.session_id },
                }),
            ),
            self.event(
                "session.configured",
                None,
                None,
                None,
                json!({
                    "permissionMode": runtime_mode.permission_mode(),
                    "cwd": cwd,
                }),
            ),
            self.event(
                "session.state.changed",
                None,
                None,
                None,
                json!({ "state": "ready" }),
            ),
        ]
    }

    pub fn start_turn(&mut self, input: TurnInput) -> Vec<CanonicalEvent> {
        self.current_turn_id = Some(input.turn_id.clone());
        vec![self.event(
            "turn.started",
            Some(input.turn_id),
            None,
            None,
            json!({ "input": input.input }),
        )]
    }

    pub fn handle_message(&mut self, message: ClaudeMessage) -> Vec<CanonicalEvent> {
        match message {
            ClaudeMessage::StreamEvent(message) => self.handle_stream_event(message.event),
            ClaudeMessage::User(message) => self.handle_user_message(message.message.content),
            ClaudeMessage::Assistant(message) => self.handle_assistant_message(message),
            ClaudeMessage::Result(message) => self.handle_result_message(message),
        }
    }

    pub fn handle_assistant_message(&mut self, message: AssistantMessage) -> Vec<CanonicalEvent> {
        let mut events = Vec::new();
        for content in message.message.content {
            if let AssistantContent::ToolUse { id, name, input } = content
                && name == "ExitPlanMode"
                && let Some(plan_markdown) = input
                    .get("plan")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            {
                events.push(self.event(
                    "turn.proposed.completed",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": id })),
                    json!({ "planMarkdown": plan_markdown }),
                ));
            }
        }
        events
    }

    pub fn open_permission_request(
        &mut self,
        input: PermissionRequestInput,
        request_id: &str,
    ) -> Vec<CanonicalEvent> {
        let provider_item_id = input.tool_use_id.clone();
        let tool_name = input.tool_name.clone();
        let tool_input = input.input.clone();
        let suggestions = input.suggestions.clone();
        self.pending_approvals.insert(
            request_id.to_owned(),
            PendingApproval {
                provider_item_id: provider_item_id.clone(),
                raw: json!({
                    "requestId": request_id,
                    "providerItemId": provider_item_id,
                    "toolName": tool_name,
                    "input": tool_input,
                    "suggestions": suggestions,
                }),
            },
        );
        vec![self.event(
            "request.opened",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": input.tool_use_id })),
            json!({
                "requestType": classify_request_type(&input.tool_name),
                "toolName": input.tool_name,
                "input": input.input,
                "suggestions": input.suggestions,
            }),
        )]
    }

    pub fn resolve_permission_request(
        &mut self,
        request_id: &str,
        decision: Decision,
    ) -> Vec<CanonicalEvent> {
        let Some(pending) = self.pending_approvals.remove(request_id) else {
            return Vec::new();
        };
        vec![self.event(
            "request.resolved",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": pending.provider_item_id })),
            json!({ "decision": decision }),
        )]
    }

    pub fn open_user_input_request(
        &mut self,
        input: UserInputRequestInput,
        request_id: &str,
    ) -> Vec<CanonicalEvent> {
        let questions = normalize_questions(&input.input);
        let provider_item_id = input.tool_use_id.clone();
        self.pending_user_inputs.insert(
            request_id.to_owned(),
            PendingUserInput {
                provider_item_id: provider_item_id.clone(),
                original_input: input.input.clone(),
                raw: json!({
                    "requestId": request_id,
                    "providerItemId": provider_item_id,
                    "questions": questions.clone(),
                }),
            },
        );
        vec![self.event(
            "user-input.requested",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": input.tool_use_id })),
            json!({ "questions": questions }),
        )]
    }

    pub fn resolve_user_input_request(
        &mut self,
        request_id: &str,
        answers: Value,
    ) -> ResolvedUserInput {
        let pending = self
            .pending_user_inputs
            .remove(request_id)
            .expect("pending user input request");
        let updated_input = json!({
            "questions": pending
                .original_input
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([])),
            "answers": answers.clone(),
        });
        let events = vec![self.event(
            "user-input.resolved",
            self.current_turn_id.clone(),
            Some(request_id.to_owned()),
            Some(json!({ "providerItemId": pending.provider_item_id })),
            json!({ "answers": answers }),
        )];
        ResolvedUserInput {
            updated_input,
            events,
        }
    }

    pub fn handle_stream_failure(&mut self, error: &str) -> Vec<CanonicalEvent> {
        let error_message = if is_interrupted_error(error) {
            "Claude runtime interrupted.".to_owned()
        } else {
            error.to_owned()
        };
        vec![
            self.event(
                "turn.completed",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "state": "interrupted",
                    "errorMessage": error_message,
                }),
            ),
            self.event(
                "session.exited",
                None,
                None,
                None,
                json!({ "reason": "stream_failure" }),
            ),
        ]
    }

    pub fn snapshot(&self) -> ReconnectSnapshot {
        ReconnectSnapshot {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.current_turn_id.clone(),
            runtime_mode: self.runtime_mode.unwrap_or(RuntimeMode::ApprovalRequired),
            pending_approvals: self
                .pending_approvals
                .values()
                .map(|pending| pending.raw.clone())
                .collect(),
            pending_user_inputs: self
                .pending_user_inputs
                .values()
                .map(|pending| pending.raw.clone())
                .collect(),
        }
    }

    pub fn restore_from_snapshot(&mut self, snapshot: ReconnectSnapshot) {
        self.session_id = snapshot.session_id;
        self.thread_id = snapshot.thread_id;
        self.current_turn_id = snapshot.turn_id;
        self.runtime_mode = Some(snapshot.runtime_mode);
        self.pending_approvals = snapshot
            .pending_approvals
            .into_iter()
            .filter_map(|value| {
                let request_id = value.get("requestId")?.as_str()?.to_owned();
                let provider_item_id = value.get("providerItemId")?.as_str()?.to_owned();
                Some((
                    request_id,
                    PendingApproval {
                        provider_item_id,
                        raw: value,
                    },
                ))
            })
            .collect();
        self.pending_user_inputs = snapshot
            .pending_user_inputs
            .into_iter()
            .filter_map(|value| {
                let request_id = value.get("requestId")?.as_str()?.to_owned();
                let provider_item_id = value.get("providerItemId")?.as_str()?.to_owned();
                Some((
                    request_id,
                    PendingUserInput {
                        provider_item_id,
                        original_input: json!({
                            "questions": value.get("questions").cloned().unwrap_or_else(|| json!([])),
                        }),
                        raw: value,
                    },
                ))
            })
            .collect();
    }

    fn handle_stream_event(&mut self, event: StreamEvent) -> Vec<CanonicalEvent> {
        match event {
            StreamEvent::MessageStart { message } => vec![self.event(
                "thread.started",
                self.current_turn_id.clone(),
                None,
                None,
                json!({ "providerThreadId": message.id }),
            )],
            StreamEvent::ContentBlockStart {
                index,
                content_block: ContentBlock::ToolUse { id, name, input },
            } => {
                self.in_flight_tools.insert(
                    id.clone(),
                    InFlightTool {
                        index,
                        tool_use_id: id.clone(),
                        tool_name: name.clone(),
                        input: input.clone(),
                        result: None,
                        stopped: false,
                        completed: false,
                    },
                );
                vec![self.event(
                    "item.started",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": id })),
                    json!({
                        "itemType": classify_item_type(&name),
                        "title": classify_title(&name),
                        "data": {
                            "toolName": name,
                            "input": input,
                        },
                    }),
                )]
            }
            StreamEvent::ContentBlockDelta {
                index: _,
                delta: ContentBlockDelta::ThinkingDelta { thinking },
            } => vec![self.event(
                "content.delta",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "streamKind": "reasoning_text",
                    "delta": thinking,
                }),
            )],
            StreamEvent::ContentBlockDelta {
                index: _,
                delta: ContentBlockDelta::TextDelta { text },
            } => vec![self.event(
                "content.delta",
                self.current_turn_id.clone(),
                None,
                None,
                json!({
                    "streamKind": "assistant_text",
                    "delta": text,
                }),
            )],
            StreamEvent::ContentBlockDelta {
                index,
                delta: ContentBlockDelta::InputJsonDelta { partial_json },
            } => {
                let Some((tool_use_id, tool_name, parsed_input, plan)) =
                    self.update_tool_input(index, &partial_json)
                else {
                    return Vec::new();
                };
                let mut events = vec![self.event(
                    "item.updated",
                    self.current_turn_id.clone(),
                    None,
                    Some(json!({ "providerItemId": tool_use_id })),
                    json!({
                        "data": {
                            "toolName": tool_name,
                            "input": parsed_input,
                        },
                    }),
                )];
                if let Some(plan) = plan {
                    events.push(self.event(
                        "turn.plan.updated",
                        self.current_turn_id.clone(),
                        None,
                        None,
                        json!({ "plan": plan }),
                    ));
                }
                events
            }
            StreamEvent::ContentBlockStop { index } => {
                if let Some(tool) = self.find_tool_by_index_mut(index) {
                    tool.stopped = true;
                }
                Vec::new()
            }
        }
    }

    fn handle_user_message(&mut self, contents: Vec<UserContent>) -> Vec<CanonicalEvent> {
        let mut events = Vec::new();
        for content in contents {
            match content {
                UserContent::ToolResult {
                    tool_use_id,
                    content,
                } => {
                    let Some((provider_item_id, result, should_complete)) =
                        self.apply_tool_result(&tool_use_id, content)
                    else {
                        continue;
                    };
                    events.push(self.event(
                        "item.updated",
                        self.current_turn_id.clone(),
                        None,
                        Some(json!({ "providerItemId": provider_item_id.clone() })),
                        json!({ "data": result }),
                    ));
                    if should_complete
                        && let Some(event) = self.complete_tool_by_id(&provider_item_id)
                    {
                        events.push(event);
                    }
                }
            }
        }
        events
    }

    fn handle_result_message(&mut self, message: ResultMessage) -> Vec<CanonicalEvent> {
        let mut events = self.flush_incomplete_tools();
        let interrupted = is_interrupted_result(&message);
        let stop_reason = message.stop_reason.unwrap_or_else(|| {
            if interrupted {
                "interrupted".to_owned()
            } else {
                "success".to_owned()
            }
        });
        let mut payload = json!({
            "state": if interrupted { "interrupted" } else { "completed" },
            "stopReason": stop_reason,
        });
        if interrupted {
            let error_message = message
                .errors
                .first()
                .cloned()
                .unwrap_or_else(|| "Claude runtime interrupted.".to_owned());
            payload["errorMessage"] = json!(error_message);
        }
        events.push(self.event(
            "turn.completed",
            self.current_turn_id.clone(),
            None,
            None,
            payload,
        ));
        events
    }

    fn flush_incomplete_tools(&mut self) -> Vec<CanonicalEvent> {
        let pending_ids = self
            .in_flight_tools
            .iter()
            .filter_map(|(tool_id, tool)| (!tool.completed).then_some(tool_id.clone()))
            .collect::<Vec<_>>();
        pending_ids
            .into_iter()
            .filter_map(|tool_id| self.complete_tool_by_id(&tool_id))
            .collect()
    }

    fn complete_tool_by_id(&mut self, tool_id: &str) -> Option<CanonicalEvent> {
        let turn_id = self.current_turn_id.clone();
        let (provider_item_id, data) = {
            let tool = self.in_flight_tools.get_mut(tool_id)?;
            tool.completed = true;
            let mut data = json!({
                "toolName": tool.tool_name,
                "input": tool.input,
            });
            if let Some(result) = &tool.result {
                data["result"] = result.clone();
            }
            (tool.tool_use_id.clone(), data)
        };
        Some(self.event(
            "item.completed",
            turn_id,
            None,
            Some(json!({ "providerItemId": provider_item_id })),
            json!({ "data": data }),
        ))
    }

    fn update_tool_input(
        &mut self,
        index: u64,
        partial_json: &str,
    ) -> Option<(String, String, Value, Option<Vec<Value>>)> {
        let parsed_input = serde_json::from_str::<Value>(partial_json).unwrap_or_else(|_| {
            json!({
                "raw": partial_json,
            })
        });
        let tool = self.find_tool_by_index_mut(index)?;
        tool.input = parsed_input.clone();
        let plan = if is_todo_tool(&tool.tool_name) {
            extract_plan_steps(&tool.input)
        } else {
            None
        };
        Some((
            tool.tool_use_id.clone(),
            tool.tool_name.clone(),
            parsed_input,
            plan,
        ))
    }

    fn apply_tool_result(
        &mut self,
        tool_use_id: &str,
        content: Value,
    ) -> Option<(String, Value, bool)> {
        let tool = self.in_flight_tools.get_mut(tool_use_id)?;
        let result = json!({
            "tool_use_id": tool_use_id,
            "content": content,
        });
        tool.result = Some(result.clone());
        Some((
            tool.tool_use_id.clone(),
            result,
            tool.stopped && !tool.completed,
        ))
    }

    fn find_tool_by_index_mut(&mut self, index: u64) -> Option<&mut InFlightTool> {
        self.in_flight_tools
            .values_mut()
            .find(|tool| tool.index == index)
    }

    fn event(
        &self,
        event_type: &str,
        turn_id: Option<String>,
        request_id: Option<String>,
        provider_refs: Option<Value>,
        payload: Value,
    ) -> CanonicalEvent {
        CanonicalEvent {
            event_type: event_type.to_owned(),
            thread_id: self.thread_id.clone(),
            turn_id,
            request_id,
            provider_refs,
            payload,
        }
    }
}

fn classify_request_type(tool_name: &str) -> &'static str {
    let normalized = tool_name.to_ascii_lowercase();
    if normalized.contains("bash") || normalized.contains("command") || normalized.contains("shell")
    {
        return "command_execution_approval";
    }
    if normalized.contains("grep") || normalized.contains("read") {
        return "file_read_approval";
    }
    if normalized.contains("edit") || normalized.contains("write") {
        return "file_change_approval";
    }
    "dynamic_tool_call"
}

fn classify_item_type(tool_name: &str) -> &'static str {
    let normalized = tool_name.to_ascii_lowercase();
    if normalized == "task" || normalized.contains("subagent") {
        return "collab_agent_tool_call";
    }
    if is_todo_tool(tool_name) {
        return "plan";
    }
    "dynamic_tool_call"
}

fn classify_title(tool_name: &str) -> &'static str {
    match classify_item_type(tool_name) {
        "collab_agent_tool_call" => "Subagent task",
        "plan" => "Plan",
        _ => "Tool call",
    }
}

fn is_todo_tool(tool_name: &str) -> bool {
    tool_name.to_ascii_lowercase().contains("todowrite")
}

fn extract_plan_steps(input: &Value) -> Option<Vec<Value>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|todo| {
                let todo = todo.as_object()?;
                let step = todo
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Task");
                let status = match todo.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("in_progress") => "inProgress",
                    _ => "pending",
                };
                Some(json!({
                    "step": step,
                    "status": status,
                }))
            })
            .collect(),
    )
}

fn normalize_questions(input: &Value) -> Vec<Value> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .enumerate()
                .filter_map(|(index, question)| {
                    let question = question.as_object()?;
                    let prompt = question
                        .get("question")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let id = if prompt.is_empty() {
                        format!("q-{index}")
                    } else {
                        prompt.clone()
                    };
                    let header = question
                        .get("header")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("Question {}", index + 1));
                    let options = question
                        .get("options")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    Some(json!({
                        "id": id,
                        "header": header,
                        "question": prompt,
                        "options": options,
                        "multiSelect": question
                            .get("multiSelect")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_interrupted_result(message: &ResultMessage) -> bool {
    message
        .errors
        .iter()
        .any(|error| is_interrupted_error(error))
        || message.subtype == "error_during_execution"
}

fn is_interrupted_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("all fibers interrupted without error")
        || normalized.contains("request was aborted")
        || normalized.contains("interrupted by user")
}
