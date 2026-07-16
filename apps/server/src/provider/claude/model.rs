use std::collections::HashSet;

use serde_json::{Value, json};

const MINIMUM_FABLE_5_VERSION: [u64; 3] = [2, 1, 169];
const MINIMUM_OPUS_4_8_VERSION: [u64; 3] = [2, 1, 154];
const MINIMUM_OPUS_4_7_VERSION: [u64; 3] = [2, 1, 111];

pub fn all_models(custom_models: &[String]) -> Vec<Value> {
    with_custom_models(built_in_models(), custom_models)
}

pub fn models_for_version(version: &str, custom_models: &[String]) -> Vec<Value> {
    let parsed = semantic_version(version);
    let models = built_in_models()
        .into_iter()
        .filter(|model| match model["slug"].as_str() {
            Some("claude-fable-5") => supports(parsed, MINIMUM_FABLE_5_VERSION),
            Some("claude-opus-4-8") => supports(parsed, MINIMUM_OPUS_4_8_VERSION),
            Some("claude-opus-4-7") => supports(parsed, MINIMUM_OPUS_4_7_VERSION),
            _ => true,
        })
        .collect();
    with_custom_models(models, custom_models)
}

fn supports(version: Option<[u64; 3]>, minimum: [u64; 3]) -> bool {
    version.is_some_and(|version| version >= minimum)
}

fn semantic_version(value: &str) -> Option<[u64; 3]> {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .filter(|candidate| !candidate.is_empty())
        .find_map(|candidate| {
            let mut parts = candidate.split('.');
            let version = [
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
            ];
            parts.next().is_none().then_some(version)
        })
}

fn with_custom_models(mut models: Vec<Value>, custom_models: &[String]) -> Vec<Value> {
    let mut slugs = models
        .iter()
        .filter_map(|model| model["slug"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    for slug in custom_models.iter().map(|slug| slug.trim()) {
        if slug.is_empty() || !slugs.insert(slug.to_owned()) {
            continue;
        }
        models.push(json!({
            "slug": slug,
            "name": slug,
            "isCustom": true,
            "capabilities": { "optionDescriptors": [] },
        }));
    }
    models
}

fn built_in_models() -> Vec<Value> {
    vec![
        model(
            "claude-fable-5",
            "Claude Fable 5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultracode", "Ultracode", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-opus-4-8",
            "Claude Opus 4.8",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultracode", "Ultracode", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-opus-4-7",
            "Claude Opus 4.7",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", false),
                    ("xhigh", "Extra High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-opus-4-6",
            "Claude Opus 4.6",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
                context_window(),
            ],
        ),
        model(
            "claude-opus-4-5",
            "Claude Opus 4.5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                ]),
                boolean_option("fastMode", "Fast Mode"),
            ],
        ),
        model(
            "claude-sonnet-5",
            "Claude Sonnet 5",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("xhigh", "Extra High", false),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            vec![
                effort(&[
                    ("low", "Low", false),
                    ("medium", "Medium", false),
                    ("high", "High", true),
                    ("max", "Max", false),
                    ("ultrathink", "Ultrathink", false),
                ]),
                context_window(),
            ],
        ),
        model(
            "claude-haiku-4-5",
            "Claude Haiku 4.5",
            vec![boolean_option("thinking", "Thinking")],
        ),
    ]
}

fn model(slug: &str, name: &str, option_descriptors: Vec<Value>) -> Value {
    json!({
        "slug": slug,
        "name": name,
        "isCustom": false,
        "capabilities": { "optionDescriptors": option_descriptors },
    })
}

fn effort(options: &[(&str, &str, bool)]) -> Value {
    let prompt_injected_values = options
        .iter()
        .any(|(id, _, _)| *id == "ultrathink")
        .then_some(&["ultrathink"][..]);
    select_option("effort", "Reasoning", options, prompt_injected_values)
}

fn context_window() -> Value {
    select_option(
        "contextWindow",
        "Context Window",
        &[("200k", "200k", true), ("1m", "1M", false)],
        None,
    )
}

fn select_option(
    id: &str,
    label: &str,
    options: &[(&str, &str, bool)],
    prompt_injected_values: Option<&[&str]>,
) -> Value {
    let mut descriptor = json!({
        "id": id,
        "label": label,
        "type": "select",
        "options": options
            .iter()
            .map(|(id, label, is_default)| {
                let mut option = json!({ "id": id, "label": label });
                if *is_default {
                    option["isDefault"] = json!(true);
                }
                option
            })
            .collect::<Vec<_>>(),
    });
    if let Some(values) = prompt_injected_values {
        descriptor["promptInjectedValues"] = json!(values);
    }
    descriptor
}

fn boolean_option(id: &str, label: &str) -> Value {
    json!({ "id": id, "label": label, "type": "boolean" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_version_from_claude_cli_output() {
        assert_eq!(semantic_version("2.1.207 (Claude Code)"), Some([2, 1, 207]));
    }

    #[test]
    fn custom_models_do_not_duplicate_built_ins() {
        let models = all_models(&["claude-sonnet-5".to_owned(), " custom-model ".to_owned()]);
        assert_eq!(models.len(), 9);
        assert_eq!(models.last().unwrap()["slug"], "custom-model");
    }

    #[test]
    fn prompt_injected_ultrathink_is_exposed_only_by_models_that_offer_it() {
        let models = all_models(&[]);
        let effort = |slug: &str| {
            models
                .iter()
                .find(|model| model["slug"] == slug)
                .unwrap()["capabilities"]["optionDescriptors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| option["id"] == "effort")
                .cloned()
                .unwrap()
        };

        assert_eq!(
            effort("claude-sonnet-5")["promptInjectedValues"],
            json!(["ultrathink"])
        );
        assert!(
            effort("claude-opus-4-5")
                .get("promptInjectedValues")
                .is_none()
        );
    }
}
