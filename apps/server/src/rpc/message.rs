use std::{fmt, sync::Arc};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RequestId(Arc<str>);

#[derive(Debug, Error)]
#[error("RPC request id must be a non-empty unsigned decimal string")]
pub struct InvalidRequestId;

impl RequestId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for RequestId {
    type Error = InvalidRequestId;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(InvalidRequestId);
        }
        Ok(Self(Arc::from(value)))
    }
}

impl TryFrom<String> for RequestId {
    type Error = InvalidRequestId;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_from(value.as_str())
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for RequestId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RequestId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum ClientMessage {
    Request {
        id: RequestId,
        tag: String,
        payload: Value,
        headers: Vec<(String, String)>,
        #[serde(rename = "traceId", default, skip_serializing_if = "Option::is_none")]
        trace_id: Option<String>,
        #[serde(rename = "spanId", default, skip_serializing_if = "Option::is_none")]
        span_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sampled: Option<bool>,
    },
    Ack {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Interrupt {
        #[serde(rename = "requestId")]
        request_id: RequestId,
    },
    Eof,
    Ping,
}

impl ClientMessage {
    #[must_use]
    pub fn request_id(&self) -> Option<&RequestId> {
        match self {
            Self::Request { id, .. } => Some(id),
            Self::Ack { request_id } | Self::Interrupt { request_id } => Some(request_id),
            Self::Eof | Self::Ping => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RpcRequest {
    pub id: RequestId,
    pub tag: String,
    pub payload: Value,
    pub headers: Vec<(String, String)>,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub sampled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum RpcExit {
    Success {
        #[serde(default)]
        value: Option<Value>,
    },
    Failure {
        cause: Vec<CauseItem>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum CauseItem {
    Fail {
        error: Value,
    },
    Die {
        defect: Value,
    },
    Interrupt {
        #[serde(rename = "fiberId", default, skip_serializing_if = "Option::is_none")]
        fiber_id: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum ServerMessage {
    Chunk {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        #[serde(deserialize_with = "deserialize_non_empty_values")]
        values: Vec<Value>,
    },
    Exit {
        #[serde(rename = "requestId")]
        request_id: RequestId,
        exit: RpcExit,
    },
    Defect {
        defect: Value,
    },
    Pong,
    ClientProtocolError {
        error: Value,
    },
}

fn deserialize_non_empty_values<'de, D>(deserializer: D) -> Result<Vec<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<Value>::deserialize(deserializer)?;
    if values.is_empty() {
        return Err(de::Error::custom(
            "RPC Chunk values must contain at least one value",
        ));
    }
    Ok(values)
}

impl ServerMessage {
    #[must_use]
    pub fn request_id(&self) -> Option<&RequestId> {
        match self {
            Self::Chunk { request_id, .. } | Self::Exit { request_id, .. } => Some(request_id),
            Self::Defect { .. } | Self::Pong | Self::ClientProtocolError { .. } => None,
        }
    }

    pub(crate) fn success(request_id: RequestId, value: Option<Value>) -> Self {
        Self::Exit {
            request_id,
            exit: RpcExit::Success { value },
        }
    }

    pub(crate) fn failure(request_id: RequestId, error: Value) -> Self {
        Self::Exit {
            request_id,
            exit: RpcExit::Failure {
                cause: vec![CauseItem::Fail { error }],
            },
        }
    }

    pub(crate) fn connection_defect(defect: impl Into<Value>) -> Self {
        Self::Defect {
            defect: defect.into(),
        }
    }

    pub(crate) fn interrupt(request_id: RequestId) -> Self {
        Self::Exit {
            request_id,
            exit: RpcExit::Failure {
                cause: vec![CauseItem::Interrupt { fiber_id: None }],
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum WireMessage {
    Client(ClientMessage),
    Server(ServerMessage),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_success_serializes_an_explicit_null_value() {
        let request_id = RequestId::try_from("1").expect("request id");
        let encoded = serde_json::to_value(ServerMessage::success(request_id, None))
            .expect("serialize stream success");
        let exit = encoded["exit"].as_object().expect("exit object");

        assert_eq!(exit.get("value"), Some(&Value::Null));
    }
}
