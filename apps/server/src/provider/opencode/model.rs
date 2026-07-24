use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeProviderModel {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capabilities: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInventorySnapshot {
    pub status: String,
    pub auth: Value,
    pub models: Vec<OpenCodeProviderModel>,
    pub commands: Vec<Value>,
    pub agents: Vec<Value>,
}

pub fn parse_model_slug(slug: &str) -> Option<(String, String)> {
    let (provider, model) = slug.split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_owned(), model.to_owned()))
}

pub fn build_inventory_snapshot(
    provider_list: &Value,
    agents: &Value,
    commands: &Value,
    custom_models: &[String],
) -> OpenCodeInventorySnapshot {
    let connected = provider_list
        .get("connected")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let mut models = Vec::new();
    if let Some(all) = provider_list.get("all").and_then(Value::as_array) {
        for provider in all {
            let provider_id = provider
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !connected.contains(provider_id) {
                continue;
            }
            if let Some(provider_models) = provider.get("models").and_then(Value::as_object) {
                for (model_id, model) in provider_models {
                    models.push(OpenCodeProviderModel {
                        slug: format!("{provider_id}/{model_id}"),
                        name: model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(model_id)
                            .to_owned(),
                        is_custom: false,
                        capabilities: model_capabilities(provider_id, model, agents),
                    });
                }
            }
        }
    }
    for custom in custom_models {
        let trimmed = custom.trim();
        if trimmed.is_empty() || models.iter().any(|model| model.slug == trimmed) {
            continue;
        }
        models.push(OpenCodeProviderModel {
            slug: trimmed.to_owned(),
            name: trimmed.to_owned(),
            is_custom: true,
            capabilities: json!({ "optionDescriptors": [] }),
        });
    }
    OpenCodeInventorySnapshot {
        status: "ready".to_owned(),
        auth: json!({ "status": if connected.is_empty() { "unknown" } else { "authenticated" } }),
        models,
        commands: command_inventory(commands),
        agents: agent_inventory(agents),
    }
}

pub fn command_inventory(commands: &Value) -> Vec<Value> {
    commands
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command
                .get("name")?
                .as_str()?
                .trim()
                .trim_start_matches('/');
            if name.is_empty() {
                return None;
            }
            let mut result = json!({ "name": name });
            if let Some(description) = command
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                result["description"] = json!(description);
            }
            if command
                .get("template")
                .and_then(Value::as_str)
                .is_some_and(|template| template.contains("$ARGUMENTS"))
            {
                result["input"] = json!({ "hint": "arguments" });
            }
            Some(result)
        })
        .collect()
}

fn agent_inventory(agents: &Value) -> Vec<Value> {
    agents
        .as_array()
        .into_iter()
        .flatten()
        .filter(|agent| {
            !agent
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|agent| {
            let name = agent.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let mut result = json!({ "name": name });
            for key in ["description", "model", "mode"] {
                if let Some(value) = agent
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    result[key] = json!(value);
                }
            }
            let mode = agent
                .get("mode")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if matches!(mode, Some("subagent" | "all")) {
                result["invocation"] = json!("mention");
            }
            Some(result)
        })
        .collect()
}

pub fn merge_assistant_text(previous: Option<&str>, next: &str) -> (String, String) {
    let previous = previous.unwrap_or_default();
    if let Some(stripped) = next.strip_prefix(previous) {
        return (next.to_owned(), stripped.to_owned());
    }
    (
        next.to_owned(),
        if previous.is_empty() {
            next.to_owned()
        } else {
            String::new()
        },
    )
}

fn model_capabilities(provider_id: &str, model: &Value, agents: &Value) -> Value {
    let mut descriptors = Vec::new();
    let (variant_options, default_variant) = variant_options(provider_id, model.get("variants"));
    if !variant_options.is_empty() {
        let mut descriptor = json!({
            "id": "variant",
            "label": "Variant",
            "type": "select",
            "options": variant_options,
        });
        if let Some(default_variant) = default_variant {
            descriptor["currentValue"] = Value::String(default_variant);
        }
        descriptors.push(descriptor);
    }

    let (agent_options, default_agent) = eligible_agent_options(agents);
    if !agent_options.is_empty() {
        let mut descriptor = json!({
            "id": "agent",
            "label": "Agent",
            "type": "select",
            "options": agent_options,
        });
        if let Some(default_agent) = default_agent {
            descriptor["currentValue"] = Value::String(default_agent);
        }
        descriptors.push(descriptor);
    }

    json!({ "optionDescriptors": descriptors })
}

