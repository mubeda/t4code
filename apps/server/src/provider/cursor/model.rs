#![cfg_attr(test, allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAboutResult {
    pub version: Option<String>,
    pub status: String,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderModel {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capabilities: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorProviderSnapshot {
    pub installed: bool,
    pub status: String,
    pub version: Option<String>,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub models: Vec<CursorProviderModel>,
}

pub fn parse_about_output(code: i32, stdout: &str, _stderr: &str) -> CursorAboutResult {
    if code != 0 {
        let version = stdout
            .lines()
            .find_map(|line| line.strip_prefix("grok-cli ").map(str::to_owned));
        return CursorAboutResult {
            version,
            status: "error".to_owned(),
            auth: json!({ "status": "unknown" }),
            message: Some("Cursor Agent is installed but failed to run.".to_owned()),
        };
    }

    if let Ok(value) = serde_json::from_str::<Value>(stdout) {
        let version = value
            .get("cliVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let user_email = value.get("userEmail").and_then(Value::as_str);
        let tier = value
            .get("subscriptionTier")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if matches!(user_email, Some(email) if !email.trim().is_empty() && email != "Not logged in")
        {
            let mut auth = json!({
                "status": "authenticated",
                "email": user_email,
            });
            if let Some(tier) = tier {
                auth["type"] = json!(tier);
            }
            return CursorAboutResult {
                version,
                status: "ready".to_owned(),
                auth,
                message: None,
            };
        }
        return CursorAboutResult {
            version,
            status: "error".to_owned(),
            auth: json!({ "status": "unauthenticated" }),
            message: Some(
                "Cursor Agent is not authenticated. Run `agent login` and try again.".to_owned(),
            ),
        };
    }

    let version = stdout.lines().find_map(|line| {
        line.strip_prefix("CLI Version")
            .map(str::trim)
            .map(str::to_owned)
    });
    let user_email = stdout
        .lines()
        .find_map(|line| line.strip_prefix("User Email").map(str::trim));
    if matches!(user_email, Some(email) if !email.is_empty() && email != "Not logged in") {
        return CursorAboutResult {
            version,
            status: "ready".to_owned(),
            auth: json!({ "status": "authenticated", "email": user_email }),
            message: None,
        };
    }
    CursorAboutResult {
        version,
        status: "error".to_owned(),
        auth: json!({ "status": "unauthenticated" }),
        message: Some(
            "Cursor Agent is not authenticated. Run `agent login` and try again.".to_owned(),
        ),
    }
}

pub fn parse_version_date(version: &str) -> Option<u32> {
    let digits = version
        .split('-')
        .next()
        .unwrap_or(version)
        .split('.')
        .collect::<Vec<_>>();
    if digits.len() != 3 {
        return None;
    }
    Some(
        digits[0].parse::<u32>().ok()? * 10_000
            + digits[1].parse::<u32>().ok()? * 100
            + digits[2].parse::<u32>().ok()?,
    )
}

pub fn parse_cli_config_channel(content: &str) -> Option<String> {
    serde_json::from_str::<Value>(content)
        .ok()?
        .get("channel")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn resolve_acp_base_model_id(model_id: &str) -> String {
    model_id
        .split('[')
        .next()
        .unwrap_or(model_id)
        .trim()
        .to_owned()
}

pub fn build_capabilities_from_config_options(options: &Value) -> Value {
    let Some(options) = options.as_array() else {
        return json!({ "optionDescriptors": [] });
    };
    let mut descriptors = Vec::new();
    let reasoning_source = options
        .iter()
        .find(|option| {
            matches!(
                option.get("category").and_then(Value::as_str),
                Some("model_option")
            ) && option.get("id").and_then(Value::as_str) == Some("effort")
        })
        .or_else(|| {
            options.iter().find(|option| {
                matches!(
                    option.get("category").and_then(Value::as_str),
                    Some("thought_level")
                )
            })
        });
    if let Some(reasoning) = reasoning_source {
        descriptors.push(select_descriptor(
            "reasoning",
            reasoning
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Reasoning"),
            reasoning
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            reasoning.get("currentValue").and_then(Value::as_str),
        ));
    }
    for option in options {
        match (
            option.get("category").and_then(Value::as_str),
            option.get("id").and_then(Value::as_str),
        ) {
            (Some("model_config"), Some("context")) => descriptors.push(select_descriptor(
                "contextWindow",
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Context"),
                option
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                option.get("currentValue").and_then(Value::as_str),
            )),
            (Some("model_config"), Some("fast")) => descriptors.push(boolean_descriptor(
                "fastMode",
                option.get("name").and_then(Value::as_str).unwrap_or("Fast"),
                option.get("currentValue"),
            )),
            (Some("model_config"), Some("thinking")) => descriptors.push(boolean_descriptor(
                "thinking",
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Thinking"),
                option.get("currentValue"),
            )),
            _ => {}
        }
    }
    json!({ "optionDescriptors": descriptors })
}

pub fn resolve_acp_config_updates(options: &Value, updates: &Value) -> Vec<Value> {
    let Some(options) = options.as_array() else {
        return Vec::new();
    };
    let Some(updates) = updates.as_array() else {
        return Vec::new();
    };
    let has_model_option_effort = options.iter().any(|option| {
        option.get("category").and_then(Value::as_str) == Some("model_option")
            && option.get("id").and_then(Value::as_str) == Some("effort")
    });
    let mut resolved = Vec::new();
    for update in updates {
        match update.get("id").and_then(Value::as_str) {
            Some("reasoning") => {
                let config_id = if has_model_option_effort {
                    "effort"
                } else {
                    "reasoning"
                };
                let value = match update.get("value") {
                    Some(Value::String(value)) if value == "xhigh" => json!("extra-high"),
                    Some(value) => value.clone(),
                    None => continue,
                };
                resolved.push(json!({ "configId": config_id, "value": value }));
            }
            Some("contextWindow") => {
                if let Some(value) = update.get("value") {
                    resolved.push(json!({ "configId": "context", "value": value }));
                }
            }
            Some("fastMode") => {
                if let Some(value) = update.get("value").and_then(Value::as_bool) {
                    resolved.push(json!({ "configId": "fast", "value": value.to_string() }));
                }
            }
            Some("thinking") => {
                if let Some(value) = update.get("value") {
                    resolved.push(json!({ "configId": "thinking", "value": value }));
                }
            }
            _ => {}
        }
    }
    resolved
}

pub fn discover_models_from_list_available_models(
    response: &Value,
    custom_models: &[String],
) -> Result<Vec<CursorProviderModel>, String> {
    let models = response
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "cursor/list_available_models response missing models".to_owned())?;
    let mut discovered = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for model in models {
        let slug = model
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| "cursor model missing value".to_owned())?;
        let name = model.get("name").and_then(Value::as_str).unwrap_or(slug);
        discovered.push(CursorProviderModel {
            slug: resolve_acp_base_model_id(slug),
            name: name.to_owned(),
            is_custom: false,
            capabilities: build_capabilities_from_config_options(&json!(
                model
                    .get("configOptions")
                    .cloned()
                    .unwrap_or(Value::Array(Vec::new()))
            )),
        });
        seen.insert(resolve_acp_base_model_id(slug));
    }
    for custom in custom_models {
        let trimmed = custom.trim();
        if trimmed.is_empty() || seen.contains(trimmed) {
            continue;
        }
        discovered.push(CursorProviderModel {
            slug: trimmed.to_owned(),
            name: trimmed.to_owned(),
            is_custom: true,
            capabilities: json!({ "optionDescriptors": [] }),
        });
    }
    Ok(discovered)
}

fn select_descriptor(id: &str, label: &str, options: Vec<Value>, current: Option<&str>) -> Value {
    json!({
        "id": id,
        "label": label,
        "type": "select",
        "options": options.into_iter().map(|option| {
            let value = option.get("value").and_then(Value::as_str).unwrap_or_default();
            let name = option.get("name").and_then(Value::as_str).unwrap_or(value);
            let normalized_id = match value {
                "extra-high" => "xhigh",
                other => other,
            };
            if Some(value) == current {
                json!({ "id": normalized_id, "label": name, "isDefault": true })
            } else {
                json!({ "id": normalized_id, "label": name })
            }
        }).collect::<Vec<_>>(),
    })
}

fn boolean_descriptor(id: &str, label: &str, current: Option<&Value>) -> Value {
    let current_value = match current {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::String(value)) => Some(value == "true"),
        _ => None,
    };
    match current_value {
        Some(value) => json!({
            "id": id,
            "label": label,
            "type": "boolean",
            "currentValue": value,
        }),
        None => json!({
            "id": id,
            "label": label,
            "type": "boolean",
        }),
    }
}
