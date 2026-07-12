use std::{ffi::OsString, path::Path, process::Stdio, time::Duration};

use serde_json::{Value, json};
use tokio::{process::Command, time::timeout};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{OutputPolicy, ProcessRequest, ProcessRunner},
    production::provider_runtime::{provider_launch_program, resolve_provider_executable},
    provider::{codex, cursor, opencode},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug)]
struct ProviderDefinition {
    instance_id: String,
    driver: String,
    display_name: Option<String>,
    enabled: bool,
    binary_path: String,
    available: bool,
    custom_models: Vec<String>,
    endpoint: Option<String>,
}

pub(crate) async fn probe(settings: &Value, selected: Option<&str>, cwd: &Path) -> Vec<Value> {
    let mut snapshots = Vec::new();
    for definition in definitions(settings) {
        if selected.is_none_or(|selected| selected == definition.instance_id) {
            snapshots.push(probe_one(definition, cwd).await);
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
        });
    }
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;

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

async fn probe_one(definition: ProviderDefinition, cwd: &Path) -> Value {
    let checked_at = super::control::now_iso();
    if !definition.available {
        return snapshot(
            &definition,
            false,
            None,
            "disabled",
            json!({ "status": "unknown" }),
            Vec::new(),
            Vec::new(),
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
            custom_models(&definition.custom_models),
            Vec::new(),
            None,
            checked_at,
            "available",
        );
    }
    if definition.driver == "opencode"
        && let Some(endpoint) = definition.endpoint.as_deref()
        && let Some(inventory) = probe_opencode(endpoint, &definition.custom_models).await
    {
        let models = serde_json::to_value(inventory.models)
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_else(|| custom_models(&definition.custom_models));
        return snapshot(
            &definition,
            true,
            None,
            "ready",
            inventory.auth,
            models,
            Vec::new(),
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
            custom_models(&definition.custom_models),
            Vec::new(),
            Some("Provider executable was not found."),
            checked_at,
            "available",
        );
    };

    let version_output = run_command(&executable, &["--version"], cwd).await;
    let version = version_output
        .as_ref()
        .and_then(|output| first_line(&output.stdout, &output.stderr));
    let mut installed = version_output.is_some();
    let mut status = match version_output.as_ref() {
        Some(output) if output.success => "ready",
        Some(_) => "warning",
        None => "error",
    };
    let mut auth = json!({ "status": "unknown" });
    let mut models = custom_models(&definition.custom_models);
    let mut skills = Vec::new();
    let mut message = match version_output.as_ref() {
        Some(output) if !output.success => Some("Provider executable returned a non-zero status."),
        None => Some("Provider executable could not be started."),
        Some(_) => None,
    };

    match definition.driver.as_str() {
        "codex" => {
            if let Some(inventory) = probe_codex(&executable, cwd, &definition.custom_models).await
            {
                installed = true;
                status = "ready";
                auth = codex_auth(&inventory.account);
                models = serde_json::to_value(inventory.models)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or(models);
                skills = serde_json::to_value(inventory.skills)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default();
                message = None;
            }
        }
        "cursor" => {
            if let Some(output) = run_command(&executable, &["about"], cwd).await {
                let about = cursor::parse_about_output(output.code, &output.stdout, &output.stderr);
                installed = true;
                status = if about.status == "ready" {
                    "ready"
                } else {
                    "error"
                };
                auth = about.auth;
                if let Some(discovered) = probe_cursor_models(
                    &executable,
                    definition.endpoint.as_deref(),
                    &definition.custom_models,
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
                    skills,
                    about.message,
                    checked_at,
                );
            }
        }
        "claudeAgent" => {
            if let Some(output) = run_command(&executable, &["auth", "status", "--json"], cwd).await
            {
                auth = claude_auth(&output.stdout);
                if auth["status"] == "unauthenticated" {
                    status = "warning";
                    message = Some("Claude is installed but not authenticated.");
                }
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
        skills,
        message,
        checked_at,
        "available",
    )
}

struct CommandOutput {
    success: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

async fn run_command(executable: &Path, args: &[&str], cwd: &Path) -> Option<CommandOutput> {
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
                env: Vec::new(),
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
) -> Option<codex::CodexProviderSnapshot> {
    let (program, prefix_args) = provider_launch_program(executable);
    let mut child = Command::new(program)
        .args(prefix_args)
        .arg("app-server")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let stdin = child.stdin.take()?;
    let stderr = child.stderr.take()?;
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
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn probe_cursor_models(
    executable: &Path,
    endpoint: Option<&str>,
    custom_models: &[String],
) -> Option<Vec<Value>> {
    let (program, prefix_args) = provider_launch_program(executable);
    let mut command = Command::new(program);
    command.args(prefix_args);
    if let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) {
        command.args(["-e", endpoint]);
    }
    let mut child = command
        .arg("acp")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let stdin = child.stdin.take()?;
    let stderr = child.stderr.take()?;
    let (connection, _incoming) = cursor::AcpJsonRpcConnection::spawn(
        stdout,
        stdin,
        stderr,
        cursor::AcpConnectionConfig::default(),
    );
    let response = timeout(PROBE_TIMEOUT, async {
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
    let _ = child.kill().await;
    let _ = child.wait().await;
    let models =
        cursor::discover_models_from_list_available_models(&response?, custom_models).ok()?;
    serde_json::to_value(models)
        .ok()
        .and_then(|value| value.as_array().cloned())
}

async fn probe_opencode(
    endpoint: &str,
    custom_models: &[String],
) -> Option<opencode::OpenCodeInventorySnapshot> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .ok()?;
    let endpoint = endpoint.trim_end_matches('/');
    let providers = client
        .get(format!("{endpoint}/provider"))
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    let agents = client
        .get(format!("{endpoint}/agent"))
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    Some(opencode::build_inventory_snapshot(
        &providers,
        &agents,
        custom_models,
    ))
}

fn first_line(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
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
    skills: Vec<Value>,
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
        skills,
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
    skills: Vec<Value>,
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
        "slashCommands": [],
        "skills": skills,
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
