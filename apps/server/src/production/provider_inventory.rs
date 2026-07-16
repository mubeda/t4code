use std::{collections::HashSet, ffi::OsString, path::Path, process::Stdio, time::Duration};

#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::Command,
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{OutputPolicy, ProcessRequest, ProcessRunner},
    production::provider_runtime::{
        provider_launch_program, resolve_provider_executable,
        sanitize_provider_subprocess_environment,
    },
    provider::{claude, codex, cursor, grok, opencode},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CURSOR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_CAPABILITIES_TIMEOUT: Duration = Duration::from_secs(45);
const CLAUDE_SKILLS_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_CAPABILITY_PROBE_ARGS: [&str; 12] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--setting-sources=user,project,local",
    "--settings",
    r#"{"disableAllHooks":true}"#,
    "--permission-mode",
    "default",
    "--no-session-persistence",
];
const LOCAL_OPENCODE_HEALTH_TIMEOUT: Duration = Duration::from_millis(250);
const LOCAL_OPENCODE_INVENTORY_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_OPENCODE_STARTUP_ATTEMPTS: usize = 50;
const PROBE_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone)]
struct ProviderDefinition {
    instance_id: String,
    driver: String,
    display_name: Option<String>,
    enabled: bool,
    binary_path: String,
    available: bool,
    custom_models: Vec<String>,
    endpoint: Option<String>,
    server_password: Option<String>,
    environment: Vec<(OsString, OsString)>,
}

#[derive(Clone, Debug, Default)]
struct ProviderCapabilities {
    slash_commands: Vec<Value>,
    skills: Vec<Value>,
    agents: Vec<Value>,
}

pub(crate) async fn probe(settings: &Value, selected: Option<&str>, cwd: &Path) -> Vec<Value> {
    probe_inner(settings, selected, cwd, false).await
}

pub(crate) async fn probe_full(settings: &Value, selected: Option<&str>, cwd: &Path) -> Vec<Value> {
    probe_inner(settings, selected, cwd, true).await
}

async fn probe_inner(
    settings: &Value,
    selected: Option<&str>,
    cwd: &Path,
    include_slow_capabilities: bool,
) -> Vec<Value> {
    let mut snapshots = Vec::new();
    for definition in definitions(settings) {
        if selected.is_none_or(|selected| selected == definition.instance_id) {
            snapshots.push(probe_one(definition, cwd, include_slow_capabilities).await);
        }
    }
    snapshots
}

