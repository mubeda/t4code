use std::{ffi::OsString, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{process::Command, sync::mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        CreateWorktreeInput, GitRepository, OutputPolicy, ProcessRequest, ProcessRunner,
        StatusBroadcaster,
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    source_control::{
        ProviderKind, PullRequestService, ResolvePullRequestInput, SourceControlDiscovery,
    },
};

const STREAM_CAPACITY: usize = 8;
const STATUS_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

pub const GIT_VCS_UNARY_METHODS: &[&str] = &[
    "shell.openInEditor",
    "vcs.pull",
    "vcs.refreshStatus",
    "vcs.listRefs",
    "vcs.listCommits",
    "vcs.createWorktree",
    "vcs.removeWorktree",
    "vcs.clone",
    "vcs.createRef",
    "vcs.switchRef",
    "vcs.init",
    "vcs.stageFiles",
    "vcs.unstageFiles",
    "vcs.discardFiles",
    "vcs.generateCommitMessage",
    "git.resolvePullRequest",
    "git.preparePullRequestThread",
    "server.discoverSourceControl",
    "sourceControl.lookupRepository",
    "sourceControl.cloneRepository",
    "sourceControl.publishRepository",
];

pub const GIT_VCS_STREAM_METHODS: &[&str] = &["subscribeVcsStatus", "git.runStackedAction"];

#[derive(Clone)]
pub struct GitVcsRpcServices {
    repository: Arc<GitRepository>,
    broadcaster: StatusBroadcaster,
    discovery: SourceControlDiscovery,
    pull_requests: PullRequestService,
}

impl Default for GitVcsRpcServices {
    fn default() -> Self {
        let repository = Arc::new(GitRepository::default());
        Self {
            broadcaster: StatusBroadcaster::new(
                Arc::clone(&repository),
                STATUS_REFRESH_INTERVAL,
                STREAM_CAPACITY,
            ),
            repository,
            discovery: SourceControlDiscovery::default(),
            pull_requests: PullRequestService::default(),
        }
    }
}

pub fn register_git_vcs_rpc(registry: &mut RpcRegistry, services: GitVcsRpcServices) {
    for method in GIT_VCS_UNARY_METHODS {
        let services = services.clone();
        registry.register_unary(*method, move |request, cancellation| {
            let services = services.clone();
            async move { services.handle_unary(request, cancellation).await }
        });
    }

    let stream_services = services.clone();
    registry.register_stream(GIT_VCS_STREAM_METHODS[0], move |request, cancellation| {
        stream_services.status_stream(request, cancellation)
    });
    registry.register_stream(GIT_VCS_STREAM_METHODS[1], move |request, cancellation| {
        services.stacked_action_stream(request, cancellation)
    });
}

impl GitVcsRpcServices {
    async fn handle_unary(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        match request.tag.as_str() {
            "shell.openInEditor" => self.open_in_editor(request.payload).await,
            "vcs.pull" => {
                let input: CwdInput = decode(request.payload, "vcs.pull")?;
                encode_result(
                    self.repository
                        .pull_current_branch(&input.cwd, &cancellation)
                        .await,
                )
            }
            "vcs.refreshStatus" => {
                let input: CwdInput = decode(request.payload, "vcs.refreshStatus")?;
                encode_result(self.repository.status(&input.cwd, &cancellation).await)
            }
            "vcs.listRefs" => {
                let input: ListRefsInput = decode(request.payload, "vcs.listRefs")?;
                encode_result(
                    self.repository
                        .list_refs(
                            &input.cwd,
                            input.query.as_deref(),
                            input.cursor.unwrap_or(0),
                            input.limit.unwrap_or(50).clamp(1, 200),
                            input.include_matching_remote_refs.unwrap_or(false),
                            input.ref_kind.as_deref(),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.listCommits" => {
                let input: ListCommitsInput = decode(request.payload, "vcs.listCommits")?;
                encode_result(
                    self.repository
                        .list_commits(
                            &input.cwd,
                            input.limit.unwrap_or(50).clamp(1, 200),
                            input.cursor.unwrap_or(0),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.createWorktree" => {
                let input: CreateWorktree = decode(request.payload, "vcs.createWorktree")?;
                encode_result(
                    self.repository
                        .create_worktree(
                            CreateWorktreeInput {
                                cwd: input.cwd,
                                ref_name: input.ref_name,
                                new_ref_name: input.new_ref_name,
                                base_ref_name: input.base_ref_name,
                                path: input.path,
                            },
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.removeWorktree" => {
                let input: RemoveWorktree = decode(request.payload, "vcs.removeWorktree")?;
                encode_null(
                    self.repository
                        .remove_worktree(
                            &input.cwd,
                            &input.path,
                            input.force.unwrap_or(false),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.clone" => {
                let input: CloneInput = decode(request.payload, "vcs.clone")?;
                let result = self
                    .repository
                    .clone_repository(
                        &input.url,
                        &input.parent_dir,
                        input.directory_name.as_deref(),
                        &cancellation,
                    )
                    .await;
                encode_result(result.map(|path| json!({ "path": display_path(path) })))
            }
            "vcs.createRef" => {
                let input: CreateRefInput = decode(request.payload, "vcs.createRef")?;
                let result = self
                    .repository
                    .create_ref(
                        &input.cwd,
                        &input.ref_name,
                        input.switch_ref.unwrap_or(false),
                        &cancellation,
                    )
                    .await;
                encode_result(result.map(|ref_name| json!({ "refName": ref_name })))
            }
            "vcs.switchRef" => {
                let input: SwitchRefInput = decode(request.payload, "vcs.switchRef")?;
                let result = self
                    .repository
                    .switch_ref(&input.cwd, &input.ref_name, &cancellation)
                    .await;
                encode_result(result.map(|ref_name| json!({ "refName": ref_name })))
            }
            "vcs.init" => {
                let input: InitInput = decode(request.payload, "vcs.init")?;
                if input.kind.as_deref().is_some_and(|kind| kind != "git") {
                    return Err(vcs_error(
                        "vcs.init",
                        &input.cwd,
                        "Only the git VCS driver can initialize repositories.",
                    ));
                }
                encode_null(self.repository.init(&input.cwd, &cancellation).await)
            }
            "vcs.stageFiles" | "vcs.unstageFiles" | "vcs.discardFiles" => {
                let input: FilePathsInput = decode(request.payload, &request.tag)?;
                let result = match request.tag.as_str() {
                    "vcs.stageFiles" => {
                        self.repository
                            .stage_files(&input.cwd, &input.file_paths, &cancellation)
                            .await
                    }
                    "vcs.unstageFiles" => {
                        self.repository
                            .unstage_files(&input.cwd, &input.file_paths, &cancellation)
                            .await
                    }
                    _ => {
                        self.repository
                            .discard_files(&input.cwd, &input.file_paths, &cancellation)
                            .await
                    }
                };
                encode_null(result)
            }
            "vcs.generateCommitMessage" => {
                let input: CommitMessageInput =
                    decode(request.payload, "vcs.generateCommitMessage")?;
                let context = self
                    .repository
                    .commit_context(&input.cwd, &cancellation)
                    .await
                    .map_err(serialize_error)?;
                let message = summarize_commit_context(&context, input.file_paths.as_deref());
                Ok(json!({ "message": message }))
            }
            "git.resolvePullRequest" => {
                let input: PullRequestInput = decode(request.payload, "git.resolvePullRequest")?;
                let pull_request = self.resolve_pull_request(&input, &cancellation).await?;
                Ok(json!({ "pullRequest": pull_request }))
            }
            "git.preparePullRequestThread" => {
                let input: PreparePullRequestInput =
                    decode(request.payload, "git.preparePullRequestThread")?;
                self.prepare_pull_request(input, &cancellation).await
            }
            "server.discoverSourceControl" => {
                let _: EmptyInput = decode(request.payload, "server.discoverSourceControl")?;
                Ok(encode_value(
                    self.discovery
                        .discover(PathBuf::from("."), &cancellation)
                        .await,
                ))
            }
            "sourceControl.lookupRepository" => {
                let input: LookupRepositoryInput =
                    decode(request.payload, "sourceControl.lookupRepository")?;
                self.lookup_repository(input, cancellation).await
            }
            "sourceControl.cloneRepository" => {
                let input: CloneRepositoryInput =
                    decode(request.payload, "sourceControl.cloneRepository")?;
                self.clone_source_repository(input, &cancellation).await
            }
            "sourceControl.publishRepository" => {
                let input: PublishRepositoryInput =
                    decode(request.payload, "sourceControl.publishRepository")?;
                self.publish_repository(input, &cancellation).await
            }
            _ => Err(request_error(
                &request.tag,
                "RPC method is not registered here.",
            )),
        }
    }

    fn status_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
        let broadcaster = self.broadcaster.clone();
        tokio::spawn(async move {
            let input = match decode::<CwdInput>(request.payload, "subscribeVcsStatus") {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let mut subscription =
                match broadcaster.subscribe(input.cwd, cancellation.clone()).await {
                    Ok(subscription) => subscription,
                    Err(error) => {
                        let _ = sender.send(Err(serialize_error(error))).await;
                        return;
                    }
                };
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    event = subscription.recv() => {
                        let Some(event) = event else { break };
                        let chunk = serde_json::to_value(event).map(|event| vec![event]).map_err(|error| {
                            request_error("subscribeVcsStatus", &error.to_string())
                        });
                        if sender.send(chunk).await.is_err() { break; }
                    }
                }
            }
        });
        receiver
    }

    fn stacked_action_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
        let repository = Arc::clone(&self.repository);
        tokio::spawn(async move {
            let input = match decode::<StackedActionInput>(request.payload, "git.runStackedAction")
            {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let phases = action_phases(&input.action);
            if send_event(
                &sender,
                json!({
                    "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                    "kind": "action_started", "phases": phases,
                }),
            )
            .await
            .is_err()
            {
                return;
            }
            let result = run_stacked_action(&repository, &input, &cancellation).await;
            let event = match result {
                Ok(result) => json!({
                    "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                    "kind": "action_finished", "result": result,
                }),
                Err(error) => json!({
                    "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                    "kind": "action_failed", "phase": Value::Null,
                    "message": error.get("detail").and_then(Value::as_str).unwrap_or("Git action failed."),
                }),
            };
            let _ = send_event(&sender, event).await;
        });
        receiver
    }

    async fn resolve_pull_request(
        &self,
        input: &PullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<Value, Value> {
        let local = self
            .repository
            .local_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        let provider = local
            .source_control_provider
            .as_ref()
            .map(|provider| match provider.kind {
                crate::git::ProviderKind::Github => ProviderKind::Github,
                crate::git::ProviderKind::Gitlab => ProviderKind::Gitlab,
                crate::git::ProviderKind::AzureDevops => ProviderKind::AzureDevops,
                crate::git::ProviderKind::Bitbucket => ProviderKind::Bitbucket,
                crate::git::ProviderKind::Unknown => ProviderKind::Unknown,
            })
            .unwrap_or(ProviderKind::Unknown);
        let pull_request = self
            .pull_requests
            .resolve(
                ResolvePullRequestInput {
                    cwd: input.cwd.clone(),
                    provider,
                    reference: input.reference.clone(),
                },
                cancellation,
            )
            .await
            .map_err(serialize_error)?;
        serde_json::to_value(pull_request)
            .map_err(|error| request_error("git.resolvePullRequest", &error.to_string()))
    }

    async fn prepare_pull_request(
        &self,
        input: PreparePullRequestInput,
        cancellation: &CancellationToken,
    ) -> RpcResult {
        let pull_request = self
            .resolve_pull_request(
                &PullRequestInput {
                    cwd: input.cwd.clone(),
                    reference: input.reference,
                },
                cancellation,
            )
            .await?;
        let branch = pull_request["headBranch"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if branch.is_empty() {
            return Err(request_error(
                "git.preparePullRequestThread",
                "Pull request has no head branch.",
            ));
        }
        let worktree_path = if input.mode == "worktree" {
            let created = self
                .repository
                .create_worktree(
                    CreateWorktreeInput {
                        cwd: input.cwd,
                        ref_name: branch.clone(),
                        new_ref_name: None,
                        base_ref_name: None,
                        path: None,
                    },
                    cancellation,
                )
                .await
                .map_err(serialize_error)?;
            Some(created.worktree.path)
        } else {
            self.repository
                .switch_ref(&input.cwd, &branch, cancellation)
                .await
                .map_err(serialize_error)?;
            None
        };
        Ok(json!({ "pullRequest": pull_request, "branch": branch, "worktreePath": worktree_path }))
    }

    async fn lookup_repository(
        &self,
        input: LookupRepositoryInput,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let (command, args) = match input.provider.as_str() {
            "github" => (
                "gh",
                vec![
                    "repo",
                    "view",
                    &input.repository,
                    "--json",
                    "nameWithOwner,url,sshUrl",
                ],
            ),
            "gitlab" => (
                "glab",
                vec!["repo", "view", &input.repository, "--output", "json"],
            ),
            provider => {
                return Err(source_control_error(
                    provider,
                    "lookupRepository",
                    "Provider repository lookup is unavailable.",
                ));
            }
        };
        run_provider_json(
            command,
            &args,
            input.cwd.as_deref(),
            cancellation,
            &input.provider,
            "lookupRepository",
        )
        .await
    }

    async fn clone_source_repository(
        &self,
        input: CloneRepositoryInput,
        cancellation: &CancellationToken,
    ) -> RpcResult {
        let remote_url = input
            .remote_url
            .or_else(|| input.repository.clone())
            .ok_or_else(|| {
                source_control_error(
                    input.provider.as_deref().unwrap_or("unknown"),
                    "cloneRepository",
                    "Enter a repository path or clone URL before cloning.",
                )
            })?;
        let destination = input.destination_path;
        let parent = destination.parent().ok_or_else(|| {
            request_error(
                "sourceControl.cloneRepository",
                "Destination has no parent directory.",
            )
        })?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            source_control_error(
                input.provider.as_deref().unwrap_or("unknown"),
                "cloneRepository",
                &error.to_string(),
            )
        })?;
        let directory_name = destination.file_name().and_then(|value| value.to_str());
        let cwd = self
            .repository
            .clone_repository(&remote_url, parent, directory_name, cancellation)
            .await
            .map_err(serialize_error)?;
        Ok(json!({ "cwd": display_path(cwd), "remoteUrl": remote_url, "repository": Value::Null }))
    }

    async fn publish_repository(
        &self,
        input: PublishRepositoryInput,
        cancellation: &CancellationToken,
    ) -> RpcResult {
        if input.provider != "github" {
            return Err(source_control_error(
                &input.provider,
                "publishRepository",
                "Native repository publishing is unavailable for this provider.",
            ));
        }
        let remote_name = input.remote_name.unwrap_or_else(|| "origin".into());
        let visibility = match input.visibility.as_str() {
            "private" => "--private",
            "public" => "--public",
            _ => {
                return Err(source_control_error(
                    &input.provider,
                    "publishRepository",
                    "Repository visibility must be private or public.",
                ));
            }
        };
        let output = ProcessRunner
            .run(
                ProcessRequest {
                    operation: "source-control.publishRepository.create".into(),
                    command: "gh".into(),
                    args: [
                        "repo",
                        "create",
                        input.repository.as_str(),
                        visibility,
                        "--source",
                        ".",
                        "--remote",
                        remote_name.as_str(),
                    ]
                    .into_iter()
                    .map(OsString::from)
                    .collect(),
                    cwd: input.cwd.clone(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(60),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                source_control_error(&input.provider, "publishRepository", &error.to_string())
            })?;
        if output.exit_code != 0 {
            return Err(source_control_error(
                &input.provider,
                "publishRepository",
                "GitHub CLI could not create the repository.",
            ));
        }
        let branch = self
            .repository
            .push_current_branch(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        let repository_url = format!("https://github.com/{}", input.repository);
        let remote_url = if input.protocol.as_deref() == Some("ssh") {
            format!("git@github.com:{}.git", input.repository)
        } else {
            format!("{repository_url}.git")
        };
        let ssh_url = format!("git@github.com:{}.git", input.repository);
        let upstream_branch = format!("{remote_name}/{branch}");
        Ok(json!({
            "repository": {
                "provider": "github",
                "nameWithOwner": input.repository,
                "url": repository_url,
                "sshUrl": ssh_url,
            },
            "remoteName": remote_name,
            "remoteUrl": remote_url,
            "branch": branch,
            "upstreamBranch": upstream_branch,
            "status": "pushed",
        }))
    }

    async fn open_in_editor(&self, payload: Value) -> RpcResult {
        let input: LaunchEditorInput = decode(payload, "shell.openInEditor")?;
        let (command, args): (&str, Vec<String>) = match input.editor.as_str() {
            "file-manager" => return open::that_detached(&input.cwd).map(|()| Value::Null).map_err(|error| json!({
                "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
                "target": display_path(&input.cwd), "command": "open", "args": [], "cause": error.to_string(),
            })),
            "cursor" => ("cursor", vec!["--goto".into(), display_path(&input.cwd)]),
            "trae" => ("trae", vec!["--goto".into(), display_path(&input.cwd)]),
            "kiro" => ("kiro", vec!["ide".into(), "--goto".into(), display_path(&input.cwd)]),
            "vscode" => ("code", vec!["--goto".into(), display_path(&input.cwd)]),
            "vscode-insiders" => ("code-insiders", vec!["--goto".into(), display_path(&input.cwd)]),
            "vscodium" => ("codium", vec!["--goto".into(), display_path(&input.cwd)]),
            "zed" => ("zed", vec![display_path(&input.cwd)]),
            "antigravity" => ("agy", vec!["--goto".into(), display_path(&input.cwd)]),
            editor if JETBRAINS_EDITORS.contains(&editor) => (editor, vec![display_path(&input.cwd)]),
            editor => return Err(json!({ "_tag": "ExternalLauncherUnknownEditorError", "editor": editor })),
        };
        Command::new(command).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(false).spawn()
            .map(|_| Value::Null)
            .map_err(|error| json!({ "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor, "target": display_path(input.cwd), "command": command, "args": args, "cause": error.to_string() }))
    }
}

const JETBRAINS_EDITORS: &[&str] = &[
    "idea",
    "aqua",
    "clion",
    "datagrip",
    "dataspell",
    "goland",
    "phpstorm",
    "pycharm",
    "rider",
    "rubymine",
    "rustrover",
    "webstorm",
];

#[derive(Deserialize)]
struct EmptyInput {}
#[derive(Deserialize)]
struct CwdInput {
    cwd: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRefsInput {
    cwd: PathBuf,
    query: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
    include_matching_remote_refs: Option<bool>,
    ref_kind: Option<String>,
}
#[derive(Deserialize)]
struct ListCommitsInput {
    cwd: PathBuf,
    limit: Option<usize>,
    cursor: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorktree {
    cwd: PathBuf,
    ref_name: String,
    new_ref_name: Option<String>,
    base_ref_name: Option<String>,
    path: Option<PathBuf>,
}
#[derive(Deserialize)]
struct RemoveWorktree {
    cwd: PathBuf,
    path: PathBuf,
    force: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneInput {
    url: String,
    parent_dir: PathBuf,
    directory_name: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRefInput {
    cwd: PathBuf,
    ref_name: String,
    switch_ref: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchRefInput {
    cwd: PathBuf,
    ref_name: String,
}
#[derive(Deserialize)]
struct InitInput {
    cwd: PathBuf,
    kind: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePathsInput {
    cwd: PathBuf,
    file_paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitMessageInput {
    cwd: PathBuf,
    file_paths: Option<Vec<String>>,
}
#[derive(Deserialize)]
struct PullRequestInput {
    cwd: PathBuf,
    reference: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparePullRequestInput {
    cwd: PathBuf,
    reference: String,
    mode: String,
    #[allow(dead_code)]
    thread_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackedActionInput {
    action_id: String,
    cwd: PathBuf,
    action: String,
    commit_message: Option<String>,
    file_paths: Option<Vec<String>>,
    #[allow(dead_code)]
    feature_branch: Option<bool>,
    #[allow(dead_code)]
    commit_staged_index_as_is: Option<bool>,
}
#[derive(Deserialize)]
struct LookupRepositoryInput {
    provider: String,
    repository: String,
    cwd: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneRepositoryInput {
    provider: Option<String>,
    repository: Option<String>,
    remote_url: Option<String>,
    destination_path: PathBuf,
    #[allow(dead_code)]
    protocol: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishRepositoryInput {
    cwd: PathBuf,
    provider: String,
    repository: String,
    visibility: String,
    remote_name: Option<String>,
    protocol: Option<String>,
}
#[derive(Deserialize)]
struct LaunchEditorInput {
    cwd: PathBuf,
    editor: String,
}

async fn run_stacked_action(
    repository: &GitRepository,
    input: &StackedActionInput,
    cancellation: &CancellationToken,
) -> Result<Value, Value> {
    let wants_commit = matches!(
        input.action.as_str(),
        "commit" | "commit_push" | "commit_push_pr"
    );
    let wants_push = matches!(
        input.action.as_str(),
        "push" | "create_pr" | "commit_push" | "commit_push_pr"
    );
    let wants_pr = matches!(input.action.as_str(), "create_pr" | "commit_push_pr");
    let commit = if wants_commit {
        let message = input.commit_message.as_deref().ok_or_else(|| {
            request_error(
                "git.runStackedAction",
                "commitMessage is required for commit actions.",
            )
        })?;
        let sha = repository
            .commit(
                &input.cwd,
                message,
                input.file_paths.as_deref(),
                cancellation,
            )
            .await
            .map_err(serialize_error)?;
        json!({ "status": "created", "commitSha": sha, "subject": message.lines().next().unwrap_or(message) })
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let push = if wants_push {
        let branch = repository
            .push_current_branch(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        json!({ "status": "pushed", "branch": branch })
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let pull_request = if wants_pr {
        let output = ProcessRunner
            .run(
                ProcessRequest {
                    operation: "git.runStackedAction.createPullRequest".into(),
                    command: "gh".into(),
                    args: ["pr", "create", "--fill"]
                        .into_iter()
                        .map(OsString::from)
                        .collect(),
                    cwd: input.cwd.clone(),
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
                source_control_error("github", "createPullRequest", &error.to_string())
            })?;
        let url = output
            .stdout
            .lines()
            .find(|line| line.starts_with("http"))
            .map(str::trim)
            .unwrap_or_default();
        if url.is_empty() {
            return Err(source_control_error(
                "github",
                "createPullRequest",
                "GitHub CLI did not return a pull-request URL.",
            ));
        }
        let number = url
            .rsplit('/')
            .next()
            .and_then(|value| value.parse::<u64>().ok());
        number.map_or_else(
            || json!({ "status": "created", "url": url }),
            |number| json!({ "status": "created", "url": url, "number": number }),
        )
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    Ok(json!({
        "action": input.action,
        "branch": { "status": "skipped_not_requested" },
        "commit": commit,
        "push": push,
        "pr": pull_request,
        "toast": { "title": "Git action completed", "cta": { "kind": "none" } }
    }))
}

fn action_phases(action: &str) -> Vec<&'static str> {
    match action {
        "commit" => vec!["commit"],
        "push" => vec!["push"],
        "create_pr" => vec!["push", "pr"],
        "commit_push" => vec!["commit", "push"],
        "commit_push_pr" => vec!["commit", "push", "pr"],
        _ => vec![],
    }
}

async fn send_event(sender: &mpsc::Sender<RpcStreamChunk>, event: Value) -> Result<(), ()> {
    sender.send(Ok(vec![event])).await.map_err(|_| ())
}

async fn run_provider_json(
    command: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    cancellation: CancellationToken,
    provider: &str,
    operation: &str,
) -> RpcResult {
    let output = ProcessRunner
        .run(
            ProcessRequest {
                operation: format!("source-control.{operation}"),
                command: command.into(),
                args: args.iter().map(OsString::from).collect(),
                cwd: cwd
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .to_path_buf(),
                env: vec![],
                stdin: None,
                timeout: Duration::from_secs(30),
                max_output_bytes: 256_000,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit: true,
            },
            &cancellation,
        )
        .await
        .map_err(|error| source_control_error(provider, operation, &error.to_string()))?;
    if output.exit_code != 0 {
        return Err(source_control_error(
            provider,
            operation,
            "Provider command failed.",
        ));
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| source_control_error(provider, operation, &error.to_string()))
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value, method: &str) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|error| request_error(method, &error.to_string()))
}
fn encode_result<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> RpcResult {
    result.map(encode_value).map_err(serialize_error)
}
fn encode_null<E: serde::Serialize>(result: Result<(), E>) -> RpcResult {
    result.map(|()| Value::Null).map_err(serialize_error)
}
fn encode_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or_else(
        |error| json!({ "_tag": "RpcSerializationError", "message": error.to_string() }),
    )
}
fn serialize_error<E: serde::Serialize>(error: E) -> Value {
    encode_value(error)
}
fn request_error(method: &str, detail: &str) -> Value {
    json!({ "_tag": "RpcRequestInvalid", "method": method, "detail": detail })
}
fn vcs_error(operation: &str, cwd: &std::path::Path, detail: &str) -> Value {
    json!({ "_tag": "GitCommandError", "operation": operation, "command": "git", "cwd": display_path(cwd), "detail": detail })
}
fn source_control_error(provider: &str, operation: &str, detail: &str) -> Value {
    json!({ "_tag": "SourceControlRepositoryError", "provider": provider, "operation": operation, "detail": detail })
}
fn display_path(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
fn summarize_commit_context(context: &str, paths: Option<&[String]>) -> String {
    if let Some(paths) = paths
        && !paths.is_empty()
    {
        return format!("Update {}", paths.join(", "));
    }
    context
        .lines()
        .find(|line| line.starts_with("diff --git "))
        .and_then(|line| line.split(" b/").nth(1))
        .map_or_else(
            || "Update working tree".into(),
            |path| format!("Update {path}"),
        )
}
