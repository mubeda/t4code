mod discovery;
mod pull_request;

#[allow(unused_imports)]
pub use discovery::{
    AuthStatus, DiscoveryStatus, SourceControlDiscovery, SourceControlDiscoveryResult,
    SourceControlProviderAuth, SourceControlProviderDiscoveryItem, VcsDiscoveryItem,
    VcsDiscoveryKind, WireOption,
};
#[allow(unused_imports)]
pub use pull_request::{
    ChangeRequestState, CreatePullRequestInput, PullRequestService, ResolvePullRequestInput,
    ResolvedPullRequest, SourceControlProviderError, parse_github_pull_request,
    parse_gitlab_merge_request,
};

use serde::{Deserialize, Serialize};

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
pub struct ProviderInfo {
    pub kind: ProviderKind,
    pub name: String,
    pub base_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubAuthStatusAccount {
    pub host: String,
    pub account: String,
    pub authenticated: bool,
    pub active: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubAuthStatus {
    pub parsed: bool,
    pub accounts: Vec<GitHubAuthStatusAccount>,
}

#[derive(Deserialize)]
struct RawGitHubStatus {
    hosts: std::collections::HashMap<String, Vec<RawGitHubAccount>>,
}

#[derive(Deserialize)]
struct RawGitHubAccount {
    state: String,
    #[serde(default)]
    error: Option<String>,
    active: bool,
    host: String,
    login: String,
}

#[must_use]
pub fn parse_github_auth_status(text: &str) -> GitHubAuthStatus {
    let Ok(status) = serde_json::from_str::<RawGitHubStatus>(text) else {
        return GitHubAuthStatus {
            parsed: false,
            accounts: vec![],
        };
    };
    let accounts = status
        .hosts
        .into_values()
        .flatten()
        .filter_map(|account| {
            let host = non_empty(&account.host)?.to_lowercase();
            let login = non_empty(&account.login)?;
            Some(GitHubAuthStatusAccount {
                host,
                account: login,
                authenticated: account.state == "success",
                active: account.active,
                error: account.error.and_then(|error| non_empty(&error)),
            })
        })
        .collect();
    GitHubAuthStatus {
        parsed: true,
        accounts,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitLabAuthStatusHost {
    pub host: String,
    pub account: Option<String>,
}

#[must_use]
pub fn parse_gitlab_auth_status(text: &str) -> Vec<GitLabAuthStatusHost> {
    let mut result = Vec::new();
    let mut current_host: Option<String> = None;
    let mut current_lines = Vec::new();
    let flush = |result: &mut Vec<GitLabAuthStatusHost>,
                 current_host: &mut Option<String>,
                 current_lines: &mut Vec<String>| {
        let Some(host) = current_host.take() else {
            return;
        };
        let joined = current_lines.join("\n");
        let account = joined
            .split("Logged in to ")
            .nth(1)
            .and_then(|value| value.split(" as ").nth(1))
            .and_then(|value| value.split_whitespace().next())
            .and_then(non_empty);
        result.push(GitLabAuthStatusHost { host, account });
        current_lines.clear();
    };
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if raw_line.len() == raw_line.trim_start().len() && looks_like_host(line) {
            flush(&mut result, &mut current_host, &mut current_lines);
            current_host = Some(line.to_lowercase());
        } else if current_host.is_some() {
            current_lines.push(line.to_owned());
        }
    }
    flush(&mut result, &mut current_host, &mut current_lines);
    result
}

#[must_use]
pub fn provider_from_remote(remote: &str) -> ProviderInfo {
    let normalized = remote.trim().to_lowercase();
    if normalized.contains("github.com") {
        provider(ProviderKind::Github, "GitHub", "https://github.com")
    } else if normalized.contains("gitlab") {
        let host = remote_host(remote).unwrap_or_else(|| "gitlab.com".into());
        provider(ProviderKind::Gitlab, "GitLab", &format!("https://{host}"))
    } else if normalized.contains("dev.azure.com") || normalized.contains("visualstudio.com") {
        provider(
            ProviderKind::AzureDevops,
            "Azure DevOps",
            "https://dev.azure.com",
        )
    } else if normalized.contains("bitbucket") {
        provider(
            ProviderKind::Bitbucket,
            "Bitbucket",
            "https://bitbucket.org",
        )
    } else {
        ProviderInfo {
            kind: ProviderKind::Unknown,
            name: "Unknown".into(),
            base_url: String::new(),
        }
    }
}

fn provider(kind: ProviderKind, name: &str, base_url: &str) -> ProviderInfo {
    ProviderInfo {
        kind,
        name: name.into(),
        base_url: base_url.into(),
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn looks_like_host(value: &str) -> bool {
    let without_port = value
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|character| character.is_ascii_digit()))
        .map_or(value, |(host, _)| host);
    !without_port.is_empty()
        && !without_port.contains(char::is_whitespace)
        && (without_port.contains('.') || without_port.starts_with('['))
}

fn remote_host(remote: &str) -> Option<String> {
    let value = remote.trim();
    if let Some(after_scheme) = value.split_once("://").map(|(_, value)| value) {
        return after_scheme
            .rsplit_once('@')
            .map_or(after_scheme, |(_, host)| host)
            .split(['/', ':'])
            .next()
            .and_then(non_empty)
            .map(|host| host.to_lowercase());
    }
    value
        .split_once('@')
        .map(|(_, value)| value)
        .and_then(|value| value.split([':', '/']).next())
        .and_then(non_empty)
        .map(|host| host.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_github_status_is_not_parsed() {
        assert!(!parse_github_auth_status("not-json").parsed);
    }

    #[test]
    fn recognizes_self_hosted_gitlab() {
        let info = provider_from_remote("ssh://git@gitlab.example.test/team/repo.git");
        assert_eq!(info.kind, ProviderKind::Gitlab);
        assert_eq!(info.base_url, "https://gitlab.example.test");
    }

    #[test]
    fn auth_and_remote_parsers_cover_filtered_accounts_and_host_variants() {
        let github = parse_github_auth_status(
            r#"{"hosts":{"github.com":[
                {"state":"success","active":true,"host":"GITHUB.COM","login":"octo"},
                {"state":"failure","error":" denied ","active":false,"host":"enterprise.test","login":"user"},
                {"state":"success","active":false,"host":" ","login":"ignored"}
            ]}}"#,
        );
        assert!(github.parsed);
        assert_eq!(github.accounts.len(), 2);
        assert_eq!(github.accounts[1].error.as_deref(), Some("denied"));

        let gitlab = parse_gitlab_auth_status(
            "gitlab.example.test:443\n  Logged in to gitlab.example.test as user\n\n[::1]:8443\n  not logged in\n",
        );
        assert_eq!(gitlab.len(), 2);
        assert_eq!(gitlab[0].account.as_deref(), Some("user"));
        assert_eq!(gitlab[1].account, None);

        assert_eq!(
            provider_from_remote("https://github.com/team/repo.git").kind,
            ProviderKind::Github
        );
        assert_eq!(
            provider_from_remote("https://dev.azure.com/team/repo").kind,
            ProviderKind::AzureDevops
        );
        assert_eq!(
            provider_from_remote("git@bitbucket.org:team/repo.git").kind,
            ProviderKind::Bitbucket
        );
        assert_eq!(provider_from_remote("local").kind, ProviderKind::Unknown);
        assert_eq!(
            provider_from_remote("https://user@gitlab.example.test:8443/team/repo.git").base_url,
            "https://gitlab.example.test"
        );
    }
}