fn definitions(settings: &Value) -> Vec<ProviderDefinition> {
    let legacy = settings.get("providers").and_then(Value::as_object);
    let instances = settings.get("providerInstances").and_then(Value::as_object);
    let mut definitions = instances
        .filter(|instances| !instances.is_empty())
        .map(|instances| {
            instances
                .iter()
                .map(|(instance_id, instance)| {
                    let driver = instance
                        .get("driver")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let legacy_settings = legacy.and_then(|providers| providers.get(driver));
                    let config = instance.get("config");
                    ProviderDefinition {
                        instance_id: instance_id.clone(),
                        driver: driver.to_owned(),
                        display_name: instance
                            .get("displayName")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        enabled: instance
                            .get("enabled")
                            .and_then(Value::as_bool)
                            .or_else(|| {
                                legacy_settings
                                    .and_then(|value| value.get("enabled"))
                                    .and_then(Value::as_bool)
                            })
                            .unwrap_or(true),
                        binary_path: string_setting(config, "binaryPath")
                            .or_else(|| string_setting(legacy_settings, "binaryPath"))
                            .unwrap_or(driver)
                            .to_owned(),
                        available: is_builtin_driver(driver),
                        custom_models: string_array(config, "customModels")
                            .or_else(|| string_array(legacy_settings, "customModels"))
                            .unwrap_or_default(),
                        endpoint: string_setting(config, "serverUrl")
                            .or_else(|| string_setting(config, "apiEndpoint"))
                            .or_else(|| string_setting(legacy_settings, "serverUrl"))
                            .or_else(|| string_setting(legacy_settings, "apiEndpoint"))
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_owned),
                        server_password: string_setting(config, "serverPassword")
                            .or_else(|| string_setting(legacy_settings, "serverPassword"))
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned),
                        environment: provider_environment(instance),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for driver in ["codex", "claudeAgent", "cursor", "grok", "opencode"] {
        if definitions
            .iter()
            .any(|definition| definition.driver == driver)
        {
            continue;
        }
        let driver_settings = legacy.and_then(|providers| providers.get(driver));
        definitions.push(ProviderDefinition {
            instance_id: driver.to_owned(),
            driver: driver.to_owned(),
            display_name: None,
            enabled: driver_settings
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(driver != "cursor"),
            binary_path: string_setting(driver_settings, "binaryPath")
                .unwrap_or(driver)
                .to_owned(),
            available: true,
            custom_models: string_array(driver_settings, "customModels").unwrap_or_default(),
            endpoint: string_setting(driver_settings, "serverUrl")
                .or_else(|| string_setting(driver_settings, "apiEndpoint"))
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
            server_password: string_setting(driver_settings, "serverPassword")
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            environment: Vec::new(),
        });
    }
    definitions
}

fn string_setting<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a str> {
    value?.get(name)?.as_str()
}

fn string_array(value: Option<&Value>, name: &str) -> Option<Vec<String>> {
    Some(
        value?
            .get(name)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

fn provider_environment(instance: &Value) -> Vec<(OsString, OsString)> {
    instance
        .get("environment")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            !entry
                .get("valueRedacted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            Some((
                OsString::from(name),
                OsString::from(
                    entry
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
            ))
        })
        .collect()
}

async fn probe_one(
    definition: ProviderDefinition,
    cwd: &Path,
    include_slow_capabilities: bool,
) -> Value {
    let checked_at = super::control::now_iso();
    let default_models = provider_models_without_version(&definition);
    if !definition.available {
        return snapshot(
            &definition,
            false,
            None,
            "disabled",
            json!({ "status": "unknown" }),
            default_models,
            ProviderCapabilities::default(),
            Some("Provider driver is unavailable in this build."),
            checked_at,
            "unavailable",
        );
    }
    if !definition.enabled {
        return snapshot(
            &definition,
            false,
            None,
            "disabled",
            json!({ "status": "unknown" }),
            default_models,
            ProviderCapabilities::default(),
            None,
            checked_at,
            "available",
        );
    }
    if !include_slow_capabilities
        && definition.driver == "opencode"
        && definition.endpoint.is_some()
    {
        return snapshot(
            &definition,
            true,
            None,
            "ready",
            json!({ "status": "unknown" }),
            default_models,
            ProviderCapabilities::default(),
            None,
            checked_at,
            "available",
        );
    }
    if include_slow_capabilities
        && definition.driver == "opencode"
        && let Some(endpoint) = definition.endpoint.as_deref()
        && let Some(inventory) = probe_opencode(
            endpoint,
            definition.server_password.as_deref(),
            &definition.custom_models,
        )
        .await
    {
        let models = serde_json::to_value(inventory.models)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_else(|| custom_models(&definition.custom_models));
        let capabilities = ProviderCapabilities {
            slash_commands: inventory.commands,
            skills: Vec::new(),
            agents: inventory.agents,
        };
        return snapshot(
            &definition,
            true,
            None,
            "ready",
            inventory.auth,
            models,
            capabilities,
            None,
            checked_at,
            "available",
        );
    }
    let Some(executable) = resolve_provider_executable(&definition.binary_path) else {
        return snapshot(
            &definition,
            false,
            None,
            "error",
            json!({ "status": "unknown" }),
            default_models,
            ProviderCapabilities::default(),
            Some("Provider executable was not found."),
            checked_at,
            "available",
        );
    };
    if !include_slow_capabilities {
        return snapshot(
            &definition,
            true,
            None,
            "ready",
            json!({ "status": "unknown" }),
            default_models,
            ProviderCapabilities {
                slash_commands: built_in_slash_commands(&definition.driver),
                ..ProviderCapabilities::default()
            },
            None,
            checked_at,
            "available",
        );
    }

    let version_output =
        run_command(&executable, &["--version"], cwd, &definition.environment).await;
    let version = version_output
        .as_ref()
        .and_then(|output| first_line(&output.stdout, &output.stderr));
    let version = normalize_provider_version(&definition.driver, version);
    let mut installed = version_output.is_some();
    let mut status = match version_output.as_ref() {
        Some(output) if output.success => "ready",
        Some(_) => "warning",
        None => "error",
    };
    let mut auth = json!({ "status": "unknown" });
    let mut models = default_models;
    let mut capabilities = ProviderCapabilities {
        slash_commands: built_in_slash_commands(&definition.driver),
        ..ProviderCapabilities::default()
    };
    let mut message = match version_output.as_ref() {
        Some(output) if !output.success => Some("Provider executable returned a non-zero status."),
        None => Some("Provider executable could not be started."),
        Some(_) => None,
    };

    match definition.driver.as_str() {
        "codex" => {
            if include_slow_capabilities
                && let Some(inventory) = probe_codex(
                    &executable,
                    cwd,
                    &definition.custom_models,
                    &definition.environment,
                )
                .await
            {
                installed = true;
                (status, auth, message) = codex_probe_health(&inventory.account);
                models = serde_json::to_value(inventory.models)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or(models);
                capabilities.skills = serde_json::to_value(inventory.skills)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default();
            }
        }
        "cursor" => {
            if let Some(output) =
                run_command(&executable, &["about"], cwd, &definition.environment).await
            {
                let about = cursor::parse_about_output(output.code, &output.stdout, &output.stderr);
                installed = true;
                status = if about.status == "ready" {
                    "ready"
                } else {
                    "error"
                };
                auth = about.auth;
                let workspace_capabilities = cursor::discover_workspace_capabilities(cwd).await;
                capabilities.slash_commands = merge_slash_commands(
                    workspace_capabilities.slash_commands,
                    capabilities.slash_commands,
                );
                capabilities.skills = workspace_capabilities.skills;
                capabilities.agents = workspace_capabilities.agents;
                if include_slow_capabilities
                    && let Some(discovered) = probe_cursor_models(
                        &executable,
                        definition.endpoint.as_deref(),
                        &definition.custom_models,
                        cwd,
                        &definition.environment,
                    )
                    .await
                {
                    models = discovered;
                }
                return snapshot_owned_message(
                    &definition,
                    installed,
                    about.version.or(version),
                    status,
                    auth,
                    models,
                    capabilities,
                    about.message,
                    checked_at,
                );
            }
        }
        "claudeAgent" => {
            if version_output.as_ref().is_some_and(|output| output.success)
                && let Some(version) = version.as_deref()
            {
                models = claude::model::models_for_version(version, &definition.custom_models);
            }
            if let Some(output) = run_command(
                &executable,
                &["auth", "status", "--json"],
                cwd,
                &definition.environment,
            )
            .await
            {
                auth = claude_auth(&output.stdout);
                if auth["status"] == "unauthenticated" {
                    status = "warning";
                    message = Some("Claude is installed but not authenticated.");
                }
            }
            if include_slow_capabilities
                && let Some(discovered) =
                    probe_claude_capabilities(&executable, cwd, &definition.environment).await
            {
                capabilities = discovered;
                capabilities.slash_commands = merge_slash_commands(
                    capabilities.slash_commands,
                    built_in_slash_commands(&definition.driver),
                );
                apply_agent_options(&mut models, &capabilities.agents);
            }
        }
        "opencode" => {
            if include_slow_capabilities
                && let Some(inventory) = probe_local_opencode(
                    &executable,
                    cwd,
                    &definition.custom_models,
                    &definition.environment,
                )
                .await
            {
                status = "ready";
                auth = inventory.auth;
                models = serde_json::to_value(inventory.models)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or(models);
                capabilities.slash_commands = inventory.commands;
                capabilities.agents = inventory.agents;
                message = None;
            }
        }
        _ => {}
    }

    snapshot(
        &definition,
        installed,
        version,
        status,
        auth,
        models,
        capabilities,
        message,
        checked_at,
        "available",
    )
}

fn provider_models_without_version(definition: &ProviderDefinition) -> Vec<Value> {
    match definition.driver.as_str() {
        "claudeAgent" => claude::model::all_models(&definition.custom_models),
        "grok" => serde_json::to_value(grok::model::default_models(&definition.custom_models))
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_else(|| custom_models(&definition.custom_models)),
        _ => custom_models(&definition.custom_models),
    }
}

fn built_in_slash_commands(driver: &str) -> Vec<Value> {
    match driver {
        "codex" => vec![slash_command(
            "goal",
            "Set a completion condition and keep working until it is met",
            Some("<condition>"),
        )],
        "claudeAgent" => vec![
            slash_command(
                "goal",
                "Set a completion condition and keep working until it is met",
                Some("[condition|clear]"),
            ),
            slash_command(
                "loop",
                "Run a prompt repeatedly while the session stays open",
                Some("[interval] [prompt]"),
            ),
        ],
        "cursor" => vec![
            slash_command("models", "List and switch Cursor models", None),
            slash_command(
                "auto-run",
                "Configure automatic command execution",
                Some("[on|off|status]"),
            ),
            slash_command("new-chat", "Start a new Cursor chat", None),
            slash_command("vim", "Toggle Vim keys", None),
            slash_command("help", "Show Cursor command help", Some("[command]")),
            slash_command("feedback", "Send feedback to Cursor", Some("<message>")),
            slash_command("resume", "Resume a Cursor chat", Some("<chat>")),
            slash_command("copy-req-id", "Copy the last Cursor request ID", None),
            slash_command("rules", "Create or edit Cursor rules", None),
            slash_command("commands", "Create or edit Cursor commands", None),
            slash_command("mcp", "Manage Cursor MCP servers", Some("[enable|disable]")),
            slash_command("max-mode", "Toggle Cursor max mode", Some("[on|off]")),
            slash_command("compress", "Compress the current Cursor context", None),
            slash_command("add-plugin", "Install a Cursor plugin", None),
            slash_command("logout", "Sign out from Cursor", None),
            slash_command("quit", "Exit the Cursor session", None),
        ],
        "grok" => vec![
            slash_command("loop", "Run a prompt repeatedly", Some("[prompt]")),
            slash_command("agents", "List and manage Grok agents", None),
            slash_command("skills", "List available Grok skills", None),
        ],
        _ => Vec::new(),
    }
}

fn slash_command(name: &str, description: &str, hint: Option<&str>) -> Value {
    let mut command = json!({
        "name": name,
        "description": description,
    });
    if let Some(hint) = hint.filter(|value| !value.trim().is_empty()) {
        command["input"] = json!({ "hint": hint });
    }
    command
}

fn parse_claude_initialization_response(response: &Value) -> ProviderCapabilities {
    ProviderCapabilities {
        slash_commands: parse_command_values(response.get("commands")),
        skills: Vec::new(),
        agents: response
            .get("agents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|agent| {
                let name = agent.get("name")?.as_str()?.trim();
                if name.is_empty() {
                    return None;
                }
                let mut result = json!({ "name": name });
                copy_non_empty_string(agent, &mut result, "description");
                copy_non_empty_string(agent, &mut result, "model");
                Some(result)
            })
            .collect(),
    }
}

fn parse_claude_skills_response(response: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    response
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|skill| {
            let name = skill.get("name")?.as_str()?.trim().trim_start_matches('/');
            if name.is_empty() || !seen.insert(name.to_ascii_lowercase()) {
                return None;
            }
            let mut result = json!({
                "name": name,
                "path": format!("claude://skill/{name}"),
                "scope": "provider",
                "enabled": true,
                "invocation": "slash",
            });
            copy_non_empty_string(skill, &mut result, "description");
            Some(result)
        })
        .collect()
}

fn parse_command_values(value: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command
                .get("name")?
                .as_str()?
                .trim()
                .trim_start_matches('/');
            if name.is_empty() || !seen.insert(name.to_ascii_lowercase()) {
                return None;
            }
            let mut result = json!({ "name": name });
            copy_non_empty_string(command, &mut result, "description");
            if let Some(hint) = command
                .get("argumentHint")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|hint| !hint.is_empty())
            {
                result["input"] = json!({ "hint": hint });
            }
            Some(result)
        })
        .collect()
}

