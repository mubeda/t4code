use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fmt, fs,
    future::Future,
    io,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use crate::diagnostics::redact_sensitive_text;

use super::{
    ChangeRequest, CreateWorktreeInput, GitCommandDiagnostics, GitCommandError, OutputPolicy,
    ProcessError, ProcessOutput, ProcessRequest, ProcessRunner, ProviderKind, PullStatus,
    SourceControlProviderInfo, VcsCommit, VcsCreateWorktreeResult, VcsListCommitsResult,
    VcsListRefsResult, VcsPullResult, VcsRef, VcsStagingArea, VcsStatusLocalResult,
    VcsStatusRemoteResult, VcsStatusResult, VcsWorkingTree, VcsWorkingTreeFile,
    VcsWorkingTreeFileStatus, VcsWorktree, parse_numstat, parse_porcelain_v2_line,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTPUT_LIMIT: usize = 1_000_000;
const COMMIT_FIELD_SEPARATOR: char = '\x1f';
const CLONE_OPERATION: &str = "GitVcsDriver.clone";
const MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS: usize = 100;

pub type BoxWorktreeBaseDirectoryFuture<'a> =
    Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;

pub trait WorktreeBaseDirectoryProvider: Send + Sync {
    fn worktree_base_directory<'a>(&'a self) -> BoxWorktreeBaseDirectoryFuture<'a>;
}

#[derive(Debug, Default)]
struct DefaultWorktreeBaseDirectory;

impl WorktreeBaseDirectoryProvider for DefaultWorktreeBaseDirectory {
    fn worktree_base_directory<'a>(&'a self) -> BoxWorktreeBaseDirectoryFuture<'a> {
        Box::pin(async { None })
    }
}

#[derive(Clone)]
pub struct GitRepository {
    runner: ProcessRunner,
    worktree_settings: Arc<dyn WorktreeBaseDirectoryProvider>,
}

impl Default for GitRepository {
    fn default() -> Self {
        Self {
            runner: ProcessRunner,
            worktree_settings: Arc::new(DefaultWorktreeBaseDirectory),
        }
    }
}

impl fmt::Debug for GitRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitRepository")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
struct WorktreePathPolicy {
    configured_base: Option<PathBuf>,
}

impl WorktreePathPolicy {
    fn path_for(&self, cwd: &Path, target_ref: &str) -> PathBuf {
        let repo = cwd
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("repository");
        let base = self
            .configured_base
            .clone()
            .unwrap_or_else(|| cwd.parent().unwrap_or(cwd).join(".t4code-worktrees"));
        base.join(repo).join(target_ref.replace('/', "-"))
    }

    fn configured_base(&self) -> Option<&Path> {
        self.configured_base.as_deref()
    }
}

#[derive(Debug)]
struct OwnedWorktreePath {
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorktreePathReservationStage {
    Parent,
    Destination,
}

#[derive(Debug)]
struct WorktreePathReservationError {
    stage: WorktreePathReservationStage,
    source: io::Error,
}

impl WorktreePathReservationError {
    fn kind(&self) -> io::ErrorKind {
        self.source.kind()
    }

