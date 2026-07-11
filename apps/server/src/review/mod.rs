use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type ReviewFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<ReviewDiffPreviewResult>, ReviewError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffPreviewInput {
    pub cwd: String,
    pub base_ref: Option<String>,
    pub ignore_whitespace: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffPreviewResult {
    pub cwd: String,
    pub generated_at: u64,
    pub sources: Vec<ReviewSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    pub path: String,
    pub diff: String,
}

#[derive(Debug, Error)]
pub enum ReviewError {
    #[allow(dead_code)]
    #[error("review backend failed: {0}")]
    Backend(String),
}

pub trait ReviewBackend: Send + Sync {
    fn get_diff_preview<'a>(&'a self, input: &'a ReviewDiffPreviewInput) -> ReviewFuture<'a>;
}

#[derive(Clone)]
pub struct ReviewService {
    backend: Arc<dyn ReviewBackend>,
}

impl ReviewService {
    pub fn new(backend: Arc<dyn ReviewBackend>) -> Self {
        Self { backend }
    }

    pub async fn get_diff_preview(
        &self,
        input: ReviewDiffPreviewInput,
    ) -> Result<ReviewDiffPreviewResult, ReviewError> {
        if let Some(result) = self.backend.get_diff_preview(&input).await? {
            return Ok(result);
        }
        Ok(ReviewDiffPreviewResult {
            cwd: input.cwd,
            generated_at: now_millis(),
            sources: Vec::new(),
        })
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