fn merge_slash_commands(mut commands: Vec<Value>, fallbacks: Vec<Value>) -> Vec<Value> {
    let mut seen = commands
        .iter()
        .filter_map(|command| command.get("name").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .collect::<HashSet<_>>();
    commands.extend(fallbacks.into_iter().filter(|command| {
        command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| seen.insert(name.to_ascii_lowercase()))
    }));
    commands
}

fn copy_non_empty_string(source: &Value, target: &mut Value, key: &str) {
    if let Some(value) = source
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target[key] = json!(value);
    }
}

fn apply_agent_options(models: &mut [Value], agents: &[Value]) {
    let default_agent = agents
        .iter()
        .find(|agent| agent["name"] == "claude")
        .or_else(|| agents.first())
        .and_then(|agent| agent.get("name"))
        .and_then(Value::as_str);
    let options = agents
        .iter()
        .filter_map(|agent| {
            let name = agent.get("name")?.as_str()?;
            let mut option = json!({
                "id": name,
                "label": name,
            });
            if Some(name) == default_agent {
                option["isDefault"] = json!(true);
            }
            Some(option)
        })
        .collect::<Vec<_>>();
    if options.is_empty() {
        return;
    }
    for model in models {
        let capabilities = model
            .as_object_mut()
            .and_then(|model| model.get_mut("capabilities"))
            .and_then(Value::as_object_mut);
        let Some(capabilities) = capabilities else {
            continue;
        };
        let descriptors = capabilities
            .entry("optionDescriptors")
            .or_insert_with(|| json!([]));
        let Some(descriptors) = descriptors.as_array_mut() else {
            continue;
        };
        descriptors.retain(|descriptor| descriptor["id"] != "agent");
        descriptors.push(json!({
            "id": "agent",
            "label": "Agent",
            "type": "select",
            "options": options.clone(),
            "currentValue": default_agent,
        }));
    }
}

