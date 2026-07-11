use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaudeMessage {
    StreamEvent(StreamEventMessage),
    User(UserMessage),
    Assistant(AssistantMessage),
    Result(ResultMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamEventMessage {
    pub session_id: String,
    pub uuid: String,
    pub parent_tool_use_id: Option<String>,
    pub event: StreamEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    MessageStart {
        message: StreamMessageStart,
    },
    ContentBlockStart {
        index: u64,
        content_block: ContentBlock,
    },
    ContentBlockDelta {
        index: u64,
        delta: ContentBlockDelta,
    },
    ContentBlockStop {
        index: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamMessageStart {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlockDelta {
    ThinkingDelta { thinking: String },
    TextDelta { text: String },
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    pub session_id: String,
    pub uuid: String,
    pub parent_tool_use_id: Option<String>,
    pub message: UserPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserPayload {
    pub role: String,
    #[serde(default)]
    pub content: Vec<UserContent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserContent {
    ToolResult { tool_use_id: String, content: Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub session_id: String,
    pub uuid: String,
    pub parent_tool_use_id: Option<String>,
    pub message: AssistantPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantPayload {
    pub id: Option<String>,
    #[serde(default)]
    pub content: Vec<AssistantContent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantContent {
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultMessage {
    pub subtype: String,
    pub is_error: bool,
    #[serde(default)]
    pub errors: Vec<String>,
    pub stop_reason: Option<String>,
    pub session_id: String,
    pub uuid: String,
}
