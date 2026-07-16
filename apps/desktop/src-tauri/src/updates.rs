use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::config::{app_version, runtime_info};

const UPDATE_STATE_EVENT: &str = "desktop:update-state";
const STATUS_DISABLED: &str = "disabled";
const STATUS_IDLE: &str = "idle";
const STATUS_CHECKING: &str = "checking";
const STATUS_UP_TO_DATE: &str = "up-to-date";
const STATUS_AVAILABLE: &str = "available";
const STATUS_DOWNLOADING: &str = "downloading";
const STATUS_DOWNLOADED: &str = "downloaded";
const STATUS_ERROR: &str = "error";

struct DownloadedUpdate {
    update: Update,
    version: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct DesktopUpdateInner {
    available_update: Option<Update>,
    available_version: Option<String>,
    downloaded_update: Option<DownloadedUpdate>,
    downloaded_version: Option<String>,
    status: Option<String>,
    download_percent: Option<f64>,
    checked_at: Option<String>,
    message: Option<String>,
    error_context: Option<&'static str>,
    can_retry: bool,
}

#[derive(Default)]
pub struct DesktopUpdateManager {
    inner: Mutex<DesktopUpdateInner>,
}

impl DesktopUpdateManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self, app: &AppHandle, channel: &str) -> Value {
        let inner = self.inner.lock().expect("desktop update mutex poisoned");
        match app.updater() {
            Ok(_) => update_state_value(app, channel, true, &inner),
            Err(error) if is_updater_disabled(&error) => disabled_update_state(app, channel),
            Err(error) => error_update_state(app, channel, "check", error.to_string()),
        }
    }

    pub async fn check_for_update(&self, app: AppHandle, channel: &str) -> Value {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) if is_updater_disabled(&error) => {
                return disabled_update_check_result(disabled_update_state(&app, channel));
            }
            Err(error) => {
                let state = self.record_error_state(&app, channel, "check", error.to_string());
                return json!({
                    "checked": false,
                    "state": state,
                });
            }
        };

        self.replace_inner(|inner| {
            inner.status = Some(STATUS_CHECKING.to_string());
            inner.message = None;
            inner.error_context = None;
            inner.can_retry = false;
        })
        .emit(&app, channel);

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let checked_at = now_rfc3339();
                let state = self.replace_inner(|inner| {
                    inner.available_version = Some(version.clone());
                    inner.available_update = Some(update);
                    inner.downloaded_update = None;
                    inner.downloaded_version = None;
                    inner.download_percent = None;
                    inner.status = Some(STATUS_AVAILABLE.to_string());
                    inner.checked_at = Some(checked_at);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app, channel);
                json!({
                    "checked": true,
                    "state": update_state,
                })
            }
            Ok(None) => {
                let checked_at = now_rfc3339();
                let state = self.replace_inner(|inner| {
                    inner.available_update = None;
                    inner.available_version = None;
                    inner.downloaded_update = None;
                    inner.downloaded_version = None;
                    inner.download_percent = None;
                    inner.status = Some(STATUS_UP_TO_DATE.to_string());
                    inner.checked_at = Some(checked_at);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app, channel);
                json!({
                    "checked": true,
                    "state": update_state,
                })
            }
            Err(error) => {
                let state = self.record_error_state(&app, channel, "check", error.to_string());
                json!({
                    "checked": false,
                    "state": state,
                })
            }
        }
    }

    pub async fn download_update(&self, app: AppHandle, channel: &str) -> Value {
        if let Err(error) = app.updater() {
            if is_updater_disabled(&error) {
                return disabled_update_action_result(disabled_update_state(&app, channel));
            }
            let state = self.record_error_state(&app, channel, "download", error.to_string());
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        }

        let Some(update) = self
            .inner
            .lock()
            .expect("desktop update mutex poisoned")
            .available_update
            .clone()
        else {
            let state = self.record_error_state(
                &app,
                channel,
                "download",
                "No checked update is available to download.".to_string(),
            );
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        };

        let version = update.version.clone();
        let channel = channel.to_string();
        self.replace_inner(|inner| {
            inner.status = Some(STATUS_DOWNLOADING.to_string());
            inner.download_percent = Some(0.0);
            inner.message = None;
            inner.error_context = None;
            inner.can_retry = false;
        })
        .emit(&app, &channel);

        let mut downloaded_bytes = 0_u64;
        let progress_app = app.clone();
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                    if let Some(total_bytes) = content_length.filter(|value| *value > 0) {
                        let percent = ((downloaded_bytes as f64 / total_bytes as f64) * 100.0)
                            .clamp(0.0, 100.0);
                        self.replace_inner(|inner| {
                            inner.download_percent = Some(percent);
                        })
                        .emit(&progress_app, &channel);
                    }
                },
                || {},
            )
            .await;

        match bytes {
            Ok(bytes) => {
                let state = self.replace_inner(|inner| {
                    inner.downloaded_update = Some(DownloadedUpdate {
                        update,
                        version: version.clone(),
                        bytes,
                    });
                    inner.downloaded_version = Some(version);
                    inner.status = Some(STATUS_DOWNLOADED.to_string());
                    inner.download_percent = Some(100.0);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(&app, &channel);
                json!({
                    "accepted": true,
                    "completed": true,
                    "state": update_state,
                })
            }
            Err(error) => {
                let state = self.record_error_state(&app, &channel, "download", error.to_string());
                json!({
                    "accepted": true,
                    "completed": false,
                    "state": state,
                })
            }
        }
    }

    pub fn install_update(&self, app: &AppHandle, channel: &str) -> Value {
        if let Err(error) = app.updater() {
            if is_updater_disabled(&error) {
                return disabled_update_action_result(disabled_update_state(app, channel));
            }
            let state = self.record_error_state(app, channel, "install", error.to_string());
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        }

        let downloaded = self
            .inner
            .lock()
            .expect("desktop update mutex poisoned")
            .downloaded_update
            .take();

        let Some(downloaded) = downloaded else {
            let state = self.record_error_state(
                app,
                channel,
                "install",
                "No downloaded update is available to install.".to_string(),
            );
            return json!({
                "accepted": false,
                "completed": false,
                "state": state,
            });
        };

        match downloaded.update.install(&downloaded.bytes) {
            Ok(()) => {
                let state = self.replace_inner(|inner| {
                    inner.status = Some(STATUS_DOWNLOADED.to_string());
                    inner.downloaded_version = Some(downloaded.version);
                    inner.download_percent = Some(100.0);
                    inner.message = None;
                    inner.error_context = None;
                    inner.can_retry = false;
                });
                let update_state = state.emit(app, channel);
                json!({
                    "accepted": true,
                    "completed": true,
                    "state": update_state,
                })
            }
            Err(error) => {
                let state = self.record_error_state(app, channel, "install", error.to_string());
                json!({
                    "accepted": true,
                    "completed": false,
                    "state": state,
                })
            }
        }
    }

    fn replace_inner(&self, update: impl FnOnce(&mut DesktopUpdateInner)) -> DesktopUpdateInner {
        let mut inner = self.inner.lock().expect("desktop update mutex poisoned");
        update(&mut inner);
        inner.clone_without_updates()
    }

    fn record_error_state(
        &self,
        app: &AppHandle,
        channel: &str,
        context: &'static str,
        message: String,
    ) -> Value {
        let state = self.replace_inner(|inner| {
            inner.status = Some(STATUS_ERROR.to_string());
            inner.message = Some(message);
            inner.error_context = Some(context);
            inner.can_retry = true;
        });
        state.emit(app, channel)
    }
}