async fn probe_claude_capabilities(
    executable: &Path,
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Option<ProviderCapabilities> {
    let (program, prefix_args) = provider_launch_program(executable);
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .args(CLAUDE_CAPABILITY_PROBE_ARGS)
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-rust")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = supervised_command(command).spawn().ok()?;
    let mut stdin = child.stdin().take()?;
    let stdout = child.stdout().take()?;
    let mut lines = BufReader::new(stdout).lines();

    write_claude_control_request(&mut stdin, "t4code-inventory", "initialize")
        .await
        .ok()?;
    let initialization = timeout(
        CLAUDE_CAPABILITIES_TIMEOUT,
        read_claude_control_response(&mut lines, "t4code-inventory"),
    )
    .await
    .ok()
    .flatten()?;
    let mut capabilities = parse_claude_initialization_response(&initialization);

    if write_claude_control_request(&mut stdin, "t4code-skills", "reload_skills")
        .await
        .is_ok()
        && let Ok(Some(skills)) = timeout(
            CLAUDE_SKILLS_TIMEOUT,
            read_claude_control_response(&mut lines, "t4code-skills"),
        )
        .await
    {
        capabilities.skills = parse_claude_skills_response(&skills);
    }
    let _ = stdin.shutdown().await;
    stop_supervised_child(&mut *child).await;
    Some(capabilities)
}

async fn write_claude_control_request(
    stdin: &mut tokio::process::ChildStdin,
    request_id: &str,
    subtype: &str,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(&json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": subtype },
    }))
    .map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await
}

async fn read_claude_control_response<R: AsyncBufRead + Unpin>(
    lines: &mut Lines<R>,
    request_id: &str,
) -> Option<Value> {
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(response) = value.get("response") else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("control_response")
            && response.get("request_id").and_then(Value::as_str) == Some(request_id)
            && response.get("subtype").and_then(Value::as_str) == Some("success")
        {
            return response.get("response").cloned();
        }
    }
    None
}

