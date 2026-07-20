use std::time::Duration;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacosWebviewOps as Platform;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WindowsWebviewOps as Platform;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::LinuxWebviewOps as Platform;

#[derive(Debug, Clone, Copy)]
pub struct ClearDataKinds {
    pub cookies: bool,
    pub cache: bool,
    pub storage: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewPlatformError {
    #[error("preview platform unavailable: {0}")]
    Unavailable(String),
    #[error("preview platform call timed out")]
    Timeout,
    #[error("preview javascript error: {0}")]
    Js(String),
}

pub trait PlatformWebviewOps {
    fn eval_json(
        webview: &tauri::Webview,
        js: &str,
        timeout: Duration,
    ) -> Result<String, PreviewPlatformError>;
    fn title(webview: &tauri::Webview) -> Result<String, PreviewPlatformError>;
    fn can_go_back(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn can_go_forward(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn go_back(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn go_forward(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn hard_reload(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn screenshot_png(
        webview: &tauri::Webview,
        timeout: Duration,
    ) -> Result<Vec<u8>, PreviewPlatformError>;
    fn clear_data(
        webview: &tauri::Webview,
        kinds: ClearDataKinds,
    ) -> Result<(), PreviewPlatformError>;
}

/// Wrap arbitrary JS so the completion value is always a JSON envelope.
pub fn json_envelope(js: &str) -> String {
    format!(
        "(function(){{ try {{ return JSON.stringify({{ ok: (function(){{ return ({js}); }})() }}) ?? '{{\"ok\":null}}'; }} catch (e) {{ return JSON.stringify({{ err: String((e && e.message) || e) }}); }} }})()"
    )
}

#[cfg(test)]
mod tests {
    use super::json_envelope;

    #[test]
    fn envelope_wraps_expression() {
        let js = json_envelope("1 + 1");
        assert!(js.contains("1 + 1"));
        assert!(js.contains("JSON.stringify"));
    }
}
