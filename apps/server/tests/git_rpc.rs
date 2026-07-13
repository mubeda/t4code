#![allow(dead_code)]

use t4code_server::{git, source_control, vcs};

use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};

use git::{
    CreateWorktreeInput, GitRepository, OutputPolicy, ProcessError, ProcessRequest, ProcessRunner,
    StatusBroadcaster, VcsStagingArea, VcsStatusStreamEvent, VcsWorkingTreeFileStatus,
    parse_porcelain_v2_line,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

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
        .expect("git must be installed for real-repository tests");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn init_repo() -> TempDir {
    let temp = tempfile::tempdir().expect("temporary repository");
    git(temp.path(), &["init", "-b", "main"]);
    git(temp.path(), &["config", "user.name", "T4Code Test"]);
    git(
        temp.path(),
        &["config", "user.email", "t4code@example.invalid"],
    );
    temp
}

fn commit_file(repo: &Path, path: &str, contents: &str, message: &str) {
    let absolute = repo.join(path);
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).expect("parent directory");
    }
    fs::write(absolute, contents).expect("fixture file");
    git(repo, &["add", "--", path]);
    git(repo, &["commit", "-m", message]);
}

fn cancellation() -> CancellationToken {
    CancellationToken::new()
}

async fn observe_initial_remote(
    snapshot: Option<VcsStatusStreamEvent>,
    subscription: &mut git::StatusSubscription,
) {
    match snapshot {
        Some(VcsStatusStreamEvent::Snapshot {
            remote: Some(_), ..
        }) => {}
        Some(VcsStatusStreamEvent::Snapshot { remote: None, .. }) => {
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(5), subscription.recv()).await,
                Ok(Some(VcsStatusStreamEvent::RemoteUpdated { .. }))
            ));
        }
        event => panic!("expected initial VCS snapshot, got {event:?}"),
    }
}

#[tokio::test]
async fn unborn_head_can_be_unstaged_and_has_empty_history() {
    let repo = init_repo();
    fs::write(repo.path().join("new.txt"), "new\n").expect("new file");
    let repository = GitRepository::default();

    repository
        .stage_files(repo.path(), &["new.txt".into()], &cancellation())
        .await
        .expect("stage on unborn branch");
    let staged = repository
        .local_status(repo.path(), &cancellation())
        .await
        .expect("status");
    assert!(staged.working_tree.files.iter().any(|file| {
        file.path == "new.txt"
            && file.area == Some(VcsStagingArea::Staged)
            && file.status == Some(VcsWorkingTreeFileStatus::Added)
    }));

    repository
        .unstage_files(repo.path(), &["new.txt".into()], &cancellation())
        .await
        .expect("unborn unstage");
    let unstaged = repository
        .local_status(repo.path(), &cancellation())
        .await
        .expect("status after unstage");
    assert!(
        unstaged
            .working_tree
            .files
            .iter()
            .any(|file| { file.path == "new.txt" && file.area == Some(VcsStagingArea::Untracked) })
    );
    assert!(
        repository
            .list_commits(repo.path(), 30, 0, &cancellation())
            .await
            .expect("unborn history")
            .commits
            .is_empty()
    );
}

#[tokio::test]
async fn corrupt_history_is_reported_instead_of_rendered_as_empty() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let sha = git(repo.path(), &["rev-parse", "HEAD"]);
    fs::remove_file(
        repo.path()
            .join(".git/objects")
            .join(&sha[..2])
            .join(&sha[2..]),
    )
    .expect("remove loose commit object");

    let error = GitRepository::default()
        .list_commits(repo.path(), 30, 0, &cancellation())
        .await
        .expect_err("corrupt history must be visible");
    assert_eq!(error.tag, "GitCommandError");
    assert_eq!(error.operation.as_ref(), "GitVcsDriver.listCommits");
    assert_ne!(
        error.detail.as_ref(),
        "Git process exited with a non-zero status."
    );
}

