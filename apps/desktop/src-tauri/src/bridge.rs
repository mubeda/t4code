use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

use crate::backend::{BackendRunConfig, BackendSupervisor};
use crate::config::{
    app_branding, read_json_file, resolve_pick_folder_default_path, state_dir, write_json_file,
};
use crate::context_menu::{
    ContextMenuPosition, NativeContextMenuManager, context_menu_request_from_values,
    context_menu_request_has_selectable_items, show_native_context_menu,
};
use crate::security::{
    CONNECTION_CATALOG_PROTECTION_KIND, protect_string as protect_catalog_string,
    unprotect_string as unprotect_catalog_string,
};
use crate::ssh::{
    SshEnvironmentEnsureOptions, SshEnvironmentManager, SshEnvironmentTarget,
    SshPasswordPromptManager, SshPasswordPromptResolution, default_home_dir, discover_ssh_hosts,
};
use crate::tailscale::{
    TailscaleStatus, build_tailscale_https_base_url, probe_tailscale_https_endpoint,
    read_tailscale_status,
};
use crate::updates::DesktopUpdateManager;

const AUTH_ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE: &str =
    "urn:t4code:params:oauth:token-type:environment-bootstrap";
const AUTH_TOKEN_EXCHANGE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const CLIENT_SETTINGS_FILE_NAME: &str = "client-settings.json";
const CONNECTION_CATALOG_FILE_NAME: &str = "connection-catalog.tauri.json";
const DESKTOP_SETTINGS_FILE_NAME: &str = "desktop-settings.json";
const DEFAULT_TAILSCALE_SERVE_PORT: u16 = 443;
const PRIMARY_LOCAL_ENVIRONMENT_ID: &str = "primary";
const WSL_INSTANCE_ID_PREFIX: &str = "wsl:";
const REMOTE_API_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const TAURI_DESKTOP_BRIDGE_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopSettings {
    server_exposure_mode: String,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    update_channel: String,
    update_channel_configured_by_user: bool,
    wsl_backend_enabled: bool,
    wsl_distro: Option<String>,
    wsl_only: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsDocument {
    server_exposure_mode: Option<String>,
    tailscale_serve_enabled: Option<bool>,
    tailscale_serve_port: Option<u64>,
    update_channel: Option<String>,
    update_channel_configured_by_user: Option<bool>,
    wsl_backend_enabled: Option<bool>,
    wsl_mode: Option<String>,
    wsl_distro: Option<String>,
    wsl_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionCatalogDocument {
    version: Option<u64>,
    catalog: Option<String>,
    encrypted_catalog: Option<String>,
    protection: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WslDistro {
    name: String,
    is_default: bool,
    version: u8,
}

fn bridge_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn environment_endpoint_url(http_base_url: &str, pathname: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(http_base_url)
        .map_err(|error| bridge_error("Could not parse the environment base URL", error))?;
    url.set_path(pathname);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn remote_api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REMOTE_API_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| bridge_error("Could not create the environment HTTP client", error))
}

async fn remote_json_response(
    operation: &str,
    response: reqwest::Response,
) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "[ssh_http:{}] SSH remote API request failed during {operation}.",
            status.as_u16()
        ));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| bridge_error("Could not decode the environment API response", error))
}

async fn remote_get_json(
    operation: &str,
    http_base_url: String,
    pathname: &str,
    bearer_token: Option<String>,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let mut request = client.get(environment_endpoint_url(&http_base_url, pathname)?);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response(operation, response).await
}

async fn remote_post_json(
    operation: &str,
    http_base_url: String,
    pathname: &str,
    bearer_token: Option<String>,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let mut request = client.post(environment_endpoint_url(&http_base_url, pathname)?);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response(operation, response).await
}

fn client_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(CLIENT_SETTINGS_FILE_NAME))
}

fn connection_catalog_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(CONNECTION_CATALOG_FILE_NAME))
}

fn desktop_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(state_dir(app)?.join(DESKTOP_SETTINGS_FILE_NAME))
}

fn default_desktop_settings() -> DesktopSettings {
    DesktopSettings {
        server_exposure_mode: "local-only".to_string(),
        tailscale_serve_enabled: false,
        tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
        update_channel: "latest".to_string(),
        update_channel_configured_by_user: false,
        wsl_backend_enabled: false,
        wsl_distro: None,
        wsl_only: false,
    }
}

fn normalize_server_exposure_mode(value: Option<&str>) -> String {
    match value {
        Some("network-accessible") => "network-accessible".to_string(),
        _ => "local-only".to_string(),
    }
}

fn normalize_update_channel(value: Option<&str>) -> String {
    match value {
        Some("nightly") => "nightly".to_string(),
        _ => "latest".to_string(),
    }
}

fn normalize_tailscale_serve_port(value: Option<u64>) -> u16 {
    match value {
        Some(value) if (1..=u16::MAX as u64).contains(&value) => value as u16,
        _ => DEFAULT_TAILSCALE_SERVE_PORT,
    }
}

fn is_valid_distro_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let Some(last) = value.chars().last() else {
        return false;
    };

    fn is_edge_char(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_'
    }

    is_edge_char(first)
        && is_edge_char(last)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ' || c == '-' || c == '.')
}

fn normalize_wsl_distro(value: Option<String>) -> Option<String> {
    value.filter(|name| is_valid_distro_name(name))
}

fn normalize_desktop_settings_document(document: DesktopSettingsDocument) -> DesktopSettings {
    let update_channel = normalize_update_channel(document.update_channel.as_deref());
    let update_channel_configured_by_user = document
        .update_channel_configured_by_user
        .unwrap_or_else(|| update_channel == "nightly");
    let wsl_backend_enabled = document
        .wsl_backend_enabled
        .unwrap_or_else(|| document.wsl_mode.as_deref() == Some("wsl"));

    DesktopSettings {
        server_exposure_mode: normalize_server_exposure_mode(
            document.server_exposure_mode.as_deref(),
        ),
        tailscale_serve_enabled: document.tailscale_serve_enabled.unwrap_or(false),
        tailscale_serve_port: normalize_tailscale_serve_port(document.tailscale_serve_port),
        update_channel,
        update_channel_configured_by_user,
        wsl_backend_enabled,
        wsl_distro: normalize_wsl_distro(document.wsl_distro),
        wsl_only: document.wsl_only.unwrap_or(false),
    }
}

