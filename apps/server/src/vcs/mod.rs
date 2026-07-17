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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn service_detects_repository_state_and_reads_local_status() {
        let _guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let repository = tempfile::tempdir().expect("temporary repository");
        let cancellation = CancellationToken::new();
        let service = VcsService::default();
        assert_eq!(
            service
                .detect(repository.path(), &cancellation)
                .await
                .unwrap(),
            VcsDriverKind::Unknown
        );
        let output = std::process::Command::new("git")
            .arg("init")
            .current_dir(repository.path())
            .output()
            .expect("git init should start");
        assert!(output.status.success());
        assert_eq!(
            service
                .detect(repository.path(), &cancellation)
                .await
                .unwrap(),
            VcsDriverKind::Git
        );
        assert!(
            service
                .local_status(repository.path(), &cancellation)
                .await
                .is_ok()
        );
    }
}