#[test]
fn porcelain_v2_preserves_current_rename_and_copy_paths() {
    let renamed = parse_porcelain_v2_line(
        "2 R. N... 100644 100644 100644 abcdef0 abcdef1 R100 src/new name.rs\tsrc/old name.rs",
    )
    .expect("rename record");
    assert_eq!(renamed.path, "src/new name.rs");
    assert_eq!(renamed.index_status, VcsWorkingTreeFileStatus::Renamed);

    let copied = parse_porcelain_v2_line(
        "2 C. N... 100644 100644 100644 abcdef0 abcdef1 C075 copied file.txt\toriginal file.txt",
    )
    .expect("copy record");
    assert_eq!(copied.path, "copied file.txt");
    assert_eq!(copied.index_status, VcsWorkingTreeFileStatus::Copied);
}

#[tokio::test]
async fn real_rename_status_uses_the_new_path() {
    let repo = init_repo();
    commit_file(repo.path(), "old name.txt", "old\n", "initial");
    git(repo.path(), &["mv", "old name.txt", "new name.txt"]);

    let status = GitRepository::default()
        .local_status(repo.path(), &cancellation())
        .await
        .expect("rename status");
    assert!(status.working_tree.files.iter().any(|file| {
        file.path == "new name.txt"
            && file.area == Some(VcsStagingArea::Staged)
            && file.status == Some(VcsWorkingTreeFileStatus::Renamed)
    }));
}

#[tokio::test]
async fn discard_preserves_staged_snapshot_and_removes_only_selected_untracked_paths() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    fs::write(repo.path().join("tracked.txt"), "staged\n").expect("staged edit");
    git(repo.path(), &["add", "tracked.txt"]);
    fs::write(repo.path().join("tracked.txt"), "unstaged\n").expect("unstaged edit");
    fs::create_dir_all(repo.path().join("selected/nested")).expect("selected directory");
    fs::write(repo.path().join("selected/nested/file.txt"), "remove\n").expect("selected file");
    fs::write(repo.path().join("keep.txt"), "keep\n").expect("unrelated file");

    let repository = GitRepository::default();
    repository
        .discard_files(
            repo.path(),
            &["tracked.txt".into(), "selected/nested/file.txt".into()],
            &cancellation(),
        )
        .await
        .expect("safe discard");

    assert_eq!(
        fs::read_to_string(repo.path().join("tracked.txt"))
            .expect("tracked contents")
            .replace("\r\n", "\n"),
        "staged\n"
    );
    assert!(!repo.path().join("selected/nested/file.txt").exists());
    assert!(repo.path().join("keep.txt").exists());
    assert!(git(repo.path(), &["diff", "--cached", "--", "tracked.txt"]).contains("+staged"));

    repository
        .discard_files(repo.path(), &[], &cancellation())
        .await
        .expect("empty discard is a no-op");
    assert!(repo.path().join("keep.txt").exists());
}

#[tokio::test]
async fn worktree_lifecycle_is_reflected_in_ref_listing() {
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "hello\n", "initial");
    let worktree_parent = tempfile::tempdir().expect("temporary worktree parent");
    let worktree_path = worktree_parent.path().join("feature-worktree");
    let repository = GitRepository::default();

    let created = repository
        .create_worktree(
            CreateWorktreeInput {
                cwd: repo.path().to_path_buf(),
                ref_name: "main".into(),
                new_ref_name: Some("feature/worktree".into()),
                base_ref_name: Some("main".into()),
                path: Some(worktree_path.clone()),
            },
            &cancellation(),
        )
        .await
        .expect("create worktree");
    let refs = repository
        .list_refs(repo.path(), None, 0, 100, true, None, &cancellation())
        .await
        .expect("list refs");
    let feature = refs
        .refs
        .iter()
        .find(|reference| reference.name == "feature/worktree")
        .expect("feature ref");
    assert_eq!(
        feature
            .worktree_path
            .as_deref()
            .map(|path| path.replace('\\', "/")),
        Some(created.worktree.path.replace('\\', "/"))
    );

    repository
        .remove_worktree(repo.path(), &worktree_path, false, &cancellation())
        .await
        .expect("remove worktree");
    assert!(!worktree_path.exists());
}