    fn is_destination_collision(&self) -> bool {
        self.stage == WorktreePathReservationStage::Destination
            && self.kind() == io::ErrorKind::AlreadyExists
    }
}

impl OwnedWorktreePath {
    fn reserve(path: PathBuf) -> Result<Self, WorktreePathReservationError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| WorktreePathReservationError {
                stage: WorktreePathReservationStage::Parent,
                source,
            })?;
        }
        fs::create_dir(&path).map_err(|source| WorktreePathReservationError {
            stage: WorktreePathReservationStage::Destination,
            source,
        })?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl GitRepository {
    pub fn with_worktree_settings(
        worktree_settings: Arc<dyn WorktreeBaseDirectoryProvider>,
    ) -> Self {
        Self {
            runner: ProcessRunner,
            worktree_settings,
        }
    }

    async fn worktree_path_policy(
        &self,
        cwd: &Path,
    ) -> Result<WorktreePathPolicy, GitCommandError> {
        let configured_base = self.worktree_settings.worktree_base_directory().await;
        if let Some(path) = configured_base.as_ref() {
            let available = tokio::fs::metadata(path)
                .await
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            if !available {
                return Err(workspace_unavailable_error(cwd, path));
            }
        }
        Ok(WorktreePathPolicy { configured_base })
    }

    async fn execute(
        &self,
        operation: &str,
        cwd: &Path,
        args: &[String],
        allow_non_zero_exit: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.runner
            .run(
                ProcessRequest {
                    operation: operation.to_owned(),
                    command: PathBuf::from("git"),
                    args: args.iter().map(OsString::from).collect(),
                    cwd: cwd.to_path_buf(),
                    env: git_environment(),
                    stdin: None,
                    timeout: DEFAULT_TIMEOUT,
                    max_output_bytes: DEFAULT_OUTPUT_LIMIT,
                    output_policy: OutputPolicy::Truncate,
                    append_truncation_marker: false,
                    allow_non_zero_exit,
                },
                cancellation,
            )
            .await
            .map_err(|error| git_error(operation, cwd, args.len(), error))
    }

    async fn run(
        &self,
        operation: &str,
        cwd: &Path,
        args: &[String],
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, GitCommandError> {
        self.execute(operation, cwd, args, false, cancellation)
            .await
    }

    pub async fn is_repository(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<bool, GitCommandError> {
        let result = self
            .execute(
                "GitVcsDriver.detectRepository",
                cwd,
                &strings(&["rev-parse", "--is-inside-work-tree"]),
                true,
                cancellation,
            )
            .await?;
        Ok(result.exit_code == 0 && result.stdout.trim() == "true")
    }

    pub async fn repository_root(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let output = self
            .run(
                "GitVcsDriver.repositoryRoot",
                cwd,
                &strings(&["rev-parse", "--show-toplevel"]),
                cancellation,
            )
            .await?;
        Ok(Some(PathBuf::from(output.stdout.trim())))
    }

    pub async fn local_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusLocalResult, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(VcsStatusLocalResult::non_repository());
        }
        let status = self
            .run(
                "GitVcsDriver.statusDetailsLocal.status",
                cwd,
                &strings(&[
                    "-c",
                    "core.quotePath=false",
                    "status",
                    "--porcelain=2",
                    "--branch",
                    "--untracked-files=all",
                ]),
                cancellation,
            )
            .await?;
        let staged_numstat = self
            .run(
                "GitVcsDriver.statusDetailsLocal.stagedNumstat",
                cwd,
                &strings(&[
                    "-c",
                    "core.quotePath=false",
                    "diff",
                    "--cached",
                    "--numstat",
                ]),
                cancellation,
            )
            .await?;
        let unstaged_numstat = self
            .run(
                "GitVcsDriver.statusDetailsLocal.unstagedNumstat",
                cwd,
                &strings(&["-c", "core.quotePath=false", "diff", "--numstat"]),
                cancellation,
            )
            .await?;
        let remotes = self
            .execute(
                "GitVcsDriver.statusDetailsLocal.remotes",
                cwd,
                &strings(&["remote"]),
                true,
                cancellation,
            )
            .await?;
        let remote_names: Vec<&str> = remotes.stdout.lines().map(str::trim).collect();
        let has_primary_remote = remote_names.contains(&"origin");
        let (ref_name, upstream_ref, ahead_count, behind_count) =
            parse_branch_headers(&status.stdout);
        let default_ref_name = self
            .default_ref(cwd, ref_name.as_deref(), cancellation)
            .await?;
        let source_control_provider = if has_primary_remote {
            self.remote_provider(cwd, cancellation).await?
        } else {
            None
        };
        let staged_stats = parse_numstat(&staged_numstat.stdout);
        let unstaged_stats = parse_numstat(&unstaged_numstat.stdout);
        let mut files = Vec::new();
        for line in status.stdout.lines() {
            let Some(record) = parse_porcelain_v2_line(line) else {
                continue;
            };
            if record.untracked {
                let insertions = untracked_line_count(&cwd.join(&record.path)).await;
                files.push(VcsWorkingTreeFile {
                    path: record.path,
                    insertions,
                    deletions: 0,
                    status: Some(VcsWorkingTreeFileStatus::Untracked),
                    area: Some(VcsStagingArea::Untracked),
                });
                continue;
            }
            if record.index_changed {
                let (insertions, deletions) =
                    staged_stats.get(&record.path).copied().unwrap_or((0, 0));
                files.push(VcsWorkingTreeFile {
                    path: record.path.clone(),
                    insertions,
                    deletions,
                    status: Some(record.index_status),
                    area: Some(VcsStagingArea::Staged),
                });
            }
            if record.worktree_changed {
                let (insertions, deletions) =
                    unstaged_stats.get(&record.path).copied().unwrap_or((0, 0));
                files.push(VcsWorkingTreeFile {
                    path: record.path,
                    insertions,
                    deletions,
                    status: Some(record.worktree_status),
                    area: Some(VcsStagingArea::Unstaged),
                });
            }
        }
        files.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(area_order(left.area).cmp(&area_order(right.area)))
        });
        let insertions = files.iter().map(|file| file.insertions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();
        let working_tree = VcsWorkingTree {
            files,
            insertions,
            deletions,
        };
        let _ = (upstream_ref, ahead_count, behind_count);
        Ok(VcsStatusLocalResult {
            is_repo: true,
            source_control_provider,
            has_primary_remote,
            is_default_ref: ref_name.is_some() && ref_name == default_ref_name,
            ref_name,
            default_ref_name,
            has_working_tree_changes: !working_tree.files.is_empty(),
            working_tree,
        })
    }

    pub async fn remote_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<VcsStatusRemoteResult>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let status = self
            .run(
                "GitVcsDriver.statusDetailsRemote.status",
                cwd,
                &strings(&[
                    "status",
                    "--porcelain=2",
                    "--branch",
                    "--untracked-files=no",
                ]),
                cancellation,
            )
            .await?;
        let (branch, upstream, ahead_count, behind_count) = parse_branch_headers(&status.stdout);
        let default_ref = self
            .default_ref(cwd, branch.as_deref(), cancellation)
            .await?;
        let ahead_of_default_count = match (branch.as_deref(), default_ref.as_deref()) {
            (Some(current), Some(default)) if current == default => Some(0),
            (Some(_), Some(default)) => {
                let range = format!("{default}..HEAD");
                let count = self
                    .execute(
                        "GitVcsDriver.statusDetailsRemote.defaultDelta",
                        cwd,
                        &["rev-list".into(), "--count".into(), range],
                        true,
                        cancellation,
                    )
                    .await?;
                (count.exit_code == 0).then(|| count.stdout.trim().parse::<u64>().unwrap_or(0))
            }
            _ => Some(ahead_count),
        };
        Ok(Some(VcsStatusRemoteResult {
            has_upstream: upstream.is_some(),
            ahead_count,
            behind_count,
            ahead_of_default_count,
            pr: None::<ChangeRequest>,
        }))
    }

    pub async fn refresh_remote_status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<VcsStatusRemoteResult>, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(None);
        }
        let upstream = self
            .execute(
                "GitVcsDriver.refreshRemoteStatus.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        if upstream.exit_code == 0 {
            let upstream = upstream.stdout.trim();
            let remotes = self
                .run(
                    "GitVcsDriver.refreshRemoteStatus.remotes",
                    cwd,
                    &strings(&["remote"]),
                    cancellation,
                )
                .await?;
            let mut remote_names: Vec<&str> = remotes
                .stdout
                .lines()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .collect();
            remote_names.sort_by_key(|name| std::cmp::Reverse(name.len()));
            if let Some(remote) = remote_names
                .into_iter()
                .find(|remote| upstream.starts_with(&format!("{remote}/")))
            {
                self.run(
                    "GitVcsDriver.refreshRemoteStatus.fetch",
                    cwd,
                    &["fetch".into(), "--quiet".into(), remote.into()],
                    cancellation,
                )
                .await?;
            }
        }
        self.remote_status(cwd, cancellation).await
    }

    pub async fn status(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsStatusResult, GitCommandError> {
        let local = self.local_status(cwd, cancellation).await?;
        let remote =
            self.remote_status(cwd, cancellation)
                .await?
                .unwrap_or(VcsStatusRemoteResult {
                    has_upstream: false,
                    ahead_count: 0,
                    behind_count: 0,
                    ahead_of_default_count: Some(0),
                    pr: None,
                });
        Ok(VcsStatusResult { local, remote })
    }

    pub async fn stage_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.stageFiles", cwd, paths)?;
        let mut args = strings(&["add", "--"]);
        args.extend(paths.iter().cloned());
        self.run("GitVcsDriver.stageFiles", cwd, &args, cancellation)
            .await?;
        Ok(())
    }

    pub async fn unstage_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.unstageFiles", cwd, paths)?;
        let head = self
            .execute(
                "GitVcsDriver.unstageFiles.verifyHead",
                cwd,
                &strings(&["rev-parse", "--verify", "--quiet", "HEAD"]),
                true,
                cancellation,
            )
            .await?;
        let mut args = if head.exit_code == 0 {
            strings(&["restore", "--staged", "--"])
        } else {
            strings(&["rm", "--cached", "-r", "--ignore-unmatch", "--"])
        };
        args.extend(paths.iter().cloned());
        self.run("GitVcsDriver.unstageFiles", cwd, &args, cancellation)
            .await?;
        Ok(())
    }

    pub async fn discard_files(
        &self,
        cwd: &Path,
        paths: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if paths.is_empty() {
            return Ok(());
        }
        validate_pathspecs("GitVcsDriver.discardFiles", cwd, paths)?;
        let mut list_args = strings(&["-c", "core.quotePath=false", "ls-files", "-z", "--"]);
        list_args.extend(paths.iter().cloned());
        let tracked = self
            .run(
                "GitVcsDriver.discardFiles.listTracked",
                cwd,
                &list_args,
                cancellation,
            )
            .await?;
        let tracked_paths: Vec<String> = tracked
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        if !tracked_paths.is_empty() {
            let mut restore_args = strings(&["restore", "--worktree", "--"]);
            restore_args.extend(tracked_paths);
            self.run(
                "GitVcsDriver.discardFiles.restore",
                cwd,
                &restore_args,
                cancellation,
            )
            .await?;
        }
        let status = self.local_status(cwd, cancellation).await?;
        let untracked: HashSet<&str> = status
            .working_tree
            .files
            .iter()
            .filter(|file| file.area == Some(VcsStagingArea::Untracked))
            .map(|file| file.path.as_str())
            .collect();
        let requested_untracked: Vec<String> = paths
            .iter()
            .filter(|path| {
                untracked.contains(path.as_str())
                    || untracked
                        .iter()
                        .any(|candidate| candidate.starts_with(&format!("{path}/")))
            })
            .cloned()
            .collect();
        if !requested_untracked.is_empty() {
            let mut clean_args = strings(&["clean", "-fd", "--"]);
            clean_args.extend(requested_untracked);
            self.run(
                "GitVcsDriver.discardFiles.clean",
                cwd,
                &clean_args,
                cancellation,
            )
            .await?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn list_refs(
        &self,
        cwd: &Path,
        query: Option<&str>,
        cursor: usize,
        limit: usize,
        include_matching_remote_refs: bool,
        ref_kind: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<VcsListRefsResult, GitCommandError> {
        if !self.is_repository(cwd, cancellation).await? {
            return Ok(VcsListRefsResult {
                refs: vec![],
                is_repo: false,
                has_primary_remote: false,
                next_cursor: None,
                total_count: 0,
            });
        }
        let branches = self
            .run(
                "GitVcsDriver.listRefs",
                cwd,
                &strings(&[
                    "for-each-ref",
                    "--format=%(refname:short)%09%(HEAD)%09%(committerdate:unix)",
                    "refs/heads",
                    "refs/remotes",
                ]),
                cancellation,
            )
            .await?;
        let remotes = self
            .run(
                "GitVcsDriver.listRefs.remoteNames",
                cwd,
                &strings(&["remote"]),
                cancellation,
            )
            .await?;
        let remote_names: Vec<String> = remotes
            .stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        let default_ref = self.default_ref(cwd, None, cancellation).await?;
        let worktrees = self.worktree_map(cwd, cancellation).await?;
        let mut refs_with_time = Vec::new();
        for line in branches.stdout.lines() {
            let mut fields = line.split('\t');
            let Some(name) = fields.next().map(str::trim).filter(|name| !name.is_empty()) else {
                continue;
            };
            if name.contains("HEAD ->") || name.ends_with("/HEAD") {
                continue;
            }
            let current = fields.next().is_some_and(|head| head.trim() == "*");
            let timestamp = fields
                .next()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(0);
            let remote_name = remote_names
                .iter()
                .find(|remote| name.starts_with(&format!("{remote}/")))
                .cloned();
            let is_remote = remote_name.is_some();
            refs_with_time.push((
                VcsRef {
                    name: name.to_owned(),
                    is_remote: Some(is_remote),
                    remote_name,
                    current,
                    is_default: !is_remote && default_ref.as_deref() == Some(name),
                    worktree_path: (!is_remote).then(|| worktrees.get(name).cloned()).flatten(),
                },
                timestamp,
            ));
        }
        if !include_matching_remote_refs {
            let locals: HashSet<String> = refs_with_time
                .iter()
                .filter(|(reference, _)| reference.is_remote != Some(true))
                .map(|(reference, _)| reference.name.clone())
                .collect();
            refs_with_time.retain(|(reference, _)| {
                reference.is_remote != Some(true)
                    || reference
                        .remote_name
                        .as_ref()
                        .and_then(|remote| reference.name.strip_prefix(&format!("{remote}/")))
                        .is_none_or(|branch| !locals.contains(branch))
            });
        }
        refs_with_time.retain(|(reference, _)| match ref_kind {
            Some("local") => reference.is_remote != Some(true),
            Some("remote") => reference.is_remote == Some(true),
            _ => true,
        });
        if let Some(query) = query {
            let query = query.to_lowercase();
            refs_with_time.retain(|(reference, _)| reference.name.to_lowercase().contains(&query));
        }
        refs_with_time.sort_by(|(left, left_time), (right, right_time)| {
            ref_priority(left)
                .cmp(&ref_priority(right))
                .then(right_time.cmp(left_time))
                .then(left.name.cmp(&right.name))
        });
        let total_count = refs_with_time.len();
        let refs: Vec<VcsRef> = refs_with_time
            .into_iter()
            .skip(cursor)
            .take(limit.min(200))
            .map(|(reference, _)| reference)
            .collect();
        let next_cursor = (cursor + refs.len() < total_count).then_some(cursor + refs.len());
        Ok(VcsListRefsResult {
            refs,
            is_repo: true,
            has_primary_remote: remote_names.iter().any(|remote| remote == "origin"),
            next_cursor,
            total_count,
        })
    }

    pub async fn list_commits(
        &self,
        cwd: &Path,
        limit: usize,
        cursor: usize,
        cancellation: &CancellationToken,
    ) -> Result<VcsListCommitsResult, GitCommandError> {
        let format = format!(
            "--pretty=format:%H{COMMIT_FIELD_SEPARATOR}%h{COMMIT_FIELD_SEPARATOR}%s{COMMIT_FIELD_SEPARATOR}%an{COMMIT_FIELD_SEPARATOR}%at"
        );
        let args = vec![
            "log".into(),
            format!("--max-count={}", limit.min(200) + 1),
            format!("--skip={cursor}"),
            format,
        ];
        let result = self
            .execute("GitVcsDriver.listCommits", cwd, &args, true, cancellation)
            .await?;
        if result.exit_code != 0 {
            let stderr = result.stderr.to_lowercase();
            if stderr.contains("not a git repository")
                || stderr.contains("does not have any commits yet")
                || stderr.contains("bad default revision")
            {
                return Ok(VcsListCommitsResult {
                    commits: vec![],
                    next_cursor: None,
                });
            }
            return Err(command_output_error(
                "GitVcsDriver.listCommits",
                cwd,
                args.len(),
                &result,
                "Git log failed.",
            ));
        }
        let mut commits: Vec<VcsCommit> = result.stdout.lines().filter_map(parse_commit).collect();
        let has_more = commits.len() > limit;
        commits.truncate(limit);
        Ok(VcsListCommitsResult {
            commits,
            next_cursor: has_more.then_some(cursor + limit),
        })
    }

    pub async fn create_worktree(
        &self,
        input: CreateWorktreeInput,
        cancellation: &CancellationToken,
    ) -> Result<VcsCreateWorktreeResult, GitCommandError> {
        let target_ref = input
            .new_ref_name
            .as_deref()
            .unwrap_or(input.ref_name.as_str());
        let requested_path = match input.path.as_deref() {
            Some(path) => Some(resolve_explicit_worktree_path(&input.cwd, path).await),
            None => None,
        };
        let path_policy = if requested_path.is_none() {
            Some(self.worktree_path_policy(&input.cwd).await?)
        } else {
            None
        };
        let existing_ref_is_local = input.new_ref_name.is_none()
            && self
                .local_branch_exists(&input.cwd, &input.ref_name, cancellation)
                .await?;
        if existing_ref_is_local {
            let worktrees = self.worktree_map(&input.cwd, cancellation).await?;
            if worktrees.contains_key(&input.ref_name) {
                return self
                    .create_suffixed_worktree_from_occupied_branch(
                        &input.cwd,
                        &input.ref_name,
                        requested_path.as_ref(),
                        path_policy.as_ref(),
                        cancellation,
                    )
                    .await;
            }
        }

        let path = requested_path.clone().unwrap_or_else(|| {
            path_policy
                .as_ref()
                .expect("implicit worktree path has a policy")
                .path_for(&input.cwd, target_ref)
        });
        let path_string = display_path(&path);
        let new_ref_existed = if let Some(new_ref) = input.new_ref_name.as_deref() {
            self.local_branch_exists(&input.cwd, new_ref, cancellation)
                .await?
        } else {
            false
        };
        let owned_path = if requested_path.is_none()
            && path_policy
                .as_ref()
                .and_then(WorktreePathPolicy::configured_base)
                .is_some()
        {
            Some(reserve_implicit_worktree_path(
                &input.cwd,
                &path,
                path_policy.as_ref().expect("implicit path has a policy"),
            )?)
        } else {
            None
        };
        let mut args = strings(&["worktree", "add"]);
        if let Some(new_ref) = input.new_ref_name.as_deref() {
            args.extend(["-b".into(), new_ref.into()]);
        }
        args.extend([path_string, input.ref_name.clone()]);
        if let Err(mut error) = self
            .run(
                "GitVcsDriver.createWorktree",
                &input.cwd,
                &args,
                cancellation,
            )
            .await
        {
            if let Some(owned_path) = owned_path.as_ref()
                && let Err(cleanup_error) =
                    self.cleanup_owned_worktree(&input.cwd, owned_path).await
            {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            if let Some(new_ref) = input.new_ref_name.as_deref()
                && !new_ref_existed
                && let Err(rollback_error) = self.rollback_created_branch(&input.cwd, new_ref).await
            {
                error.detail = format!(
                    "{}\nWorktree branch rollback also failed: {}",
                    error.detail, rollback_error.detail
                )
                .into();
            }
            if input.new_ref_name.is_none()
                && existing_ref_is_local
                && self
                    .worktree_map(&input.cwd, cancellation)
                    .await?
                    .contains_key(&input.ref_name)
            {
                return self
                    .create_suffixed_worktree_from_occupied_branch(
                        &input.cwd,
                        &input.ref_name,
                        requested_path.as_ref(),
                        path_policy.as_ref(),
                        cancellation,
                    )
                    .await;
            }
            return Err(error);
        }
        let canonical_path = tokio::fs::canonicalize(&path).await.unwrap_or(path);
        let path_string = display_path(&canonical_path);
        if let (Some(new_ref), Some(base_ref)) = (
            input.new_ref_name.as_deref(),
            input.base_ref_name.as_deref(),
        ) {
            self.run(
                "GitVcsDriver.createWorktree.configureBaseRef",
                &input.cwd,
                &[
                    "config".into(),
                    format!("branch.{new_ref}.t4code-base-ref"),
                    base_ref.into(),
                ],
                cancellation,
            )
            .await?;
        }
        Ok(VcsCreateWorktreeResult {
            worktree: VcsWorktree {
                path: path_string,
                ref_name: target_ref.to_owned(),
            },
        })
    }

    async fn create_suffixed_worktree_from_occupied_branch(
        &self,
        cwd: &Path,
        base_ref: &str,
        requested_path: Option<&PathBuf>,
        path_policy: Option<&WorktreePathPolicy>,
        cancellation: &CancellationToken,
    ) -> Result<VcsCreateWorktreeResult, GitCommandError> {
        for suffix in 2..(2 + MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS) {
            let candidate = format!("{base_ref}-{suffix}");
            if self
                .local_branch_exists(cwd, &candidate, cancellation)
                .await?
            {
                continue;
            }

            let path = requested_path.cloned().unwrap_or_else(|| {
                path_policy
                    .expect("implicit worktree path has a policy")
                    .path_for(cwd, &candidate)
            });
            let owned_path = match OwnedWorktreePath::reserve(path.clone()) {
                Ok(owned_path) => owned_path,
                Err(error)
                    if requested_path.is_none()
                        && error.kind() == io::ErrorKind::AlreadyExists
                        && (path_policy
                            .and_then(WorktreePathPolicy::configured_base)
                            .is_none()
                            || error.is_destination_collision()) =>
                {
                    continue;
                }
                Err(error) => {
                    return Err(worktree_reservation_error(
                        cwd,
                        &path,
                        error,
                        path_policy.and_then(WorktreePathPolicy::configured_base),
                    ));
                }
            };
            self.prepare_detached_owned_worktree(cwd, base_ref, &owned_path, cancellation)
                .await?;

            match self
                .checkout_owned_suffixed_branch(cwd, &owned_path, &candidate, cancellation)
                .await
            {
                Ok(()) => {
                    let canonical_path = tokio::fs::canonicalize(owned_path.path())
                        .await
                        .unwrap_or(path);
                    return Ok(VcsCreateWorktreeResult {
                        worktree: VcsWorktree {
                            path: display_path(&canonical_path),
                            ref_name: candidate,
                        },
                    });
                }
                Err(error) => {
                    if cancellation.is_cancelled() {
                        return Err(error);
                    }
                    let cleanup_token = CancellationToken::new();
                    let candidate_was_claimed = self
                        .local_branch_exists(cwd, &candidate, &cleanup_token)
                        .await?;
                    if candidate_was_claimed {
                        continue;
                    }
                    return Err(error);
                }
            }
        }

        Err(simple_error(
            "GitVcsDriver.createWorktree",
            cwd,
            &format!(
                "No available worktree branch was found for '{base_ref}' after {MAX_AUTOMATIC_WORKTREE_SUFFIX_ATTEMPTS} attempts. Remove an unused suffixed branch or choose another base."
            ),
        ))
    }

    async fn prepare_detached_owned_worktree(
        &self,
        cwd: &Path,
        base_ref: &str,
        owned_path: &OwnedWorktreePath,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let args = vec![
            "worktree".into(),
            "add".into(),
            "--detach".into(),
            display_path(owned_path.path()),
            base_ref.into(),
        ];
        if let Err(mut error) = self
            .run("GitVcsDriver.createWorktree", cwd, &args, cancellation)
            .await
        {
            if let Err(cleanup_error) = self.cleanup_owned_worktree(cwd, owned_path).await {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            return Err(error);
        }
        Ok(())
    }

    async fn checkout_owned_suffixed_branch(
        &self,
        cwd: &Path,
        owned_path: &OwnedWorktreePath,
        candidate: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        if let Err(mut error) = self
            .run(
                "GitVcsDriver.createWorktree.createBranch",
                owned_path.path(),
                &["checkout".into(), "-b".into(), candidate.into()],
                cancellation,
            )
            .await
        {
            if let Err(cleanup_error) = self.cleanup_owned_worktree(cwd, owned_path).await {
                error.detail = format!(
                    "{}\nOwned worktree cleanup also failed: {}",
                    error.detail, cleanup_error.detail
                )
                .into();
            }
            return Err(error);
        }
        Ok(())
    }

    async fn cleanup_owned_worktree(
        &self,
        cwd: &Path,
        owned_path: &OwnedWorktreePath,
    ) -> Result<(), GitCommandError> {
        let cleanup_token = CancellationToken::new();
        let removal_error = self
            .remove_worktree(cwd, owned_path.path(), true, &cleanup_token)
            .await
            .err();
        let filesystem_error = match tokio::fs::remove_dir_all(owned_path.path()).await {
            Ok(()) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => Some(error),
        };
        let still_registered = self
            .worktree_paths(cwd, &cleanup_token)
            .await?
            .iter()
            .any(|registered| same_worktree_path(registered, owned_path.path()));
        if still_registered {
            return Err(removal_error.unwrap_or_else(|| {
                simple_error(
                    "GitVcsDriver.createWorktree.cleanup",
                    cwd,
                    &format!(
                        "The owned worktree '{}' is still registered after cleanup.",
                        display_path(owned_path.path())
                    ),
                )
            }));
        }
        if let Some(error) = filesystem_error {
            return Err(simple_error(
                "GitVcsDriver.createWorktree.cleanup",
                cwd,
                &format!(
                    "The owned worktree path '{}' could not be removed: {error}",
                    display_path(owned_path.path())
                ),
            ));
        }
        Ok(())
    }

    async fn local_branch_exists(
        &self,
        cwd: &Path,
        branch: &str,
        cancellation: &CancellationToken,
    ) -> Result<bool, GitCommandError> {
        let output = self
            .execute(
                "GitVcsDriver.createWorktree.branchExists",
                cwd,
                &[
                    "show-ref".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    format!("refs/heads/{branch}"),
                ],
                true,
                cancellation,
            )
            .await?;
        match output.exit_code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(command_output_error(
                "GitVcsDriver.createWorktree.branchExists",
                cwd,
                4,
                &output,
                &actionable_git_failure(&output.stderr, &output.stdout),
            )),
        }
    }

    async fn rollback_created_branch(
        &self,
        cwd: &Path,
        branch: &str,
    ) -> Result<(), GitCommandError> {
        let cancellation = CancellationToken::new();
        if !self.local_branch_exists(cwd, branch, &cancellation).await? {
            return Ok(());
        }
        self.run(
            "GitVcsDriver.createWorktree.rollbackBranch",
            cwd,
            &["branch".into(), "-D".into(), "--".into(), branch.into()],
            &cancellation,
        )
        .await?;
        Ok(())
    }

    pub async fn remove_worktree(
        &self,
        cwd: &Path,
        path: &Path,
        force: bool,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        let mut args = strings(&["worktree", "remove"]);
        if force {
            args.push("--force".into());
        }
        args.push(display_path(path));
        self.run("GitVcsDriver.removeWorktree", cwd, &args, cancellation)
            .await?;
        Ok(())
    }

    pub async fn create_ref(
        &self,
        cwd: &Path,
        ref_name: &str,
        switch_ref: bool,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let args = if switch_ref {
            vec!["switch".into(), "-c".into(), ref_name.into()]
        } else {
            vec!["branch".into(), ref_name.into()]
        };
        self.run("GitVcsDriver.createRef", cwd, &args, cancellation)
            .await?;
        Ok(ref_name.to_owned())
    }

    pub async fn switch_ref(
        &self,
        cwd: &Path,
        ref_name: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        self.run(
            "GitVcsDriver.switchRef",
            cwd,
            &["switch".into(), ref_name.into()],
            cancellation,
        )
        .await?;
        self.current_ref(cwd, cancellation).await
    }

    pub async fn rename_ref(
        &self,
        cwd: &Path,
        old_ref: &str,
        new_ref: &str,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        if old_ref == new_ref {
            return Ok(new_ref.to_owned());
        }
        self.run(
            "GitVcsDriver.renameBranch",
            cwd,
            &["branch".into(), "-m".into(), old_ref.into(), new_ref.into()],
            cancellation,
        )
        .await?;
        Ok(new_ref.to_owned())
    }

    pub async fn init(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), GitCommandError> {
        self.run(
            "GitVcsDriver.initRepo",
            cwd,
            &strings(&["init"]),
            cancellation,
        )
        .await?;
        Ok(())
    }

    pub async fn clone_repository(
        &self,
        url: &str,
        parent_dir: &Path,
        directory_name: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let derived = directory_name.map_or_else(
            || {
                url.trim_end_matches(['/', '\\'])
                    .rsplit(['/', '\\', ':'])
                    .next()
                    .unwrap_or("repository")
                    .trim_end_matches(".git")
                    .to_owned()
            },
            str::to_owned,
        );
        let destination = parent_dir.join(&derived);
        match tokio::fs::symlink_metadata(&destination).await {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(simple_error(
                        CLONE_OPERATION,
                        parent_dir,
                        "Existing clone destination is not a Git repository.",
                    ));
                }
                return self
                    .reuse_existing_clone(url, &destination, cancellation)
                    .await;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(simple_error(
                    CLONE_OPERATION,
                    parent_dir,
                    &format!("Failed to inspect the existing clone destination: {error}"),
                ));
            }
        }
        self.run(
            CLONE_OPERATION,
            parent_dir,
            &["clone".into(), "--".into(), url.into(), derived.clone()],
            cancellation,
        )
        .await?;
        Ok(destination)
    }

    async fn reuse_existing_clone(
        &self,
        url: &str,
        destination: &Path,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let Some(repository_root) = self.repository_root(destination, cancellation).await? else {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing clone destination is not a Git repository.",
            ));
        };
        let canonical_destination =
            tokio::fs::canonicalize(destination)
                .await
                .map_err(|error| {
                    simple_error(
                        CLONE_OPERATION,
                        destination,
                        &format!("Failed to inspect the existing clone destination: {error}"),
                    )
                })?;
        let canonical_repository_root =
            tokio::fs::canonicalize(&repository_root)
                .await
                .map_err(|error| {
                    simple_error(
                        CLONE_OPERATION,
                        destination,
                        &format!("Failed to inspect the existing Git repository root: {error}"),
                    )
                })?;
        if canonical_destination != canonical_repository_root {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing clone destination is not a Git repository root.",
            ));
        }
        let origin = self
            .execute(
                "GitVcsDriver.clone.inspectOrigin",
                destination,
                &strings(&["config", "--get", "remote.origin.url"]),
                true,
                cancellation,
            )
            .await?;
        if origin.exit_code != 0 {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing Git repository does not have an origin remote.",
            ));
        }
        if origin.stdout.trim() != url {
            return Err(simple_error(
                CLONE_OPERATION,
                destination,
                "Existing Git repository has a different origin.",
            ));
        }
        Ok(destination.to_path_buf())
    }

    pub async fn pull_current_branch(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<VcsPullResult, GitCommandError> {
        let ref_name = self.current_ref(cwd, cancellation).await?.ok_or_else(|| {
            simple_error(
                "GitVcsDriver.pullCurrentBranch",
                cwd,
                "Cannot pull from detached HEAD.",
            )
        })?;
        let upstream = self
            .execute(
                "GitVcsDriver.pullCurrentBranch.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        let upstream_ref = (upstream.exit_code == 0)
            .then(|| upstream.stdout.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                simple_error(
                    "GitVcsDriver.pullCurrentBranch",
                    cwd,
                    "Current branch has no upstream.",
                )
            })?;
        let before = self
            .run(
                "GitVcsDriver.pullCurrentBranch.before",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        self.run(
            "GitVcsDriver.pullCurrentBranch",
            cwd,
            &strings(&["pull", "--ff-only"]),
            cancellation,
        )
        .await?;
        let after = self
            .run(
                "GitVcsDriver.pullCurrentBranch.after",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        Ok(VcsPullResult {
            status: if before.stdout.trim() == after.stdout.trim() {
                PullStatus::SkippedUpToDate
            } else {
                PullStatus::Pulled
            },
            ref_name,
            upstream_ref: Some(upstream_ref),
        })
    }

    pub async fn commit(
        &self,
        cwd: &Path,
        message: &str,
        file_paths: Option<&[String]>,
        preserve_index: bool,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        if !preserve_index {
            if let Some(paths) = file_paths.filter(|paths| !paths.is_empty()) {
                let _ = self
                    .execute(
                        "GitVcsDriver.prepareCommitContext.reset",
                        cwd,
                        &strings(&["reset"]),
                        true,
                        cancellation,
                    )
                    .await?;
                let mut args = strings(&["add", "-A", "--"]);
                args.extend(paths.iter().cloned());
                self.run(
                    "GitVcsDriver.prepareCommitContext.addSelected",
                    cwd,
                    &args,
                    cancellation,
                )
                .await?;
            } else {
                self.run(
                    "GitVcsDriver.prepareCommitContext.addAll",
                    cwd,
                    &strings(&["add", "-A"]),
                    cancellation,
                )
                .await?;
            }
        }
        let staged = self
            .run(
                "GitVcsDriver.prepareCommitContext.stagedSummary",
                cwd,
                &strings(&["diff", "--cached", "--name-status"]),
                cancellation,
            )
            .await?;
        if staged.stdout.trim().is_empty() {
            return Ok(None);
        }
        self.run(
            "GitVcsDriver.commit",
            cwd,
            &["commit".into(), "-m".into(), message.into()],
            cancellation,
        )
        .await?;
        let sha = self
            .run(
                "GitVcsDriver.commit.sha",
                cwd,
                &strings(&["rev-parse", "HEAD"]),
                cancellation,
            )
            .await?;
        Ok(Some(sha.stdout.trim().to_owned()))
    }

    pub async fn push_current_branch(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let branch = self.current_ref(cwd, cancellation).await?.ok_or_else(|| {
            simple_error(
                "GitVcsDriver.pushCurrentBranch",
                cwd,
                "Cannot push from detached HEAD.",
            )
        })?;
        let upstream = self
            .execute(
                "GitVcsDriver.pushCurrentBranch.upstream",
                cwd,
                &strings(&["rev-parse", "--abbrev-ref", "@{upstream}"]),
                true,
                cancellation,
            )
            .await?;
        let args = if upstream.exit_code == 0 {
            strings(&["push"])
        } else {
            vec![
                "push".into(),
                "--set-upstream".into(),
                "origin".into(),
                branch.clone(),
            ]
        };
        self.run("GitVcsDriver.pushCurrentBranch", cwd, &args, cancellation)
            .await?;
        Ok(branch)
    }

    pub async fn commit_context(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        let staged = self
            .run(
                "GitVcsDriver.commitContext.staged",
                cwd,
                &strings(&["diff", "--cached", "--patch", "--stat"]),
                cancellation,
            )
            .await?;
        if !staged.stdout.trim().is_empty() {
            return Ok(staged.stdout);
        }
        let working = self
            .run(
                "GitVcsDriver.commitContext.working",
                cwd,
                &strings(&["diff", "--patch", "--stat"]),
                cancellation,
            )
            .await?;
        Ok(working.stdout)
    }

    async fn current_ref(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        let result = self
            .execute(
                "GitVcsDriver.currentRef",
                cwd,
                &strings(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                true,
                cancellation,
            )
            .await?;
        Ok((result.exit_code == 0)
            .then(|| result.stdout.trim().to_owned())
            .filter(|value| !value.is_empty()))
    }

    async fn default_ref(
        &self,
        cwd: &Path,
        current: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, GitCommandError> {
        let origin_head = self
            .execute(
                "GitVcsDriver.defaultRef.originHead",
                cwd,
                &strings(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
                true,
                cancellation,
            )
            .await?;
        if origin_head.exit_code == 0 {
            let value = origin_head
                .stdout
                .trim()
                .trim_start_matches("refs/remotes/origin/")
                .to_owned();
            if !value.is_empty() {
                return Ok(Some(value));
            }
        }
        for candidate in ["main", "master"] {
            let result = self
                .execute(
                    "GitVcsDriver.defaultRef.candidate",
                    cwd,
                    &[
                        "show-ref".into(),
                        "--verify".into(),
                        "--quiet".into(),
                        format!("refs/heads/{candidate}"),
                    ],
                    true,
                    cancellation,
                )
                .await?;
            if result.exit_code == 0 || current == Some(candidate) {
                return Ok(Some(candidate.to_owned()));
            }
        }
        Ok(current.map(str::to_owned))
    }

    async fn remote_provider(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Option<SourceControlProviderInfo>, GitCommandError> {
        let remote = self
            .execute(
                "GitVcsDriver.remoteProvider",
                cwd,
                &strings(&["config", "--get", "remote.origin.url"]),
                true,
                cancellation,
            )
            .await?;
        Ok((remote.exit_code == 0)
            .then(|| provider_info(remote.stdout.trim()))
            .flatten())
    }

    async fn worktree_map(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<HashMap<String, String>, GitCommandError> {
        let output = self
            .run(
                "GitVcsDriver.listRefs.worktreeList",
                cwd,
                &strings(&["worktree", "list", "--porcelain"]),
                cancellation,
            )
            .await?;
        let mut map = HashMap::new();
        let mut path: Option<String> = None;
        for line in output.stdout.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(value.to_owned());
            } else if let (Some(branch), Some(path)) =
                (line.strip_prefix("branch refs/heads/"), path.as_ref())
            {
                map.insert(branch.to_owned(), display_path(Path::new(path)));
            } else if line.is_empty() {
                path = None;
            }
        }
        Ok(map)
    }

    async fn worktree_paths(
        &self,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<HashSet<String>, GitCommandError> {
        let output = self
            .run(
                "GitVcsDriver.worktreePaths",
                cwd,
                &strings(&["worktree", "list", "--porcelain"]),
                cancellation,
            )
            .await?;
        Ok(output
            .stdout
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(|path| display_path(Path::new(path)))
            .collect())
    }
}

fn git_environment() -> Vec<(OsString, OsString)> {
    [
        ("GCM_INTERACTIVE", "never"),
        ("GIT_ASKPASS", ""),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("SSH_ASKPASS", ""),
        ("SSH_ASKPASS_REQUIRE", "never"),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

async fn resolve_explicit_worktree_path(cwd: &Path, requested_path: &Path) -> PathBuf {
    let repository_cwd = match tokio::fs::canonicalize(cwd).await {
        Ok(path) => path,
        Err(_) if cwd.is_absolute() => cwd.to_path_buf(),
        Err(_) => std::env::current_dir()
            .map(|current_dir| current_dir.join(cwd))
            .unwrap_or_else(|_| cwd.to_path_buf()),
    };
    let path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        repository_cwd.join(requested_path)
    };
    normalize_path_lexically(&path)
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                );
                if can_pop {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn same_worktree_path(registered: &str, path: &Path) -> bool {
    let candidate = display_path(path);
    if cfg!(windows) {
        registered.eq_ignore_ascii_case(&candidate)
    } else {
        registered == candidate
    }
}

fn parse_branch_headers(stdout: &str) -> (Option<String>, Option<String>, u64, u64) {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                branch = Some(value.to_owned());
            }
        } else if let Some(value) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
        }
    }
    (branch, upstream, ahead, behind)
}

async fn untracked_line_count(path: &Path) -> u64 {
    let Ok(bytes) = tokio::fs::read(path).await else {
        return 0;
    };
    if bytes.is_empty() {
        0
    } else {
        bytes.iter().filter(|byte| **byte == b'\n').count() as u64
            + u64::from(bytes.last() != Some(&b'\n'))
    }
}

fn area_order(area: Option<VcsStagingArea>) -> u8 {
    match area {
        Some(VcsStagingArea::Staged) => 0,
        Some(VcsStagingArea::Unstaged) => 1,
        Some(VcsStagingArea::Untracked) => 2,
        None => 3,
    }
}

fn validate_pathspecs(
    operation: &str,
    cwd: &Path,
    paths: &[String],
) -> Result<(), GitCommandError> {
    for path in paths {
        let parsed = Path::new(path);
        if path.trim().is_empty()
            || parsed.is_absolute()
            || parsed
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(simple_error(
                operation,
                cwd,
                "File pathspec must be a non-empty repository-relative path without traversal.",
            ));
        }
    }
    Ok(())
}

fn parse_commit(line: &str) -> Option<VcsCommit> {
    let mut fields = line.split(COMMIT_FIELD_SEPARATOR);
    let sha = fields.next()?.to_owned();
    let short_sha = fields.next()?.to_owned();
    if sha.is_empty() || short_sha.is_empty() {
        return None;
    }
    Some(VcsCommit {
        sha,
        short_sha,
        subject: fields.next().unwrap_or_default().to_owned(),
        author_name: fields.next().unwrap_or_default().to_owned(),
        authored_at_ms: fields
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_mul(1000),
    })
}

fn ref_priority(reference: &VcsRef) -> u8 {
    if reference.current {
        0
    } else if reference.is_default {
        1
    } else {
        2
    }
}

fn provider_info(remote: &str) -> Option<SourceControlProviderInfo> {
    let normalized = remote.to_lowercase();
    let (kind, name, base_url) = if normalized.contains("github.com") {
        (ProviderKind::Github, "GitHub", "https://github.com")
    } else if normalized.contains("gitlab") {
        (ProviderKind::Gitlab, "GitLab", "https://gitlab.com")
    } else if normalized.contains("dev.azure.com") || normalized.contains("visualstudio.com") {
        (
            ProviderKind::AzureDevops,
            "Azure DevOps",
            "https://dev.azure.com",
        )
    } else if normalized.contains("bitbucket") {
        (
            ProviderKind::Bitbucket,
            "Bitbucket",
            "https://bitbucket.org",
        )
    } else {
        return None;
    };
    Some(SourceControlProviderInfo {
        kind,
        name: name.into(),
        base_url: base_url.into(),
    })
}

fn git_error(
    operation: &str,
    cwd: &Path,
    argument_count: usize,
    error: ProcessError,
) -> GitCommandError {
    let (exit_code, stdout_length, stderr_length, detail) = match error {
        ProcessError::NonZeroExit {
            exit_code,
            stdout_length,
            stderr_length,
            stdout,
            stderr,
            ..
        } => (
            Some(exit_code),
            Some(stdout_length),
            Some(stderr_length),
            actionable_git_failure(&stderr, &stdout),
        ),
        ProcessError::Cancelled { .. } => (None, None, None, "Git command was interrupted.".into()),
        ProcessError::Timeout { .. } => (None, None, None, "Git command timed out.".into()),
        ProcessError::OutputLimit { .. } => (
            None,
            None,
            None,
            "Git command output exceeded its limit.".into(),
        ),
        other => (None, None, None, other.to_string()),
    };
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: Some(Box::new(GitCommandDiagnostics {
            argument_count: Some(argument_count),
            exit_code,
            stdout_length,
            stderr_length,
        })),
        detail: detail.into(),
    }
}

fn actionable_git_failure(stderr: &str, stdout: &str) -> String {
    let output = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    if output.trim().is_empty() {
        return "Git process exited with a non-zero status.".to_owned();
    }
    redact_sensitive_text(output.trim())
}

fn simple_error(operation: &str, cwd: &Path, detail: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: None,
        detail: detail.into(),
    }
}

fn reserve_implicit_worktree_path(
    cwd: &Path,
    path: &Path,
    path_policy: &WorktreePathPolicy,
) -> Result<OwnedWorktreePath, GitCommandError> {
    OwnedWorktreePath::reserve(path.to_path_buf()).map_err(|error| {
        worktree_reservation_error(cwd, path, error, path_policy.configured_base())
    })
}

fn worktree_reservation_error(
    cwd: &Path,
    path: &Path,
    error: WorktreePathReservationError,
    configured_base: Option<&Path>,
) -> GitCommandError {
    if !error.is_destination_collision()
        && let Some(configured_base) = configured_base
    {
        return workspace_unavailable_error(cwd, configured_base);
    }

    let detail = if error.kind() == io::ErrorKind::AlreadyExists {
        format!(
            "The requested worktree path '{}' already exists. Choose an absent path so T4Code can safely own its cleanup.",
            display_path(path)
        )
    } else {
        format!(
            "The worktree path '{}' could not be reserved: {}",
            display_path(path),
            error.source
        )
    };
    simple_error("GitVcsDriver.createWorktree", cwd, &detail)
}

fn workspace_unavailable_error(cwd: &Path, workspace: &Path) -> GitCommandError {
    simple_error(
        "GitVcsDriver.createWorktree",
        cwd,
        &format!(
            "Workspace {} is unavailable. Choose another folder in Settings → General.",
            display_path(workspace)
        ),
    )
}

fn command_output_error(
    operation: &str,
    cwd: &Path,
    argument_count: usize,
    output: &ProcessOutput,
    detail: &str,
) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: operation.into(),
        command: "git".into(),
        cwd: display_path(cwd).into(),
        diagnostics: Some(Box::new(GitCommandDiagnostics {
            argument_count: Some(argument_count),
            exit_code: Some(output.exit_code),
            stdout_length: Some(output.stdout.len()),
            stderr_length: Some(output.stderr.len()),
        })),
        detail: detail.into(),
    }
}

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc_path) = raw.strip_prefix(r"\\?\UNC\") {
        return format!("//{}", unc_path.replace('\\', "/"));
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).replace('\\', "/")
}