fn desktop_settings_to_value(settings: &DesktopSettings) -> Value {
    json!({
        "serverExposureMode": &settings.server_exposure_mode,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
        "updateChannel": &settings.update_channel,
        "updateChannelConfiguredByUser": settings.update_channel_configured_by_user,
        "wslBackendEnabled": settings.wsl_backend_enabled,
        "wslDistro": &settings.wsl_distro,
        "wslOnly": settings.wsl_only,
    })
}

fn normalize_client_settings_document(value: Value) -> Value {
    match value {
        Value::Object(mut object) => match object.remove("settings") {
            Some(settings @ Value::Object(_)) => settings,
            _ => Value::Object(object),
        },
        other => other,
    }
}

fn connection_catalog_to_value(catalog: &str) -> Result<Value, String> {
    let encrypted_catalog = protect_catalog_string(catalog)?;
    Ok(json!({
        "version": 1,
        "protection": CONNECTION_CATALOG_PROTECTION_KIND,
        "encryptedCatalog": encrypted_catalog,
    }))
}

fn normalize_connection_catalog_document(value: Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(catalog) => Ok(Some(catalog)),
        value => {
            let document =
                serde_json::from_value::<ConnectionCatalogDocument>(value).map_err(|error| {
                    bridge_error(
                        "Could not decode the Tauri connection catalog document",
                        error,
                    )
                })?;
            match document.version.unwrap_or(1) {
                1 => {
                    if let Some(encrypted_catalog) = document.encrypted_catalog {
                        let Some(protection) = document.protection else {
                            return Ok(None);
                        };
                        if protection != CONNECTION_CATALOG_PROTECTION_KIND {
                            return Err(format!(
                                "Unsupported Tauri connection catalog protection: {protection}"
                            ));
                        }
                        return unprotect_catalog_string(&encrypted_catalog).map(Some);
                    }
                    Ok(document.catalog)
                }
                version => Err(format!(
                    "Unsupported Tauri connection catalog document version: {version}"
                )),
            }
        }
    }
}

fn read_connection_catalog_document(path: &Path) -> Result<Option<String>, String> {
    let Some(value) = read_json_file(path)? else {
        return Ok(None);
    };
    normalize_connection_catalog_document(value)
}

fn write_connection_catalog_document(path: &Path, catalog: &str) -> Result<bool, String> {
    write_json_file(path, &connection_catalog_to_value(catalog)?)?;
    Ok(true)
}

fn clear_connection_catalog_document(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(bridge_error(
            &format!("Could not remove {}", path.display()),
            error,
        )),
    }
}

fn read_desktop_settings(app: &AppHandle) -> Result<DesktopSettings, String> {
    let path = desktop_settings_path(app)?;
    let Some(value) = read_json_file(&path)? else {
        return Ok(default_desktop_settings());
    };
    let document = serde_json::from_value::<DesktopSettingsDocument>(value).unwrap_or_default();
    Ok(normalize_desktop_settings_document(document))
}

fn write_desktop_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let path = desktop_settings_path(app)?;
    write_json_file(&path, &desktop_settings_to_value(settings))
}

fn update_desktop_settings(
    app: &AppHandle,
    update: impl FnOnce(&mut DesktopSettings),
) -> Result<DesktopSettings, String> {
    let mut settings = read_desktop_settings(app)?;
    update(&mut settings);
    write_desktop_settings(app, &settings)?;
    Ok(settings)
}

fn server_exposure_state(settings: &DesktopSettings, config: Option<&BackendRunConfig>) -> Value {
    if let Some(config) = config {
        return json!({
            "mode": &config.server_exposure_mode,
            "endpointUrl": &config.endpoint_url,
            "advertisedHost": &config.advertised_host,
            "tailscaleServeEnabled": config.tailscale_serve_enabled,
            "tailscaleServePort": config.tailscale_serve_port,
        });
    }

    json!({
        "mode": &settings.server_exposure_mode,
        "endpointUrl": null,
        "advertisedHost": null,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
    })
}

fn normalize_http_base_url(raw_value: &str) -> Result<String, String> {
    let mut url = url::Url::parse(raw_value)
        .map_err(|error| bridge_error("Could not parse advertised endpoint URL", error))?;
    match url.scheme() {
        "ws" => {
            url.set_scheme("http")
                .map_err(|_| "Could not normalize ws endpoint URL.".to_string())?;
        }
        "wss" => {
            url.set_scheme("https")
                .map_err(|_| "Could not normalize wss endpoint URL.".to_string())?;
        }
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Endpoint must use HTTP or HTTPS. Received {scheme}:"
            ));
        }
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn derive_ws_base_url(http_base_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(http_base_url).map_err(|error| {
        bridge_error("Could not derive advertised endpoint websocket URL", error)
    })?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        scheme => {
            return Err(format!(
                "Endpoint must use HTTP or HTTPS. Received {scheme}:"
            ));
        }
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not derive advertised endpoint websocket URL.".to_string())?;
    Ok(url.to_string())
}

fn hosted_https_compatibility(http_base_url: &str) -> Result<&'static str, String> {
    let url = url::Url::parse(http_base_url).map_err(|error| {
        bridge_error(
            "Could not inspect advertised endpoint HTTPS compatibility",
            error,
        )
    })?;
    Ok(if url.scheme() == "http" {
        "mixed-content-blocked"
    } else {
        "unknown"
    })
}

fn advertised_endpoint(
    id: String,
    label: &str,
    http_base_url: String,
    reachability: &str,
    is_default: Option<bool>,
    description: &str,
) -> Result<Value, String> {
    let http_base_url = normalize_http_base_url(&http_base_url)?;
    let ws_base_url = derive_ws_base_url(&http_base_url)?;
    let hosted_https_app = hosted_https_compatibility(&http_base_url)?;
    let mut endpoint = json!({
        "id": id,
        "label": label,
        "provider": {
            "id": "desktop-core",
            "label": "Desktop",
            "kind": "core",
            "isAddon": false,
        },
        "httpBaseUrl": http_base_url,
        "wsBaseUrl": ws_base_url,
        "reachability": reachability,
        "compatibility": {
            "hostedHttpsApp": hosted_https_app,
            "desktopApp": "compatible",
        },
        "source": "desktop-core",
        "status": "available",
        "description": description,
    });
    if let Some(is_default) = is_default {
        endpoint["isDefault"] = Value::Bool(is_default);
    }
    Ok(endpoint)
}

