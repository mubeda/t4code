use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokProviderModel {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capabilities: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokProviderSnapshot {
    pub installed: bool,
    pub status: String,
    pub version: Option<String>,
    pub auth: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub models: Vec<GrokProviderModel>,
}

#[must_use]
pub fn default_models(custom_models: &[String]) -> Vec<GrokProviderModel> {
    let mut models = vec![GrokProviderModel {
        slug: "grok-build".to_owned(),
        name: "Grok Build".to_owned(),
        is_custom: false,
        capabilities: json!({ "optionDescriptors": [] }),
    }];
    append_custom_models(&mut models, custom_models);
    models
}

pub fn build_snapshot_from_probe(
    version_stdout: &str,
    exit_code: i32,
    model_state: &Value,
    custom_models: &[String],
) -> GrokProviderSnapshot {
    let version = version_stdout.split_whitespace().nth(1).map(str::to_owned);
    let mut models = default_models(&[]);
    if let Some(available_models) = model_state.get("availableModels").and_then(Value::as_array) {
        models = available_models
            .iter()
            .filter_map(|model| {
                let model_id = model.get("modelId").and_then(Value::as_str)?;
                Some(GrokProviderModel {
                    slug: model_id.to_owned(),
                    name: model
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(model_id)
                        .to_owned(),
                    is_custom: false,
                    capabilities: json!({ "optionDescriptors": [] }),
                })
            })
            .collect();
    }
    append_custom_models(&mut models, custom_models);
    GrokProviderSnapshot {
        installed: true,
        status: if exit_code == 0 && models.iter().any(|model| model.slug != "grok-build") {
            "ready".to_owned()
        } else {
            "error".to_owned()
        },
        version,
        auth: json!({ "status": "unknown" }),
        message: if exit_code == 0 && models.iter().any(|model| model.slug != "grok-build") {
            None
        } else {
            Some("ACP startup failed".to_owned())
        },
        models,
    }
}

fn append_custom_models(models: &mut Vec<GrokProviderModel>, custom_models: &[String]) {
    for custom in custom_models {
        let trimmed = custom.trim();
        if trimmed.is_empty() || models.iter().any(|model| model.slug == trimmed) {
            continue;
        }
        models.push(GrokProviderModel {
            slug: trimmed.to_owned(),
            name: trimmed.to_owned(),
            is_custom: true,
            capabilities: json!({ "optionDescriptors": [] }),
        });
    }
}