struct CommandOutput {
    success: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run_command(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Option<CommandOutput> {
    let (program, prefix_args) = provider_launch_program(executable);
    let process_args = prefix_args
        .into_iter()
        .map(OsString::from)
        .chain(args.iter().map(OsString::from))
        .collect();
    let output = ProcessRunner
        .run(
            ProcessRequest {
                operation: "provider.inventory.probe".to_owned(),
                command: program,
                args: process_args,
                cwd: cwd.to_path_buf(),
                env: environment.to_vec(),
                stdin: None,
                timeout: PROBE_TIMEOUT,
                max_output_bytes: PROBE_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Truncate,
                append_truncation_marker: true,
                allow_non_zero_exit: true,
            },
            &CancellationToken::new(),
        )
        .await
        .ok()?;
    Some(CommandOutput {
        success: output.exit_code == 0,
        code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

async fn probe_codex(
    executable: &Path,
    cwd: &Path,
    custom_models: &[String],
    environment: &[(OsString, OsString)],
) -> Option<codex::CodexProviderSnapshot> {
    let (program, prefix_args) = provider_launch_program(executable);
    let mut command = Command::new(program);
    command.envs(environment.iter().cloned());
    sanitize_provider_subprocess_environment(&mut command);
    command
        .args(prefix_args)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = supervised_command(command).spawn().ok()?;
    let stdout = child.stdout().take()?;
    let stdin = child.stdin().take()?;
    let stderr = child.stderr().take()?;
    let (connection, _incoming) =
        codex::JsonRpcConnection::spawn(stdout, stdin, stderr, codex::ConnectionConfig::default());
    let cwd = cwd.to_string_lossy().into_owned();
    let result = timeout(
        PROBE_TIMEOUT,
        codex::probe_provider(&connection, env!("CARGO_PKG_VERSION"), &cwd, custom_models),
    )
    .await
    .ok()
    .and_then(Result::ok);
    connection.close().await;
    stop_supervised_child(&mut *child).await;
    result
}

async fn probe_cursor_models(
    executable: &Path,
    endpoint: Option<&str>,
    custom_models: &[String],
    cwd: &Path,
    environment: &[(OsString, OsString)],
) -> Option<Vec<Value>> {
    let (program, prefix_args) = provider_launch_program(executable);
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .current_dir(cwd)
        .envs(environment.iter().cloned());
    if let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) {
        command.args(["-e", endpoint]);
    }
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = supervised_command(command).spawn().ok()?;
    let stdout = child.stdout().take()?;
    let stdin = child.stdin().take()?;
    let stderr = child.stderr().take()?;
    let (connection, _incoming) = cursor::AcpJsonRpcConnection::spawn(
        stdout,
        stdin,
        stderr,
        cursor::AcpConnectionConfig::default(),
    );
    let response = timeout(CURSOR_DISCOVERY_TIMEOUT, async {
        connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                    },
                    "clientInfo": { "name": "t4code-rust", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await
            .ok()?;
        connection
            .request("authenticate", json!({ "methodId": "cursor_login" }))
            .await
            .ok()?;
        connection
            .request("cursor/list_available_models", json!({}))
            .await
            .ok()
    })
    .await
    .ok()
    .flatten();
    stop_supervised_child(&mut *child).await;
    let models =
        cursor::discover_models_from_list_available_models(&response?, custom_models).ok()?;
    serde_json::to_value(models)
        .ok()
        .and_then(|value| value.as_array().cloned())
}

async fn probe_opencode(
    endpoint: &str,
    server_password: Option<&str>,
    custom_models: &[String],
) -> Option<opencode::OpenCodeInventorySnapshot> {
    probe_opencode_with_timeout(endpoint, server_password, custom_models, PROBE_TIMEOUT).await
}

async fn probe_opencode_with_timeout(
    endpoint: &str,
    server_password: Option<&str>,
    custom_models: &[String],
    request_timeout: Duration,
) -> Option<opencode::OpenCodeInventorySnapshot> {
    let client = reqwest::Client::builder()
        .timeout(request_timeout)
        .build()
        .ok()?;
    let endpoint = endpoint.trim_end_matches('/');
    let (providers, agents, commands) = tokio::join!(
        get_opencode_json(&client, endpoint, "/provider", server_password),
        get_opencode_json(&client, endpoint, "/agent", server_password),
        get_opencode_json(&client, endpoint, "/command", server_password),
    );
    if providers.is_none() && agents.is_none() && commands.is_none() {
        return None;
    }
    let providers = providers.unwrap_or_else(|| {
        json!({
            "all": [],
            "connected": [],
            "default": {}
        })
    });
    let agents = agents.unwrap_or_else(|| json!([]));
    let commands = commands.unwrap_or_else(|| json!([]));
    Some(opencode::build_inventory_snapshot(
        &providers,
        &agents,
        &commands,
        custom_models,
    ))
}

async fn get_opencode_json(
    client: &reqwest::Client,
    endpoint: &str,
    path: &str,
    server_password: Option<&str>,
) -> Option<Value> {
    let request = client.get(format!("{endpoint}{path}"));
    let request = match server_password.filter(|value| !value.is_empty()) {
        Some(password) => request.basic_auth("opencode", Some(password)),
        None => request,
    };
    request
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()
}

async fn opencode_is_healthy(endpoint: &str, server_password: Option<&str>) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(LOCAL_OPENCODE_HEALTH_TIMEOUT)
        .build()
    else {
        return false;
    };
    get_opencode_json(
        &client,
        endpoint.trim_end_matches('/'),
        "/global/health",
        server_password,
    )
    .await
    .is_some()
}

async fn probe_local_opencode(
    executable: &Path,
    cwd: &Path,
    custom_models: &[String],
    environment: &[(OsString, OsString)],
) -> Option<opencode::OpenCodeInventorySnapshot> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    let endpoint = format!("http://127.0.0.1:{port}");
    let (program, prefix_args) = provider_launch_program(executable);
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .args(["serve", "--hostname=127.0.0.1", &format!("--port={port}")])
        .current_dir(cwd)
        .envs(environment.iter().cloned())
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let local_password = uuid::Uuid::new_v4().to_string();
    command.env("OPENCODE_SERVER_PASSWORD", &local_password);
    let mut child = supervised_command(command).spawn().ok()?;
    let mut ready = false;
    for _ in 0..LOCAL_OPENCODE_STARTUP_ATTEMPTS {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if opencode_is_healthy(&endpoint, Some(&local_password)).await {
            ready = true;
            break;
        }
        sleep(Duration::from_millis(100)).await;
    }
    let inventory = if ready && child.try_wait().ok().flatten().is_none() {
        let snapshot = probe_opencode_with_timeout(
            &endpoint,
            Some(&local_password),
            custom_models,
            LOCAL_OPENCODE_INVENTORY_TIMEOUT,
        )
        .await;
        child
            .try_wait()
            .ok()
            .flatten()
            .is_none()
            .then_some(snapshot)
            .flatten()
    } else {
        None
    };
    stop_supervised_child(&mut *child).await;
    inventory
}

fn supervised_command(command: Command) -> CommandWrap {
    let mut command = CommandWrap::from(command);
    command.wrap(KillOnDrop);
    #[cfg(windows)]
    command.wrap(JobObject);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    command
}

async fn stop_supervised_child(child: &mut dyn ChildWrapper) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn first_line(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn normalize_provider_version(driver: &str, version: Option<String>) -> Option<String> {
    let version = version?;
    if driver != "codex" {
        return Some(version);
    }
    version
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
                && part.contains('.')
        })
        .map(str::to_owned)
        .or(Some(version))
}

fn codex_probe_health(account: &Value) -> (&'static str, Value, Option<&'static str>) {
    let auth = codex_auth(account);
    let requires_openai_auth = account
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_account = account.get("account").is_some_and(|value| !value.is_null());
    if requires_openai_auth && !has_account {
        return (
            "error",
            auth,
            Some("Codex is installed but requires authentication."),
        );
    }
    ("ready", auth, None)
}

fn codex_auth(account: &Value) -> Value {
    let Some(account) = account.get("account").and_then(Value::as_object) else {
        return json!({ "status": "unauthenticated" });
    };
    let mut auth = json!({ "status": "authenticated" });
    if let Some(account_type) = account.get("type").and_then(Value::as_str) {
        auth["type"] = json!(account_type);
    }
    if let Some(email) = account.get("email").and_then(Value::as_str) {
        auth["email"] = json!(email);
    }
    auth
}

fn claude_auth(stdout: &str) -> Value {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return json!({ "status": "unknown" });
    };
    let authenticated = value
        .get("loggedIn")
        .and_then(Value::as_bool)
        .or_else(|| value.get("authenticated").and_then(Value::as_bool));
    let mut auth = json!({
        "status": match authenticated {
            Some(true) => "authenticated",
            Some(false) => "unauthenticated",
            None => "unknown",
        }
    });
    if let Some(method) = value
        .get("authMethod")
        .or_else(|| value.get("subscriptionType"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        auth["type"] = json!(method);
    }
    if let Some(email) = value
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        auth["email"] = json!(email);
    }
    auth
}

