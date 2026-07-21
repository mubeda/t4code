use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};

#[cfg(not(windows))]
use std::process::Stdio;

use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(not(windows))]
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        ChangeRequest, CreateWorktreeInput, GitRepository, OutputPolicy, ProcessRequest,
        ProcessRunner, StatusBroadcaster, VcsStatusLocalResult, VcsStatusRemoteResult,
        VcsStatusStreamEvent,
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    source_control::{
        ChangeRequestState, CreatePullRequestInput, ProviderKind, PullRequestService,
        ResolvePullRequestInput, ResolvedPullRequest, SourceControlDiscovery,
    },
};

use super::host_paths::resolve_host_directory;

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
                let mut status = self
                    .repository
                    .status(&input.cwd, &cancellation)
                    .await
                    .map_err(serialize_error)?;
                enrich_remote_pull_request(
                    &self.pull_requests,
                    &input.cwd,
                    &status.local,
                    &mut status.remote,
                    &cancellation,
                )
                .await;
                serde_json::to_value(status)
                    .map_err(|error| request_error("vcs.refreshStatus", &error.to_string()))
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
                let parent_dir = resolve_host_directory(&input.parent_dir, false)
                    .await
                    .map_err(|error| {
                        vcs_error("vcs.clone", &input.parent_dir, &error.to_string())
                    })?;
                let result = self
                    .repository
                    .clone_repository(
                        &input.url,
                        &parent_dir,
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
        let pull_requests = self.pull_requests.clone();
        tokio::spawn(async move {
            let input = match decode::<CwdInput>(request.payload, "subscribeVcsStatus") {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let mut subscription = match broadcaster
                .subscribe(input.cwd.clone(), cancellation.clone())
                .await
            {
                Ok(subscription) => subscription,
                Err(error) => {
                    let _ = sender.send(Err(serialize_error(error))).await;
                    return;
                }
            };
            let mut current_local = None;
            loop {
                tokio::select! {
                    _ = cancellation.cancelled() => break,
                    event = subscription.recv() => {
                        let Some(mut event) = event else { break };
                        match &mut event {
                            VcsStatusStreamEvent::Snapshot { local, remote } => {
                                current_local = Some(local.clone());
                                if let Some(remote) = remote {
                                    enrich_remote_pull_request(
                                        &pull_requests,
                                        &input.cwd,
                                        local,
                                        remote,
                                        &cancellation,
                                    ).await;
                                }
                            }
                            VcsStatusStreamEvent::LocalUpdated { local } => {
                                current_local = Some(local.clone());
                            }
                            VcsStatusStreamEvent::RemoteUpdated { remote } => {
                                if let (Some(local), Some(remote)) = (current_local.as_ref(), remote) {
                                    enrich_remote_pull_request(
                                        &pull_requests,
                                        &input.cwd,
                                        local,
                                        remote,
                                        &cancellation,
                                    ).await;
                                }
                            }
                        }
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
        let pull_requests = self.pull_requests.clone();
        tokio::spawn(async move {
            let input = match decode::<StackedActionInput>(request.payload, "git.runStackedAction")
            {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let phases = action_phases(&input.action, input.feature_branch.unwrap_or(false));
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
            let result =
                run_stacked_action(&repository, &pull_requests, &input, &cancellation).await;
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
        let (branch, worktree_path) = if input.mode == "worktree" {
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
            prepared_worktree_response_fields(branch, created)
        } else {
            self.repository
                .switch_ref(&input.cwd, &branch, cancellation)
                .await
                .map_err(serialize_error)?;
            (branch, None)
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
        open_in_editor_with(payload, launch_editor)
    }
}

fn open_in_editor_with(
    payload: Value,
    launch: impl FnOnce(&EditorLaunchStrategy) -> std::io::Result<()>,
) -> RpcResult {
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
    let target = display_path(&input.cwd);
    let strategy = editor_launch_strategy(command, args.clone(), target.clone());
    launch(&strategy).map(|()| Value::Null).map_err(|error| {
        json!({
            "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
            "target": target, "command": command, "args": args, "cause": error.to_string()
        })
    })
}

fn launch_editor(strategy: &EditorLaunchStrategy) -> std::io::Result<()> {
    match strategy {
        #[cfg(windows)]
        EditorLaunchStrategy::ShellAssociation {
            application,
            target,
        } => open::with_detached(target, application.clone()),
        #[cfg(not(windows))]
        EditorLaunchStrategy::Process { command, args } => Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map(|_| ()),
    }
}

#[derive(Debug, Eq, PartialEq)]
enum EditorLaunchStrategy {
    #[cfg(windows)]
    ShellAssociation { application: String, target: String },
    #[cfg(not(windows))]
    Process { command: String, args: Vec<String> },
}

fn editor_launch_strategy(
    command: &str,
    args: Vec<String>,
    target: String,
) -> EditorLaunchStrategy {
    #[cfg(windows)]
    {
        let _ = args;
        EditorLaunchStrategy::ShellAssociation {
            application: command.to_owned(),
            target,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        EditorLaunchStrategy::Process {
            command: command.to_owned(),
            args,
        }
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
    feature_branch: Option<bool>,
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
    pull_requests: &PullRequestService,
    input: &StackedActionInput,
    cancellation: &CancellationToken,
) -> Result<Value, Value> {
    if !matches!(
        input.action.as_str(),
        "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr"
    ) {
        return Err(request_error(
            "git.runStackedAction",
            &format!("Unsupported Git action '{}'.", input.action),
        ));
    }
    let wants_commit = matches!(
        input.action.as_str(),
        "commit" | "commit_push" | "commit_push_pr"
    );
    let wants_pr = matches!(input.action.as_str(), "create_pr" | "commit_push_pr");
    let feature_branch = input.feature_branch.unwrap_or(false);
    let commit_staged_index_as_is = input.commit_staged_index_as_is.unwrap_or(false);
    if feature_branch && !wants_commit {
        return Err(request_error(
            "git.runStackedAction",
            "Feature-branch checkout is only supported for commit actions.",
        ));
    }
    let initial_local = repository
        .local_status(&input.cwd, cancellation)
        .await
        .map_err(serialize_error)?;
    if feature_branch && !initial_local.has_working_tree_changes {
        return Err(request_error(
            "git.runStackedAction",
            "Cannot create a feature branch because there are no changes to commit.",
        ));
    }
    if input.action == "create_pr" && initial_local.has_working_tree_changes {
        return Err(request_error(
            "git.runStackedAction",
            "Commit local changes before creating a PR.",
        ));
    }
    if !feature_branch && (wants_pr || input.action == "push") && initial_local.ref_name.is_none() {
        let detail = if wants_pr {
            "Cannot create a pull request from detached HEAD."
        } else {
            "Cannot push from detached HEAD."
        };
        return Err(request_error("git.runStackedAction", detail));
    }
    let wants_push = if input.action == "create_pr" {
        let remote = repository
            .remote_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        remote.is_none_or(|status| !status.has_upstream || status.ahead_count > 0)
    } else {
        matches!(
            input.action.as_str(),
            "push" | "commit_push" | "commit_push_pr"
        )
    };
    let resolved_message = if wants_commit {
        Some(match input.commit_message.as_deref().map(str::trim) {
            Some(message) if !message.is_empty() => message.to_owned(),
            _ => {
                let context = repository
                    .commit_context(&input.cwd, cancellation)
                    .await
                    .map_err(serialize_error)?;
                let message = summarize_commit_context(&context, input.file_paths.as_deref());
                if message.is_empty() {
                    "Update working tree".to_owned()
                } else {
                    message
                }
            }
        })
    } else {
        None
    };
    let branch = if feature_branch {
        let subject = resolved_message
            .as_deref()
            .and_then(|message| message.lines().next())
            .unwrap_or("update");
        let preferred = sanitize_feature_branch_name(subject);
        let existing = local_branch_names(repository, &input.cwd, cancellation).await?;
        let name = resolve_feature_branch_name(&existing, &preferred);
        repository
            .create_ref(&input.cwd, &name, true, cancellation)
            .await
            .map_err(serialize_error)?;
        json!({ "status": "created", "name": name })
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let commit = if wants_commit {
        let message = resolved_message.as_deref().unwrap_or("Update working tree");
        let sha = repository
            .commit(
                &input.cwd,
                message,
                input.file_paths.as_deref(),
                commit_staged_index_as_is,
                cancellation,
            )
            .await
            .map_err(serialize_error)?;
        sha.map_or_else(
            || json!({ "status": "skipped_no_changes" }),
            |sha| json!({ "status": "created", "commitSha": sha, "subject": message.lines().next().unwrap_or(message) }),
        )
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
        let current_local = repository
            .local_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        let provider = local_provider_kind(&current_local);
        let head_branch = current_local.ref_name.as_deref().ok_or_else(|| {
            request_error(
                "git.runStackedAction",
                "Cannot create a pull request from detached HEAD.",
            )
        })?;
        if let Some(existing) = resolve_open_pull_request(
            pull_requests,
            &input.cwd,
            provider,
            head_branch,
            cancellation,
        )
        .await
        {
            resolved_pull_request_step("opened_existing", &existing)
        } else {
            let title = match resolved_message
                .as_deref()
                .and_then(|message| message.lines().next())
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                Some(title) => title.to_owned(),
                None => repository
                    .list_commits(&input.cwd, 1, 0, cancellation)
                    .await
                    .map_err(serialize_error)?
                    .commits
                    .into_iter()
                    .next()
                    .map_or_else(|| format!("Update {head_branch}"), |commit| commit.subject),
            };
            let base_branch = current_local
                .default_ref_name
                .clone()
                .unwrap_or_else(|| "main".to_owned());
            let created = pull_requests
                .create(
                    CreatePullRequestInput {
                        cwd: input.cwd.clone(),
                        provider,
                        base_branch,
                        head_branch: head_branch.to_owned(),
                        title,
                        body: String::new(),
                    },
                    cancellation,
                )
                .await
                .map_err(serialize_error)?;
            resolved_pull_request_step("created", &created)
        }
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    Ok(json!({
        "action": input.action,
        "branch": branch,
        "commit": commit,
        "push": push,
        "pr": pull_request,
        "toast": { "title": "Git action completed", "cta": { "kind": "none" } }
    }))
}

fn local_provider_kind(local: &VcsStatusLocalResult) -> ProviderKind {
    local
        .source_control_provider
        .as_ref()
        .map_or(ProviderKind::Unknown, |provider| match provider.kind {
            crate::git::ProviderKind::Github => ProviderKind::Github,
            crate::git::ProviderKind::Gitlab => ProviderKind::Gitlab,
            crate::git::ProviderKind::AzureDevops => ProviderKind::AzureDevops,
            crate::git::ProviderKind::Bitbucket => ProviderKind::Bitbucket,
            crate::git::ProviderKind::Unknown => ProviderKind::Unknown,
        })
}

async fn resolve_open_pull_request(
    pull_requests: &PullRequestService,
    cwd: &std::path::Path,
    provider: ProviderKind,
    reference: &str,
    cancellation: &CancellationToken,
) -> Option<ResolvedPullRequest> {
    if provider == ProviderKind::Unknown {
        return None;
    }
    pull_requests
        .resolve_current(
            ResolvePullRequestInput {
                cwd: cwd.to_path_buf(),
                provider,
                reference: reference.to_owned(),
            },
            cancellation,
        )
        .await
        .ok()
        .filter(|pull_request| pull_request.state == ChangeRequestState::Open)
}

fn resolved_pull_request_step(status: &str, pull_request: &ResolvedPullRequest) -> Value {
    json!({
        "status": status,
        "url": pull_request.url,
        "number": pull_request.number,
        "baseBranch": pull_request.base_branch,
        "headBranch": pull_request.head_branch,
        "title": pull_request.title,
    })
}

async fn enrich_remote_pull_request(
    pull_requests: &PullRequestService,
    cwd: &std::path::Path,
    local: &VcsStatusLocalResult,
    remote: &mut VcsStatusRemoteResult,
    cancellation: &CancellationToken,
) {
    let Some(reference) = local.ref_name.as_deref() else {
        return;
    };
    let Some(pull_request) = resolve_open_pull_request(
        pull_requests,
        cwd,
        local_provider_kind(local),
        reference,
        cancellation,
    )
    .await
    else {
        return;
    };
    remote.pr = Some(ChangeRequest {
        number: pull_request.number,
        title: pull_request.title,
        url: pull_request.url,
        base_ref: pull_request.base_branch,
        head_ref: pull_request.head_branch,
        state: "open".to_owned(),
    });
}

async fn local_branch_names(
    repository: &GitRepository,
    cwd: &std::path::Path,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Value> {
    let mut names = Vec::new();
    let mut cursor = 0;
    loop {
        let page = repository
            .list_refs(cwd, None, cursor, 200, true, Some("local"), cancellation)
            .await
            .map_err(serialize_error)?;
        names.extend(page.refs.into_iter().map(|reference| reference.name));
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = next_cursor;
    }
    Ok(names)
}

fn sanitize_branch_fragment(raw: &str) -> String {
    let mut fragment = String::with_capacity(raw.len().min(64));
    for character in raw.trim().to_lowercase().chars() {
        if matches!(character, '\'' | '"' | '`') {
            continue;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            if character != '-' || !fragment.ends_with('-') {
                fragment.push(character);
            }
        } else if character == '/' {
            if !fragment.ends_with('/') {
                fragment.push('/');
            }
        } else if !fragment.ends_with('-') {
            fragment.push('-');
        }
        if fragment.len() >= 64 {
            fragment.truncate(64);
            break;
        }
    }
    let fragment = fragment
        .trim_matches(|character| matches!(character, '.' | '/' | '_' | '-'))
        .to_owned();
    if fragment.is_empty() {
        "update".to_owned()
    } else {
        fragment
    }
}

fn sanitize_feature_branch_name(raw: &str) -> String {
    let fragment = sanitize_branch_fragment(raw);
    if fragment.starts_with("feature/") {
        fragment
    } else {
        format!("feature/{fragment}")
    }
}

fn resolve_feature_branch_name(existing: &[String], preferred: &str) -> String {
    if !existing
        .iter()
        .any(|name| name.eq_ignore_ascii_case(preferred))
    {
        return preferred.to_owned();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{preferred}-{suffix}");
        if !existing
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&candidate))
        {
            return candidate;
        }
        suffix += 1;
    }
}

fn action_phases(action: &str, feature_branch: bool) -> Vec<&'static str> {
    let mut phases = if feature_branch {
        vec!["branch"]
    } else {
        vec![]
    };
    phases.extend(match action {
        "commit" => vec!["commit"],
        "push" => vec!["push"],
        "create_pr" => vec!["push", "pr"],
        "commit_push" => vec!["commit", "push"],
        "commit_push_pr" => vec!["commit", "push", "pr"],
        _ => vec![],
    });
    phases
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
    if context.trim().is_empty() {
        return String::new();
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

fn prepared_worktree_response_fields(
    _requested_branch: String,
    created: crate::git::VcsCreateWorktreeResult,
) -> (String, Option<String>) {
    (created.worktree.ref_name, Some(created.worktree.path))
}

#[cfg(all(test, windows))]
mod tests {
    use super::{
        EditorLaunchStrategy, editor_launch_strategy, open_in_editor_with,
        prepared_worktree_response_fields,
    };
    use crate::git::{VcsCreateWorktreeResult, VcsWorktree};
    use serde_json::json;

    #[test]
    fn windows_editor_launch_uses_the_shell_resolved_application() {
        let strategy = editor_launch_strategy(
            "cursor",
            vec!["--goto".to_owned(), "C:\\repo\\keybindings.json".to_owned()],
            "C:\\repo\\keybindings.json".to_owned(),
        );

        assert_eq!(
            strategy,
            EditorLaunchStrategy::ShellAssociation {
                application: "cursor".to_owned(),
                target: "C:\\repo\\keybindings.json".to_owned(),
            }
        );
    }

    #[test]
    fn editor_spawn_errors_are_typed_without_launching_an_external_application() {
        let error = open_in_editor_with(
            json!({
                "cwd": "C:\\repo",
                "editor": "rustrover",
            }),
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "missing fixture editor",
                ))
            },
        )
        .expect_err("injected launcher failure");

        assert_eq!(error["_tag"], "ExternalLauncherEditorSpawnError");
        assert_eq!(error["editor"], "rustrover");
        assert_eq!(error["target"], "C:\\repo");
        assert_eq!(error["command"], "rustrover");
        assert_eq!(error["args"], json!(["C:\\repo"]));
        assert_eq!(error["cause"], "missing fixture editor");
    }

    #[test]
    fn pull_request_worktree_response_uses_the_repository_returned_ref() {
        let (branch, worktree_path) = prepared_worktree_response_fields(
            "feature".to_owned(),
            VcsCreateWorktreeResult {
                worktree: VcsWorktree {
                    path: "C:/repo/.t4code-worktrees/feature-2".to_owned(),
                    ref_name: "feature-2".to_owned(),
                },
            },
        );

        assert_eq!(branch, "feature-2");
        assert_eq!(
            worktree_path.as_deref(),
            Some("C:/repo/.t4code-worktrees/feature-2")
        );
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::RequestId;
    use std::ffi::{OsStr, OsString};

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
        fn new(keys: &[&'static str]) -> Self {
            Self {
                saved: keys
                    .iter()
                    .map(|key| (*key, std::env::var_os(key)))
                    .collect(),
            }
        }

        fn set(key: &'static str, value: impl AsRef<OsStr>) {
            // The external-process lock serializes environment-sensitive unit tests.
            unsafe { std::env::set_var(key, value) };
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.saved.drain(..) {
                // Restore every environment value before releasing the process lock.
                unsafe {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
    }

    fn rpc_request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    fn git(cwd: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git should start");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
    }

    async fn unary(services: &GitVcsRpcServices, tag: &str, payload: Value) -> RpcResult {
        services
            .handle_unary(rpc_request(tag, payload), CancellationToken::new())
            .await
    }

    #[tokio::test]
    async fn native_git_vcs_service_covers_repository_lifecycle_and_validation_paths() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temporary = tempfile::tempdir().expect("temporary repository parent");
        let repository = temporary.path().join("repository");
        tokio::fs::create_dir_all(&repository)
            .await
            .expect("repository directory should create");
        let cwd = repository.to_string_lossy().into_owned();
        let services = GitVcsRpcServices::default();

        assert!(
            unary(&services, "vcs.init", json!({"cwd":cwd,"kind":"mercurial"}),)
                .await
                .is_err()
        );
        assert_eq!(
            unary(&services, "vcs.init", json!({"cwd":cwd,"kind":"git"}))
                .await
                .expect("repository should initialize"),
            Value::Null,
        );
        git(&repository, &["config", "user.name", "T4Code Test"]);
        git(
            &repository,
            &["config", "user.email", "t4code@example.test"],
        );

        tokio::fs::write(repository.join("tracked.txt"), "first\n")
            .await
            .expect("tracked file should write");
        let status = unary(&services, "vcs.refreshStatus", json!({"cwd":cwd}))
            .await
            .expect("status should refresh");
        assert!(
            status["workingTree"]["files"]
                .as_array()
                .is_some_and(|files| !files.is_empty())
        );
        assert_eq!(
            unary(
                &services,
                "vcs.generateCommitMessage",
                json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
            )
            .await
            .expect("commit message should generate")["message"],
            "Update tracked.txt",
        );
        assert_eq!(
            unary(
                &services,
                "vcs.stageFiles",
                json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
            )
            .await
            .expect("file should stage"),
            Value::Null,
        );
        git(&repository, &["commit", "--quiet", "-m", "initial"]);
        git(&repository, &["branch", "-M", "main"]);

        let refs = unary(
            &services,
            "vcs.listRefs",
            json!({
                "cwd":cwd,
                "query":"",
                "cursor":0,
                "limit":500,
                "includeMatchingRemoteRefs":true,
                "refKind":"branch",
            }),
        )
        .await
        .expect("refs should list");
        assert!(
            refs["refs"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );
        let commits = unary(
            &services,
            "vcs.listCommits",
            json!({"cwd":cwd,"cursor":0,"limit":500}),
        )
        .await
        .expect("commits should list");
        assert!(
            commits["commits"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );

        assert_eq!(
            unary(
                &services,
                "vcs.createRef",
                json!({"cwd":cwd,"refName":"feature","switchRef":true}),
            )
            .await
            .expect("feature ref should create")["refName"],
            "feature",
        );
        assert_eq!(
            unary(
                &services,
                "vcs.switchRef",
                json!({"cwd":cwd,"refName":"main"}),
            )
            .await
            .expect("base ref should switch")["refName"],
            "main",
        );

        tokio::fs::write(repository.join("tracked.txt"), "second\n")
            .await
            .expect("tracked file should change");
        unary(
            &services,
            "vcs.stageFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should stage");
        unary(
            &services,
            "vcs.unstageFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should unstage");
        unary(
            &services,
            "vcs.discardFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should discard");

        let worktree = temporary.path().join("worktree");
        unary(
            &services,
            "vcs.createWorktree",
            json!({
                "cwd":cwd,
                "refName":"feature",
                "newRefName":null,
                "baseRefName":null,
                "path":worktree,
            }),
        )
        .await
        .expect("worktree should create");
        unary(
            &services,
            "vcs.removeWorktree",
            json!({"cwd":cwd,"path":worktree,"force":true}),
        )
        .await
        .expect("worktree should remove");

        let clone_parent = temporary.path().join("clones");
        tokio::fs::create_dir_all(&clone_parent)
            .await
            .expect("clone parent should create");
        let cloned = unary(
            &services,
            "vcs.clone",
            json!({
                "url":repository,
                "parentDir":clone_parent,
                "directoryName":"copy",
            }),
        )
        .await
        .expect("repository should clone");
        assert!(
            cloned["path"]
                .as_str()
                .is_some_and(|path| path.ends_with("copy"))
        );

        assert!(
            unary(&services, "vcs.pull", json!({"cwd":cwd}))
                .await
                .is_err()
        );
        assert!(
            unary(
                &services,
                "git.resolvePullRequest",
                json!({"cwd":cwd,"reference":"current"}),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "sourceControl.lookupRepository",
                json!({"provider":"unknown","repository":"owner/name","cwd":cwd}),
            )
            .await
            .is_err()
        );
        assert!(
            unary(&services, "server.discoverSourceControl", json!({}))
                .await
                .expect("source control should discover")["versionControlSystems"]
                .is_array()
        );
        let source_clone = temporary.path().join("source-clone");
        assert!(
            unary(
                &services,
                "sourceControl.cloneRepository",
                json!({
                    "remoteUrl":format!("file://{}", repository.display()),
                    "destinationPath":source_clone,
                }),
            )
            .await
            .expect("source repository should clone")["cwd"]
                .is_string()
        );
        assert!(
            unary(
                &services,
                "sourceControl.publishRepository",
                json!({
                    "cwd":cwd,
                    "provider":"github",
                    "repository":"owner/name",
                    "visibility":"friends-only",
                }),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "git.preparePullRequestThread",
                json!({
                    "cwd":cwd,
                    "reference":"current",
                    "mode":"unsupported",
                    "threadId":"thread-1",
                }),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "shell.openInEditor",
                json!({"cwd":cwd,"editor":"missing-editor"}),
            )
            .await
            .is_err()
        );
        assert!(unary(&services, "unknown.method", json!({})).await.is_err());
        assert!(
            unary(&services, "vcs.listRefs", json!({"cwd":42}))
                .await
                .is_err()
        );

        let mut invalid_status = services.status_stream(
            rpc_request("subscribeVcsStatus", json!({"cwd":42})),
            CancellationToken::new(),
        );
        assert!(invalid_status.recv().await.expect("status error").is_err());
        let mut invalid_action = services.stacked_action_stream(
            rpc_request("git.runStackedAction", json!({"actionId":"invalid"})),
            CancellationToken::new(),
        );
        assert!(invalid_action.recv().await.expect("action error").is_err());

        let mut unsupported_action = services.stacked_action_stream(
            rpc_request(
                "git.runStackedAction",
                json!({
                    "actionId":"unsupported-action",
                    "cwd":cwd,
                    "action":"unsupported"
                }),
            ),
            CancellationToken::new(),
        );
        let started = unsupported_action
            .recv()
            .await
            .expect("action start chunk")
            .expect("action start event");
        assert_eq!(started[0]["kind"], "action_started");
        let failed = unsupported_action
            .recv()
            .await
            .expect("action failure chunk")
            .expect("action failure event");
        assert_eq!(failed[0]["kind"], "action_failed");
        assert!(
            failed[0]["message"]
                .as_str()
                .is_some_and(|message| message.contains("Unsupported Git action"))
        );

        let mut unavailable_status = services.status_stream(
            rpc_request("subscribeVcsStatus", json!({"cwd":"\u{0}"})),
            CancellationToken::new(),
        );
        assert!(
            unavailable_status
                .recv()
                .await
                .expect("unavailable status chunk")
                .is_err()
        );

        let branches =
            local_branch_names(&services.repository, &repository, &CancellationToken::new())
                .await
                .expect("local branches should list");
        assert!(branches.iter().any(|branch| branch == "main"));
        assert_eq!(
            sanitize_branch_fragment(" Feature: It's Ready! "),
            "feature-its-ready"
        );
        assert_eq!(sanitize_branch_fragment("..."), "update");
        assert_eq!(
            sanitize_feature_branch_name("Ready Now"),
            "feature/ready-now"
        );
        assert_eq!(
            sanitize_feature_branch_name("feature/already"),
            "feature/already",
        );
        assert_eq!(
            resolve_feature_branch_name(
                &["feature/update".to_owned(), "FEATURE/UPDATE-2".to_owned()],
                "feature/update",
            ),
            "feature/update-3",
        );
        assert_eq!(
            action_phases("commit_push_pr", true),
            vec!["branch", "commit", "push", "pr"]
        );
        assert_eq!(action_phases("unknown", false), Vec::<&str>::new());

        let (event_sender, mut event_receiver) = mpsc::channel(1);
        send_event(&event_sender, json!({"kind":"test"}))
            .await
            .expect("stream event should send");
        assert_eq!(
            event_receiver
                .recv()
                .await
                .expect("stream event")
                .expect("successful stream event"),
            vec![json!({"kind":"test"})],
        );
        drop(event_receiver);
        assert!(send_event(&event_sender, json!({})).await.is_err());

        assert_eq!(
            run_provider_json(
                "/bin/sh",
                &["-c", "printf '{\"ok\":true}'"],
                Some(&repository),
                CancellationToken::new(),
                "fixture",
                "success",
            )
            .await
            .expect("provider JSON should decode"),
            json!({"ok":true}),
        );
        assert!(
            run_provider_json(
                "/bin/sh",
                &["-c", "exit 1"],
                None,
                CancellationToken::new(),
                "fixture",
                "failure",
            )
            .await
            .is_err()
        );
        assert!(
            run_provider_json(
                "/bin/sh",
                &["-c", "printf invalid"],
                None,
                CancellationToken::new(),
                "fixture",
                "invalid-json",
            )
            .await
            .is_err()
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let bare_remote = temporary.path().join("published.git");
            tokio::fs::create_dir(&bare_remote)
                .await
                .expect("bare remote directory");
            git(&bare_remote, &["init", "--bare"]);

            let gh = temporary.path().join("gh");
            tokio::fs::write(
                &gh,
                r#"#!/bin/sh
case "$1:$2" in
  repo:view)
    printf '%s\n' '{"nameWithOwner":"owner/name","url":"https://github.test/owner/name","sshUrl":"git@github.test:owner/name.git"}'
    ;;
  repo:create)
    git remote add origin "$T4CODE_TEST_REMOTE"
    ;;
  *)
    exit 64
    ;;
esac
"#,
            )
            .await
            .expect("gh fixture");
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700))
                .expect("gh fixture permissions");

            let _environment = EnvGuard::new(&["PATH", "T4CODE_TEST_REMOTE"]);
            let inherited_path = std::env::var_os("PATH").unwrap_or_default();
            EnvGuard::set(
                "PATH",
                std::env::join_paths(
                    std::iter::once(temporary.path().to_path_buf())
                        .chain(std::env::split_paths(&inherited_path)),
                )
                .expect("fixture PATH"),
            );
            EnvGuard::set("T4CODE_TEST_REMOTE", &bare_remote);

            let lookup = unary(
                &services,
                "sourceControl.lookupRepository",
                json!({
                    "provider":"github",
                    "repository":"owner/name",
                    "cwd":cwd
                }),
            )
            .await
            .expect("GitHub repository lookup should use the fixture CLI");
            assert_eq!(lookup["nameWithOwner"], "owner/name");

            let published = unary(
                &services,
                "sourceControl.publishRepository",
                json!({
                    "cwd":cwd,
                    "provider":"github",
                    "repository":"owner/name",
                    "visibility":"private",
                    "protocol":"ssh",
                    "remoteName":"origin"
                }),
            )
            .await
            .expect("GitHub repository publish should use the fixture CLI");
            assert_eq!(published["status"], "pushed");
            assert_eq!(published["branch"], "main");
            assert_eq!(published["remoteUrl"], "git@github.com:owner/name.git");
            assert_eq!(published["upstreamBranch"], "origin/main");
        }

        let invalid_action = StackedActionInput {
            action_id: "action-1".to_owned(),
            cwd: repository.clone(),
            action: "unsupported".to_owned(),
            commit_message: None,
            file_paths: None,
            feature_branch: None,
            commit_staged_index_as_is: None,
        };
        assert!(
            run_stacked_action(
                &services.repository,
                &services.pull_requests,
                &invalid_action,
                &CancellationToken::new(),
            )
            .await
            .is_err()
        );
        assert!(matches!(
            editor_launch_strategy(
                "missing-editor",
                vec!["--goto".to_owned(), repository.display().to_string()],
                repository.display().to_string(),
            ),
            EditorLaunchStrategy::Process { .. }
        ));

        assert_eq!(summarize_commit_context("", None), "");
        assert_eq!(
            summarize_commit_context("diff --git a/a.txt b/a.txt\n", None),
            "Update a.txt",
        );
        assert_eq!(
            summarize_commit_context("plain context", None),
            "Update working tree",
        );
        assert!(request_error("method", "detail").is_object());
        assert!(vcs_error("operation", &repository, "detail").is_object());
        assert!(source_control_error("unknown", "lookup", "detail").is_object());
    }

    #[tokio::test]
    async fn every_unary_method_rejects_malformed_payloads_through_its_typed_decoder() {
        let services = GitVcsRpcServices::default();
        for method in GIT_VCS_UNARY_METHODS {
            let result = services
                .handle_unary(
                    rpc_request(method, json!("not-an-object")),
                    CancellationToken::new(),
                )
                .await;
            assert!(
                result.is_err(),
                "{method} unexpectedly accepted a string payload"
            );
        }
    }
}
