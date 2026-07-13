use std::{ffi::OsString, path::PathBuf, time::Duration};

use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

#[derive(Clone, Debug)]
pub struct CreatePullRequestInput {
    pub cwd: PathBuf,
    pub provider: ProviderKind,
    pub base_branch: String,
    pub head_branch: String,
    pub title: String,
    pub body: String,
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

#[derive(Clone, Debug, Default)]
pub struct PullRequestService {
    runner: ProcessRunner,
    client: Client,
}

impl PullRequestService {
    pub async fn resolve_current(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        if input.provider != ProviderKind::AzureDevops {
            return self.resolve(input, cancellation).await;
        }
        let source_branch = format!("refs/heads/{}", input.reference);
        let output = self
            .run_provider(
                input.provider,
                &input.cwd,
                "resolveCurrentPullRequest",
                "az",
                [
                    "repos",
                    "pr",
                    "list",
                    "--only-show-errors",
                    "--detect",
                    "true",
                    "--source-branch",
                    source_branch.as_str(),
                    "--status",
                    "active",
                    "--top",
                    "1",
                    "--output",
                    "json",
                ],
                cancellation,
            )
            .await?;
        parse_azure_pull_request_list(&output.stdout).ok_or_else(|| {
            operation_error(
                input.provider,
                &input.cwd,
                "resolveCurrentPullRequest",
                Some("az"),
                Some(&input.reference),
                "No open pull request was found for the current branch.",
            )
        })
    }