fn eligible_agent_options(agents: &Value) -> (Vec<Value>, Option<String>) {
    let eligible = agents
        .as_array()
        .into_iter()
        .flatten()
        .filter(|agent| {
            !agent
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && matches!(
                    agent.get("mode").and_then(Value::as_str),
                    Some("primary" | "all")
                )
        })
        .filter_map(|agent| agent.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let default_agent = eligible
        .iter()
        .find(|name| **name == "build")
        .or_else(|| eligible.first())
        .map(|name| (*name).to_owned());
    let options = eligible
        .into_iter()
        .map(|name| {
            let mut option = json!({
                "id": name,
                "label": title_case_slug(name),
            });
            if default_agent.as_deref() == Some(name) {
                option["isDefault"] = Value::Bool(true);
            }
            option
        })
        .collect();
    (options, default_agent)
}

fn title_case_slug(value: &str) -> String {
    value
        .split(['-', '_', '/'])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn variant_options(provider_id: &str, variants: Option<&Value>) -> (Vec<Value>, Option<String>) {
    let Some(variants) = variants.and_then(Value::as_object) else {
        return (Vec::new(), None);
    };
    let variant_ids = variants.keys().map(String::as_str).collect::<Vec<_>>();
    let default_variant = infer_default_variant(provider_id, &variant_ids);
    let mut options = Vec::with_capacity(variant_ids.len());
    for key in variants.keys() {
        let mut option = json!({
            "id": key,
            "label": title_case_slug(key),
        });
        if default_variant.as_deref() == Some(key) {
            option["isDefault"] = Value::Bool(true);
        }
        options.push(option);
    }
    (options, default_variant)
}

fn infer_default_variant(provider_id: &str, variants: &[&str]) -> Option<String> {
    if variants.len() == 1 {
        return Some(variants[0].to_owned());
    }
    if provider_id == "anthropic" || provider_id.starts_with("google") {
        return variants.contains(&"high").then(|| "high".to_owned());
    }
    if provider_id == "openai" || provider_id == "opencode" {
        return variants
            .contains(&"medium")
            .then(|| "medium".to_owned())
            .or_else(|| variants.contains(&"high").then(|| "high".to_owned()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_inventory_marks_only_visible_subagent_capable_agents_as_mentions() {
        let inventory = agent_inventory(&json!([
            { "name": "plan", "mode": "primary" },
            { "name": "review", "mode": "subagent" },
            { "name": "build", "mode": "all" },
            { "name": "secret", "mode": "subagent", "hidden": true }
        ]));

        assert_eq!(inventory.len(), 3);
        assert!(
            inventory
                .iter()
                .any(|agent| { agent["name"] == "plan" && agent.get("invocation").is_none() })
        );
        assert!(
            inventory
                .iter()
                .any(|agent| { agent["name"] == "review" && agent["invocation"] == "mention" })
        );
        assert!(
            inventory
                .iter()
                .any(|agent| { agent["name"] == "build" && agent["invocation"] == "mention" })
        );
    }

    #[test]
    fn inventory_excludes_models_from_disconnected_providers() {
        let provider_list = json!({
            "connected": ["openai"],
            "all": [
                {
                    "id": "openai",
                    "models": {
                        "gpt-5": { "name": "GPT-5" }
                    }
                },
                {
                    "id": "anthropic",
                    "models": {
                        "claude-sonnet": { "name": "Claude Sonnet" }
                    }
                }
            ]
        });

        let snapshot = build_inventory_snapshot(&provider_list, &json!([]), &json!([]), &[]);
        let slugs = snapshot
            .models
            .iter()
            .map(|model| model.slug.as_str())
            .collect::<Vec<_>>();

        assert_eq!(slugs, vec!["openai/gpt-5"]);
    }

    #[test]
    fn inventory_exposes_all_eligible_primary_agents_with_build_as_current_default() {
        let provider_list = json!({
            "connected": ["openai"],
            "all": [{
                "id": "openai",
                "models": {
                    "gpt-5": { "name": "GPT-5" }
                }
            }]
        });
        let agents = json!([
            { "name": "plan", "hidden": false, "mode": "primary" },
            { "name": "build", "hidden": false, "mode": "all" },
            { "name": "secret", "hidden": true, "mode": "primary" },
            { "name": "explore", "hidden": false, "mode": "subagent" }
        ]);

        let snapshot = build_inventory_snapshot(&provider_list, &agents, &json!([]), &[]);

        assert_eq!(
            snapshot.models[0].capabilities,
            json!({
                "optionDescriptors": [{
                    "id": "agent",
                    "label": "Agent",
                    "type": "select",
                    "options": [
                        { "id": "plan", "label": "Plan" },
                        { "id": "build", "label": "Build", "isDefault": true }
                    ],
                    "currentValue": "build"
                }]
            })
        );
    }

    #[test]
    fn inventory_uses_provider_aware_variant_defaults_and_current_values() {
        let cases = [
            ("anthropic", json!({ "low": {}, "high": {} }), Some("high")),
            (
                "google-vertex",
                json!({ "low": {}, "high": {} }),
                Some("high"),
            ),
            (
                "openai",
                json!({ "high": {}, "medium": {} }),
                Some("medium"),
            ),
            (
                "opencode",
                json!({ "high": {}, "medium": {} }),
                Some("medium"),
            ),
            ("custom", json!({ "turbo": {} }), Some("turbo")),
            ("custom", json!({ "fast": {}, "slow": {} }), None),
        ];

        for (provider_id, variants, expected_default) in cases {
            let capabilities =
                model_capabilities(provider_id, &json!({ "variants": variants }), &json!([]));
            let descriptor = &capabilities["optionDescriptors"][0];
            let actual_default = descriptor["options"]
                .as_array()
                .and_then(|options| {
                    options
                        .iter()
                        .find(|option| option["isDefault"] == Value::Bool(true))
                })
                .and_then(|option| option["id"].as_str());

            assert_eq!(
                descriptor.get("currentValue").and_then(Value::as_str),
                expected_default,
                "unexpected current variant for {provider_id}"
            );
            assert_eq!(
                actual_default, expected_default,
                "unexpected default variant for {provider_id}"
            );
        }
    }
}