fn tailscale_advertised_endpoint(
    id: String,
    label: &str,
    http_base_url: String,
    status: &str,
    hosted_https_app: &str,
    description: &str,
) -> Result<Value, String> {
    let http_base_url = normalize_http_base_url(&http_base_url)?;
    let ws_base_url = derive_ws_base_url(&http_base_url)?;
    Ok(json!({
        "id": id,
        "label": label,
        "provider": {
            "id": "tailscale",
            "label": "Tailscale",
            "kind": "private-network",
            "isAddon": true,
        },
        "httpBaseUrl": http_base_url,
        "wsBaseUrl": ws_base_url,
        "reachability": "private-network",
        "compatibility": {
            "hostedHttpsApp": hosted_https_app,
            "desktopApp": "compatible",
        },
        "source": "desktop-addon",
        "status": status,
        "description": description,
    }))
}

fn advertised_endpoints_for_config(config: &BackendRunConfig) -> Result<Vec<Value>, String> {
    let mut endpoints = vec![advertised_endpoint(
        format!("desktop-loopback:{}", config.port),
        "This machine",
        config.http_base_url(),
        "loopback",
        None,
        "Loopback endpoint for this desktop app.",
    )?];

    if let Some(endpoint_url) = &config.endpoint_url {
        endpoints.push(advertised_endpoint(
            format!("desktop-lan:{endpoint_url}"),
            "Local network",
            endpoint_url.clone(),
            "lan",
            Some(true),
            "Reachable from devices on the same network.",
        )?);
    }

    Ok(endpoints)
}

fn tailscale_endpoints_for_status(
    config: &BackendRunConfig,
    status: &TailscaleStatus,
    magic_dns_reachable: bool,
) -> Result<Vec<Value>, String> {
    let mut endpoints = Vec::new();
    for address in &status.tailnet_ipv4_addresses {
        let http_base_url = format!("http://{address}:{}", config.port);
        endpoints.push(tailscale_advertised_endpoint(
            format!("tailscale-ip:{http_base_url}"),
            "Tailscale IP",
            http_base_url,
            "available",
            "mixed-content-blocked",
            "Reachable from devices on the same Tailnet.",
        )?);
    }

    let Some(magic_dns_name) = &status.magic_dns_name else {
        return Ok(endpoints);
    };
    let http_base_url =
        build_tailscale_https_base_url(magic_dns_name, config.tailscale_serve_port)?;
    endpoints.push(tailscale_advertised_endpoint(
        format!("tailscale-magicdns:{http_base_url}"),
        "Tailscale HTTPS",
        http_base_url,
        if magic_dns_reachable {
            "available"
        } else {
            "unavailable"
        },
        if magic_dns_reachable {
            "compatible"
        } else {
            "requires-configuration"
        },
        if magic_dns_reachable {
            "HTTPS endpoint served by Tailscale Serve."
        } else {
            "MagicDNS hostname. Configure Tailscale Serve for HTTPS access."
        },
    )?);

    Ok(endpoints)
}

async fn tailscale_advertised_endpoints_for_config(
    config: &BackendRunConfig,
) -> Result<Vec<Value>, String> {
    if config.server_exposure_mode != "network-accessible" && !config.tailscale_serve_enabled {
        return Ok(Vec::new());
    }

    let status = match read_tailscale_status().await {
        Ok(status) => status,
        Err(error) => {
            tracing::debug!("Tailscale advertised endpoint discovery skipped: {error}");
            return Ok(Vec::new());
        }
    };
    let magic_dns_reachable = if config.tailscale_serve_enabled {
        match status.magic_dns_name.as_ref() {
            Some(magic_dns_name) => {
                let base_url =
                    build_tailscale_https_base_url(magic_dns_name, config.tailscale_serve_port)?;
                probe_tailscale_https_endpoint(&base_url).await
            }
            None => false,
        }
    } else {
        false
    };

    tailscale_endpoints_for_status(config, &status, magic_dns_reachable)
}

fn decode_command_output(bytes: &[u8]) -> String {
    let has_utf16_bom = bytes.starts_with(&[0xff, 0xfe]);
    let likely_utf16_le = has_utf16_bom
        || bytes
            .iter()
            .take(80)
            .enumerate()
            .filter(|(index, byte)| index % 2 == 1 && **byte == 0)
            .count()
            > 10;

    if likely_utf16_le {
        let code_units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&code_units)
            .trim_start_matches('\u{feff}')
            .to_string()
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn parse_wsl_distro_list(stdout: &[u8]) -> Vec<WslDistro> {
    decode_command_output(stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let raw = line.trim_end();
            if raw.trim().is_empty() {
                return None;
            }
            let is_default = raw.trim_start().starts_with('*');
            let cleaned = raw.trim_start().trim_start_matches('*').trim();
            let fields = cleaned.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 3 {
                return None;
            }
            let version = match fields.last().copied() {
                Some("1") => 1,
                Some("2") => 2,
                _ => return None,
            };
            let name = fields[..fields.len() - 2].join(" ");
            if name.is_empty() {
                return None;
            }
            Some(WslDistro {
                name,
                is_default,
                version,
            })
        })
        .collect()
}

fn read_wsl_environment() -> (bool, Vec<WslDistro>) {
    if !cfg!(target_os = "windows") {
        return (false, Vec::new());
    }

    match Command::new("wsl.exe").args(["-l", "-v"]).output() {
        Ok(output) if output.status.success() => (true, parse_wsl_distro_list(&output.stdout)),
        _ => (false, Vec::new()),
    }
}

fn extract_wsl_distro_from_environment_id(environment_id: &str) -> Option<String> {
    let suffix = environment_id.strip_prefix(WSL_INSTANCE_ID_PREFIX)?;
    if suffix.is_empty() || suffix == "default" {
        return None;
    }
    normalize_wsl_distro(Some(suffix.to_string()))
}

fn is_wsl_pick_folder_target(raw_options: Option<&Value>) -> bool {
    let Some(target_id) = raw_options
        .and_then(|options| options.get("targetEnvironmentId"))
        .and_then(Value::as_str)
    else {
        return false;
    };

    target_id != PRIMARY_LOCAL_ENVIRONMENT_ID && target_id.starts_with(WSL_INSTANCE_ID_PREFIX)
}

fn resolve_wsl_home_unc_path(config_distro: Option<&str>, distros: &[WslDistro]) -> Option<String> {
    let distro_name = config_distro.map(str::to_string).or_else(|| {
        distros
            .iter()
            .find(|distro| distro.is_default)
            .map(|distro| distro.name.clone())
    })?;
    Some(format!("\\\\wsl.localhost\\{distro_name}\\home"))
}

