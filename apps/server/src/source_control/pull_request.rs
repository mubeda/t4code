use std::{ffi::OsString, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::git::{OutputPolicy, ProcessRequest, ProcessRunner};

use super::ProviderKind;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub base_branch: String,
    pub head_branch: String,
    pub state: ChangeRequestState,
}

#[derive(Clone, Debug)]
pub struct ResolvePullRequestInput {
    pub cwd: PathBuf,
    pub provider: ProviderKind,
    pub reference: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlProviderError {
    #[serde(rename = "_tag")]
    pub tag: &'static str,
    pub provider: ProviderKind,
    pub operation: Box<str>,
    pub cwd: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<Box<str>>,
    pub detail: Box<str>,
}

impl std::fmt::Display for SourceControlProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Source control provider {:?} failed in {}: {}",
            self.provider, self.operation, self.detail
        )
    }
}

impl std::error::Error for SourceControlProviderError {}

#[derive(Clone, Copy, Debug, Default)]
pub struct PullRequestService {
    runner: ProcessRunner,
}

impl PullRequestService {
    pub async fn resolve(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let (command, args): (&str, Vec<OsString>) = match input.provider {
            ProviderKind::Github => (
                "gh",
                [
                    "pr",
                    "view",
                    input.reference.as_str(),
                    "--json",
                    "number,title,url,baseRefName,headRefName,state",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Gitlab => (
                "glab",
                ["mr", "view", input.reference.as_str(), "--output", "json"]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
            ),
            ProviderKind::AzureDevops => (
                "az",
                [
                    "repos",
                    "pr",
                    "show",
                    "--id",
                    input.reference.as_str(),
                    "--output",
                    "json",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Bitbucket | ProviderKind::Unknown => {
                return Err(provider_error(
                    input.provider,
                    &input.cwd,
                    None,
                    &input.reference,
                    "Pull-request resolution is unavailable for this provider.",
                ));
            }
        };
        let output = self
            .runner
            .run(
                ProcessRequest {
                    operation: "source-control.resolve-change-request".into(),
                    command: command.into(),
                    args,
                    cwd: input.cwd.clone(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(30),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|_| {
                provider_error(
                    input.provider,
                    &input.cwd,
                    Some(command),
                    &input.reference,
                    "Provider CLI execution failed.",
                )
            })?;
        if output.exit_code != 0 {
            return Err(provider_error(
                input.provider,
                &input.cwd,
                Some(command),
                &input.reference,
                "Change request was not found or provider authentication failed.",
            ));
        }
        let parsed = match input.provider {
            ProviderKind::Github => parse_github_pull_request(&output.stdout),
            ProviderKind::Gitlab => parse_gitlab_merge_request(&output.stdout),
            ProviderKind::AzureDevops => parse_azure_pull_request(&output.stdout),
            ProviderKind::Bitbucket | ProviderKind::Unknown => None,
        };
        parsed.ok_or_else(|| {
            provider_error(
                input.provider,
                &input.cwd,
                Some(command),
                &input.reference,
                "Provider CLI returned an unrecognized change-request payload.",
            )
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubPullRequest {
    number: u64,
    title: String,
    url: String,
    base_ref_name: String,
    head_ref_name: String,
    state: String,
}

#[must_use]
pub fn parse_github_pull_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<GitHubPullRequest>(text).ok()?;
    Some(ResolvedPullRequest {
        number: value.number,
        title: non_empty(value.title)?,
        url: value.url,
        base_branch: non_empty(value.base_ref_name)?,
        head_branch: non_empty(value.head_ref_name)?,
        state: parse_state(&value.state, false),
    })
}

#[derive(Deserialize)]
struct GitLabMergeRequest {
    iid: u64,
    title: String,
    web_url: String,
    target_branch: String,
    source_branch: String,
    state: String,
}

#[must_use]
pub fn parse_gitlab_merge_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<GitLabMergeRequest>(text).ok()?;
    Some(ResolvedPullRequest {
        number: value.iid,
        title: non_empty(value.title)?,
        url: value.web_url,
        base_branch: non_empty(value.target_branch)?,
        head_branch: non_empty(value.source_branch)?,
        state: parse_state(&value.state, false),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzurePullRequest {
    pull_request_id: u64,
    title: String,
    #[serde(default)]
    url: String,
    target_ref_name: String,
    source_ref_name: String,
    status: String,
    #[serde(default)]
    is_draft: bool,
}

fn parse_azure_pull_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<AzurePullRequest>(text).ok()?;
    let _ = value.is_draft;
    Some(ResolvedPullRequest {
        number: value.pull_request_id,
        title: non_empty(value.title)?,
        url: value.url,
        base_branch: strip_heads(value.target_ref_name)?,
        head_branch: strip_heads(value.source_ref_name)?,
        state: parse_state(&value.status, false),
    })
}

fn parse_state(value: &str, merged: bool) -> ChangeRequestState {
    if merged || value.eq_ignore_ascii_case("merged") || value.eq_ignore_ascii_case("completed") {
        ChangeRequestState::Merged
    } else if value.eq_ignore_ascii_case("open") || value.eq_ignore_ascii_case("active") {
        ChangeRequestState::Open
    } else {
        ChangeRequestState::Closed
    }
}

fn strip_heads(value: String) -> Option<String> {
    non_empty(value.trim_start_matches("refs/heads/").to_owned())
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn provider_error(
    provider: ProviderKind,
    cwd: &std::path::Path,
    command: Option<&str>,
    reference: &str,
    detail: &str,
) -> SourceControlProviderError {
    SourceControlProviderError {
        tag: "SourceControlProviderError",
        provider,
        operation: "resolvePullRequest".into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        command: command.map(Into::into),
        reference: Some(reference.into()),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_azure_ref_prefixes() {
        let parsed = parse_azure_pull_request(
            r#"{"pullRequestId":3,"title":"Rust","url":"https://example.test/3","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/rust","status":"completed"}"#,
        )
        .expect("Azure pull request");
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.state, ChangeRequestState::Merged);
    }
}
