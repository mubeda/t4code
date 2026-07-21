use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::platform::{Platform, PlatformWebviewOps, PreviewPlatformError};
use super::{PendingBounds, PreviewHostState};

pub const STATE_EVENT: &str = "preview://state";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CreationProgress {
    token: u64,
    revision: u64,
    cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BeginCreation {
    Started(CreationProgress),
    InProgress,
}

#[derive(Debug, Default)]
struct CreationState {
    next_token: u64,
    tabs: HashMap<String, CreationProgress>,
}

#[derive(Debug, Default)]
struct CreationCoordinator {
    state: Mutex<CreationState>,
    changed: Condvar,
}

impl CreationCoordinator {
    fn begin(&self, tab_id: &str) -> Result<BeginCreation, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.tabs.contains_key(tab_id) {
            return Ok(BeginCreation::InProgress);
        }
        state.next_token = state.next_token.wrapping_add(1);
        if state.next_token == 0 {
            state.next_token = 1;
        }
        let progress = CreationProgress {
            token: state.next_token,
            revision: 0,
            cancelled: false,
        };
        state.tabs.insert(tab_id.to_string(), progress);
        Ok(BeginCreation::Started(progress))
    }

    fn wait_until_finished(&self, tab_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        while state.tabs.contains_key(tab_id) {
            state = self
                .changed
                .wait(state)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn bump_revision(&self, tab_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(progress) = state.tabs.get_mut(tab_id) {
            progress.revision = progress.revision.wrapping_add(1);
        }
        Ok(())
    }

    fn current(&self, tab_id: &str, token: u64) -> Result<Option<CreationProgress>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Ok(state
            .tabs
            .get(tab_id)
            .copied()
            .filter(|progress| progress.token == token))
    }

    fn finish(&self, tab_id: &str, token: u64) -> Result<bool, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let is_current = state
            .tabs
            .get(tab_id)
            .is_some_and(|progress| progress.token == token);
        if is_current {
            state.tabs.remove(tab_id);
            self.changed.notify_all();
        }
        Ok(is_current)
    }

    fn cancel(&self, tab_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(progress) = state.tabs.get_mut(tab_id) {
            // Retain the slot until the creator's lease closes any native child.
            // This prevents a retry from reusing the same label too early.
            progress.cancelled = true;
        }
        Ok(())
    }
}

fn creation_coordinator() -> &'static CreationCoordinator {
    static COORDINATOR: OnceLock<CreationCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(CreationCoordinator::default)
}

/// Ensures an unwind during native child creation cannot strand the
/// coordinator slot or a child webview that was registered before the panic.
struct CreationLease {
    app: AppHandle,
    tab_id: String,
    label: String,
    token: u64,
    armed: bool,
}

impl CreationLease {
    fn new(app: &AppHandle, tab_id: &str, label: &str, token: u64) -> Self {
        Self {
            app: app.clone(),
            tab_id: tab_id.to_string(),
            label: label.to_string(),
            token,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CreationLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        // Drop must stay best-effort and must never replace an active panic.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(webview) = self.app.webviews().get(&self.label) {
                let _ = webview.close();
            }
        }));
        let _ = creation_coordinator().finish(&self.tab_id, self.token);
        remove_nav_events(&self.tab_id);
    }
}

#[derive(Debug, Default)]
struct NavEventGenerations {
    next: u64,
    current: HashMap<String, u64>,
}

impl NavEventGenerations {
    fn record(&mut self, tab_id: &str) -> u64 {
        self.next = self.next.wrapping_add(1);
        if self.next == 0 {
            self.next = 1;
        }
        self.current.insert(tab_id.to_string(), self.next);
        self.next
    }

    fn is_current(&self, tab_id: &str, generation: u64) -> bool {
        self.current.get(tab_id).copied() == Some(generation)
    }

    fn remove(&mut self, tab_id: &str) {
        self.current.remove(tab_id);
    }
}

fn nav_event_generations() -> &'static Mutex<NavEventGenerations> {
    static GENERATIONS: OnceLock<Mutex<NavEventGenerations>> = OnceLock::new();
    GENERATIONS.get_or_init(|| Mutex::new(NavEventGenerations::default()))
}

fn record_nav_event(tab_id: &str) -> Option<u64> {
    nav_event_generations()
        .lock()
        .ok()
        .map(|mut generations| generations.record(tab_id))
}

fn is_current_nav_event(tab_id: &str, generation: u64) -> bool {
    nav_event_generations()
        .lock()
        .is_ok_and(|generations| generations.is_current(tab_id, generation))
}

fn lock_current_nav_event(
    tab_id: &str,
    generation: u64,
) -> Option<MutexGuard<'static, NavEventGenerations>> {
    let generations = nav_event_generations().lock().ok()?;
    generations
        .is_current(tab_id, generation)
        .then_some(generations)
}