fn wsl_linux_path_to_unc_path(distro_name: &str, linux_path: &str) -> String {
    let path = linux_path.replace('/', "\\");
    format!("\\\\wsl.localhost\\{distro_name}{path}")
}

fn resolve_wsl_pick_folder_default_path(
    raw_options: Option<&Value>,
    config_distro: Option<&str>,
    distros: &[WslDistro],
    user_home: Option<&str>,
) -> Option<PathBuf> {
    let home_path = resolve_wsl_home_unc_path(config_distro, distros);
    let initial_path = raw_options
        .and_then(|options| options.get("initialPath"))
        .and_then(Value::as_str)
        .map(str::trim);
    let Some(initial_path) = initial_path else {
        return home_path.map(PathBuf::from);
    };
    if initial_path.is_empty() {
        return home_path.map(PathBuf::from);
    }
    if initial_path.starts_with("\\\\") {
        return Some(PathBuf::from(initial_path));
    }

    let distro_name = config_distro.map(str::to_string).or_else(|| {
        distros
            .iter()
            .find(|distro| distro.is_default)
            .map(|distro| distro.name.clone())
    })?;
    let normalized_user_home = user_home.filter(|home| home.starts_with('/'));

    if initial_path == "~" {
        return Some(PathBuf::from(match normalized_user_home {
            Some(home) => wsl_linux_path_to_unc_path(&distro_name, home),
            None => home_path?,
        }));
    }
    if let Some(remainder) = initial_path.strip_prefix("~/") {
        return Some(PathBuf::from(match normalized_user_home {
            Some(home) => wsl_linux_path_to_unc_path(&distro_name, &format!("{home}/{remainder}")),
            None => format!("{}\\{}", home_path?, remainder.replace('/', "\\")),
        }));
    }
    if initial_path.starts_with('/') {
        return Some(PathBuf::from(wsl_linux_path_to_unc_path(
            &distro_name,
            initial_path,
        )));
    }

    home_path.map(PathBuf::from)
}

fn wsl_unc_path_to_linux_path(windows_path: &str) -> Option<String> {
    let trimmed = windows_path.trim();
    let without_prefix = trimmed
        .strip_prefix("\\\\wsl.localhost\\")
        .or_else(|| trimmed.strip_prefix("\\\\WSL.LOCALHOST\\"))
        .or_else(|| trimmed.strip_prefix("\\\\wsl$\\"))
        .or_else(|| trimmed.strip_prefix("\\\\WSL$\\"))?;
    let mut parts = without_prefix.split('\\');
    let distro = parts.next()?;
    if !is_valid_distro_name(distro) {
        return None;
    }
    let rest = parts.filter(|part| !part.is_empty()).collect::<Vec<_>>();
    if rest.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", rest.join("/")))
    }
}

fn resolve_pick_folder_dialog_default_path(
    app: &AppHandle,
    settings: &DesktopSettings,
    raw_options: Option<&Value>,
) -> Option<PathBuf> {
    if !is_wsl_pick_folder_target(raw_options) {
        return resolve_pick_folder_default_path(app, raw_options);
    }

    let target_distro = raw_options
        .and_then(|options| options.get("targetEnvironmentId"))
        .and_then(Value::as_str)
        .and_then(extract_wsl_distro_from_environment_id)
        .or_else(|| settings.wsl_distro.clone());
    let (_, distros) = read_wsl_environment();
    resolve_wsl_pick_folder_default_path(raw_options, target_distro.as_deref(), &distros, None)
}

fn wsl_state(settings: &DesktopSettings) -> Value {
    let (available, distros) = read_wsl_environment();
    json!({
        "enabled": settings.wsl_backend_enabled,
        "distro": &settings.wsl_distro,
        "available": available,
        "wslOnly": settings.wsl_only,
        "distros": distros,
        "preflightError": null,
    })
}

fn desktop_theme_to_tauri_theme(theme: &str) -> Result<Option<tauri::Theme>, String> {
    match theme {
        "system" => Ok(None),
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        _ => Err(format!("Unsupported desktop theme: {theme}")),
    }
}

#[tauri::command]
pub fn desktop_bridge_get_bridge_metadata() -> Value {
    json!({
        "host": "tauri",
        "bridgeVersion": TAURI_DESKTOP_BRIDGE_VERSION,
        "features": {
            "localBackend": true,
            "localBearerToken": true,
            "clientSettings": true,
            "serverExposure": true,
            "wslDiscovery": true,
            "sshRemoteHttp": true,
            "connectionCatalog": true,
            "sshProvisioning": true,
            "preview": false,
            "updater": false,
            "menuEvents": true,
        },
    })
}

#[tauri::command]
pub fn desktop_bridge_get_app_branding(app: AppHandle) -> Option<Value> {
    Some(app_branding(&app))
}

#[tauri::command]
pub fn desktop_bridge_get_local_environment_bootstraps(
    backend: State<'_, BackendSupervisor>,
) -> Vec<Value> {
    backend.local_environment_bootstraps()
}

#[tauri::command]
pub fn desktop_bridge_get_client_settings(app: AppHandle) -> Result<Option<Value>, String> {
    let path = client_settings_path(&app)?;
    read_json_file(&path).map(|value| value.map(normalize_client_settings_document))
}

#[tauri::command]
pub fn desktop_bridge_set_client_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    let path = client_settings_path(&app)?;
    write_json_file(&path, &settings)
}

#[tauri::command]
pub fn desktop_bridge_get_connection_catalog(app: AppHandle) -> Result<Option<String>, String> {
    let path = connection_catalog_path(&app)?;
    read_connection_catalog_document(&path)
}

#[tauri::command]
pub fn desktop_bridge_set_connection_catalog(
    app: AppHandle,
    catalog: String,
) -> Result<bool, String> {
    let path = connection_catalog_path(&app)?;
    write_connection_catalog_document(&path, &catalog)
}

#[tauri::command]
pub fn desktop_bridge_clear_connection_catalog(app: AppHandle) -> Result<(), String> {
    let path = connection_catalog_path(&app)?;
    clear_connection_catalog_document(&path)
}