impl DesktopUpdateInner {
    fn emit(&self, app: &AppHandle, channel: &str) -> Value {
        let state = update_state_value(app, channel, true, self);
        emit_update_state(app, &state);
        state
    }

    fn clone_without_updates(&self) -> DesktopUpdateInner {
        DesktopUpdateInner {
            available_update: None,
            available_version: self.available_version.clone(),
            downloaded_update: None,
            downloaded_version: self.downloaded_version.clone(),
            status: self.status.clone(),
            download_percent: self.download_percent,
            checked_at: self.checked_at.clone(),
            message: self.message.clone(),
            error_context: self.error_context,
            can_retry: self.can_retry,
        }
    }
}

fn is_updater_disabled(error: &UpdaterError) -> bool {
    matches!(error, UpdaterError::EmptyEndpoints)
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn emit_update_state(app: &AppHandle, state: &Value) {
    if let Err(error) = app.emit(UPDATE_STATE_EVENT, state.clone()) {
        tracing::debug!("failed to emit Tauri update state event: {error}");
    }
}

pub fn disabled_update_state(app: &AppHandle, channel: &str) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": false,
        "status": STATUS_DISABLED,
        "channel": channel,
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": null,
        "downloadedVersion": null,
        "downloadPercent": null,
        "checkedAt": null,
        "message": null,
        "errorContext": null,
        "canRetry": false,
    })
}