#[cfg(test)]
mod worktree_ownership_tests {
    use std::{fs, path::Path, process::Command};

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::{GitRepository, OwnedWorktreePath, display_path};

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "T4Code Test")
            .env("GIT_AUTHOR_EMAIL", "t4code@example.invalid")
            .env("GIT_COMMITTER_NAME", "T4Code Test")
            .env("GIT_COMMITTER_EMAIL", "t4code@example.invalid")
            .output()
            .expect("git starts");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn repository() -> TempDir {
        let repo = tempfile::tempdir().expect("temporary repository");
        git(repo.path(), &["init", "-b", "main"]);
        fs::write(repo.path().join("README.md"), "base\n").expect("write fixture");
        git(repo.path(), &["add", "README.md"]);
        git(repo.path(), &["commit", "-m", "initial"]);
        repo
    }

    #[tokio::test]
    async fn failed_detached_preparation_cleans_its_owned_reserved_path() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");

        GitRepository::default()
            .prepare_detached_owned_worktree(
                repo.path(),
                "missing-ref",
                &owned,
                &CancellationToken::new(),
            )
            .await
            .expect_err("missing base fails detached preparation");

        assert!(!path.exists());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn cancelled_detached_preparation_cleans_its_owned_reserved_path() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        GitRepository::default()
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &cancelled)
            .await
            .expect_err("cancelled detached preparation fails");

        assert!(!path.exists());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn cancelled_branch_checkout_cleans_the_prepared_detached_worktree() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let repository = GitRepository::default();
        repository
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &CancellationToken::new())
            .await
            .expect("Git accepts an atomically reserved empty directory");
        let cancelled = CancellationToken::new();
        cancelled.cancel();

        repository
            .checkout_owned_suffixed_branch(repo.path(), &owned, "main-2", &cancelled)
            .await
            .expect_err("cancelled checkout fails");

        assert!(!path.exists());
        assert!(git(repo.path(), &["branch", "--list", "main-2"]).is_empty());
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }

    #[tokio::test]
    async fn competing_branch_checkout_failure_cleans_only_the_owned_worktree() {
        let repo = repository();
        let parent = tempfile::tempdir().expect("worktree parent");
        let path = parent.path().join("reserved");
        let owned = OwnedWorktreePath::reserve(path.clone()).expect("reserve absent path");
        let repository = GitRepository::default();
        repository
            .prepare_detached_owned_worktree(repo.path(), "main", &owned, &CancellationToken::new())
            .await
            .expect("prepare detached worktree");
        git(repo.path(), &["branch", "main-2"]);

        repository
            .checkout_owned_suffixed_branch(
                repo.path(),
                &owned,
                "main-2",
                &CancellationToken::new(),
            )
            .await
            .expect_err("competing branch makes checkout fail");

        assert!(!path.exists());
        assert_eq!(git(repo.path(), &["branch", "--list", "main-2"]), "main-2");
        assert!(
            !git(repo.path(), &["worktree", "list", "--porcelain"])
                .replace('\\', "/")
                .contains(&display_path(&path))
        );
    }
}