fn custom_models(slugs: &[String]) -> Vec<Value> {
    slugs
        .iter()
        .map(|slug| {
            json!({
                "slug": slug,
                "name": slug,
                "isCustom": true,
                "capabilities": null,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn snapshot(
    definition: &ProviderDefinition,
    installed: bool,
    version: Option<String>,
    status: &str,
    auth: Value,
    models: Vec<Value>,
    capabilities: ProviderCapabilities,
    message: Option<&str>,
    checked_at: String,
    availability: &str,
) -> Value {
    let mut result = snapshot_owned_message(
        definition,
        installed,
        version,
        status,
        auth,
        models,
        capabilities,
        message.map(str::to_owned),
        checked_at,
    );
    result["availability"] = json!(availability);
    if availability == "unavailable" {
        result["unavailableReason"] = json!("Provider driver is unavailable in this build.");
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn snapshot_owned_message(
    definition: &ProviderDefinition,
    installed: bool,
    version: Option<String>,
    status: &str,
    auth: Value,
    models: Vec<Value>,
    capabilities: ProviderCapabilities,
    message: Option<String>,
    checked_at: String,
) -> Value {
    let mut result = json!({
        "instanceId": definition.instance_id,
        "driver": definition.driver,
        "enabled": definition.enabled && definition.available,
        "installed": installed,
        "version": version,
        "status": status,
        "auth": auth,
        "checkedAt": checked_at,
        "availability": "available",
        "models": models,
        "slashCommands": capabilities.slash_commands,
        "skills": capabilities.skills,
        "agents": capabilities.agents,
    });
    if let Some(display_name) = &definition.display_name {
        result["displayName"] = json!(display_name);
    }
    if let Some(message) = message {
        result["message"] = json!(message);
    }
    result
}

fn is_builtin_driver(driver: &str) -> bool {
    matches!(
        driver,
        "codex" | "claudeAgent" | "cursor" | "grok" | "opencode"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::{Json, Router, routing::get};

    #[test]
    fn provider_probe_timeouts_allow_slow_windows_cli_startup() {
        assert!(PROBE_TIMEOUT >= Duration::from_secs(10));
        assert!(LOCAL_OPENCODE_INVENTORY_TIMEOUT >= Duration::from_secs(30));
    }

    #[test]
    fn configured_instances_do_not_hide_enabled_legacy_providers() {
        let settings = json!({
            "providerInstances": {
                "cursor": {
                    "driver": "cursor",
                    "enabled": true,
                    "config": { "binaryPath": "agent" }
                }
            },
            "providers": {
                "codex": { "enabled": true, "binaryPath": "codex" },
                "claudeAgent": { "enabled": true, "binaryPath": "claude" },
                "cursor": { "enabled": false, "binaryPath": "agent" },
                "grok": { "enabled": true, "binaryPath": "grok" },
                "opencode": { "enabled": true, "binaryPath": "opencode" }
            }
        });

        let definitions = definitions(&settings);
        let drivers = definitions
            .iter()
            .map(|definition| definition.driver.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            drivers,
            ["cursor", "codex", "claudeAgent", "grok", "opencode"]
        );
        assert_eq!(
            drivers.iter().filter(|driver| **driver == "cursor").count(),
            1
        );
    }

    #[test]
    fn codex_cli_version_is_normalized_to_semver() {
        assert_eq!(
            normalize_provider_version("codex", Some("codex-cli 0.144.1".to_owned())),
            Some("0.144.1".to_owned())
        );
    }

    #[test]
    fn codex_required_auth_is_not_reported_as_ready() {
        let account = json!({ "account": null, "requiresOpenaiAuth": true });

        assert_eq!(
            codex_probe_health(&account),
            (
                "error",
                json!({ "status": "unauthenticated" }),
                Some("Codex is installed but requires authentication.")
            )
        );
    }

    #[test]
    fn codex_authenticated_account_remains_ready_when_openai_auth_is_required() {
        let account = json!({
            "account": {
                "type": "chatgpt",
                "email": "user@example.com"
            },
            "requiresOpenaiAuth": true
        });

        assert_eq!(
            codex_probe_health(&account),
            (
                "ready",
                json!({
                    "status": "authenticated",
                    "type": "chatgpt",
                    "email": "user@example.com"
                }),
                None
            )
        );
    }

    #[test]
    fn codex_without_required_openai_auth_remains_ready() {
        let account = json!({ "account": null, "requiresOpenaiAuth": false });

        assert_eq!(
            codex_probe_health(&account),
            ("ready", json!({ "status": "unauthenticated" }), None)
        );
    }

    #[test]
    fn grok_inventory_has_a_builtin_model_before_acp_discovery() {
        let definition = ProviderDefinition {
            instance_id: "grok".to_owned(),
            driver: "grok".to_owned(),
            display_name: None,
            enabled: true,
            binary_path: "grok".to_owned(),
            available: true,
            custom_models: Vec::new(),
            endpoint: None,
            server_password: None,
            environment: Vec::new(),
        };

        assert_eq!(
            provider_models_without_version(&definition)[0]["slug"],
            "grok-build"
        );
    }

    #[test]
    fn provider_environment_excludes_redacted_and_empty_entries() {
        let instance = json!({
            "environment": [
                { "name": "API_KEY", "value": "secret", "valueRedacted": false },
                { "name": "HIDDEN", "value": "redacted", "valueRedacted": true },
                { "name": "", "value": "ignored", "valueRedacted": false }
            ]
        });
        assert_eq!(
            provider_environment(&instance),
            vec![(OsString::from("API_KEY"), OsString::from("secret"))]
        );
    }

    #[test]
    fn claude_initialization_exposes_commands_and_agents() {
        let capabilities = parse_claude_initialization_response(&json!({
            "commands": [
                { "name": "goal", "description": "Keep working", "argumentHint": "[condition]" },
                { "name": "loop", "description": "Run repeatedly", "argumentHint": "[interval] [prompt]" }
            ],
            "agents": [
                { "name": "code-reviewer", "description": "Reviews code", "model": "opus" }
            ]
        }));

        assert_eq!(capabilities.slash_commands[0]["name"], "goal");
        assert_eq!(
            capabilities.slash_commands[0]["input"]["hint"],
            "[condition]"
        );
        assert_eq!(capabilities.slash_commands[1]["name"], "loop");
        assert_eq!(capabilities.agents[0]["name"], "code-reviewer");
        assert_eq!(capabilities.agents[0]["model"], "opus");
    }

    #[test]
    fn claude_reload_skills_uses_provider_native_slash_invocation() {
        let skills = parse_claude_skills_response(&json!({
            "skills": [
                { "name": "loop", "description": "Run repeatedly", "argumentHint": "[interval] [prompt]" },
                { "name": "loop", "description": "Duplicate lower-priority skill" }
            ]
        }));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], "loop");
        assert_eq!(skills[0]["invocation"], "slash");
        assert_eq!(skills[0]["path"], "claude://skill/loop");
    }

    #[test]
    fn claude_inventory_probe_disables_hooks_without_disabling_capabilities() {
        assert!(
            CLAUDE_CAPABILITY_PROBE_ARGS
                .windows(2)
                .any(|pair| pair == ["--settings", r#"{"disableAllHooks":true}"#])
        );
        assert!(CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--setting-sources=user,project,local"));
        assert!(!CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--safe-mode"));
        assert!(!CLAUDE_CAPABILITY_PROBE_ARGS.contains(&"--bare"));
    }

    #[test]
    fn opencode_command_inventory_preserves_arguments() {
        let commands = opencode::model::command_inventory(&json!([
            {
                "name": "review",
                "description": "Review changes",
                "template": "Review $ARGUMENTS"
            }
        ]));

        assert_eq!(commands[0]["name"], "review");
        assert_eq!(commands[0]["input"]["hint"], "arguments");
    }

    #[tokio::test]
    async fn opencode_slow_command_inventory_does_not_erase_models_and_agents() {
        let app = Router::new()
            .route(
                "/provider",
                get(|| async {
                    Json(json!({
                        "all": [{
                            "id": "openai",
                            "name": "OpenAI",
                            "models": {
                                "gpt-5": {
                                    "id": "gpt-5",
                                    "providerID": "openai",
                                    "name": "GPT-5"
                                }
                            }
                        }],
                        "connected": ["openai"],
                        "default": { "openai": "gpt-5" }
                    }))
                }),
            )
            .route(
                "/agent",
                get(|| async {
                    Json(json!([{
                        "name": "build",
                        "description": "Default agent",
                        "mode": "primary",
                        "native": true
                    }]))
                }),
            )
            .route(
                "/command",
                get(|| async {
                    sleep(Duration::from_millis(200)).await;
                    Json(json!([{
                        "name": "review",
                        "description": "Review changes",
                        "template": "Review $ARGUMENTS"
                    }]))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake OpenCode server");
        let endpoint = format!("http://{}", listener.local_addr().expect("local address"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve fake OpenCode API");
        });

        let inventory = probe_opencode_with_timeout(
            &endpoint,
            None,
            &["custom/model".to_owned()],
            Duration::from_millis(75),
        )
        .await
        .expect("partial OpenCode inventory");
        server.abort();

        assert!(
            inventory
                .models
                .iter()
                .any(|model| model.slug == "openai/gpt-5")
        );
        assert!(
            inventory
                .models
                .iter()
                .any(|model| model.slug == "custom/model")
        );
        assert_eq!(inventory.agents[0]["name"], "build");
        assert!(inventory.commands.is_empty());
    }

    #[tokio::test]
    async fn cursor_discovers_project_commands_skills_and_agents() {
        let workspace = tempfile::tempdir().expect("temporary Cursor workspace");
        let command_directory = workspace.path().join(".cursor/commands");
        let skill_directory = workspace.path().join(".cursor/skills/review-code");
        let agent_directory = workspace.path().join(".cursor/agents");
        tokio::fs::create_dir_all(&command_directory)
            .await
            .expect("create Cursor command directory");
        tokio::fs::create_dir_all(&skill_directory)
            .await
            .expect("create Cursor skill directory");
        tokio::fs::create_dir_all(&agent_directory)
            .await
            .expect("create Cursor agent directory");
        tokio::fs::write(
            command_directory.join("review.md"),
            "Review the current changes.",
        )
        .await
        .expect("write Cursor command");
        tokio::fs::write(skill_directory.join("SKILL.md"), "# Review code")
            .await
            .expect("write Cursor skill");
        tokio::fs::write(
            agent_directory.join("reviewer.md"),
            "Review code carefully.",
        )
        .await
        .expect("write Cursor agent");

        let capabilities = cursor::discover_workspace_capabilities(workspace.path()).await;

        assert!(
            capabilities
                .slash_commands
                .iter()
                .any(|command| command["name"] == "review")
        );
        assert!(capabilities.skills.iter().any(|skill| {
            skill["name"] == "review-code"
                && skill["scope"] == "project"
                && skill["invocation"] == "slash"
        }));
        assert!(
            capabilities
                .agents
                .iter()
                .any(|agent| agent["name"] == "reviewer")
        );
    }

    #[test]
    fn built_in_capabilities_include_provider_specific_goal_and_loop_commands() {
        let codex = built_in_slash_commands("codex");
        let claude = built_in_slash_commands("claudeAgent");
        let cursor = built_in_slash_commands("cursor");
        let grok = built_in_slash_commands("grok");

        assert!(codex.iter().any(|command| command["name"] == "goal"));
        assert!(claude.iter().any(|command| command["name"] == "goal"));
        assert!(claude.iter().any(|command| command["name"] == "loop"));
        assert!(cursor.iter().any(|command| command["name"] == "models"));
        assert!(cursor.iter().any(|command| command["name"] == "rules"));
        assert!(cursor.iter().any(|command| command["name"] == "commands"));
        assert!(grok.iter().any(|command| command["name"] == "loop"));
        assert!(grok.iter().any(|command| command["name"] == "agents"));
        assert!(grok.iter().any(|command| command["name"] == "skills"));
    }
}
