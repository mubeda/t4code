use serde_json::Value;
use std::time::Duration;
use t4code_server::process::configure_background_command;
use tokio::process::Command;

const DEFAULT_TAILSCALE_SERVE_PORT: u16 = 443;
const TAILSCALE_STATUS_TIMEOUT: Duration = Duration::from_millis(1_500);
const TAILSCALE_PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscaleStatus {
    pub magic_dns_name: Option<String>,
    pub tailnet_ipv4_addresses: Vec<String>,
}

fn tailscale_command() -> &'static str {
    if cfg!(target_os = "windows") {
        "tailscale.exe"
    } else {
        "tailscale"
    }
}

fn normalize_magic_dns_name(status: &Value) -> Option<String> {
    let normalized = status
        .get("Self")?
        .get("DNSName")?
        .as_str()?
        .trim()
        .trim_end_matches('.')
        .to_string();
    (!normalized.is_empty()).then_some(normalized)
}

pub fn is_tailscale_ipv4_address(address: &str) -> bool {
    let parts = address.split('.').collect::<Vec<_>>();
    if parts.len() != 4 {
        return false;
    }

    let Some(first) = parts.first().and_then(|part| part.parse::<u8>().ok()) else {
        return false;
    };
    let Some(second) = parts.get(1).and_then(|part| part.parse::<u8>().ok()) else {
        return false;
    };
    let Some(_third) = parts.get(2).and_then(|part| part.parse::<u8>().ok()) else {
        return false;
    };
    let Some(_fourth) = parts.get(3).and_then(|part| part.parse::<u8>().ok()) else {
        return false;
    };

    first == 100 && (64..=127).contains(&second)
}

pub fn parse_tailscale_status(raw_status_json: &str) -> Result<TailscaleStatus, String> {
    let status = serde_json::from_str::<Value>(raw_status_json)
        .map_err(|error| format!("Failed to decode tailscale status JSON: {error}"))?;
    let tailnet_ipv4_addresses = status
        .get("Self")
        .and_then(|self_value| self_value.get("TailscaleIPs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|address| is_tailscale_ipv4_address(address))
        .map(str::to_string)
        .collect::<Vec<_>>();

    Ok(TailscaleStatus {
        magic_dns_name: normalize_magic_dns_name(&status),
        tailnet_ipv4_addresses,
    })
}

pub fn build_tailscale_https_base_url(
    magic_dns_name: &str,
    serve_port: u16,
) -> Result<String, String> {
    let mut url = url::Url::parse(&format!("https://{magic_dns_name}"))
        .map_err(|error| format!("Could not build Tailscale HTTPS URL: {error}"))?;
    if serve_port != DEFAULT_TAILSCALE_SERVE_PORT {
        url.set_port(Some(serve_port))
            .map_err(|_| "Could not set Tailscale HTTPS port.".to_string())?;
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

pub async fn read_tailscale_status() -> Result<TailscaleStatus, String> {
    let mut command = Command::new(tailscale_command());
    configure_background_command(&mut command);
    let child = command
        .args(["status", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to spawn tailscale status: {error}"))?;

    let output = tokio::time::timeout(TAILSCALE_STATUS_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "tailscale status timed out after 1500ms.".to_string())?
        .map_err(|error| format!("Failed to read tailscale status output: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "tailscale status exited with code {}.",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string())
        ));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("tailscale status returned non-UTF-8 JSON: {error}"))?;
    parse_tailscale_status(&stdout)
}

pub async fn probe_tailscale_https_endpoint(base_url: &str) -> bool {
    let mut url = match url::Url::parse(base_url) {
        Ok(url) => url,
        Err(_) => return false,
    };
    url.set_path("/.well-known/t4code/environment");
    url.set_query(None);
    url.set_fragment(None);

    let client = match reqwest::Client::builder()
        .timeout(TAILSCALE_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    matches!(
        tokio::time::timeout(TAILSCALE_PROBE_TIMEOUT, client.get(url).send()).await,
        Ok(Ok(response)) if response.status().is_success()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAILSCALE_STATUS_JSON: &str = r#"{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}"#;

    #[test]
    fn detects_tailnet_ipv4_addresses() {
        assert!(is_tailscale_ipv4_address("100.64.0.1"));
        assert!(is_tailscale_ipv4_address("100.127.255.254"));
        assert!(!is_tailscale_ipv4_address("100.128.0.1"));
        assert!(!is_tailscale_ipv4_address("192.168.1.44"));
        assert!(!is_tailscale_ipv4_address("not-an-ip"));
    }

    #[test]
    fn parses_status_facts() {
        let status = parse_tailscale_status(TAILSCALE_STATUS_JSON).expect("status should parse");

        assert_eq!(
            status.magic_dns_name,
            Some("desktop.tail.ts.net".to_string())
        );
        assert_eq!(
            status.tailnet_ipv4_addresses,
            vec!["100.100.100.100".to_string()]
        );
    }

    #[test]
    fn builds_clean_https_base_urls() {
        assert_eq!(
            build_tailscale_https_base_url("desktop.tail.ts.net", 443).expect("url should build"),
            "https://desktop.tail.ts.net/"
        );
        assert_eq!(
            build_tailscale_https_base_url("desktop.tail.ts.net", 8443).expect("url should build"),
            "https://desktop.tail.ts.net:8443/"
        );
    }

    #[tokio::test]
    async fn command_and_probe_helpers_reject_invalid_endpoints_without_io() {
        assert_eq!(
            tailscale_command(),
            if cfg!(target_os = "windows") {
                "tailscale.exe"
            } else {
                "tailscale"
            }
        );
        assert!(!probe_tailscale_https_endpoint("not a URL").await);
    }
}
