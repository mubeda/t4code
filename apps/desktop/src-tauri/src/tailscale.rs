use serde_json::Value;
use std::{path::Path, time::Duration};
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
    read_tailscale_status_with(Path::new(tailscale_command()), TAILSCALE_STATUS_TIMEOUT).await
}

async fn read_tailscale_status_with(
    command_path: &Path,
    timeout: Duration,
) -> Result<TailscaleStatus, String> {
    let mut command = Command::new(command_path);
    configure_background_command(&mut command);
    let child = command
        .args(["status", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to spawn tailscale status: {error}"))?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "tailscale status timed out after {}ms.",
                timeout.as_millis()
            )
        })?
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::path::{Path, PathBuf};

    const TAILSCALE_STATUS_JSON: &str = r#"{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}"#;

    #[test]
    fn detects_tailnet_ipv4_addresses() {
        assert!(is_tailscale_ipv4_address("100.64.0.1"));
        assert!(is_tailscale_ipv4_address("100.127.255.254"));
        assert!(!is_tailscale_ipv4_address("100.128.0.1"));
        assert!(!is_tailscale_ipv4_address("192.168.1.44"));
        assert!(!is_tailscale_ipv4_address("not-an-ip"));
        assert!(!is_tailscale_ipv4_address("nope.64.0.1"));
        assert!(!is_tailscale_ipv4_address("100.nope.0.1"));
        assert!(!is_tailscale_ipv4_address("100.64.nope.1"));
        assert!(!is_tailscale_ipv4_address("100.64.0.nope"));
        assert!(!is_tailscale_ipv4_address("100.64.0.256"));
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

        assert_eq!(
            parse_tailscale_status(r#"{"Self":{"DNSName":" ... ","TailscaleIPs":[null,42]}}"#)
                .unwrap(),
            TailscaleStatus {
                magic_dns_name: None,
                tailnet_ipv4_addresses: Vec::new(),
            }
        );
        assert_eq!(
            parse_tailscale_status("{}").unwrap(),
            TailscaleStatus {
                magic_dns_name: None,
                tailnet_ipv4_addresses: Vec::new(),
            }
        );
        assert!(
            parse_tailscale_status("not json")
                .unwrap_err()
                .contains("decode")
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
        assert!(build_tailscale_https_base_url("desktop:invalid-port", 443).is_err());
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

    async fn probe_local_endpoint(status: &str) -> bool {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response_status = status.to_owned();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 1024];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /.well-known/t4code/environment "));
            stream
                .write_all(
                    format!("HTTP/1.1 {response_status}\r\nContent-Length: 0\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
        });

        let result =
            probe_tailscale_https_endpoint(&format!("http://{address}/ignored?query=yes")).await;
        server.await.unwrap();
        result
    }

    #[tokio::test]
    async fn probe_reports_successful_and_failed_http_responses() {
        assert!(probe_local_endpoint("204 No Content").await);
        assert!(!probe_local_endpoint("503 Service Unavailable").await);
    }

    #[cfg(unix)]
    fn executable_script(directory: &Path, name: &str, body: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    async fn read_status_fixture(
        path: &Path,
        timeout: Duration,
    ) -> Result<TailscaleStatus, String> {
        for _ in 0..10 {
            let result = read_tailscale_status_with(path, timeout).await;
            if result.as_ref().err().map(String::as_str)
                != Some("tailscale status exited with code unknown.")
            {
                return result;
            }
            tokio::task::yield_now().await;
        }

        Err(
            "tailscale status fixture was repeatedly terminated by a concurrent process test."
                .to_owned(),
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_command_reports_success_and_process_failures() {
        let directory = tempfile::tempdir().unwrap();
        let success = executable_script(
            directory.path(),
            "success",
            &format!("printf '%s' '{TAILSCALE_STATUS_JSON}'"),
        );
        assert_eq!(
            read_status_fixture(&success, Duration::from_secs(2))
                .await
                .unwrap()
                .magic_dns_name
                .as_deref(),
            Some("desktop.tail.ts.net")
        );

        let failed = executable_script(directory.path(), "failed", "exit 7");
        assert_eq!(
            read_status_fixture(&failed, Duration::from_secs(1))
                .await
                .unwrap_err(),
            "tailscale status exited with code 7."
        );

        let invalid_utf8 = executable_script(directory.path(), "invalid-utf8", "printf '\\377'");
        assert!(
            read_status_fixture(&invalid_utf8, Duration::from_secs(1))
                .await
                .unwrap_err()
                .contains("non-UTF-8")
        );

        let invalid_json = executable_script(directory.path(), "invalid-json", "printf nope");
        assert!(
            read_status_fixture(&invalid_json, Duration::from_secs(1))
                .await
                .unwrap_err()
                .contains("decode")
        );

        let slow = executable_script(directory.path(), "slow", "sleep 1");
        assert_eq!(
            read_status_fixture(&slow, Duration::from_millis(10))
                .await
                .unwrap_err(),
            "tailscale status timed out after 10ms."
        );

        assert!(
            read_status_fixture(&directory.path().join("missing"), Duration::from_secs(1))
                .await
                .unwrap_err()
                .contains("Failed to spawn")
        );
    }
}