    pub async fn create(
        &self,
        input: CreatePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        if input.provider == ProviderKind::Bitbucket {
            return self.create_bitbucket(&input, cancellation).await;
        }
        let (command, args): (&str, Vec<OsString>) = match input.provider {
            ProviderKind::Github => (
                "gh",
                [
                    "pr",
                    "create",
                    "--base",
                    input.base_branch.as_str(),
                    "--head",
                    input.head_branch.as_str(),
                    "--title",
                    input.title.as_str(),
                    "--body",
                    input.body.as_str(),
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Gitlab => (
                "glab",
                vec![
                    "api".into(),
                    "--method".into(),
                    "POST".into(),
                    "projects/:fullpath/merge_requests".into(),
                    "--raw-field".into(),
                    format!("source_branch={}", input.head_branch).into(),
                    "--raw-field".into(),
                    format!("target_branch={}", input.base_branch).into(),
                    "--raw-field".into(),
                    format!("title={}", input.title).into(),
                    "--raw-field".into(),
                    format!("description={}", input.body).into(),
                ],
            ),
            ProviderKind::AzureDevops => (
                "az",
                [
                    "repos",
                    "pr",
                    "create",
                    "--only-show-errors",
                    "--detect",
                    "true",
                    "--target-branch",
                    input.base_branch.as_str(),
                    "--source-branch",
                    input.head_branch.as_str(),
                    "--title",
                    input.title.as_str(),
                    "--description",
                    input.body.as_str(),
                    "--output",
                    "json",
                ]
                .into_iter()
                .map(OsString::from)
                .collect(),
            ),
            ProviderKind::Bitbucket | ProviderKind::Unknown => {
                return Err(operation_error(
                    input.provider,
                    &input.cwd,
                    "createPullRequest",
                    None,
                    Some(&input.head_branch),
                    "Pull-request creation is unavailable for this provider.",
                ));
            }
        };
        let output = self
            .run_provider_os(
                input.provider,
                &input.cwd,
                "createPullRequest",
                command,
                args,
                cancellation,
            )
            .await?;
        let parsed = match input.provider {
            ProviderKind::Github => parse_github_create_output(&output.stdout, &input),
            ProviderKind::Gitlab => parse_gitlab_merge_request(&output.stdout),
            ProviderKind::AzureDevops => parse_azure_pull_request(&output.stdout),
            ProviderKind::Bitbucket | ProviderKind::Unknown => None,
        };
        parsed.ok_or_else(|| {
            operation_error(
                input.provider,
                &input.cwd,
                "createPullRequest",
                Some(command),
                Some(&input.head_branch),
                "Provider CLI returned an unrecognized pull-request payload.",
            )
        })
    }

    pub async fn resolve(
        &self,
        input: ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        if input.provider == ProviderKind::Bitbucket {
            return self.resolve_bitbucket(&input, cancellation).await;
        }
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

    async fn resolve_bitbucket(
        &self,
        input: &ResolvePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let locator = self.bitbucket_locator(&input.cwd, cancellation).await?;
        let base = bitbucket_api_base_url();
        let repository_url = format!(
            "{base}/repositories/{}/{}",
            locator.workspace, locator.repository
        );
        if normalize_pull_request_number(&input.reference).is_some() {
            let number = normalize_pull_request_number(&input.reference).unwrap_or_default();
            let pull_request: BitbucketPullRequest = self
                .send_bitbucket(
                    self.client
                        .get(format!("{repository_url}/pullrequests/{number}")),
                    &input.cwd,
                    "resolvePullRequest",
                    Some(&input.reference),
                    cancellation,
                )
                .await?;
            return normalize_bitbucket_pull_request(pull_request).ok_or_else(|| {
                operation_error(
                    ProviderKind::Bitbucket,
                    &input.cwd,
                    "resolvePullRequest",
                    None,
                    Some(&input.reference),
                    "Bitbucket returned an incomplete pull-request payload.",
                )
            });
        }
        let escaped = input.reference.replace('"', "\\\"");
        let query = format!("source.branch.name = \"{escaped}\" AND state = \"OPEN\"");
        let mut list_url =
            reqwest::Url::parse(&format!("{repository_url}/pullrequests")).map_err(|error| {
                operation_error(
                    ProviderKind::Bitbucket,
                    &input.cwd,
                    "resolveCurrentPullRequest",
                    None,
                    Some(&input.reference),
                    &error.to_string(),
                )
            })?;
        list_url
            .query_pairs_mut()
            .append_pair("q", &query)
            .append_pair("pagelen", "1");
        let list: BitbucketPullRequestList = self
            .send_bitbucket(
                self.client.get(list_url),
                &input.cwd,
                "resolveCurrentPullRequest",
                Some(&input.reference),
                cancellation,
            )
            .await?;
        list.values
            .into_iter()
            .next()
            .and_then(normalize_bitbucket_pull_request)
            .ok_or_else(|| {
                operation_error(
                    ProviderKind::Bitbucket,
                    &input.cwd,
                    "resolveCurrentPullRequest",
                    None,
                    Some(&input.reference),
                    "No open Bitbucket pull request was found for the current branch.",
                )
            })
    }

    async fn create_bitbucket(
        &self,
        input: &CreatePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        let locator = self.bitbucket_locator(&input.cwd, cancellation).await?;
        let base = bitbucket_api_base_url();
        let pull_request: BitbucketPullRequest = self
            .send_bitbucket(
                self.client
                    .post(format!(
                        "{base}/repositories/{}/{}/pullrequests",
                        locator.workspace, locator.repository
                    ))
                    .json(&serde_json::json!({
                        "title": input.title,
                        "description": input.body,
                        "source": { "branch": { "name": input.head_branch } },
                        "destination": { "branch": { "name": input.base_branch } },
                    })),
                &input.cwd,
                "createPullRequest",
                Some(&input.head_branch),
                cancellation,
            )
            .await?;
        normalize_bitbucket_pull_request(pull_request).ok_or_else(|| {
            operation_error(
                ProviderKind::Bitbucket,
                &input.cwd,
                "createPullRequest",
                None,
                Some(&input.head_branch),
                "Bitbucket returned an incomplete pull-request payload.",
            )
        })
    }

    async fn bitbucket_locator(
        &self,
        cwd: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<BitbucketRepositoryLocator, SourceControlProviderError> {
        let output = self
            .runner
            .run(
                ProcessRequest {
                    operation: "source-control.bitbucketRemote".into(),
                    command: "git".into(),
                    args: ["remote", "get-url", "origin"]
                        .into_iter()
                        .map(OsString::from)
                        .collect(),
                    cwd: cwd.to_path_buf(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(10),
                    max_output_bytes: 16_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: false,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    "resolveRepository",
                    Some("git"),
                    None,
                    &error.to_string(),
                )
            })?;
        parse_bitbucket_repository(&output.stdout).ok_or_else(|| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                "resolveRepository",
                Some("git"),
                None,
                "The origin remote is not a recognizable Bitbucket repository URL.",
            )
        })
    }

    async fn send_bitbucket<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
        cwd: &std::path::Path,
        operation: &str,
        reference: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<T, SourceControlProviderError> {
        let request = bitbucket_credentials()
            .map(|credentials| credentials.apply(request))
            .ok_or_else(|| {
                operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    operation,
                    None,
                    reference,
                    "Set T4CODE_BITBUCKET_EMAIL and T4CODE_BITBUCKET_API_TOKEN, or T4CODE_BITBUCKET_ACCESS_TOKEN.",
                )
            })?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => {
                return Err(operation_error(
                    ProviderKind::Bitbucket,
                    cwd,
                    operation,
                    None,
                    reference,
                    "Bitbucket request was cancelled.",
                ));
            }
            response = request.send() => response,
        }
        .map_err(|error| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &error.to_string(),
            )
        })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &error.to_string(),
            )
        })?;
        if !status.is_success() {
            return Err(operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &format!(
                    "Bitbucket returned HTTP {status}: {}",
                    truncate_detail(&body)
                ),
            ));
        }
        serde_json::from_str(&body).map_err(|error| {
            operation_error(
                ProviderKind::Bitbucket,
                cwd,
                operation,
                None,
                reference,
                &format!("Bitbucket returned invalid JSON: {error}"),
            )
        })
    }

    async fn run_provider<const N: usize>(
        &self,
        provider: ProviderKind,
        cwd: &std::path::Path,
        operation: &str,
        command: &str,
        args: [&str; N],
        cancellation: &CancellationToken,
    ) -> Result<crate::git::ProcessOutput, SourceControlProviderError> {
        self.run_provider_os(
            provider,
            cwd,
            operation,
            command,
            args.into_iter().map(OsString::from).collect(),
            cancellation,
        )
        .await
    }

    async fn run_provider_os(
        &self,
        provider: ProviderKind,
        cwd: &std::path::Path,
        operation: &str,
        command: &str,
        args: Vec<OsString>,
        cancellation: &CancellationToken,
    ) -> Result<crate::git::ProcessOutput, SourceControlProviderError> {
        self.runner
            .run(
                ProcessRequest {
                    operation: format!("source-control.{operation}").into(),
                    command: command.into(),
                    args,
                    cwd: cwd.to_path_buf(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(60),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: false,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                operation_error(
                    provider,
                    cwd,
                    operation,
                    Some(command),
                    None,
                    &error.to_string(),
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
    #[serde(default)]
    repository: Option<AzureRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzureRepository {
    #[serde(default)]
    web_url: String,
}

#[derive(Deserialize)]
struct BitbucketPullRequestList {
    #[serde(default)]
    values: Vec<BitbucketPullRequest>,
}

#[derive(Deserialize)]
struct BitbucketPullRequest {
    id: u64,
    title: String,
    state: String,
    links: BitbucketLinks,
    source: BitbucketRef,
    destination: BitbucketRef,
}

#[derive(Deserialize)]
struct BitbucketLinks {
    html: BitbucketLink,
}

#[derive(Deserialize)]
struct BitbucketLink {
    href: String,
}

#[derive(Deserialize)]
struct BitbucketRef {
    branch: BitbucketBranch,
}

#[derive(Deserialize)]
struct BitbucketBranch {
    name: String,
}

struct BitbucketRepositoryLocator {
    workspace: String,
    repository: String,
}

enum BitbucketCredentials {
    Bearer(String),
    Basic { email: String, token: String },
}

impl BitbucketCredentials {
    fn apply(self, request: RequestBuilder) -> RequestBuilder {
        match self {
            Self::Bearer(token) => request.bearer_auth(token),
            Self::Basic { email, token } => request.basic_auth(email, Some(token)),
        }
    }
}

fn parse_azure_pull_request(text: &str) -> Option<ResolvedPullRequest> {
    let value = serde_json::from_str::<AzurePullRequest>(text).ok()?;
    normalize_azure_pull_request(value)
}

fn normalize_azure_pull_request(value: AzurePullRequest) -> Option<ResolvedPullRequest> {
    let _ = value.is_draft;
    let url = if value.url.trim().is_empty() {
        value.repository.and_then(|repository| {
            let base = repository.web_url.trim_end_matches('/');
            (!base.is_empty()).then(|| format!("{base}/pullrequest/{}", value.pull_request_id))
        })?
    } else {
        value.url
    };
    Some(ResolvedPullRequest {
        number: value.pull_request_id,
        title: non_empty(value.title)?,
        url,
        base_branch: strip_heads(value.target_ref_name)?,
        head_branch: strip_heads(value.source_ref_name)?,
        state: parse_state(&value.status, false),
    })
}

fn parse_azure_pull_request_list(text: &str) -> Option<ResolvedPullRequest> {
    let values = serde_json::from_str::<Vec<AzurePullRequest>>(text).ok()?;
    values
        .into_iter()
        .next()
        .and_then(normalize_azure_pull_request)
}

fn parse_github_create_output(
    text: &str,
    input: &CreatePullRequestInput,
) -> Option<ResolvedPullRequest> {
    let url = text
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some(ResolvedPullRequest {
        number,
        title: input.title.clone(),
        url: url.to_owned(),
        base_branch: input.base_branch.clone(),
        head_branch: input.head_branch.clone(),
        state: ChangeRequestState::Open,
    })
}

fn normalize_bitbucket_pull_request(
    pull_request: BitbucketPullRequest,
) -> Option<ResolvedPullRequest> {
    Some(ResolvedPullRequest {
        number: pull_request.id,
        title: non_empty(pull_request.title)?,
        url: non_empty(pull_request.links.html.href)?,
        base_branch: non_empty(pull_request.destination.branch.name)?,
        head_branch: non_empty(pull_request.source.branch.name)?,
        state: parse_state(&pull_request.state, false),
    })
}

fn parse_bitbucket_repository(remote: &str) -> Option<BitbucketRepositoryLocator> {
    let normalized = remote
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace('\\', "/");
    let path = normalized
        .split_once("://")
        .map_or(normalized.as_str(), |(_, rest)| rest)
        .split_once(':')
        .map_or_else(
            || {
                normalized
                    .split_once("://")
                    .map_or(normalized.as_str(), |(_, rest)| rest)
            },
            |(_, path)| path,
        );
    let parts = path
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    let repository = parts.last()?.trim();
    let workspace = parts.get(parts.len().checked_sub(2)?)?.trim();
    if workspace.eq_ignore_ascii_case("bitbucket.org")
        || workspace.is_empty()
        || repository.is_empty()
    {
        return None;
    }
    Some(BitbucketRepositoryLocator {
        workspace: workspace.to_owned(),
        repository: repository.to_owned(),
    })
}

fn normalize_pull_request_number(reference: &str) -> Option<u64> {
    let trimmed = reference.trim().trim_start_matches('#');
    trimmed.parse().ok().or_else(|| {
        trimmed
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .and_then(|value| value.parse().ok())
    })
}

fn bitbucket_api_base_url() -> String {
    environment_value("T4CODE_BITBUCKET_API_BASE_URL")
        .unwrap_or_else(|| "https://api.bitbucket.org/2.0".to_owned())
        .trim_end_matches('/')
        .to_owned()
}

fn bitbucket_credentials() -> Option<BitbucketCredentials> {
    if let Some(token) = environment_value("T4CODE_BITBUCKET_ACCESS_TOKEN") {
        return Some(BitbucketCredentials::Bearer(token));
    }
    let email = environment_value("T4CODE_BITBUCKET_EMAIL")?;
    let token = environment_value("T4CODE_BITBUCKET_API_TOKEN")?;
    Some(BitbucketCredentials::Basic { email, token })
}

fn environment_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn truncate_detail(value: &str) -> String {
    value.chars().take(2_000).collect()
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

fn operation_error(
    provider: ProviderKind,
    cwd: &std::path::Path,
    operation: &str,
    command: Option<&str>,
    reference: Option<&str>,
    detail: &str,
) -> SourceControlProviderError {
    SourceControlProviderError {
        tag: "SourceControlProviderError",
        provider,
        operation: operation.into(),
        cwd: cwd.to_string_lossy().into_owned().into(),
        command: command.map(Into::into),
        reference: reference.map(Into::into),
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

    #[test]
    fn parses_azure_current_pull_request_lists_and_derives_a_web_url() {
        let parsed = parse_azure_pull_request_list(
            r#"[{"pullRequestId":7,"title":"Native source control","url":"","targetRefName":"refs/heads/main","sourceRefName":"refs/heads/feature/native","status":"active","repository":{"webUrl":"https://dev.azure.com/example/project/_git/repo"}}]"#,
        )
        .expect("Azure pull request list");
        assert_eq!(parsed.number, 7);
        assert_eq!(parsed.head_branch, "feature/native");
        assert_eq!(
            parsed.url,
            "https://dev.azure.com/example/project/_git/repo/pullrequest/7"
        );
    }

    #[test]
    fn parses_github_create_url_with_input_metadata() {
        let input = CreatePullRequestInput {
            cwd: PathBuf::from("repo"),
            provider: ProviderKind::Github,
            base_branch: "main".into(),
            head_branch: "feature/native".into(),
            title: "Native source control".into(),
            body: String::new(),
        };
        let parsed =
            parse_github_create_output("https://github.com/example/repo/pull/42\n", &input)
                .expect("GitHub create output");
        assert_eq!(parsed.number, 42);
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.state, ChangeRequestState::Open);
    }

    #[test]
    fn parses_bitbucket_https_and_ssh_repository_remotes() {
        for remote in [
            "https://bitbucket.org/example/native-source-control.git",
            "git@bitbucket.org:example/native-source-control.git",
        ] {
            let parsed = parse_bitbucket_repository(remote).expect("Bitbucket repository");
            assert_eq!(parsed.workspace, "example");
            assert_eq!(parsed.repository, "native-source-control");
        }
    }

    #[test]
    fn normalizes_bitbucket_pull_request_payloads() {
        let raw = r#"{"id":19,"title":"Native source control","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/example/repo/pull-requests/19"}},"source":{"branch":{"name":"feature/native"}},"destination":{"branch":{"name":"main"}}}"#;
        let parsed = normalize_bitbucket_pull_request(
            serde_json::from_str(raw).expect("Bitbucket pull request JSON"),
        )
        .expect("Bitbucket pull request");
        assert_eq!(parsed.number, 19);
        assert_eq!(parsed.base_branch, "main");
        assert_eq!(parsed.head_branch, "feature/native");
        assert_eq!(parsed.state, ChangeRequestState::Open);
    }
}