#[cfg(windows)]
#[tokio::test]
async fn worktree_creation_accepts_windows_extended_length_repository_paths() {
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "hello\n", "initial");
    let extended_cwd = fs::canonicalize(repo.path()).expect("canonical repository path");
    assert!(
        extended_cwd.to_string_lossy().starts_with(r"\\?\"),
        "Windows canonicalization must exercise the extended path form"
    );
    let repository = GitRepository::default();

    let created = repository
        .create_worktree(
            CreateWorktreeInput {
                cwd: extended_cwd,
                ref_name: "main".into(),
                new_ref_name: Some("feature/extended-path".into()),
                base_ref_name: Some("main".into()),
                path: None,
            },
            &cancellation(),
        )
        .await
        .expect("extended repository paths create worktrees");
    assert!(!created.worktree.path.starts_with("//?/"));
    let worktree_path = Path::new(&created.worktree.path);
    assert!(worktree_path.is_dir());

    repository
        .remove_worktree(repo.path(), worktree_path, true, &cancellation())
        .await
        .expect("remove extended-path worktree");
    git(repo.path(), &["branch", "-D", "feature/extended-path"]);
}

#[tokio::test]
async fn failed_worktree_creation_removes_only_the_branch_created_by_the_attempt() {
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "hello\n", "initial");
    let blocked_parent = repo.path().join("not-a-directory");
    fs::write(&blocked_parent, "blocked\n").expect("blocking path fixture");
    let repository = GitRepository::default();

    repository
        .create_worktree(
            CreateWorktreeInput {
                cwd: repo.path().to_path_buf(),
                ref_name: "main".into(),
                new_ref_name: Some("feature/rollback-created-branch".into()),
                base_ref_name: Some("main".into()),
                path: Some(blocked_parent.join("worktree")),
            },
            &cancellation(),
        )
        .await
        .expect_err("invalid worktree path fails");

    assert!(
        git(
            repo.path(),
            &["branch", "--list", "feature/rollback-created-branch"]
        )
        .is_empty(),
        "a failed worktree attempt must not leak its newly created branch"
    );
}

#[tokio::test]
async fn failed_worktree_creation_preserves_a_preexisting_branch() {
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "hello\n", "initial");
    git(repo.path(), &["branch", "feature/preexisting-branch"]);
    let blocked_parent = repo.path().join("not-a-directory");
    fs::write(&blocked_parent, "blocked\n").expect("blocking path fixture");

    GitRepository::default()
        .create_worktree(
            CreateWorktreeInput {
                cwd: repo.path().to_path_buf(),
                ref_name: "main".into(),
                new_ref_name: Some("feature/preexisting-branch".into()),
                base_ref_name: Some("main".into()),
                path: Some(blocked_parent.join("worktree")),
            },
            &cancellation(),
        )
        .await
        .expect_err("duplicate branch cannot create a worktree");

    assert_eq!(
        git(
            repo.path(),
            &["branch", "--list", "feature/preexisting-branch"]
        ),
        "feature/preexisting-branch"
    );
}

