use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsWorkingTreeFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsStagingArea {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsWorkingTreeFile {
    pub path: String,
    pub insertions: u64,
    pub deletions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<VcsWorkingTreeFileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<VcsStagingArea>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsWorkingTree {
    pub files: Vec<VcsWorkingTreeFile>,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Github,
    Gitlab,
    AzureDevops,
    Bitbucket,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlProviderInfo {
    pub kind: ProviderKind,
    pub name: String,
    pub base_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatusLocalResult {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_control_provider: Option<SourceControlProviderInfo>,
    pub has_primary_remote: bool,
    pub is_default_ref: bool,
    pub ref_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ref_name: Option<String>,
    pub has_working_tree_changes: bool,
    pub working_tree: VcsWorkingTree,
}

impl VcsStatusLocalResult {
    #[must_use]
    pub fn non_repository() -> Self {
        Self {
            is_repo: false,
            source_control_provider: None,
            has_primary_remote: false,
            is_default_ref: false,
            ref_name: None,
            default_ref_name: None,
            has_working_tree_changes: false,
            working_tree: VcsWorkingTree::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatusRemoteResult {
    pub has_upstream: bool,
    pub ahead_count: u64,
    pub behind_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead_of_default_count: Option<u64>,
    pub pr: Option<ChangeRequest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub base_ref: String,
    pub head_ref: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsStatusResult {
    #[serde(flatten)]
    pub local: VcsStatusLocalResult,
    #[serde(flatten)]
    pub remote: VcsStatusRemoteResult,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag")]
pub enum VcsStatusStreamEvent {
    #[serde(rename = "snapshot")]
    Snapshot {
        local: VcsStatusLocalResult,
        remote: Option<VcsStatusRemoteResult>,
    },
    #[serde(rename = "localUpdated")]
    LocalUpdated { local: VcsStatusLocalResult },
    #[serde(rename = "remoteUpdated")]
    RemoteUpdated {
        remote: Option<VcsStatusRemoteResult>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_remote: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
    pub current: bool,
    pub is_default: bool,
    pub worktree_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsListRefsResult {
    pub refs: Vec<VcsRef>,
    pub is_repo: bool,
    pub has_primary_remote: bool,
    pub next_cursor: Option<usize>,
    pub total_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: String,
    pub authored_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsListCommitsResult {
    pub commits: Vec<VcsCommit>,
    pub next_cursor: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct CreateWorktreeInput {
    pub cwd: PathBuf,
    pub ref_name: String,
    pub new_ref_name: Option<String>,
    pub base_ref_name: Option<String>,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsWorktree {
    pub path: String,
    pub ref_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VcsCreateWorktreeResult {
    pub worktree: VcsWorktree,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsPullResult {
    pub status: PullStatus,
    pub ref_name: String,
    pub upstream_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullStatus {
    Pulled,
    SkippedUpToDate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandError {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub operation: Box<str>,
    pub command: Box<str>,
    pub cwd: Box<str>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Box<GitCommandDiagnostics>>,
    pub detail: Box<str>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandDiagnostics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_length: Option<usize>,
}

impl std::fmt::Display for GitCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Git command failed in {} ({}): {}",
            self.operation, self.cwd, self.detail
        )
    }
}

impl std::error::Error for GitCommandError {}
