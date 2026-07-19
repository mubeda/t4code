use std::{collections::VecDeque, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyticsEvent {
    pub event: String,
    pub properties: Value,
    pub captured_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyticsEnvelope {
    pub distinct_id: String,
    pub batch: Vec<AnalyticsEvent>,
}

type DeliveryFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

#[derive(Clone)]
pub struct AnalyticsService {
    identifier: String,
    flush_batch_size: usize,
    max_buffered_events: usize,
    buffer: Arc<Mutex<VecDeque<AnalyticsEvent>>>,
    deliver: Arc<dyn Fn(AnalyticsEnvelope) -> DeliveryFuture + Send + Sync>,
}

impl AnalyticsService {
    pub fn new<F>(
        identifier: String,
        flush_batch_size: usize,
        max_buffered_events: usize,
        deliver: F,
    ) -> Self
    where
        F: Fn(AnalyticsEnvelope) -> DeliveryFuture + Send + Sync + 'static,
    {
        Self {
            identifier,
            flush_batch_size,
            max_buffered_events,
            buffer: Arc::new(Mutex::new(VecDeque::new())),
            deliver: Arc::new(deliver),
        }
    }

    pub async fn record(&self, event: &str, properties: Value) {
        let mut buffer = self.buffer.lock().await;
        buffer.push_back(AnalyticsEvent {
            event: event.to_owned(),
            properties,
            captured_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string()),
        });
        while buffer.len() > self.max_buffered_events {
            buffer.pop_front();
        }
    }

    pub async fn flush(&self) -> Result<(), String> {
        loop {
            let batch = {
                let mut buffer = self.buffer.lock().await;
                if buffer.is_empty() {
                    return Ok(());
                }
                let mut batch = Vec::new();
                while batch.len() < self.flush_batch_size {
                    let Some(event) = buffer.pop_front() else {
                        break;
                    };
                    batch.push(event);
                }
                batch
            };
            let envelope = AnalyticsEnvelope {
                distinct_id: self.identifier.clone(),
                batch: batch.clone(),
            };
            if let Err(error) = (self.deliver)(envelope).await {
                let mut buffer = self.buffer.lock().await;
                for event in batch.into_iter().rev() {
                    buffer.push_front(event);
                }
                return Err(error);
            }
        }
    }

    pub async fn buffer_len(&self) -> usize {
        self.buffer.lock().await.len()
    }
}

pub struct TelemetryIdentity;

impl TelemetryIdentity {
    pub async fn for_home(
        home_directory: impl Into<PathBuf>,
        anonymous_id_path: impl Into<PathBuf>,
    ) -> Result<String, std::io::Error> {
        let home_directory = home_directory.into();
        if let Some(account_id) = read_codex_account_id(&home_directory).await {
            return Ok(sha256_hex(&account_id));
        }
        if let Some(user_id) = read_claude_user_id(&home_directory).await {
            return Ok(sha256_hex(&user_id));
        }
        let anonymous_id_path = anonymous_id_path.into();
        let anonymous_id = match tokio::fs::read_to_string(&anonymous_id_path).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let generated = Uuid::new_v4().to_string();
                if let Some(parent) = anonymous_id_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&anonymous_id_path, &generated).await?;
                generated
            }
            Err(error) => return Err(error),
        };
        Ok(sha256_hex(anonymous_id.trim()))
    }
}

async fn read_codex_account_id(home_directory: &std::path::Path) -> Option<String> {
    let path = home_directory.join(".codex").join("auth.json");
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    json.get("tokens")
        .and_then(|value| value.get("account_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

async fn read_claude_user_id(home_directory: &std::path::Path) -> Option<String> {
    let path = home_directory.join(".claude.json");
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    json.get("userID")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn sha256_hex(value: &str) -> String {
    crate::crypto::sha256_hex(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn owned_identity_paths_and_direct_delivery_cover_unit_runtime_instantiations() {
        let temp = TempDir::new().expect("telemetry directory");
        let identity = TelemetryIdentity::for_home(
            temp.path().to_path_buf(),
            temp.path().join("state/anonymous-id"),
        )
        .await
        .expect("anonymous identity should persist");
        assert_eq!(identity.len(), 64);

        let service = AnalyticsService::new("identity".to_owned(), 1, 2, |envelope| {
            Box::pin(async move {
                assert_eq!(envelope.distinct_id, "identity");
                assert_eq!(envelope.batch.len(), 1);
                Ok(())
            })
        });
        service.record("runtime", Value::Null).await;
        service.flush().await.expect("telemetry should flush");
        assert_eq!(service.buffer_len().await, 0);
    }
}