#[tokio::test]
async fn branch_commit_context_and_history_workflow_uses_real_git_state() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let repository = GitRepository::default();
    repository
        .create_ref(repo.path(), "feature/rust", true, &cancellation())
        .await
        .expect("create and switch feature ref");
    fs::write(repo.path().join("tracked.txt"), "rust change\n").expect("feature edit");
    let context = repository
        .commit_context(repo.path(), &cancellation())
        .await
        .expect("AI commit context");
    assert!(context.contains("rust change"));
    let sha = repository
        .commit(
            repo.path(),
            "feat: port git to rust",
            Some(&["tracked.txt".into()]),
            false,
            &cancellation(),
        )
        .await
        .expect("commit selected file")
        .expect("selected file produced a commit");
    assert_eq!(sha.len(), 40);
    repository
        .rename_ref(
            repo.path(),
            "feature/rust",
            "feature/native-git",
            &cancellation(),
        )
        .await
        .expect("rename current ref");

    let history = repository
        .list_commits(repo.path(), 1, 0, &cancellation())
        .await
        .expect("paginated history");
    assert_eq!(history.commits[0].subject, "feat: port git to rust");
    assert_eq!(history.next_cursor, Some(1));
    let refs = repository
        .list_refs(
            repo.path(),
            Some("native"),
            0,
            100,
            false,
            None,
            &cancellation(),
        )
        .await
        .expect("filtered refs");
    assert_eq!(refs.total_count, 1);
    assert!(refs.refs[0].current);
}

#[test]
fn structured_runner_child_fixture() {
    if std::env::var_os("T4CODE_PROCESS_FIXTURE").is_none() {
        return;
    }
    if std::env::var_os("T4CODE_PROCESS_FIXTURE_ERROR").is_some() {
        eprintln!("fatal: bad config line 3 in .gitmodules");
        panic!("requested fixture failure");
    }
    let bytes = std::env::var("T4CODE_PROCESS_FIXTURE_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if bytes > 0 {
        print!("{}", "x".repeat(bytes));
    } else {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn fixture_request() -> ProcessRequest {
    ProcessRequest {
        operation: "git.test.fixture".into(),
        command: std::env::current_exe().expect("current test executable"),
        args: vec![
            "--exact".into(),
            "structured_runner_child_fixture".into(),
            "--nocapture".into(),
        ],
        cwd: std::env::current_dir().expect("current directory"),
        env: vec![("T4CODE_PROCESS_FIXTURE".into(), "1".into())],
        stdin: None,
        timeout: Duration::from_secs(10),
        max_output_bytes: 1024,
        output_policy: OutputPolicy::Truncate,
        append_truncation_marker: true,
        allow_non_zero_exit: false,
    }
}

#[tokio::test]
async fn process_runner_is_bounded_and_cancellable() {
    let runner = ProcessRunner;
    let mut bounded = fixture_request();
    bounded
        .env
        .push(("T4CODE_PROCESS_FIXTURE_BYTES".into(), "4096".into()));
    let output = runner
        .run(bounded, &cancellation())
        .await
        .expect("bounded process");
    assert!(output.stdout_truncated);
    assert!(output.stdout.len() <= 1024 + "\n\n[truncated]".len());

    let token = cancellation();
    let cancel = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.cancel();
    });
    let error = runner
        .run(fixture_request(), &token)
        .await
        .expect_err("cancelled process must fail");
    assert!(error.is_cancelled());

    let mut failed = fixture_request();
    failed
        .env
        .push(("T4CODE_PROCESS_FIXTURE_ERROR".into(), "1".into()));
    let error = runner
        .run(failed, &cancellation())
        .await
        .expect_err("non-zero process must retain bounded stderr");
    match error {
        ProcessError::NonZeroExit { stderr, .. } => {
            assert!(stderr.contains("bad config line 3 in .gitmodules"));
        }
        other => panic!("expected non-zero exit, got {other:?}"),
    }
}

