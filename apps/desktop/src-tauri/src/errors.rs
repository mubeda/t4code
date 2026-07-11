use serde::Serialize;

pub const UNSUPPORTED_CAPABILITY_CODE: &str = "tauri_capability_unsupported";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCommandError {
    pub code: &'static str,
    pub method: &'static str,
    pub capability: &'static str,
    pub message: String,
}

impl BridgeCommandError {
    pub fn unsupported(method: &'static str, capability: &'static str) -> Self {
        Self {
            code: UNSUPPORTED_CAPABILITY_CODE,
            method,
            capability,
            message: format!(
                "{method} requires {capability}, which is not implemented by the Tauri desktop host yet."
            ),
        }
    }
}

impl std::fmt::Display for BridgeCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BridgeCommandError {}
