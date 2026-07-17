use std::{ffi::OsString, path::PathBuf, time::Duration};

use serde::{
    Serialize,
    ser::{SerializeMap, Serializer},
};
use tokio_util::sync::CancellationToken;

use crate::git::{OutputPolicy, ProcessOutput, ProcessRequest, ProcessRunner};

use super::{ProviderKind, parse_github_auth_status, parse_gitlab_auth_status};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_OUTPUT_LIMIT: usize = 8_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WireOption<T>(pub Option<T>);

impl<T> WireOption<T> {
    fn some(value: T) -> Self {
        Self(Some(value))
    }

    fn none() -> Self {
        Self(None)
    }
}

impl<T: Serialize> Serialize for WireOption<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(if self.0.is_some() { 3 } else { 2 }))?;
        map.serialize_entry("_id", "Option")?;
        match self.0.as_ref() {
            Some(value) => {
                map.serialize_entry("_tag", "Some")?;
                map.serialize_entry("value", value)?;
            }
            None => map.serialize_entry("_tag", "None")?,
        }
        map.end()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveryStatus {
    Available,
    Missing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsDiscoveryKind {
    Git,
    Jj,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsDiscoveryItem {
    pub kind: VcsDiscoveryKind,
    pub label: String,
    pub executable: String,
    pub implemented: bool,
    pub status: DiscoveryStatus,
    pub version: WireOption<String>,
    pub install_hint: String,
    pub detail: WireOption<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthStatus {
    Authenticated,
    Unauthenticated,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SourceControlProviderAuth {
    pub status: AuthStatus,
    pub account: WireOption<String>,
    pub host: WireOption<String>,
    pub detail: WireOption<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlProviderDiscoveryItem {
    pub kind: ProviderKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    pub status: DiscoveryStatus,
    pub version: WireOption<String>,
    pub install_hint: String,
    pub detail: WireOption<String>,
    pub auth: SourceControlProviderAuth,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlDiscoveryResult {
    pub version_control_systems: Vec<VcsDiscoveryItem>,
    pub source_control_providers: Vec<SourceControlProviderDiscoveryItem>,
}

struct VcsProbe {
    kind: VcsDiscoveryKind,
    label: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    implemented: bool,
    install_hint: &'static str,
}

struct ProviderProbe {
    kind: ProviderKind,
    label: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    auth_args: &'static [&'static str],
    install_hint: &'static str,
}

const VCS_PROBES: &[VcsProbe] = &[
    VcsProbe {
        kind: VcsDiscoveryKind::Git,
        label: "Git",
        executable: "git",
        version_args: &["--version"],
        implemented: true,
        install_hint: "Install Git from https://git-scm.com/downloads or with your package manager.",
    },
    VcsProbe {
        kind: VcsDiscoveryKind::Jj,
        label: "Jujutsu",
        executable: "jj",
        version_args: &["--version"],
        implemented: false,
        install_hint: "Install Jujutsu from https://github.com/jj-vcs/jj.",
    },
];

const PROVIDER_PROBES: &[ProviderProbe] = &[
    ProviderProbe {
        kind: ProviderKind::Github,
        label: "GitHub",
        executable: "gh",
        version_args: &["--version"],
        auth_args: &["auth", "status", "--json", "hosts"],
        install_hint: "Install GitHub CLI from https://cli.github.com/.",
    },
    ProviderProbe {
        kind: ProviderKind::Gitlab,
        label: "GitLab",
        executable: "glab",
        version_args: &["--version"],
        auth_args: &["auth", "status"],
        install_hint: "Install GitLab CLI from https://gitlab.com/gitlab-org/cli.",
    },
    ProviderProbe {
        kind: ProviderKind::AzureDevops,
        label: "Azure DevOps",
        executable: "az",
        version_args: &["version"],
        auth_args: &["account", "show", "--output", "json"],
        install_hint: "Install Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli.",
    },
];

#[derive(Clone, Copy, Debug, Default)]
pub struct SourceControlDiscovery {
    runner: ProcessRunner,
}

impl SourceControlDiscovery {
    pub async fn discover(
        &self,
        cwd: PathBuf,
        cancellation: &CancellationToken,
    ) -> SourceControlDiscoveryResult {
        let mut version_control_systems = Vec::with_capacity(VCS_PROBES.len());
        for spec in VCS_PROBES {
            let result = self
                .probe(&cwd, spec.executable, spec.version_args, cancellation)
                .await;
            let available = result.as_ref().is_some_and(|output| output.exit_code == 0);
            version_control_systems.push(VcsDiscoveryItem {
                kind: spec.kind,
                label: spec.label.into(),
                executable: spec.executable.into(),
                implemented: spec.implemented,
                status: if available {
                    DiscoveryStatus::Available
                } else {
                    DiscoveryStatus::Missing
                },
                version: first_line(result.as_ref()),
                install_hint: spec.install_hint.into(),
                detail: if result.is_none() {
                    WireOption::some("Command was not found on the server PATH.".into())
                } else {
                    WireOption::none()
                },
            });
        }

        let mut source_control_providers = Vec::with_capacity(PROVIDER_PROBES.len() + 1);
        for spec in PROVIDER_PROBES {
            let version = self
                .probe(&cwd, spec.executable, spec.version_args, cancellation)
                .await;
            let available = version.as_ref().is_some_and(|output| output.exit_code == 0);
            let auth = if available {
                let output = self
                    .probe(&cwd, spec.executable, spec.auth_args, cancellation)
                    .await;
                parse_auth(spec.kind, output.as_ref())
            } else {
                unknown_auth("Hosting integration command was not found on the server PATH.")
            };
            source_control_providers.push(SourceControlProviderDiscoveryItem {
                kind: spec.kind,
                label: spec.label.into(),
                executable: Some(spec.executable.into()),
                status: if available {
                    DiscoveryStatus::Available
                } else {
                    DiscoveryStatus::Missing
                },
                version: first_line(version.as_ref()),
                install_hint: spec.install_hint.into(),
                detail: if version.is_none() {
                    WireOption::some("Command was not found on the server PATH.".into())
                } else {
                    WireOption::none()
                },
                auth,
            });
        }
        source_control_providers.push(SourceControlProviderDiscoveryItem {
            kind: ProviderKind::Bitbucket,
            label: "Bitbucket".into(),
            executable: None,
            status: DiscoveryStatus::Missing,
            version: WireOption::none(),
            install_hint: "Configure Bitbucket API credentials in server settings.".into(),
            detail: WireOption::none(),
            auth: unknown_auth("Bitbucket API credentials are not configured."),
        });
        SourceControlDiscoveryResult {
            version_control_systems,
            source_control_providers,
        }
    }

    async fn probe(
        &self,
        cwd: &std::path::Path,
        executable: &str,
        args: &[&str],
        cancellation: &CancellationToken,
    ) -> Option<ProcessOutput> {
        self.runner
            .run(
                ProcessRequest {
                    operation: "source-control.discovery.probe".into(),
                    command: executable.into(),
                    args: args.iter().map(OsString::from).collect(),
                    cwd: cwd.to_path_buf(),
                    env: vec![],
                    stdin: None,
                    timeout: PROBE_TIMEOUT,
                    max_output_bytes: PROBE_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Truncate,
                    append_truncation_marker: true,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .ok()
    }
}

fn first_line(result: Option<&ProcessOutput>) -> WireOption<String> {
    result
        .into_iter()
        .flat_map(|output| output.stdout.lines().chain(output.stderr.lines()))
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map_or_else(WireOption::none, |line| WireOption::some(line.into()))
}

fn parse_auth(kind: ProviderKind, result: Option<&ProcessOutput>) -> SourceControlProviderAuth {
    let Some(result) = result else {
        return unknown_auth("Authentication status command failed.");
    };
    let combined = [result.stdout.as_str(), result.stderr.as_str()]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    match kind {
        ProviderKind::Github => {
            let parsed = parse_github_auth_status(&combined);
            let account = parsed
                .accounts
                .iter()
                .find(|account| account.authenticated && account.active)
                .or_else(|| parsed.accounts.iter().find(|account| account.authenticated));
            account.map_or_else(
                || {
                    if parsed.parsed {
                        unauthenticated_auth()
                    } else {
                        unknown_auth("GitHub CLI authentication output was not recognized.")
                    }
                },
                |account| SourceControlProviderAuth {
                    status: AuthStatus::Authenticated,
                    account: WireOption::some(account.account.clone()),
                    host: WireOption::some(account.host.clone()),
                    detail: WireOption::none(),
                },
            )
        }
        ProviderKind::Gitlab => {
            let hosts = parse_gitlab_auth_status(&combined);
            hosts
                .iter()
                .find(|host| host.account.is_some())
                .map_or_else(unauthenticated_auth, |host| SourceControlProviderAuth {
                    status: AuthStatus::Authenticated,
                    account: WireOption(host.account.clone()),
                    host: WireOption::some(host.host.clone()),
                    detail: WireOption::none(),
                })
        }
        ProviderKind::AzureDevops if result.exit_code == 0 => SourceControlProviderAuth {
            status: AuthStatus::Authenticated,
            account: WireOption::none(),
            host: WireOption::some("dev.azure.com".into()),
            detail: WireOption::none(),
        },
        _ => unauthenticated_auth(),
    }
}

fn unknown_auth(detail: &str) -> SourceControlProviderAuth {
    SourceControlProviderAuth {
        status: AuthStatus::Unknown,
        account: WireOption::none(),
        host: WireOption::none(),
        detail: WireOption::some(detail.into()),
    }
}

fn unauthenticated_auth() -> SourceControlProviderAuth {
    SourceControlProviderAuth {
        status: AuthStatus::Unauthenticated,
        account: WireOption::none(),
        host: WireOption::none(),
        detail: WireOption::none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(exit_code: i32, stdout: &str, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            exit_code,
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[tokio::test]
    async fn discovery_covers_native_probe_inventory() {
        let root = tempfile::tempdir().unwrap();
        let result = SourceControlDiscovery::default()
            .discover(root.path().to_path_buf(), &CancellationToken::new())
            .await;
        assert_eq!(result.version_control_systems.len(), VCS_PROBES.len());
        assert_eq!(
            result.source_control_providers.len(),
            PROVIDER_PROBES.len() + 1
        );
        assert_eq!(
            result.source_control_providers.last().unwrap().kind,
            ProviderKind::Bitbucket
        );
    }

    #[test]
    fn auth_and_wire_helpers_cover_success_unknown_and_empty_results() {
        assert_eq!(first_line(None), WireOption::none());
        assert_eq!(
            first_line(Some(&output(0, "\n version 1 \n", "ignored"))),
            WireOption::some("version 1".to_owned())
        );
        assert_eq!(
            first_line(Some(&output(1, "", " error detail "))),
            WireOption::some("error detail".to_owned())
        );

        let github = parse_auth(
            ProviderKind::Github,
            Some(&output(
                0,
                r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octo"}]}}"#,
                "",
            )),
        );
        assert_eq!(github.status, AuthStatus::Authenticated);
        assert_eq!(github.account.0.as_deref(), Some("octo"));
        assert_eq!(
            parse_auth(
                ProviderKind::Github,
                Some(&output(1, r#"{"hosts":{}}"#, "")),
            )
            .status,
            AuthStatus::Unauthenticated
        );
        assert_eq!(
            parse_auth(ProviderKind::Github, Some(&output(1, "unrecognized", "")),).status,
            AuthStatus::Unknown
        );

        let gitlab = parse_auth(
            ProviderKind::Gitlab,
            Some(&output(
                0,
                "gitlab.example.test\n  Logged in to gitlab.example.test as user\n",
                "",
            )),
        );
        assert_eq!(gitlab.status, AuthStatus::Authenticated);
        assert_eq!(gitlab.account.0.as_deref(), Some("user"));
        assert_eq!(
            parse_auth(
                ProviderKind::Gitlab,
                Some(&output(1, "gitlab.example.test\n  not logged in\n", "")),
            )
            .status,
            AuthStatus::Unauthenticated
        );
        assert_eq!(
            parse_auth(ProviderKind::AzureDevops, Some(&output(0, "{}", ""))).status,
            AuthStatus::Authenticated
        );
        assert_eq!(
            parse_auth(ProviderKind::AzureDevops, Some(&output(1, "", ""))).status,
            AuthStatus::Unauthenticated
        );
        assert_eq!(
            parse_auth(ProviderKind::Github, None).status,
            AuthStatus::Unknown
        );

        assert_eq!(
            serde_json::to_value(WireOption::some("value")).unwrap(),
            serde_json::json!({"_id":"Option","_tag":"Some","value":"value"})
        );
        assert_eq!(
            serde_json::to_value(WireOption::<String>::none()).unwrap(),
            serde_json::json!({"_id":"Option","_tag":"None"})
        );
    }
}
