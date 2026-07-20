use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEFAULT_MODEL: &str = "gpt-5.4";
const DEFAULT_SERVICE_TIER_ID: &str = "default";

const T4CODE_BROWSER_TOOL_INSTRUCTIONS: &str = r#"

## T4Code collaborative browser

You are running inside T4Code. The `t4code` MCP server is the product-native collaborative browser shared with the user. When it exposes `preview_*` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call `preview_status`. If no automation-capable preview is attached, call `preview_open` before concluding that the browser is unavailable. Then use `preview_navigate`, `preview_snapshot`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T4 preview tools are absent, the user explicitly requests another browser, or `preview_open` returns an explicit unsupported/unavailable error. A failed T4 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
"#;

const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS: &str = r#"<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a `<proposed_plan>` block.

Separately, `update_plan` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use `update_plan` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, `target/`, `.cache/`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the `request_user_input` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the `request_user_input` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a `<proposed_plan>` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as `<proposed_plan>` and `</proposed_plan>` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a `<proposed_plan>` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one `<proposed_plan>` block per turn, and only when you are presenting a complete spec.
"#;

const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS: &str = r#"<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The `request_user_input` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
"#;

const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS: &[&str] = &[
    "not found",
    "no rollout found",
    "missing thread",
    "no such thread",
    "unknown thread",
    "does not exist",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexRuntimeMode {
    ApprovalRequired,
    AutoAcceptEdits,
    FullAccess,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServiceTier {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderModel {
    pub slug: String,
    pub name: String,
    pub is_custom: bool,
    pub capabilities: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderSkill {
    pub name: String,
    pub path: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderSnapshot {
    pub account: Value,
    pub version: Option<String>,
    pub models: Vec<CodexProviderModel>,
    pub skills: Vec<CodexProviderSkill>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadTurnSnapshot {
    pub id: String,
    pub items: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadSnapshot {
    pub thread_id: String,
    pub turns: Vec<CodexThreadTurnSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTurnStartInput {
    pub thread_id: String,
    pub runtime_mode: CodexRuntimeMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_mode: Option<String>,
}

#[must_use]
pub fn build_initialize_params(version: &str) -> Value {
    json!({
        "clientInfo": {
            "name": "t4code_desktop",
            "title": "T4Code Desktop",
            "version": version,
        },
        "capabilities": {
            "experimentalApi": true,
        },
    })
}

#[must_use]
pub fn build_turn_start_params(input: &BuildTurnStartInput) -> Value {
    let (approval_policy, sandbox_policy) = match input.runtime_mode {
        CodexRuntimeMode::ApprovalRequired => ("untrusted", json!({ "type": "readOnly" })),
        CodexRuntimeMode::AutoAcceptEdits => ("on-request", json!({ "type": "workspaceWrite" })),
        CodexRuntimeMode::FullAccess => ("never", json!({ "type": "dangerFullAccess" })),
    };

    let mut turn_input = Vec::new();
    if let Some(prompt) = input.prompt.as_ref().filter(|value| !value.is_empty()) {
        turn_input.push(json!({
            "type": "text",
            "text": prompt,
        }));
    }
    turn_input.extend(input.attachments.iter().cloned());

    let mut payload = json!({
        "threadId": input.thread_id,
        "approvalPolicy": approval_policy,
        "sandboxPolicy": sandbox_policy,
        "input": turn_input,
    });

    if let Some(model) = input.model.as_ref().map(|value| resolve_turn_model(value)) {
        payload["model"] = json!(model);
    }
    if let Some(service_tier) = input.service_tier.as_ref() {
        payload["serviceTier"] = json!(service_tier);
    }
    if let Some(effort) = input.effort.as_ref() {
        payload["effort"] = json!(effort);
    }
    if let Some(mode) = input.interaction_mode.as_ref() {
        let model = input
            .model
            .as_ref()
            .map(|value| resolve_turn_model(value))
            .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
        payload["collaborationMode"] = json!({
            "mode": mode,
            "settings": {
                "model": model,
                "reasoning_effort": input.effort.clone().unwrap_or_else(|| "medium".to_owned()),
                "developer_instructions": if mode == "plan" {
                    format!(
                        "{}{}{}",
                        CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
                        T4CODE_BROWSER_TOOL_INSTRUCTIONS,
                        "\n</collaboration_mode>"
                    )
                } else {
                    format!(
                        "{}{}{}",
                        CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
                        T4CODE_BROWSER_TOOL_INSTRUCTIONS,
                        "\n</collaboration_mode>"
                    )
                },
            }
        });
    }

    payload
}

#[must_use]
pub fn is_recoverable_thread_resume_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("thread")
        && RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS
            .iter()
            .any(|snippet| lowered.contains(snippet))
}

pub fn parse_model_list_response(
    response: &Value,
    custom_models: &[String],
) -> Result<Vec<CodexProviderModel>, String> {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "model/list response missing data array".to_owned())?;
    let mut models = Vec::with_capacity(data.len() + custom_models.len());
    for model in data {
        let slug = model
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| "model entry missing model".to_owned())?;
        let display_name = model
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(slug);
        models.push(CodexProviderModel {
            slug: slug.to_owned(),
            name: to_display_name(display_name),
            is_custom: false,
            capabilities: map_model_capabilities(model),
        });
    }

    let mut seen = models
        .iter()
        .map(|model| model.slug.clone())
        .collect::<std::collections::HashSet<_>>();
    let fallback_capabilities = models
        .iter()
        .find(|model| !model.capabilities.is_null())
        .map(|model| model.capabilities.clone())
        .unwrap_or(Value::Null);
    for custom in custom_models {
        let slug = custom.trim();
        if slug.is_empty() || seen.contains(slug) {
            continue;
        }
        seen.insert(slug.to_owned());
        models.push(CodexProviderModel {
            slug: slug.to_owned(),
            name: slug.to_owned(),
            is_custom: true,
            capabilities: fallback_capabilities.clone(),
        });
    }

    Ok(models)
}

pub fn fallback_models(
    configured_model: Option<&str>,
    configured_effort: Option<&str>,
    configured_service_tier: Option<&str>,
    custom_models: &[String],
) -> Vec<Value> {
    const EFFORTS: [&str; 8] = [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let model = configured_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MODEL);
    let selected_effort = configured_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("medium");
    let selected_service_tier = if configured_service_tier == Some("fast") {
        "fast"
    } else {
        "default"
    };
    let mut efforts = EFFORTS.into_iter().collect::<Vec<_>>();
    if !efforts.contains(&selected_effort) {
        efforts.push(selected_effort);
    }
    let effort_options = efforts
        .into_iter()
        .map(|effort| {
            let mut option = json!({
                "id": effort,
                "label": reasoning_effort_label(effort),
            });
            if effort == selected_effort {
                option["isDefault"] = json!(true);
            }
            option
        })
        .collect::<Vec<_>>();
    let mut models = vec![json!({
        "slug": model,
        "name": to_display_name(model),
        "isCustom": false,
        "capabilities": {
            "optionDescriptors": [
                {
                    "id": "reasoningEffort",
                    "label": "Reasoning",
                    "type": "select",
                    "options": effort_options,
                    "currentValue": selected_effort,
                },
                {
                    "id": "serviceTier",
                    "label": "Service Tier",
                    "type": "select",
                    "options": [
                        {
                            "id": "default",
                            "label": "Standard",
                            "isDefault": selected_service_tier == "default"
                        },
                        {
                            "id": "fast",
                            "label": "Fast",
                            "isDefault": selected_service_tier == "fast"
                        }
                    ],
                    "currentValue": selected_service_tier,
                }
            ]
        }
    })];
    let mut seen = std::collections::HashSet::from([model.to_owned()]);
    models.extend(custom_models.iter().filter_map(|custom| {
        let slug = custom.trim();
        (!slug.is_empty() && seen.insert(slug.to_owned())).then(|| {
            json!({
                "slug": slug,
                "name": slug,
                "isCustom": true,
                "capabilities": null,
            })
        })
    }));
    models
}

pub fn parse_skills_list_response(
    response: &Value,
    cwd: &str,
) -> Result<Vec<CodexProviderSkill>, String> {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "skills/list response missing data array".to_owned())?;

    let selected = data
        .iter()
        .find(|entry| entry.get("cwd").and_then(Value::as_str) == Some(cwd))
        .or_else(|| data.first());

    let Some(skills) = selected
        .and_then(|entry| entry.get("skills"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };

    Ok(skills
        .iter()
        .map(|skill| {
            let interface = skill.get("interface");
            let short_description = skill
                .get("shortDescription")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    interface
                        .and_then(|value| value.get("shortDescription"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            CodexProviderSkill {
                name: skill
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                path: skill
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                enabled: skill
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                description: skill
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                scope: skill
                    .get("scope")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                display_name: interface
                    .and_then(|value| value.get("displayName"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                short_description,
            }
        })
        .collect())
}

pub fn parse_thread_snapshot(response: &Value) -> Result<CodexThreadSnapshot, String> {
    let thread = response
        .get("thread")
        .and_then(Value::as_object)
        .ok_or_else(|| "thread response missing thread object".to_owned())?;
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "thread response missing turns array".to_owned())?;
    Ok(CodexThreadSnapshot {
        thread_id: thread
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        turns: turns
            .iter()
            .map(|turn| CodexThreadTurnSnapshot {
                id: turn
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                items: turn
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            })
            .collect(),
    })
}

fn map_model_capabilities(model: &Value) -> Value {
    let supported_reasoning_efforts = model
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_reasoning_effort = model
        .get("defaultReasoningEffort")
        .and_then(Value::as_str)
        .unwrap_or("medium");

    let reasoning_options = supported_reasoning_efforts
        .iter()
        .filter_map(|entry| entry.get("reasoningEffort").and_then(Value::as_str))
        .map(|effort| {
            if effort == default_reasoning_effort {
                json!({
                    "id": effort,
                    "label": reasoning_effort_label(effort),
                    "isDefault": true,
                })
            } else {
                json!({
                    "id": effort,
                    "label": reasoning_effort_label(effort),
                })
            }
        })
        .collect::<Vec<_>>();

    let mut service_tiers = model
        .get("serviceTiers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if service_tiers.is_empty() {
        service_tiers = model
            .get("additionalSpeedTiers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|tier| {
                tier.as_str().map(|id| {
                    json!({
                        "id": id,
                        "name": if id == "fast" { "Fast" } else { id },
                        "description": "",
                    })
                })
            })
            .collect();
    }

    let default_service_tier = model
        .get("defaultServiceTier")
        .and_then(Value::as_str)
        .filter(|default_id| {
            service_tiers
                .iter()
                .any(|tier| tier.get("id").and_then(Value::as_str) == Some(*default_id))
        })
        .unwrap_or(DEFAULT_SERVICE_TIER_ID);

    let mut option_descriptors = Vec::new();
    if !reasoning_options.is_empty() {
        option_descriptors.push(json!({
            "id": "reasoningEffort",
            "label": "Reasoning",
            "type": "select",
            "options": reasoning_options,
            "currentValue": default_reasoning_effort,
        }));
    }
    if !service_tiers.is_empty() {
        let mut standard = json!({
            "id": DEFAULT_SERVICE_TIER_ID,
            "label": "Standard",
            "isDefault": default_service_tier == DEFAULT_SERVICE_TIER_ID,
        });
        if default_service_tier != DEFAULT_SERVICE_TIER_ID {
            standard
                .as_object_mut()
                .expect("service tier option is an object")
                .remove("isDefault");
        }
        let mut options = vec![standard];
        options.extend(service_tiers.iter().map(|tier| {
            let id = tier.get("id").and_then(Value::as_str).unwrap_or_default();
            let name = tier.get("name").and_then(Value::as_str).unwrap_or(id);
            let description = tier
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({
                "id": id,
                "label": name,
                "description": if description.is_empty() { Value::Null } else { json!(description) },
                "isDefault": default_service_tier == id,
            })
        }).map(|value| {
            let mut object = value.as_object().cloned().unwrap_or_default();
            if object.get("description").is_some_and(Value::is_null) {
                object.remove("description");
            }
            if object.get("isDefault") == Some(&Value::Bool(false)) {
                object.remove("isDefault");
            }
            Value::Object(object)
        }));
        option_descriptors.push(json!({
            "id": "serviceTier",
            "label": "Service Tier",
            "type": "select",
            "options": options,
            "currentValue": default_service_tier,
        }));
    }

    json!({
        "optionDescriptors": option_descriptors,
    })
}

fn reasoning_effort_label(value: &str) -> &str {
    match value {
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        _ => value,
    }
}

fn normalize_model_slug(model: &str, preferred_id: Option<&str>) -> String {
    let normalized = model.trim().to_ascii_lowercase();
    if let Some(preferred_id) = preferred_id
        && preferred_id.ends_with("-codex")
        && preferred_id != normalized
    {
        return preferred_id.to_owned();
    }
    normalized
}

fn resolve_turn_model(model: &str) -> String {
    if model.trim().eq_ignore_ascii_case("auto") {
        DEFAULT_MODEL.to_owned()
    } else {
        normalize_model_slug(model, None)
    }
}

fn to_display_name(display_name: &str) -> String {
    let mut result = display_name.replacen("gpt", "GPT", 1);
    let mut chars = result.chars().peekable();
    let mut rebuilt = String::with_capacity(result.len());
    while let Some(character) = chars.next() {
        rebuilt.push(character);
        if character == '-'
            && let Some(next) = chars.next()
        {
            rebuilt.push(next.to_ascii_uppercase());
        }
    }
    result.clear();
    rebuilt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_models_expose_codex_effort_and_fast_service_tiers() {
        let models = fallback_models(Some("gpt-private"), Some("max"), Some("fast"), &[]);
        let model = &models[0];
        let descriptors = model["capabilities"]["optionDescriptors"]
            .as_array()
            .expect("fallback option descriptors");
        let effort = descriptors
            .iter()
            .find(|descriptor| descriptor["id"] == "reasoningEffort")
            .expect("reasoning effort descriptor");
        let service_tier = descriptors
            .iter()
            .find(|descriptor| descriptor["id"] == "serviceTier")
            .expect("service tier descriptor");

        assert_eq!(model["slug"], "gpt-private");
        assert!(
            effort["options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|option| { option["id"] == "max" && option["isDefault"] == true })
        );
        assert_eq!(service_tier["options"][0]["id"], "default");
        assert_eq!(service_tier["options"][1]["id"], "fast");
        assert_eq!(service_tier["currentValue"], "fast");
    }

    #[test]
    fn fallback_models_keep_custom_models_unique_and_label_all_known_efforts() {
        let models = fallback_models(
            None,
            Some("ultra"),
            None,
            &["gpt-custom".to_owned(), "gpt-custom".to_owned()],
        );

        assert_eq!(
            models
                .iter()
                .filter(|model| model["slug"] == "gpt-custom")
                .count(),
            1
        );
        assert_eq!(reasoning_effort_label("max"), "Max");
        assert_eq!(reasoning_effort_label("ultra"), "Ultra");
    }

    #[test]
    fn malformed_and_fallback_payloads_cover_codex_model_boundaries() {
        assert!(parse_model_list_response(&json!({}), &[]).is_err());
        assert!(parse_model_list_response(&json!({"data":[{}]}), &[]).is_err());
        let models = parse_model_list_response(
            &json!({
                "data":[{
                    "model":"gpt-test",
                    "supportedReasoningEfforts":[{}, {"reasoningEffort":"high"}],
                    "serviceTiers":[{"id":"fast"}, {"name":"missing-id"}],
                    "defaultServiceTier":"missing"
                }]
            }),
            &[" ".to_owned(), "gpt-test".to_owned(), "custom".to_owned()],
        )
        .expect("fallback model payload should parse");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "GPT-Test");
        assert!(models[1].is_custom);

        assert!(parse_skills_list_response(&json!({}), "/workspace").is_err());
        assert!(
            parse_skills_list_response(&json!({"data":[]}), "/workspace")
                .unwrap()
                .is_empty()
        );
        let skills = parse_skills_list_response(
            &json!({"data":[{"cwd":"/fallback","skills":[{
                "interface":{"shortDescription":"nested"}
            }]}]}),
            "/missing",
        )
        .unwrap();
        assert_eq!(skills[0].short_description.as_deref(), Some("nested"));

        assert!(parse_thread_snapshot(&json!({})).is_err());
        assert!(parse_thread_snapshot(&json!({"thread":{}})).is_err());
        assert_eq!(
            parse_thread_snapshot(&json!({"thread":{"turns":[{}]}}))
                .unwrap()
                .turns[0],
            CodexThreadTurnSnapshot {
                id: String::new(),
                items: Vec::new(),
            }
        );

        let turn = build_turn_start_params(&BuildTurnStartInput {
            thread_id: "thread".to_owned(),
            runtime_mode: CodexRuntimeMode::ApprovalRequired,
            prompt: Some(String::new()),
            attachments: Vec::new(),
            model: None,
            service_tier: None,
            effort: None,
            interaction_mode: Some("plan".to_owned()),
        });
        assert_eq!(
            turn["collaborationMode"]["settings"]["model"],
            DEFAULT_MODEL
        );
    }
}
