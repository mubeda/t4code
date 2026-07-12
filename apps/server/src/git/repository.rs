use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Component, Path, PathBuf},
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

#[derive(Clone, Copy, Debug, Default)]
pub struct GitRepository {
    runner: ProcessRunner,
}

impl GitRepository {
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
            "--pretty=format:%H{0}%h{0}%s{0}%an{0}%at",
            COMMIT_FIELD_SEPARATOR
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
            .unwrap_or(input.ref_name.as_str())
            .to_owned();
        let path = input.path.unwrap_or_else(|| {
            let repo = input
                .cwd
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository");
            input
                .cwd
                .parent()
                .unwrap_or(&input.cwd)
                .join(".t4code-worktrees")
                .join(repo)
                .join(target_ref.replace('/', "-"))
        });
        let path_string = display_path(&path);
        let new_ref_existed = match input.new_ref_name.as_deref() {
            Some(new_ref) => {
                self.local_branch_exists(&input.cwd, new_ref, cancellation)
                    .await?
            }
            None => false,
        };
        let mut args = strings(&["worktree", "add"]);
        if let Some(new_ref) = input.new_ref_name.as_deref() {
            args.extend(["-b".into(), new_ref.into()]);
        }
        args.extend([path_string.clone(), input.ref_name]);
        if let Err(mut error) = self
            .run(
                "GitVcsDriver.createWorktree",
                &input.cwd,
                &args,
                cancellation,
            )
            .await
        {
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
                ref_name: target_ref,
            },
        })
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
        self.run(
            "GitVcsDriver.clone",
            parent_dir,
            &["clone".into(), "--".into(), url.into(), derived.clone()],
            cancellation,
        )
        .await?;
        Ok(parent_dir.join(derived))
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
        cancellation: &CancellationToken,
    ) -> Result<String, GitCommandError> {
        if let Some(paths) = file_paths {
            self.stage_files(cwd, paths, cancellation).await?;
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
        Ok(sha.stdout.trim().to_owned())
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
                if Path::new(path).exists() {
                    map.insert(branch.to_owned(), display_path(Path::new(path)));
                }
            } else if line.is_empty() {
                path = None;
            }
        }
        Ok(map)
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
