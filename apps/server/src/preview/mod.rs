use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, broadcast};
use url::Url;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum PreviewViewportSetting {
    #[default]
    #[serde(rename = "fill")]
    Fill,
    #[serde(rename = "freeform")]
    Freeform { width: u32, height: u32 },
    #[serde(rename = "preset")]
    Preset {
        preset_id: String,
        width: u32,
        height: u32,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum PreviewNavStatus {
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionSnapshot {
    pub thread_id: String,
    pub tab_id: String,
    pub nav_status: PreviewNavStatus,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub viewport: PreviewViewportSetting,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListResult {
    pub sessions: Vec<PreviewSessionSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PreviewEvent {
    #[serde(rename = "opened")]
    Opened {
        thread_id: String,
        tab_id: String,
        created_at: String,
        snapshot: PreviewSessionSnapshot,
    },
    #[serde(rename = "navigated")]
    Navigated {
        thread_id: String,
        tab_id: String,
        created_at: String,
        snapshot: PreviewSessionSnapshot,
    },
    #[serde(rename = "resized")]
    Resized {
        thread_id: String,
        tab_id: String,
        created_at: String,
        snapshot: PreviewSessionSnapshot,
    },
    #[serde(rename = "failed")]
    Failed {
        thread_id: String,
        tab_id: String,
        created_at: String,
        url: String,
        title: String,
        code: i32,
        description: String,
    },
    #[serde(rename = "closed")]
    Closed {
        thread_id: String,
        tab_id: String,
        created_at: String,
    },
}

impl PreviewEvent {
    #[must_use]
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::Opened { .. } => "opened",
            Self::Navigated { .. } => "navigated",
            Self::Resized { .. } => "resized",
            Self::Failed { .. } => "failed",
            Self::Closed { .. } => "closed",
        }
    }

    #[must_use]
    pub fn tab_id(&self) -> &str {
        match self {
            Self::Opened { tab_id, .. }
            | Self::Navigated { tab_id, .. }
            | Self::Resized { tab_id, .. }
            | Self::Failed { tab_id, .. }
            | Self::Closed { tab_id, .. } => tab_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum PreviewError {
    #[error("Unknown preview session: thread={thread_id}, tab={tab_id}")]
    SessionLookup { thread_id: String, tab_id: String },
    #[error("Invalid preview URL ({reason}; input length {input_length}).")]
    InvalidUrl {
        input_length: usize,
        reason: &'static str,
        protocol: Option<String>,
    },
}

#[derive(Default)]
struct PreviewState {
    sessions: BTreeMap<String, PreviewSessionSnapshot>,
}

#[derive(Clone)]
pub struct PreviewManager {
    state: Arc<Mutex<PreviewState>>,
    events: broadcast::Sender<PreviewEvent>,
}

impl Default for PreviewManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewManager {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            state: Arc::new(Mutex::new(PreviewState::default())),
            events,
        }
    }

    #[must_use]
    pub fn subscribe_events(&self) -> broadcast::Receiver<PreviewEvent> {
        self.events.subscribe()
    }

    pub async fn open(
        &self,
        thread_id: &str,
        url: Option<&str>,
    ) -> Result<PreviewSessionSnapshot, PreviewError> {
        let tab_id = format!("tab_{}", Uuid::new_v4().simple());
        let updated_at = now_iso();
        let snapshot = match url {
            Some(raw) => PreviewSessionSnapshot {
                thread_id: thread_id.to_owned(),
                tab_id: tab_id.clone(),
                nav_status: PreviewNavStatus::Loading {
                    url: normalize_url(raw)?,
                    title: String::new(),
                },
                can_go_back: false,
                can_go_forward: false,
                viewport: PreviewViewportSetting::Fill,
                updated_at: updated_at.clone(),
            },
            None => PreviewSessionSnapshot {
                thread_id: thread_id.to_owned(),
                tab_id: tab_id.clone(),
                nav_status: PreviewNavStatus::Idle,
                can_go_back: false,
                can_go_forward: false,
                viewport: PreviewViewportSetting::Fill,
                updated_at: updated_at.clone(),
            },
        };
        let key = composite_key(thread_id, &tab_id);
        self.state
            .lock()
            .await
            .sessions
            .insert(key, snapshot.clone());
        let _ = self.events.send(PreviewEvent::Opened {
            thread_id: thread_id.to_owned(),
            tab_id,
            created_at: updated_at,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    pub async fn navigate(
        &self,
        thread_id: &str,
        tab_id: &str,
        url: &str,
        resolved_title: Option<&str>,
    ) -> Result<PreviewSessionSnapshot, PreviewError> {
        let url = normalize_url(url)?;
        let mut state = self.state.lock().await;
        let key = composite_key(thread_id, tab_id);
        let current =
            state
                .sessions
                .get(&key)
                .cloned()
                .ok_or_else(|| PreviewError::SessionLookup {
                    thread_id: thread_id.to_owned(),
                    tab_id: tab_id.to_owned(),
                })?;
        let previous_title = match current.nav_status {
            PreviewNavStatus::Idle => String::new(),
            PreviewNavStatus::Loading { ref title, .. }
            | PreviewNavStatus::Success { ref title, .. }
            | PreviewNavStatus::LoadFailed { ref title, .. } => title.clone(),
        };
        let updated = PreviewSessionSnapshot {
            thread_id: thread_id.to_owned(),
            tab_id: tab_id.to_owned(),
            nav_status: PreviewNavStatus::Success {
                url,
                title: resolved_title.unwrap_or(previous_title.as_str()).to_owned(),
            },
            can_go_back: current.can_go_back,
            can_go_forward: current.can_go_forward,
            viewport: current.viewport,
            updated_at: now_iso(),
        };
        state.sessions.insert(key, updated.clone());
        let _ = self.events.send(PreviewEvent::Navigated {
            thread_id: thread_id.to_owned(),
            tab_id: tab_id.to_owned(),
            created_at: updated.updated_at.clone(),
            snapshot: updated.clone(),
        });
        Ok(updated)
    }

    pub async fn report_status(
        &self,
        thread_id: &str,
        tab_id: &str,
        nav_status: PreviewNavStatus,
        can_go_back: bool,
        can_go_forward: bool,
    ) -> Result<(), PreviewError> {
        let mut state = self.state.lock().await;
        let key = composite_key(thread_id, tab_id);
        let current =
            state
                .sessions
                .get(&key)
                .cloned()
                .ok_or_else(|| PreviewError::SessionLookup {
                    thread_id: thread_id.to_owned(),
                    tab_id: tab_id.to_owned(),
                })?;
        let updated = PreviewSessionSnapshot {
            thread_id: thread_id.to_owned(),
            tab_id: tab_id.to_owned(),
            nav_status: nav_status.clone(),
            can_go_back,
            can_go_forward,
            viewport: current.viewport,
            updated_at: now_iso(),
        };
        state.sessions.insert(key, updated.clone());
        let event = match nav_status {
            PreviewNavStatus::LoadFailed {
                url,
                title,
                code,
                description,
            } => PreviewEvent::Failed {
                thread_id: thread_id.to_owned(),
                tab_id: tab_id.to_owned(),
                created_at: updated.updated_at.clone(),
                url,
                title,
                code,
                description,
            },
            _ => PreviewEvent::Navigated {
                thread_id: thread_id.to_owned(),
                tab_id: tab_id.to_owned(),
                created_at: updated.updated_at.clone(),
                snapshot: updated,
            },
        };
        let _ = self.events.send(event);
        Ok(())
    }

    pub async fn resize(
        &self,
        thread_id: &str,
        tab_id: &str,
        viewport: PreviewViewportSetting,
    ) -> Result<PreviewSessionSnapshot, PreviewError> {
        let mut state = self.state.lock().await;
        let key = composite_key(thread_id, tab_id);
        let current =
            state
                .sessions
                .get(&key)
                .cloned()
                .ok_or_else(|| PreviewError::SessionLookup {
                    thread_id: thread_id.to_owned(),
                    tab_id: tab_id.to_owned(),
                })?;
        let updated = PreviewSessionSnapshot {
            viewport,
            updated_at: now_iso(),
            ..current
        };
        state.sessions.insert(key, updated.clone());
        let _ = self.events.send(PreviewEvent::Resized {
            thread_id: thread_id.to_owned(),
            tab_id: tab_id.to_owned(),
            created_at: updated.updated_at.clone(),
            snapshot: updated.clone(),
        });
        Ok(updated)
    }

    pub async fn refresh(&self, thread_id: &str, tab_id: &str) -> Result<(), PreviewError> {
        let state = self.state.lock().await;
        let key = composite_key(thread_id, tab_id);
        if state.sessions.contains_key(&key) {
            Ok(())
        } else {
            Err(PreviewError::SessionLookup {
                thread_id: thread_id.to_owned(),
                tab_id: tab_id.to_owned(),
            })
        }
    }

    pub async fn close(&self, thread_id: &str, tab_id: Option<&str>) -> Result<(), PreviewError> {
        let mut state = self.state.lock().await;
        let targets = match tab_id {
            Some(tab_id) => state
                .sessions
                .keys()
                .filter(|key| *key == &composite_key(thread_id, tab_id))
                .cloned()
                .collect::<Vec<_>>(),
            None => state
                .sessions
                .keys()
                .filter(|key| key.starts_with(&format!("{thread_id}\u{0}")))
                .cloned()
                .collect::<Vec<_>>(),
        };
        let created_at = now_iso();
        for key in targets {
            if let Some(snapshot) = state.sessions.remove(&key) {
                let _ = self.events.send(PreviewEvent::Closed {
                    thread_id: snapshot.thread_id,
                    tab_id: snapshot.tab_id,
                    created_at: created_at.clone(),
                });
            }
        }
        Ok(())
    }

    pub async fn list(&self, thread_id: &str) -> PreviewListResult {
        let state = self.state.lock().await;
        let mut sessions = state
            .sessions
            .values()
            .filter(|snapshot| snapshot.thread_id == thread_id)
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.updated_at.cmp(&right.updated_at));
        PreviewListResult { sessions }
    }
}

fn composite_key(thread_id: &str, tab_id: &str) -> String {
    format!("{thread_id}\u{0}{tab_id}")
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

fn normalize_url(raw: &str) -> Result<String, PreviewError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PreviewError::InvalidUrl {
            input_length: raw.len(),
            reason: "empty",
            protocol: None,
        });
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else if is_loopback_host(trimmed) {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };

    let protocol = candidate
        .split_once(':')
        .map(|(scheme, _)| format!("{scheme}:"));
    let parsed = Url::parse(&candidate).map_err(|_| PreviewError::InvalidUrl {
        input_length: raw.len(),
        reason: "parse",
        protocol: protocol.clone(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(PreviewError::InvalidUrl {
            input_length: raw.len(),
            reason: "unsupported-protocol",
            protocol,
        });
    }
    Ok(parsed.to_string())
}

fn is_loopback_host(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]
        .into_iter()
        .any(|host| {
            lower == host
                || lower
                    .strip_prefix(host)
                    .is_some_and(|suffix| suffix.starts_with(':') || suffix.starts_with('/'))
        })
}

#[cfg(test)]
mod normalization_tests {
    use super::*;

    #[test]
    fn bare_loopback_ports_use_http() {
        assert_eq!(
            normalize_url("localhost:4173").expect("localhost URL"),
            "http://localhost:4173/"
        );
        assert_eq!(
            normalize_url("0.0.0.0:8080/path").expect("wildcard loopback URL"),
            "http://0.0.0.0:8080/path"
        );
    }

    #[test]
    fn qualified_unsupported_protocol_is_rejected() {
        assert!(matches!(
            normalize_url("file:///tmp/index.html"),
            Err(PreviewError::InvalidUrl {
                reason: "unsupported-protocol",
                ..
            })
        ));
    }
}
