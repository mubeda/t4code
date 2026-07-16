use std::{path::PathBuf, sync::Arc};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{process::Child, sync::Mutex};

use super::connect_mcp::EndpointRuntime;

#[derive(Clone, Default)]
pub struct ManagedEndpointRuntime {
    state: Arc<Mutex<Option<ActiveConnector>>>,
}

struct ActiveConnector {
    key: String,
    child: Child,
    config: ManagedEndpointConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedEndpointConfig {
    provider_kind: String,
    connector_token: String,
    tunnel_id: Option<String>,
    tunnel_name: Option<String>,
}

impl ManagedEndpointRuntime {
    #[must_use]
    pub fn endpoint(&self) -> EndpointRuntime {
        let runtime = self.clone();
        EndpointRuntime::new(move |config| {
            let runtime = runtime.clone();
            async move { runtime.apply(config).await }
        })
    }

    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        if let Some(mut active) = state.take() {
            let _ = active.child.kill().await;
            let _ = active.child.wait().await;
        }
    }

    async fn apply(&self, value: Value) -> Result<Value, String> {
        if value.is_null() {
            self.shutdown().await;
            return Ok(json!({ "status": "disabled" }));
        }
        let config: ManagedEndpointConfig = serde_json::from_value(value)
            .map_err(|error| format!("invalid managed endpoint config: {error}"))?;
        if config.provider_kind != "cloudflare_tunnel" {
            self.shutdown().await;
            return Ok(json!({
                "status": "unsupported",
                "providerKind": config.provider_kind,
            }));
        }
        if config.connector_token.trim().is_empty() {
            return Err("connector token must not be empty".to_owned());
        }
        let key = format!(
            "{}\0{}\0{}",
            config.connector_token,
            config.tunnel_id.as_deref().unwrap_or_default(),
            config.tunnel_name.as_deref().unwrap_or_default(),
        );
        let mut state = self.state.lock().await;
        if let Some(active) = state.as_mut() {
            if active.key == key
                && active
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
            {
                return Ok(running_status(active));
            }
            let _ = active.child.kill().await;
            let _ = active.child.wait().await;
            *state = None;
        }
        let Some(executable) = executable_on_path(if cfg!(windows) {
            "t4code-connect.exe"
        } else {
            "t4code-connect"
        }) else {
            return Ok(failed_status(&config, "The relay client is not installed."));
        };
        let mut command = tokio::process::Command::new(executable);
        command
            .args(["tunnel", "run"])
            .env("TUNNEL_TOKEN", &config.connector_token)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return Ok(failed_status(&config, &error.to_string())),
        };
        let active = ActiveConnector { key, child, config };
        let status = running_status(&active);
        *state = Some(active);
        Ok(status)
    }
}

fn running_status(active: &ActiveConnector) -> Value {
    json!({
        "status": "running",
        "providerKind": "cloudflare_tunnel",
        "pid": active.child.id(),
        "tunnelId": active.config.tunnel_id,
        "tunnelName": active.config.tunnel_name,
    })
}

fn failed_status(config: &ManagedEndpointConfig, reason: &str) -> Value {
    json!({
        "status": "failed",
        "providerKind": "cloudflare_tunnel",
        "reason": reason,
        "tunnelId": config.tunnel_id,
        "tunnelName": config.tunnel_name,
    })
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_invalid_and_unsupported_configs_are_bounded() {
        let runtime = ManagedEndpointRuntime::default();

        assert_eq!(
            runtime.apply(Value::Null).await.unwrap(),
            json!({"status":"disabled"})
        );
        assert!(
            runtime
                .apply(json!({"providerKind":"cloudflare_tunnel"}))
                .await
                .unwrap_err()
                .starts_with("invalid managed endpoint config:")
        );
        assert_eq!(
            runtime
                .apply(json!({
                    "providerKind":"future_provider",
                    "connectorToken":"ignored",
                    "tunnelId":"tunnel-1",
                    "tunnelName":"Future tunnel",
                }))
                .await
                .unwrap(),
            json!({"status":"unsupported","providerKind":"future_provider"})
        );
        assert_eq!(
            runtime
                .apply(json!({
                    "providerKind":"cloudflare_tunnel",
                    "connectorToken":"  ",
                }))
                .await
                .unwrap_err(),
            "connector token must not be empty"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn missing_connector_executable_returns_actionable_status() {
        let runtime = ManagedEndpointRuntime::default();
        let status = runtime
            .apply(json!({
                "providerKind":"cloudflare_tunnel",
                "connectorToken":"fixture-token",
                "tunnelId":"tunnel-1",
                "tunnelName":"Fixture tunnel",
            }))
            .await
            .unwrap();

        assert_eq!(status["providerKind"], "cloudflare_tunnel");
        assert_eq!(status["tunnelId"], "tunnel-1");
        assert_eq!(status["tunnelName"], "Fixture tunnel");
        assert_eq!(status["status"], "failed");
        assert_eq!(status["reason"], "The relay client is not installed.");
    }
}