fn error_update_state(
    app: &AppHandle,
    channel: &str,
    context: &'static str,
    message: String,
) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": true,
        "status": STATUS_ERROR,
        "channel": channel,
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": null,
        "downloadedVersion": null,
        "downloadPercent": null,
        "checkedAt": null,
        "message": message,
        "errorContext": context,
        "canRetry": true,
    })
}

fn update_state_value(
    app: &AppHandle,
    channel: &str,
    enabled: bool,
    inner: &DesktopUpdateInner,
) -> Value {
    let runtime = runtime_info();
    json!({
        "enabled": enabled,
        "status": inner.status.as_deref().unwrap_or(STATUS_IDLE),
        "channel": channel,
        "currentVersion": app_version(app),
        "hostArch": runtime["hostArch"].clone(),
        "appArch": runtime["appArch"].clone(),
        "runningUnderArm64Translation": runtime["runningUnderArm64Translation"].clone(),
        "availableVersion": inner.available_version,
        "downloadedVersion": inner.downloaded_version,
        "downloadPercent": inner.download_percent,
        "checkedAt": inner.checked_at,
        "message": inner.message,
        "errorContext": inner.error_context,
        "canRetry": inner.can_retry,
    })
}

pub fn disabled_update_check_result(state: Value) -> Value {
    json!({
        "checked": false,
        "state": state,
    })
}

pub fn disabled_update_action_result(state: Value) -> Value {
    json!({
        "accepted": false,
        "completed": false,
        "state": state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_update_results_preserve_bridge_shapes() {
        let state = serde_json::json!({
            "status": "disabled",
            "channel": "latest"
        });

        assert_eq!(
            disabled_update_check_result(state.clone()),
            serde_json::json!({
                "checked": false,
                "state": state.clone(),
            })
        );
        assert_eq!(
            disabled_update_action_result(state.clone()),
            serde_json::json!({
                "accepted": false,
                "completed": false,
                "state": state,
            })
        );
    }

    #[test]
    fn manager_state_helpers_clone_metadata_without_runtime_updates() {
        let manager = DesktopUpdateManager::new();
        let snapshot = manager.replace_inner(|inner| {
            inner.available_version = Some("2.0.0".to_string());
            inner.downloaded_version = Some("1.9.0".to_string());
            inner.status = Some(STATUS_AVAILABLE.to_string());
            inner.download_percent = Some(25.0);
            inner.checked_at = Some(now_rfc3339());
        });

        assert_eq!(snapshot.available_version.as_deref(), Some("2.0.0"));
        assert_eq!(snapshot.downloaded_version.as_deref(), Some("1.9.0"));
        assert_eq!(snapshot.status.as_deref(), Some(STATUS_AVAILABLE));
        assert_eq!(snapshot.download_percent, Some(25.0));
        assert!(
            snapshot
                .checked_at
                .as_deref()
                .is_some_and(|value| value.contains('T'))
        );
        assert!(is_updater_disabled(&UpdaterError::EmptyEndpoints));
    }
}
