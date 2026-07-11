use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::git::{GitCommandError, GitRepository, VcsStatusLocalResult};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsDriverKind {
    Git,
    Jj,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsDriverCapabilities {
    pub kind: VcsDriverKind,
    pub supports_worktrees: bool,
    pub supports_bookmarks: bool,
    pub supports_atomic_snapshot: bool,
    pub supports_push_default_remote: bool,
    pub ignore_classifier: IgnoreClassifier,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IgnoreClassifier {
    Native,
    GitCompatibleFallback,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct VcsService {
    git: GitRepository,
}

impl VcsService {
    #[must_use]
    pub fn capabilities(&self) -> VcsDriverCapabilities {
        VcsDriverCapabilities {
            kind: VcsDriverKind::Git,
            supports_worktrees: true,
            supports_bookmarks: false,
            supports_atomic_snapshot: true,
            supports_push_default_remote: true,
            ignore_classifier: IgnoreClassifier::Native,
        }
    }

    pub async fn detect(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsDriverKind, GitCommandError> {
        Ok(if self.git.is_repository(cwd, cancellation).await? {
            VcsDriverKind::Git
        } else {
            VcsDriverKind::Unknown
        })
    }

    pub async fn local_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        self.git.local_status(cwd, cancellation).await
    }
}