#[tokio::test]
async fn status_subscription_starts_with_snapshot_deduplicates_and_stops_last_poller() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let broadcaster = StatusBroadcaster::new(
        Arc::new(GitRepository::default()),
        Duration::from_secs(60),
        4,
    );

    let mut first = broadcaster
        .subscribe(repo.path().to_path_buf(), cancellation())
        .await
        .expect("first subscription");
    let mut second = broadcaster
        .subscribe(repo.path().to_path_buf(), cancellation())
        .await
        .expect("second subscription");
    let first_snapshot = first.recv().await;
    let second_snapshot = second.recv().await;
    assert_eq!(broadcaster.active_poller_count(), 1);
    observe_initial_remote(first_snapshot, &mut first).await;
    observe_initial_remote(second_snapshot, &mut second).await;

    broadcaster
        .refresh_local(repo.path(), &cancellation())
        .await
        .expect("unchanged refresh");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), first.recv())
            .await
            .is_err()
    );

    fs::write(repo.path().join("tracked.txt"), "changed\n").expect("working tree edit");
    broadcaster
        .refresh_local(repo.path(), &cancellation())
        .await
        .expect("changed refresh");
    assert!(matches!(
        first.recv().await,
        Some(VcsStatusStreamEvent::LocalUpdated { .. })
    ));
    assert!(matches!(
        second.recv().await,
        Some(VcsStatusStreamEvent::LocalUpdated { .. })
    ));

    drop(first);
    assert_eq!(broadcaster.active_poller_count(), 1);
    drop(second);
    assert_eq!(broadcaster.active_poller_count(), 0);
}

#[tokio::test]
async fn status_subscription_poller_observes_external_working_tree_changes() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let broadcaster = StatusBroadcaster::new(
        Arc::new(GitRepository::default()),
        Duration::from_millis(50),
        4,
    );
    let mut subscription = broadcaster
        .subscribe(repo.path().to_path_buf(), cancellation())
        .await
        .expect("status subscription");
    let snapshot = subscription.recv().await;
    observe_initial_remote(snapshot, &mut subscription).await;

    fs::write(repo.path().join("tracked.txt"), "changed externally\n")
        .expect("external working tree edit");

    let local = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(VcsStatusStreamEvent::LocalUpdated { local }) = subscription.recv().await {
                break local;
            }
        }
    })
    .await
    .expect("poller should observe an external working tree edit");
    assert!(local.has_working_tree_changes);
    assert!(
        local
            .working_tree
            .files
            .iter()
            .any(|file| file.path == "tracked.txt")
    );
}

#[tokio::test]
async fn lagging_status_subscriber_is_bounded_and_releases_its_poller() {
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let broadcaster = StatusBroadcaster::new(
        Arc::new(GitRepository::default()),
        Duration::from_secs(60),
        1,
    );
    let subscription = broadcaster
        .subscribe(repo.path().to_path_buf(), cancellation())
        .await
        .expect("bounded subscription");
    fs::write(repo.path().join("tracked.txt"), "changed\n").expect("working tree edit");
    broadcaster
        .refresh_local(repo.path(), &cancellation())
        .await
        .expect("refresh lagging subscriber");

    assert_eq!(broadcaster.active_poller_count(), 0);
    drop(subscription);
}

#[tokio::test]
async fn subscribed_remote_poller_fetches_real_upstream_changes() {
    let root = tempfile::tempdir().expect("remote fixture root");
    let remote = root.path().join("remote.git");
    fs::create_dir(&remote).expect("bare remote directory");
    git(&remote, &["init", "--bare", "--initial-branch=main"]);

    let publisher = root.path().join("publisher");
    fs::create_dir(&publisher).expect("publisher directory");
    git(&publisher, &["init", "-b", "main"]);
    git(&publisher, &["config", "user.name", "T4Code Test"]);
    git(
        &publisher,
        &["config", "user.email", "t4code@example.invalid"],
    );
    commit_file(&publisher, "tracked.txt", "base\n", "initial");
    git(
        &publisher,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );
    git(&publisher, &["push", "-u", "origin", "main"]);

    let consumer = root.path().join("consumer");
    git(
        root.path(),
        &[
            "clone",
            &remote.to_string_lossy(),
            &consumer.to_string_lossy(),
        ],
    );
    let broadcaster = StatusBroadcaster::new(
        Arc::new(GitRepository::default()),
        Duration::from_millis(100),
        4,
    );
    let mut subscription = broadcaster
        .subscribe(consumer.clone(), cancellation())
        .await
        .expect("remote subscription");
    let snapshot = subscription.recv().await;
    observe_initial_remote(snapshot, &mut subscription).await;

    fs::write(publisher.join("tracked.txt"), "remote change\n").expect("remote edit");
    git(&publisher, &["add", "tracked.txt"]);
    git(&publisher, &["commit", "-m", "remote change"]);
    git(&publisher, &["push"]);

    let behind = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(VcsStatusStreamEvent::RemoteUpdated {
                remote: Some(remote),
            }) = subscription.recv().await
                && remote.behind_count == 1
            {
                break remote;
            }
        }
    })
    .await
    .expect("poller should observe the upstream push");
    assert_eq!(behind.ahead_count, 0);
}