fn remove_nav_events(tab_id: &str) {
    if let Ok(mut generations) = nav_event_generations().lock() {
        generations.remove(tab_id);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
#[allow(dead_code)]
pub enum NavStatus {
    Idle,
    Loading {
        url: String,
        title: String,
    },
    Success {
        url: String,
        title: String,
    },
    LoadFailed {
        url: String,
        title: String,
        code: i32,
        description: String,
    },
}

/// Wire shape of `DesktopPreviewTabState`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatePayload {
    pub tab_id: String,
    pub web_contents_id: Option<i64>,
    pub nav_status: NavStatus,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub zoom_factor: f64,
    pub controller: &'static str,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateEvent {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub state: TabStatePayload,
}

pub(crate) fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Emit a state snapshot from a worker thread.
///
/// Platform navigation metadata uses native completion callbacks, so callers
/// must not invoke this from the webview UI thread.
fn emit_state(app: &AppHandle, tab_id: &str, generation: u64, url: &str, nav_status: NavStatus) {
    if !is_current_nav_event(tab_id, generation) {
        return;
    }
    let state = app.state::<PreviewHostState>();
    let (label, zoom) = {
        let mut registry = match state.0.lock() {
            Ok(registry) => registry,
            Err(error) => {
                tracing::warn!("failed to lock preview registry for state event: {error}");
                return;
            }
        };
        match registry.get_mut(tab_id) {
            Some(entry) => {
                entry.last_url = url.to_string();
                (entry.label.clone(), entry.zoom)
            }
            None => return,
        }
    };
    let webview = app.webviews().get(&label).cloned();
    let (can_go_back, can_go_forward) = webview
        .as_ref()
        .map(|webview| {
            (
                Platform::can_go_back(webview).unwrap_or(false),
                Platform::can_go_forward(webview).unwrap_or(false),
            )
        })
        .unwrap_or((false, false));
    let Some(_generation_guard) = lock_current_nav_event(tab_id, generation) else {
        return;
    };
    let payload = StateEvent {
        tab_id: tab_id.to_string(),
        state: TabStatePayload {
            tab_id: tab_id.to_string(),
            web_contents_id: None,
            nav_status,
            can_go_back,
            can_go_forward,
            zoom_factor: zoom,
            controller: "human",
            updated_at: now_iso(),
        },
    };
    if let Err(error) = app.emit(STATE_EVENT, payload) {
        tracing::warn!("failed to emit preview state: {error}");
    }
}

/// Resolve the current title via platform ops, tolerating failures.
fn current_title(app: &AppHandle, label: &str) -> String {
    app.webviews()
        .get(label)
        .and_then(|webview| Platform::title(webview).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn ensure_macos_isolated_profile_available(available: bool) -> Result<(), String> {
    if available {
        Ok(())
    } else {
        Err(
            "native preview requires macOS 14 or newer for an isolated persistent profile"
                .to_string(),
        )
    }
}

pub fn create_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    ensure_macos_isolated_profile_available(objc2::available!(macos = 14.0))?;

    let blank_url = Url::parse("about:blank").map_err(|error| error.to_string())?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    #[cfg(not(target_os = "macos"))]
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve preview profile directory: {error}"))?
        .join("preview-profile");

    let state = app.state::<PreviewHostState>();
    let (label, initial_bounds, progress) = {
        let mut registry = state.0.lock().map_err(|error| error.to_string())?;
        let entry = registry.upsert_pending(tab_id);
        if entry.created {
            return Ok(());
        }
        let label = entry.label.clone();
        let bounds = entry.bounds.unwrap_or(PendingBounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        match creation_coordinator().begin(tab_id)? {
            BeginCreation::Started(progress) => (label, bounds, progress),
            BeginCreation::InProgress => {
                drop(registry);
                creation_coordinator().wait_until_finished(tab_id)?;
                let registry = state.0.lock().map_err(|error| error.to_string())?;
                return registry
                    .get(tab_id)
                    .filter(|entry| entry.created)
                    .map(|_| ())
                    .ok_or_else(|| format!("preview tab {tab_id} creation did not complete"));
            }
        }
    };
    let mut creation_lease = CreationLease::new(app, tab_id, &label, progress.token);

    let app_for_events = app.clone();
    let tab_for_events = tab_id.to_string();
    let label_for_events = label.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(blank_url))
        .on_navigation(|url| {
            url.as_str() == "about:blank" || matches!(url.scheme(), "http" | "https")
        })
        .on_page_load(move |_webview, payload| {
            let url = payload.url().to_string();
            if url == "about:blank" {
                return;
            }
            let Some(generation) = record_nav_event(&tab_for_events) else {
                tracing::warn!("failed to record preview navigation generation");
                return;
            };
            let app = app_for_events.clone();
            let tab_id = tab_for_events.clone();
            let label = label_for_events.clone();
            let event = payload.event();
            tauri::async_runtime::spawn_blocking(move || {
                if !is_current_nav_event(&tab_id, generation) {
                    return;
                }
                let title = current_title(&app, &label);
                let nav_status = match event {
                    PageLoadEvent::Started => NavStatus::Loading {
                        url: url.clone(),
                        title,
                    },
                    PageLoadEvent::Finished => NavStatus::Success {
                        url: url.clone(),
                        title,
                    },
                };
                emit_state(&app, &tab_id, generation, &url, nav_status);
            });
        });

    // Preview browsing data is isolated from the main application session.
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(*b"t4codepreview001");
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.data_directory(profile_dir);
    }

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(initial_bounds.x, initial_bounds.y),
            LogicalSize::new(
                initial_bounds.width.max(1.0),
                initial_bounds.height.max(1.0),
            ),
        )
        .map_err(|error| error.to_string())?;

    loop {
        let snapshot = match (|| -> Result<Option<_>, String> {
            let registry = state.0.lock().map_err(|error| error.to_string())?;
            let Some(entry) = registry.get(tab_id) else {
                return Ok(None);
            };
            let Some(current) = creation_coordinator().current(tab_id, progress.token)? else {
                return Ok(None);
            };
            if current.cancelled {
                return Ok(None);
            }
            Ok(Some((
                entry.bounds.unwrap_or(PendingBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                }),
                entry.visible,
                current.revision,
            )))
        })() {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                return Err(format!("preview tab {tab_id} creation was cancelled"));
            }
            Err(error) => return Err(error),
        };

        let apply_result = webview
            .set_position(LogicalPosition::new(snapshot.0.x, snapshot.0.y))
            .and_then(|()| {
                webview.set_size(LogicalSize::new(
                    snapshot.0.width.max(1.0),
                    snapshot.0.height.max(1.0),
                ))
            })
            .and_then(|()| {
                if snapshot.1 {
                    webview.show()
                } else {
                    webview.hide()
                }
            });
        if let Err(error) = apply_result {
            return Err(error.to_string());
        }

        enum CommitCreation {
            Committed,
            Retry,
            Cancelled,
        }
        let commit = (|| -> Result<CommitCreation, String> {
            let mut registry = state.0.lock().map_err(|error| error.to_string())?;
            let Some(entry) = registry.get_mut(tab_id) else {
                return Ok(CommitCreation::Cancelled);
            };
            let Some(current) = creation_coordinator().current(tab_id, progress.token)? else {
                return Ok(CommitCreation::Cancelled);
            };
            if current.cancelled {
                return Ok(CommitCreation::Cancelled);
            }
            if current.revision != snapshot.2 {
                return Ok(CommitCreation::Retry);
            }
            entry.created = true;
            match creation_coordinator().finish(tab_id, progress.token) {
                Ok(true) => Ok(CommitCreation::Committed),
                Ok(false) => {
                    entry.created = false;
                    Ok(CommitCreation::Cancelled)
                }
                Err(error) => {
                    entry.created = false;
                    Err(error)
                }
            }
        })();
        match commit {
            Ok(CommitCreation::Committed) => {
                creation_lease.disarm();
                return Ok(());
            }
            Ok(CommitCreation::Retry) => {}
            Ok(CommitCreation::Cancelled) => {
                return Err(format!("preview tab {tab_id} creation was cancelled"));
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn with_tab_webview<T>(
    app: &AppHandle,
    tab_id: &str,
    operation: impl FnOnce(&tauri::Webview) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<PreviewHostState>();
    let label = {
        let registry = state.0.lock().map_err(|error| error.to_string())?;
        registry
            .get(tab_id)
            .filter(|entry| entry.created)
            .map(|entry| entry.label.clone())
            .ok_or_else(|| format!("preview tab {tab_id} does not exist"))?
    };
    let webviews = app.webviews();
    let webview = webviews
        .get(&label)
        .ok_or_else(|| format!("preview webview {label} not found"))?;
    operation(webview)
}

pub fn platform_err(error: PreviewPlatformError) -> String {
    error.to_string()
}

pub fn set_bounds(
    app: &AppHandle,
    tab_id: &str,
    bounds: PendingBounds,
    visible: bool,
) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    let mut registry = state.0.lock().map_err(|error| error.to_string())?;
    let (label, created) = {
        let entry = registry.upsert_pending(tab_id);
        entry.bounds = Some(bounds);
        entry.visible = visible;
        creation_coordinator().bump_revision(tab_id)?;
        (entry.label.clone(), entry.created)
    };
    if !created {
        return Ok(());
    }

    let webviews = app.webviews();
    let webview = webviews
        .get(&label)
        .ok_or_else(|| format!("preview webview {label} not found"))?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        ))
        .map_err(|error| error.to_string())?;
    if visible {
        webview.show().map_err(|error| error.to_string())?;
    } else {
        webview.hide().map_err(|error| error.to_string())?;
    }
    drop(registry);
    Ok(())
}