#[tauri::command]
pub async fn desktop_bridge_fetch_environment_descriptor(
    http_base_url: String,
) -> Result<Value, String> {
    remote_get_json(
        "fetch-environment-descriptor",
        http_base_url,
        "/.well-known/t4code/environment",
        None,
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_bootstrap_ssh_bearer_session(
    http_base_url: String,
    credential: String,
) -> Result<Value, String> {
    let client = remote_api_client()?;
    let response = client
        .post(environment_endpoint_url(&http_base_url, "/oauth/token")?)
        .form(&[
            ("grant_type", AUTH_TOKEN_EXCHANGE_GRANT_TYPE.to_string()),
            ("subject_token", credential),
            (
                "subject_token_type",
                AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE.to_string(),
            ),
            ("requested_token_type", AUTH_ACCESS_TOKEN_TYPE.to_string()),
            ("client_label", "T4Code Tauri Desktop".to_string()),
            ("client_device_type", "desktop".to_string()),
        ])
        .send()
        .await
        .map_err(|error| bridge_error("Could not reach the environment API", error))?;
    remote_json_response("bootstrap-bearer-session", response).await
}

#[tauri::command]
pub async fn desktop_bridge_fetch_ssh_session_state(
    http_base_url: String,
    bearer_token: String,
) -> Result<Value, String> {
    remote_get_json(
        "fetch-session-state",
        http_base_url,
        "/api/auth/session",
        Some(bearer_token),
    )
    .await
}

#[tauri::command]
pub async fn desktop_bridge_issue_ssh_web_socket_ticket(
    http_base_url: String,
    bearer_token: String,
) -> Result<Value, String> {
    remote_post_json(
        "issue-websocket-ticket",
        http_base_url,
        "/api/auth/websocket-ticket",
        Some(bearer_token),
    )
    .await
}

#[tauri::command]
pub fn desktop_bridge_get_server_exposure_state(
    app: AppHandle,
    backend: State<'_, BackendSupervisor>,
) -> Result<Value, String> {
    read_desktop_settings(&app)
        .map(|settings| server_exposure_state(&settings, backend.current_run_config().as_ref()))
}

#[tauri::command]
pub async fn desktop_bridge_set_server_exposure_mode(
    app: AppHandle,
    backend: State<'_, BackendSupervisor>,
    mode: String,
) -> Result<Value, String> {
    if !matches!(mode.as_str(), "local-only" | "network-accessible") {
        return Err(format!("Unsupported server exposure mode: {mode}"));
    }
    let settings = update_desktop_settings(&app, |settings| {
        settings.server_exposure_mode = mode;
    })?;
    let restarted_config = backend.restart_default_if_active(app.clone()).await?;
    let current_config = restarted_config.or_else(|| backend.current_run_config());
    Ok(server_exposure_state(&settings, current_config.as_ref()))
}

#[tauri::command]
pub async fn desktop_bridge_set_tailscale_serve_enabled(
    app: AppHandle,
    backend: State<'_, BackendSupervisor>,
    input: Value,
) -> Result<Value, String> {
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_port = input.get("port").and_then(Value::as_u64);
    let settings = update_desktop_settings(&app, |settings| {
        settings.tailscale_serve_enabled = enabled;
        settings.tailscale_serve_port = normalize_tailscale_serve_port(
            requested_port.or(Some(settings.tailscale_serve_port as u64)),
        );
    })?;
    let restarted_config = backend.restart_default_if_active(app.clone()).await?;
    let current_config = restarted_config.or_else(|| backend.current_run_config());
    Ok(server_exposure_state(&settings, current_config.as_ref()))
}

#[tauri::command]
pub fn desktop_bridge_get_wsl_state(app: AppHandle) -> Result<Value, String> {
    read_desktop_settings(&app).map(|settings| wsl_state(&settings))
}

#[tauri::command]
pub fn desktop_bridge_set_wsl_backend_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    update_desktop_settings(&app, |settings| {
        settings.wsl_backend_enabled = enabled;
        if !enabled {
            settings.wsl_only = false;
        }
    })
    .map(|settings| wsl_state(&settings))
}

#[tauri::command]
pub fn desktop_bridge_set_wsl_distro(
    app: AppHandle,
    distro: Option<String>,
) -> Result<Value, String> {
    update_desktop_settings(&app, |settings| {
        settings.wsl_distro = normalize_wsl_distro(distro);
    })
    .map(|settings| wsl_state(&settings))
}

#[tauri::command]
pub fn desktop_bridge_set_wsl_only(app: AppHandle, enabled: bool) -> Result<Value, String> {
    update_desktop_settings(&app, |settings| {
        settings.wsl_only = enabled;
    })
    .map(|settings| wsl_state(&settings))
}

#[tauri::command]
pub fn desktop_bridge_get_update_state(
    app: AppHandle,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    read_desktop_settings(&app).map(|settings| updates.state(&app, &settings.update_channel))
}

#[tauri::command]
pub fn desktop_bridge_set_update_channel(
    app: AppHandle,
    updates: State<'_, DesktopUpdateManager>,
    channel: String,
) -> Result<Value, String> {
    if !matches!(channel.as_str(), "latest" | "nightly") {
        return Err(format!("Unsupported update channel: {channel}"));
    }
    update_desktop_settings(&app, |settings| {
        settings.update_channel = channel;
        settings.update_channel_configured_by_user = true;
    })
    .map(|settings| updates.state(&app, &settings.update_channel))
}

fn dialog_file_path_to_string(path: tauri_plugin_dialog::FilePath) -> Result<String, String> {
    path.simplified()
        .into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| bridge_error("Could not normalize the selected path", error))
}

#[tauri::command]
pub fn desktop_bridge_pick_folder(
    app: AppHandle,
    options: Option<Value>,
) -> Result<Option<String>, String> {
    let title = options
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Select Folder");

    let settings = read_desktop_settings(&app)?;
    let use_wsl = is_wsl_pick_folder_target(options.as_ref());
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(default_path) =
        resolve_pick_folder_dialog_default_path(&app, &settings, options.as_ref())
    {
        dialog = dialog.set_directory(default_path);
    }

    let selected = dialog
        .blocking_pick_folder()
        .map(dialog_file_path_to_string)
        .transpose()?;

    Ok(selected.map(|path| {
        if use_wsl {
            wsl_unc_path_to_linux_path(&path).unwrap_or(path)
        } else {
            path
        }
    }))
}

