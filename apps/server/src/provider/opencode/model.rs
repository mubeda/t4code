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
    custom_models: &[String],
) -> OpenCodeInventorySnapshot {
    let connected = provider_list
        .get("connected")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut models = Vec::new();
    if let Some(all) = provider_list.get("all").and_then(Value::as_array) {
        for provider in all {
            let provider_id = provider
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
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
                        capabilities: json!({
                            "optionDescriptors": [
                                {
                                    "id": "agent",
                                    "label": "Agent",
                                    "type": "select",
                                    "options": agents.get(0).map(|agent| json!([{
                                        "id": agent.get("name").and_then(Value::as_str).unwrap_or("build"),
                                        "label": agent.get("name").and_then(Value::as_str).unwrap_or("build"),
                                        "isDefault": true
                                    }])).unwrap_or_else(|| json!([]))
                                },
                                {
                                    "id": "variant",
                                    "label": "Variant",
                                    "type": "select",
                                    "options": variant_options(model.get("variants")),
                                }
                            ]
                        }),
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
    }
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

fn variant_options(variants: Option<&Value>) -> Value {
    let Some(variants) = variants.and_then(Value::as_object) else {
        return json!([]);
    };
    let mut options = Vec::new();
    for key in variants.keys() {
        options.push(json!({
            "id": key,
            "label": key,
            "isDefault": key == "medium",
        }));
    }
    Value::Array(options)
}