pub fn close_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    let mut registry = state.0.lock().map_err(|error| error.to_string())?;
    let existing = registry
        .get(tab_id)
        .map(|entry| (entry.label.clone(), entry.created));
    creation_coordinator().cancel(tab_id)?;
    if let Some((label, created)) = existing {
        if created {
            if let Some(webview) = app.webviews().get(&label) {
                webview.close().map_err(|error| error.to_string())?;
            }
        }
        registry.remove(tab_id);
    }
    drop(registry);
    remove_nav_events(tab_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        BeginCreation, CreationCoordinator, NavEventGenerations, NavStatus, StateEvent,
        TabStatePayload,
    };

    #[test]
    fn creation_coordinator_tracks_inflight_revision_and_completion() {
        let coordinator = CreationCoordinator::default();
        let BeginCreation::Started(progress) = coordinator.begin("tab-1").expect("begin") else {
            panic!("first create should start");
        };
        assert_eq!(coordinator.begin("tab-1"), Ok(BeginCreation::InProgress));

        coordinator.bump_revision("tab-1").expect("bump revision");
        let current = coordinator
            .current("tab-1", progress.token)
            .expect("read current")
            .expect("current creation");
        assert_eq!(current.revision, 1);
        assert!(!current.cancelled);
        assert!(coordinator.finish("tab-1", progress.token).unwrap());
        coordinator
            .wait_until_finished("tab-1")
            .expect("creation finished");
        assert_eq!(coordinator.current("tab-1", progress.token).unwrap(), None);
    }

    #[test]
    fn cancelled_creation_retains_its_slot_until_creator_cleanup() {
        let coordinator = CreationCoordinator::default();
        let BeginCreation::Started(progress) = coordinator.begin("tab-1").expect("begin") else {
            panic!("first create should start");
        };

        coordinator.cancel("tab-1").expect("cancel");
        assert_eq!(coordinator.begin("tab-1"), Ok(BeginCreation::InProgress));
        assert!(
            coordinator
                .current("tab-1", progress.token)
                .expect("read current")
                .expect("cancelled creation is retained")
                .cancelled
        );

        assert!(coordinator.finish("tab-1", progress.token).unwrap());
        assert!(matches!(
            coordinator.begin("tab-1").expect("retry after cleanup"),
            BeginCreation::Started(_)
        ));
    }

    #[test]
    fn newer_navigation_events_invalidate_older_workers() {
        let mut generations = NavEventGenerations::default();
        let loading = generations.record("tab-1");
        let success = generations.record("tab-1");

        assert!(!generations.is_current("tab-1", loading));
        assert!(generations.is_current("tab-1", success));

        generations.remove("tab-1");
        assert!(!generations.is_current("tab-1", success));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_support_fails_closed_below_version_14() {
        assert!(super::ensure_macos_isolated_profile_available(true).is_ok());
        let error = super::ensure_macos_isolated_profile_available(false).unwrap_err();
        assert!(error.contains("macOS 14 or newer"));
    }

    #[test]
    fn state_event_serializes_with_the_desktop_preview_contract_shape() {
        let event = StateEvent {
            tab_id: "tab-1".to_string(),
            state: TabStatePayload {
                tab_id: "tab-1".to_string(),
                web_contents_id: None,
                nav_status: NavStatus::Success {
                    url: "https://example.com/".to_string(),
                    title: "Example".to_string(),
                },
                can_go_back: true,
                can_go_forward: false,
                zoom_factor: 1.25,
                controller: "human",
                updated_at: "2026-07-20T00:00:00Z".to_string(),
            },
        };

        assert_eq!(
            serde_json::to_value(event).expect("state event should serialize"),
            json!({
                "tabId": "tab-1",
                "state": {
                    "tabId": "tab-1",
                    "webContentsId": null,
                    "navStatus": {
                        "kind": "Success",
                        "url": "https://example.com/",
                        "title": "Example",
                    },
                    "canGoBack": true,
                    "canGoForward": false,
                    "zoomFactor": 1.25,
                    "controller": "human",
                    "updatedAt": "2026-07-20T00:00:00Z",
                },
            })
        );
    }
}