#[tauri::command]
pub fn desktop_bridge_confirm(app: AppHandle, message: String) -> bool {
    app.dialog()
        .message(message)
        .title("T4Code")
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

#[tauri::command]
pub fn desktop_bridge_open_external(app: AppHandle, url: String) -> Result<bool, String> {
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    match parsed.scheme() {
        "http" | "https" => app
            .opener()
            .open_url(parsed.as_str(), None::<&str>)
            .map(|_| true)
            .map_err(|error| error.to_string()),
        _ => Ok(false),
    }
}

#[tauri::command]
pub fn desktop_bridge_discover_ssh_hosts(app: AppHandle) -> Result<Vec<Value>, String> {
    let home_dir = app.path().home_dir().ok().or_else(default_home_dir);
    discover_ssh_hosts(home_dir)
        .map(|hosts| hosts.into_iter().map(|host| host.to_value()).collect())
}

#[tauri::command]
pub async fn desktop_bridge_ensure_ssh_environment(
    app: AppHandle,
    ssh: State<'_, SshEnvironmentManager>,
    prompts: State<'_, SshPasswordPromptManager>,
    target: SshEnvironmentTarget,
    options: Option<SshEnvironmentEnsureOptions>,
) -> Result<Value, String> {
    let bootstrap = ssh
        .ensure_environment(&app, &prompts, target, options)
        .await?;
    serde_json::to_value(bootstrap)
        .map_err(|error| bridge_error("Could not encode SSH environment bootstrap", error))
}

#[tauri::command]
pub async fn desktop_bridge_disconnect_ssh_environment(
    app: AppHandle,
    ssh: State<'_, SshEnvironmentManager>,
    prompts: State<'_, SshPasswordPromptManager>,
    target: SshEnvironmentTarget,
) -> Result<(), String> {
    ssh.disconnect_environment(&app, &prompts, target).await
}

#[tauri::command]
pub fn desktop_bridge_resolve_ssh_password_prompt(
    prompts: State<'_, SshPasswordPromptManager>,
    request_id: String,
    password: Option<String>,
) -> Result<(), String> {
    prompts
        .resolve(SshPasswordPromptResolution {
            request_id,
            password,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_bridge_get_advertised_endpoints(
    backend: State<'_, BackendSupervisor>,
) -> Result<Vec<Value>, String> {
    let Some(config) = backend.current_run_config() else {
        return Ok(Vec::new());
    };
    let mut endpoints = advertised_endpoints_for_config(&config)?;
    endpoints.extend(tailscale_advertised_endpoints_for_config(&config).await?);
    Ok(endpoints)
}

#[tauri::command]
pub fn desktop_bridge_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let native_theme = desktop_theme_to_tauri_theme(&theme)?;
    for window in app.webview_windows().values() {
        window
            .set_theme(native_theme)
            .map_err(|error| bridge_error("Could not update the Tauri window theme", error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_bridge_show_context_menu(
    app: AppHandle,
    context_menus: State<'_, NativeContextMenuManager>,
    items: Vec<Value>,
    position: Option<ContextMenuPosition>,
) -> Result<Option<String>, String> {
    let request = context_menu_request_from_values(items);
    if !context_menu_request_has_selectable_items(&request) {
        return Ok(None);
    }

    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let ticket = context_menus.begin(&request)?;
    if let Err(error) = show_native_context_menu(&window, &request, position) {
        context_menus.cancel(&ticket.request_id);
        return Err(error);
    }

    Ok(context_menus.finish_after_popup(ticket).await)
}

#[tauri::command]
pub async fn desktop_bridge_check_for_update(
    app: AppHandle,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    let settings = read_desktop_settings(&app)?;
    Ok(updates
        .check_for_update(app, &settings.update_channel)
        .await)
}

#[tauri::command]
pub async fn desktop_bridge_download_update(
    app: AppHandle,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    let settings = read_desktop_settings(&app)?;
    Ok(updates.download_update(app, &settings.update_channel).await)
}

#[tauri::command]
pub fn desktop_bridge_install_update(
    app: AppHandle,
    updates: State<'_, DesktopUpdateManager>,
) -> Result<Value, String> {
    let settings = read_desktop_settings(&app)?;
    Ok(updates.install_update(&app, &settings.update_channel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn read_test_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout should be configured");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];

        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    bytes.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&bytes);
                    let Some(header_end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let content_length = text
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    let body_start = header_end + 4;
                    if bytes.len().saturating_sub(body_start) >= content_length {
                        break;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(error) => panic!("test server failed to read request: {error}"),
            }
        }

        String::from_utf8(bytes).expect("request should be valid utf-8")
    }

    fn spawn_json_test_server(body: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("test server should bind loopback");
        let address = listener
            .local_addr()
            .expect("test server address should resolve");
        let (sender, receiver) = mpsc::channel();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test server should accept");
            let request = read_test_http_request(&mut stream);
            sender.send(request).expect("request should be observed");
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("test server should respond");
        });

        (format!("http://{address}"), receiver)
    }

    fn unique_test_path(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "t4code-tauri-bridge-{name}-{}-{suffix}.json",
            std::process::id()
        ))
    }

    #[test]
    fn normalizes_legacy_client_settings_documents() {
        let value = serde_json::json!({
            "settings": {
                "wordWrap": false
            }
        });

        assert_eq!(
            normalize_client_settings_document(value),
            serde_json::json!({
                "wordWrap": false
            })
        );
    }

    #[test]
    fn leaves_plain_client_settings_documents_unchanged() {
        let value = serde_json::json!({
            "wordWrap": true,
            "timestampFormat": "24-hour"
        });

        assert_eq!(normalize_client_settings_document(value.clone()), value);
    }

    #[test]
    fn writes_and_reads_json_files() {
        let path = unique_test_path("settings");
        let value = serde_json::json!({
            "wordWrap": false,
            "timestampFormat": "12-hour"
        });

        write_json_file(&path, &value).expect("settings should write");
        let read = read_json_file(&path).expect("settings should read");

        assert_eq!(read, Some(value));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_json_files_return_none() {
        let path = unique_test_path("missing");
        assert_eq!(read_json_file(&path).expect("read should not fail"), None);
    }

    #[test]
    fn normalizes_connection_catalog_documents() {
        assert_eq!(
            normalize_connection_catalog_document(serde_json::json!({
                "version": 1,
                "catalog": "{\"connections\":[]}"
            }))
            .expect("document should decode"),
            Some("{\"connections\":[]}".to_string())
        );
        assert_eq!(
            normalize_connection_catalog_document(Value::String("legacy-catalog".to_string()))
                .expect("string document should decode"),
            Some("legacy-catalog".to_string())
        );
        assert_eq!(
            normalize_connection_catalog_document(serde_json::json!({
                "version": 1,
                "encryptedCatalog": "unsupported-host-owned"
            }))
            .expect("unsupported protected document should not be imported"),
            None
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn protects_connection_catalog_documents() {
        let catalog = "{\"connections\":[{\"id\":\"local\"}]}";
        let value = connection_catalog_to_value(catalog).expect("catalog should protect");

        assert_eq!(value["version"], 1);
        assert_eq!(value["protection"], CONNECTION_CATALOG_PROTECTION_KIND);
        assert!(value["encryptedCatalog"].as_str().is_some());
        assert!(value.get("catalog").is_none());
        assert_eq!(
            normalize_connection_catalog_document(value).expect("catalog should unprotect"),
            Some(catalog.to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn writes_reads_and_clears_protected_connection_catalog_documents() {
        let path = unique_test_path("catalog");
        let catalog = "{\"connections\":[{\"id\":\"local\"}]}";

        assert!(write_connection_catalog_document(&path, catalog).expect("catalog should write"));
        assert_eq!(
            read_connection_catalog_document(&path).expect("catalog should read"),
            Some(catalog.to_string())
        );

        clear_connection_catalog_document(&path).expect("catalog should clear");
        assert_eq!(
            read_connection_catalog_document(&path).expect("cleared catalog should read"),
            None
        );
    }

    #[test]
    fn normalizes_desktop_settings_with_legacy_wsl_mode() {
        let settings = normalize_desktop_settings_document(DesktopSettingsDocument {
            server_exposure_mode: Some("network-accessible".to_string()),
            tailscale_serve_enabled: Some(true),
            tailscale_serve_port: Some(8443),
            update_channel: Some("nightly".to_string()),
            update_channel_configured_by_user: None,
            wsl_backend_enabled: None,
            wsl_mode: Some("wsl".to_string()),
            wsl_distro: Some("Ubuntu-24.04".to_string()),
            wsl_only: Some(true),
        });

        assert_eq!(
            settings,
            DesktopSettings {
                server_exposure_mode: "network-accessible".to_string(),
                tailscale_serve_enabled: true,
                tailscale_serve_port: 8443,
                update_channel: "nightly".to_string(),
                update_channel_configured_by_user: true,
                wsl_backend_enabled: true,
                wsl_distro: Some("Ubuntu-24.04".to_string()),
                wsl_only: true,
            }
        );
    }

    #[test]
    fn invalid_desktop_settings_fall_back_to_safe_defaults() {
        let settings = normalize_desktop_settings_document(DesktopSettingsDocument {
            server_exposure_mode: Some("public-internet".to_string()),
            tailscale_serve_enabled: Some(true),
            tailscale_serve_port: Some(70_000),
            update_channel: Some("beta".to_string()),
            update_channel_configured_by_user: Some(false),
            wsl_backend_enabled: Some(false),
            wsl_mode: Some("wsl".to_string()),
            wsl_distro: Some(" Ubuntu ".to_string()),
            wsl_only: Some(false),
        });

        assert_eq!(
            settings,
            DesktopSettings {
                server_exposure_mode: "local-only".to_string(),
                tailscale_serve_enabled: true,
                tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
                update_channel: "latest".to_string(),
                update_channel_configured_by_user: false,
                wsl_backend_enabled: false,
                wsl_distro: None,
                wsl_only: false,
            }
        );
    }

    #[test]
    fn parses_utf8_wsl_distro_list() {
        let output = b"  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  Debian Test            Stopped         1\r\n";

        assert_eq!(
            parse_wsl_distro_list(output),
            vec![
                WslDistro {
                    name: "Ubuntu-24.04".to_string(),
                    is_default: true,
                    version: 2,
                },
                WslDistro {
                    name: "Debian Test".to_string(),
                    is_default: false,
                    version: 1,
                },
            ]
        );
    }

    #[test]
    fn parses_utf16_wsl_distro_list() {
        let text =
            "  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));

        assert_eq!(
            parse_wsl_distro_list(&bytes),
            vec![WslDistro {
                name: "Ubuntu".to_string(),
                is_default: true,
                version: 2,
            }]
        );
    }

    #[test]
    fn resolves_wsl_pick_folder_default_paths() {
        let distros = vec![WslDistro {
            name: "Debian".to_string(),
            is_default: true,
            version: 2,
        }];

        assert_eq!(
            resolve_wsl_pick_folder_default_path(None, None, &distros, None)
                .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "/home/josh/project" })),
                None,
                &distros,
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home\\josh\\project".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "~/project" })),
                None,
                &distros,
                Some("/home/josh"),
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Debian\\home\\josh\\project".to_string())
        );
        assert_eq!(
            resolve_wsl_pick_folder_default_path(
                Some(&json!({ "initialPath": "\\\\wsl.localhost\\Ubuntu\\home\\josh" })),
                None,
                &distros,
                None,
            )
            .map(|path| path.to_string_lossy().into_owned()),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\josh".to_string())
        );
    }

    #[test]
    fn maps_wsl_unc_paths_back_to_linux_paths() {
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo"),
            Some("/home/josh/repo".to_string())
        );
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl$\\Debian"),
            Some("/".to_string())
        );
        assert_eq!(
            wsl_unc_path_to_linux_path("\\\\wsl.localhost\\bad!name\\home"),
            None
        );
        assert_eq!(wsl_unc_path_to_linux_path("C:\\Users\\Mauro\\repo"), None);
    }

    #[test]
    fn detects_wsl_picker_targets() {
        assert!(is_wsl_pick_folder_target(Some(&json!({
            "targetEnvironmentId": "wsl:Ubuntu"
        }))));
        assert!(is_wsl_pick_folder_target(Some(&json!({
            "targetEnvironmentId": "wsl:default"
        }))));
        assert!(!is_wsl_pick_folder_target(Some(&json!({
            "targetEnvironmentId": "primary"
        }))));
        assert!(!is_wsl_pick_folder_target(None));
        assert_eq!(
            extract_wsl_distro_from_environment_id("wsl:Ubuntu-22.04"),
            Some("Ubuntu-22.04".to_string())
        );
        assert_eq!(extract_wsl_distro_from_environment_id("wsl:default"), None);
    }

    #[test]
    fn bridge_metadata_reports_version_and_feature_flags() {
        let metadata = desktop_bridge_get_bridge_metadata();

        assert_eq!(metadata["host"], "tauri");
        assert_eq!(metadata["bridgeVersion"], 1);
        assert_eq!(metadata["features"]["localBackend"], true);
        assert_eq!(metadata["features"]["connectionCatalog"], true);
        assert_eq!(metadata["features"]["preview"], false);
        assert_eq!(metadata["features"]["sshProvisioning"], true);
        assert_eq!(metadata["features"]["menuEvents"], true);
    }

    #[test]
    fn builds_tailscale_advertised_endpoints_from_status() {
        let config = BackendRunConfig {
            environment_id: "primary".to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port: 13773,
            bind_host: "0.0.0.0".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "network-accessible".to_string(),
            endpoint_url: Some("http://192.168.1.20:13773".to_string()),
            advertised_host: Some("192.168.1.20".to_string()),
            tailscale_serve_enabled: true,
            tailscale_serve_port: 8443,
        };
        let status = TailscaleStatus {
            magic_dns_name: Some("desktop.tail.ts.net".to_string()),
            tailnet_ipv4_addresses: vec!["100.100.100.100".to_string()],
        };

        let endpoints =
            tailscale_endpoints_for_status(&config, &status, true).expect("endpoints should build");

        assert_eq!(endpoints.len(), 2);
        assert_eq!(
            endpoints[0]["id"],
            "tailscale-ip:http://100.100.100.100:13773"
        );
        assert_eq!(endpoints[0]["provider"]["id"], "tailscale");
        assert_eq!(endpoints[0]["provider"]["kind"], "private-network");
        assert_eq!(endpoints[0]["source"], "desktop-addon");
        assert_eq!(endpoints[0]["status"], "available");
        assert_eq!(endpoints[0]["httpBaseUrl"], "http://100.100.100.100:13773/");
        assert_eq!(endpoints[0]["wsBaseUrl"], "ws://100.100.100.100:13773/");
        assert_eq!(
            endpoints[0]["compatibility"]["hostedHttpsApp"],
            "mixed-content-blocked"
        );

        assert_eq!(
            endpoints[1]["id"],
            "tailscale-magicdns:https://desktop.tail.ts.net:8443/"
        );
        assert_eq!(endpoints[1]["label"], "Tailscale HTTPS");
        assert_eq!(
            endpoints[1]["httpBaseUrl"],
            "https://desktop.tail.ts.net:8443/"
        );
        assert_eq!(endpoints[1]["wsBaseUrl"], "wss://desktop.tail.ts.net:8443/");
        assert_eq!(endpoints[1]["status"], "available");
        assert_eq!(
            endpoints[1]["compatibility"]["hostedHttpsApp"],
            "compatible"
        );
    }

    #[test]
    fn marks_unprobed_tailscale_magic_dns_as_requires_configuration() {
        let config = BackendRunConfig {
            environment_id: "primary".to_string(),
            label: "Local".to_string(),
            running_distro: None,
            port: 13773,
            bind_host: "127.0.0.1".to_string(),
            local_host: "127.0.0.1".to_string(),
            desktop_bootstrap_token: "desktop-token".to_string(),
            server_exposure_mode: "local-only".to_string(),
            endpoint_url: None,
            advertised_host: None,
            tailscale_serve_enabled: false,
            tailscale_serve_port: 443,
        };
        let status = TailscaleStatus {
            magic_dns_name: Some("desktop.tail.ts.net".to_string()),
            tailnet_ipv4_addresses: Vec::new(),
        };

        let endpoints =
            tailscale_endpoints_for_status(&config, &status, false).expect("endpoint should build");

        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0]["httpBaseUrl"], "https://desktop.tail.ts.net/");
        assert_eq!(endpoints[0]["status"], "unavailable");
        assert_eq!(
            endpoints[0]["compatibility"]["hostedHttpsApp"],
            "requires-configuration"
        );
    }

    #[test]
    fn maps_desktop_theme_values_to_tauri_theme() {
        assert_eq!(
            desktop_theme_to_tauri_theme("system").expect("system theme"),
            None
        );
        assert_eq!(
            desktop_theme_to_tauri_theme("light").expect("light theme"),
            Some(tauri::Theme::Light)
        );
        assert_eq!(
            desktop_theme_to_tauri_theme("dark").expect("dark theme"),
            Some(tauri::Theme::Dark)
        );

        let error = desktop_theme_to_tauri_theme("sepia").expect_err("invalid theme");
        assert!(error.contains("Unsupported desktop theme"));
    }

    #[tokio::test]
    async fn fetch_environment_descriptor_requests_well_known_endpoint() {
        let (base_url, requests) = spawn_json_test_server(r#"{"environmentId":"env-tauri"}"#);

        let descriptor = desktop_bridge_fetch_environment_descriptor(base_url)
            .await
            .expect("descriptor request should succeed");

        assert_eq!(
            descriptor,
            serde_json::json!({ "environmentId": "env-tauri" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("GET /.well-known/t4code/environment HTTP/1.1"));
    }

    #[tokio::test]
    async fn bootstrap_ssh_bearer_session_posts_oauth_token_exchange() {
        let (base_url, requests) =
            spawn_json_test_server(r#"{"access_token":"bearer-token","token_type":"Bearer"}"#);

        let session =
            desktop_bridge_bootstrap_ssh_bearer_session(base_url, "bootstrap-token".to_string())
                .await
                .expect("bootstrap request should succeed");

        assert_eq!(
            session,
            serde_json::json!({ "access_token": "bearer-token", "token_type": "Bearer" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("POST /oauth/token HTTP/1.1"));
        assert!(request.contains("subject_token=bootstrap-token"));
        assert!(
            request
                .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange")
        );
        assert!(request.contains("client_label=T4Code+Tauri+Desktop"));
    }

    #[tokio::test]
    async fn issue_web_socket_ticket_sends_bearer_authorization() {
        let (base_url, requests) =
            spawn_json_test_server(r#"{"ticket":"ticket-1","expiresAt":"2026-07-08T00:00:00Z"}"#);

        let ticket =
            desktop_bridge_issue_ssh_web_socket_ticket(base_url, "bearer-token".to_string())
                .await
                .expect("ticket request should succeed");

        assert_eq!(
            ticket,
            serde_json::json!({ "ticket": "ticket-1", "expiresAt": "2026-07-08T00:00:00Z" })
        );
        let request = requests.recv().expect("request should be captured");
        assert!(request.starts_with("POST /api/auth/websocket-ticket HTTP/1.1"));
        assert!(request.contains("authorization: Bearer bearer-token"));
    }
}
