use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_refs: Option<Value>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEventTrace {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_refs: Option<Value>,
    pub payload: Value,
}

impl From<&CanonicalEvent> for CanonicalEventTrace {
    fn from(value: &CanonicalEvent) -> Self {
        Self {
            event_type: value.event_type.clone(),
            thread_id: value.thread_id.clone(),
            turn_id: value.turn_id.clone(),
            request_id: value.request_id.clone(),
            provider_refs: value.provider_refs.clone(),
            payload: value.payload.clone(),
        }
    }
}