#[test]
fn source_control_parsers_match_cli_shapes() {
    let github = source_control::parse_github_auth_status(
        r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"GitHub.COM","login":"mauro"}]}}"#,
    );
    assert!(github.parsed);
    assert_eq!(github.accounts[0].host, "github.com");
    assert_eq!(github.accounts[0].account, "mauro");

    let gitlab = source_control::parse_gitlab_auth_status(
        "gitlab.com\n  x Logged in to gitlab.com as mauro (keyring)\n",
    );
    assert_eq!(gitlab[0].host, "gitlab.com");
    assert_eq!(gitlab[0].account.as_deref(), Some("mauro"));
    assert_eq!(
        source_control::provider_from_remote("git@github.com:owner/repo.git").kind,
        source_control::ProviderKind::Github
    );
}

#[test]
fn pull_request_json_parsers_match_provider_cli_shapes() {
    let github = source_control::parse_github_pull_request(
        r#"{"number":42,"title":"Ship Rust","url":"https://github.com/acme/repo/pull/42","baseRefName":"main","headRefName":"feature/rust","state":"OPEN"}"#,
    )
    .expect("GitHub pull request");
    assert_eq!(github.number, 42);
    assert_eq!(github.state, source_control::ChangeRequestState::Open);
    assert_eq!(github.head_branch, "feature/rust");

    let gitlab = source_control::parse_gitlab_merge_request(
        r#"{"iid":7,"title":"Ship Rust","web_url":"https://gitlab.com/acme/repo/-/merge_requests/7","target_branch":"main","source_branch":"feature/rust","state":"merged"}"#,
    )
    .expect("GitLab merge request");
    assert_eq!(gitlab.number, 7);
    assert_eq!(gitlab.state, source_control::ChangeRequestState::Merged);
}

#[tokio::test]
async fn source_control_discovery_uses_structured_bounded_probes() {
    let discovery = source_control::SourceControlDiscovery::default()
        .discover(
            std::env::current_dir().expect("current directory"),
            &cancellation(),
        )
        .await;
    let git = discovery
        .version_control_systems
        .iter()
        .find(|item| item.kind == source_control::VcsDiscoveryKind::Git)
        .expect("Git discovery item");
    assert_eq!(git.status, source_control::DiscoveryStatus::Available);
    assert!(git.implemented);

    let wire = serde_json::to_value(discovery).expect("serialize discovery result");
    assert_eq!(wire["versionControlSystems"][0]["version"]["_id"], "Option");
}

#[test]
fn wire_models_keep_effect_contract_field_names_and_tags() {
    let value = serde_json::to_value(VcsStatusStreamEvent::LocalUpdated {
        local: git::VcsStatusLocalResult::non_repository(),
    })
    .expect("serialize status event");
    assert_eq!(value["_tag"], "localUpdated");
    assert_eq!(value["local"]["isRepo"], false);
    assert_eq!(
        value["local"]["workingTree"]["files"],
        serde_json::json!([])
    );
}

#[test]
fn owned_vcs_facade_exposes_git_capabilities() {
    let facade = vcs::VcsService::default();
    assert_eq!(facade.capabilities().kind, vcs::VcsDriverKind::Git);
    assert!(facade.capabilities().supports_worktrees);
}
