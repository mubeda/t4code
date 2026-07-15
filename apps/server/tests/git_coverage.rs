use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

use t4code_server::git::{
    CreateWorktreeInput, GitRepository, OutputPolicy, ProcessError, ProcessRequest, ProcessRunner,
    ProviderKind, PullStatus, StatusBroadcaster, VcsStagingArea, VcsStatusStreamEvent,
    VcsWorkingTreeFileStatus, parse_numstat, parse_porcelain_v2_line, resolve_numstat_new_path,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const PROCESS_FIXTURE_MODE: &str = "T4CODE_GIT_COVERAGE_PROCESS_MODE";
const ISOLATED_GIT_TEST: &str = "T4CODE_GIT_COVERAGE_ISOLATED";

#[test]
fn process_fixture() {
    let Some(mode) = std::env::var_os(PROCESS_FIXTURE_MODE) else {
        return;
    };
    match mode.to_string_lossy().as_ref() {
        "stdin" => {
            let mut input = Vec::new();
            std::io::stdin()
                .read_to_end(&mut input)
                .expect("read fixture stdin");
            std::io::stdout()
                .write_all(b"fixture-stdin:")
                .expect("write fixture prefix");
            std::io::stdout()
                .write_all(&input)
                .expect("write fixture stdin echo");
        }
        "stdout" => {
            std::io::stdout()
                .write_all(&vec![b'x'; 4096])
                .expect("write fixture stdout");
        }
        "stderr" => {
            std::io::stderr()
                .write_all(&vec![b'y'; 4096])
                .expect("write fixture stderr");
        }
        "nonzero" => {
            println!("fixture nonzero stdout");
            eprintln!("fixture nonzero stderr");
            std::process::exit(7);
        }
        "park" => loop {
            std::thread::park();
        },
        other => panic!("unknown process fixture mode: {other}"),
    }
}

fn cancellation() -> CancellationToken {
    CancellationToken::new()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "T4Code Coverage")
        .env("GIT_AUTHOR_EMAIL", "coverage@example.invalid")
        .env("GIT_COMMITTER_NAME", "T4Code Coverage")
        .env("GIT_COMMITTER_EMAIL", "coverage@example.invalid")
        .output()
        .expect("git must be installed for integration tests");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn init_repo() -> TempDir {
    let repo = tempfile::tempdir().expect("temporary repository");
    git(repo.path(), &["init", "-b", "main"]);
    git(repo.path(), &["config", "user.name", "T4Code Coverage"]);
    git(
        repo.path(),
        &["config", "user.email", "coverage@example.invalid"],
    );
    repo
}

fn commit_file(repo: &Path, relative: &str, contents: &str, message: &str) {
    let path = repo.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture parent");
    }
    fs::write(path, contents).expect("write fixture file");
    git(repo, &["add", "--", relative]);
    git(repo, &["commit", "-m", message]);
}

fn local_file_url(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    format!("file:///{}", normalized.trim_start_matches("//?/"))
}

fn relaunch_with_isolated_git_config(test_name: &str) -> bool {
    if std::env::var_os(ISOLATED_GIT_TEST).is_some() {
        return false;
    }
    let fixture = tempfile::tempdir().expect("isolated Git config fixture");
    let hooks = fixture.path().join("hooks");
    fs::create_dir(&hooks).expect("isolated hooks directory");
    let config = fixture.path().join("global.gitconfig");
    fs::write(
        &config,
        format!(
            "[commit]\n\tgpgSign = false\n[core]\n\thooksPath = {}\n",
            hooks.to_string_lossy().replace('\\', "/")
        ),
    )
    .expect("isolated global config");

    let output = Command::new(std::env::current_exe().expect("current test executable"))
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(ISOLATED_GIT_TEST, "1")
        .output()
        .expect("run test with isolated Git config");
    assert!(
        output.status.success(),
        "isolated test {test_name} failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[test]
fn git_fixtures_ignore_hostile_user_global_config() {
    let fixture = tempfile::tempdir().expect("hostile global config fixture");
    let hooks = fixture.path().join("hooks");
    fs::create_dir(&hooks).expect("hostile hooks directory");
    fs::write(hooks.join("pre-commit"), "#!/bin/sh\nexit 71\n").expect("hostile pre-commit hook");
    let config = fixture.path().join("global.gitconfig");
    fs::write(
        &config,
        format!(
            "[commit]\n\tgpgSign = true\n[core]\n\thooksPath = {}\n[url \"file:///C:/t4code-missing/\"]\n\tinsteadOf = file:///\n",
            hooks.to_string_lossy().replace('\\', "/")
        ),
    )
    .expect("hostile global config");

    let read_config = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("read hostile global config");
        assert!(output.status.success(), "git config {args:?} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    };
    assert_eq!(
        read_config(&["config", "--global", "--get", "commit.gpgSign"]),
        "true"
    );
    assert_eq!(
        read_config(&["config", "--global", "--get", "core.hooksPath"]),
        hooks.to_string_lossy().replace('\\', "/")
    );
    let rewrites = read_config(&[
        "config",
        "--global",
        "--get-regexp",
        r"^url\..*\.insteadOf$",
    ]);
    assert!(rewrites.contains("file:///"));
    assert!(rewrites.contains("file:///C:/t4code-missing/"));

    let output = Command::new(std::env::current_exe().expect("current test executable"))
        .args([
            "--exact",
            "local_clone_push_and_pull_cover_upstream_transitions",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove(ISOLATED_GIT_TEST)
        .output()
        .expect("run workflow under hostile global config");
    assert!(
        output.status.success(),
        "isolated Git workflow failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn process_request(mode: &str) -> ProcessRequest {
    ProcessRequest {
        operation: format!("git.coverage.{mode}"),
        command: std::env::current_exe().expect("current test executable"),
        args: vec![
            "--exact".into(),
            "process_fixture".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
        ],
        cwd: std::env::current_dir().expect("current directory"),
        env: vec![(PROCESS_FIXTURE_MODE.into(), mode.into())],
        stdin: None,
        timeout: Duration::from_secs(10),
        max_output_bytes: 8192,
        output_policy: OutputPolicy::Truncate,
        append_truncation_marker: false,
        allow_non_zero_exit: false,
    }
}

#[tokio::test]
async fn process_runner_writes_stdin_and_returns_both_streams() {
    let mut request = process_request("stdin");
    request.stdin = Some(b"native git input\n".to_vec());

    let output = ProcessRunner
        .run(request, &cancellation())
        .await
        .expect("stdin fixture succeeds");

    assert_eq!(output.exit_code, 0);
    assert!(output.stdout.contains("fixture-stdin:native git input\n"));
    assert!(!output.stdout_truncated);
    assert!(!output.stderr_truncated);
}

#[tokio::test]
async fn process_runner_reports_output_limits_for_each_stream() {
    for (mode, expected_stream) in [("stdout", "stdout"), ("stderr", "stderr")] {
        let mut request = process_request(mode);
        request.max_output_bytes = 1024;
        request.output_policy = OutputPolicy::Error;

        let error = ProcessRunner
            .run(request, &cancellation())
            .await
            .expect_err("oversized output must fail");

        match error {
            ProcessError::OutputLimit {
                stream,
                max_bytes,
                observed_bytes,
                ..
            } => {
                assert_eq!(stream, expected_stream);
                assert_eq!(max_bytes, 1024);
                assert!(observed_bytes >= 4096);
            }
            other => panic!("expected {expected_stream} output limit, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn process_runner_truncates_without_a_marker_when_disabled() {
    let mut request = process_request("stdout");
    request.max_output_bytes = 256;

    let output = ProcessRunner
        .run(request, &cancellation())
        .await
        .expect("truncated process succeeds");

    assert!(output.stdout_truncated);
    assert_eq!(output.stdout.len(), 256);
    assert!(!output.stdout.ends_with("[truncated]"));
}

#[tokio::test]
async fn process_runner_timeout_and_precancellation_are_distinct() {
    let mut timeout_request = process_request("park");
    timeout_request.timeout = Duration::ZERO;
    let timeout = ProcessRunner
        .run(timeout_request, &cancellation())
        .await
        .expect_err("parked process times out");
    assert!(matches!(
        timeout,
        ProcessError::Timeout { timeout_ms: 0, .. }
    ));
    assert!(!timeout.is_cancelled());

    let token = cancellation();
    token.cancel();
    let cancelled = ProcessRunner
        .run(process_request("park"), &token)
        .await
        .expect_err("pre-cancelled process is interrupted");
    assert!(cancelled.is_cancelled());
}

#[tokio::test]
async fn process_runner_preserves_nonzero_output_and_can_allow_the_exit() {
    let error = ProcessRunner
        .run(process_request("nonzero"), &cancellation())
        .await
        .expect_err("nonzero fixture fails by default");
    match error {
        ProcessError::NonZeroExit {
            exit_code,
            stdout_length,
            stderr_length,
            stdout,
            stderr,
            ..
        } => {
            assert_eq!(exit_code, 7);
            assert!(stdout_length >= "fixture nonzero stdout".len());
            assert!(stderr_length >= "fixture nonzero stderr".len());
            assert!(stdout.contains("fixture nonzero stdout"));
            assert!(stderr.contains("fixture nonzero stderr"));
        }
        other => panic!("expected nonzero exit, got {other:?}"),
    }

    let mut allowed = process_request("nonzero");
    allowed.allow_non_zero_exit = true;
    let output = ProcessRunner
        .run(allowed, &cancellation())
        .await
        .expect("explicitly allowed nonzero exit succeeds");
    assert_eq!(output.exit_code, 7);
    assert!(output.stderr.contains("fixture nonzero stderr"));
}

#[tokio::test]
async fn process_runner_spawn_error_identifies_the_operation_and_command() {
    let temp = tempfile::tempdir().expect("temporary process directory");
    let missing = temp.path().join("missing-process.exe");
    let mut request = process_request("stdin");
    request.operation = "git.coverage.spawn".into();
    request.command = missing.clone();
    request.cwd = temp.path().to_path_buf();

    let error = ProcessRunner
        .run(request, &cancellation())
        .await
        .expect_err("missing executable does not spawn");

    match error {
        ProcessError::Spawn {
            operation,
            command,
            source,
        } => {
            assert_eq!(operation, "git.coverage.spawn");
            assert_eq!(PathBuf::from(command), missing);
            assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
        }
        other => panic!("expected spawn error, got {other:?}"),
    }
}

#[test]
fn porcelain_parser_rejects_malformed_records_and_accepts_conflicts() {
    assert_eq!(parse_porcelain_v2_line(""), None);
    assert_eq!(parse_porcelain_v2_line("x unsupported"), None);
    assert_eq!(
        parse_porcelain_v2_line("1 .. N... 100644 100644 100644 abc def"),
        None
    );

    let deleted =
        parse_porcelain_v2_line("1 D. N... 100644 000000 000000 abcdef0 0000000 deleted.txt")
            .expect("deleted record");
    assert_eq!(deleted.index_status, VcsWorkingTreeFileStatus::Deleted);
    assert!(deleted.index_changed);
    assert!(!deleted.worktree_changed);

    let conflict = parse_porcelain_v2_line(
        "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflicted.txt",
    )
    .expect("unmerged record");
    assert_eq!(conflict.path, "conflicted.txt");
    assert!(conflict.index_changed);
    assert!(conflict.worktree_changed);
}

#[test]
fn numstat_parser_handles_binary_malformed_and_rename_paths() {
    assert_eq!(
        resolve_numstat_new_path("src/{old => new}/file.rs"),
        "src/new/file.rs"
    );
    assert_eq!(
        resolve_numstat_new_path("src/{unchanged}/file.rs"),
        "src/{unchanged}/file.rs"
    );

    let stats = parse_numstat(concat!(
        "-\t-\tassets/image.bin\n12\t",
        "3\tsrc/{old => new}.rs\ninvalid\n4\t2\t\n"
    ));
    assert_eq!(stats["assets/image.bin"], (0, 0));
    assert_eq!(stats["src/new.rs"], (12, 3));
    assert_eq!(stats.len(), 2);
}

#[tokio::test]
async fn non_repository_operations_return_defaults_and_reject_unsafe_pathspecs() {
    if relaunch_with_isolated_git_config(
        "non_repository_operations_return_defaults_and_reject_unsafe_pathspecs",
    ) {
        return;
    }
    let directory = tempfile::tempdir().expect("non-repository directory");
    let repository = GitRepository::default();
    let token = cancellation();

    assert!(
        !repository
            .is_repository(directory.path(), &token)
            .await
            .expect("repository probe")
    );
    assert_eq!(
        repository
            .repository_root(directory.path(), &token)
            .await
            .expect("repository root"),
        None
    );
    let local = repository
        .local_status(directory.path(), &token)
        .await
        .expect("non-repository local status");
    assert!(!local.is_repo);
    assert!(local.working_tree.files.is_empty());
    assert_eq!(
        repository
            .remote_status(directory.path(), &token)
            .await
            .expect("non-repository remote status"),
        None
    );
    assert_eq!(
        repository
            .refresh_remote_status(directory.path(), &token)
            .await
            .expect("non-repository refresh"),
        None
    );

    let status = repository
        .status(directory.path(), &token)
        .await
        .expect("combined non-repository status");
    assert!(!status.local.is_repo);
    assert!(!status.remote.has_upstream);
    assert_eq!(status.remote.ahead_of_default_count, Some(0));

    let refs = repository
        .list_refs(directory.path(), None, 0, 20, true, None, &token)
        .await
        .expect("non-repository refs");
    assert!(!refs.is_repo);
    assert!(refs.refs.is_empty());
    let commits = repository
        .list_commits(directory.path(), 20, 0, &token)
        .await
        .expect("non-repository history");
    assert!(commits.commits.is_empty());

    repository
        .stage_files(directory.path(), &[], &token)
        .await
        .expect("empty stage is a no-op");
    repository
        .unstage_files(directory.path(), &[], &token)
        .await
        .expect("empty unstage is a no-op");

    for path in [
        " ".to_owned(),
        "../escape.txt".to_owned(),
        directory
            .path()
            .join("absolute.txt")
            .to_string_lossy()
            .into_owned(),
    ] {
        let error = repository
            .stage_files(directory.path(), &[path], &token)
            .await
            .expect_err("unsafe pathspec is rejected");
        assert_eq!(error.operation.as_ref(), "GitVcsDriver.stageFiles");
        assert!(error.diagnostics.is_none());
        assert!(error.detail.contains("repository-relative"));
        assert!(error.to_string().contains("Git command failed"));
    }
}

#[tokio::test]
async fn status_reports_provider_staging_areas_and_default_branch_delta() {
    if relaunch_with_isolated_git_config(
        "status_reports_provider_staging_areas_and_default_branch_delta",
    ) {
        return;
    }
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    git(repo.path(), &["switch", "-c", "feature/status"]);
    commit_file(repo.path(), "feature.txt", "feature\n", "feature commit");
    git(
        repo.path(),
        &["remote", "add", "origin", "git@github.com:acme/project.git"],
    );

    fs::write(
        repo.path().join("tracked.txt"),
        "changed\nwith another line\n",
    )
    .expect("unstaged edit");
    fs::write(repo.path().join("staged.txt"), "staged\n").expect("staged file");
    git(repo.path(), &["add", "staged.txt"]);
    fs::write(repo.path().join("untracked.txt"), "one\ntwo")
        .expect("untracked file without final newline");

    let status = GitRepository::default()
        .status(repo.path(), &cancellation())
        .await
        .expect("combined repository status");

    assert!(status.local.is_repo);
    assert_eq!(status.local.ref_name.as_deref(), Some("feature/status"));
    assert_eq!(status.local.default_ref_name.as_deref(), Some("main"));
    assert!(!status.local.is_default_ref);
    assert!(status.local.has_primary_remote);
    let provider = status
        .local
        .source_control_provider
        .expect("recognized origin provider");
    assert_eq!(provider.kind, ProviderKind::Github);
    assert_eq!(provider.base_url, "https://github.com");
    assert!(!status.remote.has_upstream);
    assert_eq!(status.remote.ahead_of_default_count, Some(1));

    let files = &status.local.working_tree.files;
    assert!(files.iter().any(|file| {
        file.path == "staged.txt"
            && file.area == Some(VcsStagingArea::Staged)
            && file.status == Some(VcsWorkingTreeFileStatus::Added)
    }));
    assert!(files.iter().any(|file| {
        file.path == "tracked.txt"
            && file.area == Some(VcsStagingArea::Unstaged)
            && file.insertions == 2
            && file.deletions == 1
    }));
    assert!(files.iter().any(|file| {
        file.path == "untracked.txt"
            && file.area == Some(VcsStagingArea::Untracked)
            && file.insertions == 2
    }));
}

#[tokio::test]
async fn provider_detection_covers_supported_origin_url_shapes() {
    if relaunch_with_isolated_git_config("provider_detection_covers_supported_origin_url_shapes") {
        return;
    }
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "base\n", "initial");
    let repository = GitRepository::default();
    let cases = [
        (
            "ssh://git@gitlab.example/team/repo.git",
            ProviderKind::Gitlab,
        ),
        (
            "https://dev.azure.com/acme/project/_git/repo",
            ProviderKind::AzureDevops,
        ),
        ("git@bitbucket.org:acme/repo.git", ProviderKind::Bitbucket),
    ];

    for (index, (url, expected)) in cases.into_iter().enumerate() {
        if index > 0 {
            git(repo.path(), &["remote", "remove", "origin"]);
        }
        git(repo.path(), &["remote", "add", "origin", url]);
        let local = repository
            .local_status(repo.path(), &cancellation())
            .await
            .expect("provider status");
        assert_eq!(
            local.source_control_provider.map(|provider| provider.kind),
            Some(expected)
        );
    }

    git(repo.path(), &["remote", "remove", "origin"]);
    git(
        repo.path(),
        &["remote", "add", "origin", "ssh://example.invalid/acme/repo"],
    );
    assert!(
        repository
            .local_status(repo.path(), &cancellation())
            .await
            .expect("unknown provider status")
            .source_control_provider
            .is_none()
    );
}

#[tokio::test]
async fn history_paginates_real_commits_and_preserves_metadata() {
    if relaunch_with_isolated_git_config("history_paginates_real_commits_and_preserves_metadata") {
        return;
    }
    let repo = init_repo();
    commit_file(repo.path(), "one.txt", "one\n", "first");
    commit_file(repo.path(), "two.txt", "two\n", "second");
    commit_file(repo.path(), "three.txt", "three\n", "third");
    let repository = GitRepository::default();

    let first_page = repository
        .list_commits(repo.path(), 2, 0, &cancellation())
        .await
        .expect("first history page");
    assert_eq!(
        first_page
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect::<Vec<_>>(),
        ["third", "second"]
    );
    assert_eq!(first_page.next_cursor, Some(2));
    assert!(first_page.commits.iter().all(|commit| {
        commit.sha.len() == 40
            && !commit.short_sha.is_empty()
            && commit.author_name == "T4Code Coverage"
            && commit.authored_at_ms > 0
    }));

    let second_page = repository
        .list_commits(repo.path(), 2, 2, &cancellation())
        .await
        .expect("second history page");
    assert_eq!(second_page.commits.len(), 1);
    assert_eq!(second_page.commits[0].subject, "first");
    assert_eq!(second_page.next_cursor, None);
}

#[tokio::test]
async fn local_clone_push_and_pull_cover_upstream_transitions() {
    if relaunch_with_isolated_git_config("local_clone_push_and_pull_cover_upstream_transitions") {
        return;
    }
    let root = tempfile::tempdir().expect("local remote fixture");
    let remote = root.path().join("remote.git");
    fs::create_dir(&remote).expect("bare remote directory");
    git(&remote, &["init", "--bare", "--initial-branch=main"]);

    let publisher = root.path().join("publisher");
    fs::create_dir(&publisher).expect("publisher directory");
    git(&publisher, &["init", "-b", "main"]);
    git(&publisher, &["config", "user.name", "T4Code Coverage"]);
    git(
        &publisher,
        &["config", "user.email", "coverage@example.invalid"],
    );
    commit_file(&publisher, "tracked.txt", "base\n", "initial");
    let remote_url = local_file_url(&remote);
    git(&publisher, &["remote", "add", "origin", &remote_url]);
    git(&publisher, &["push", "-u", "origin", "main"]);

    let clones = root.path().join("clones");
    fs::create_dir(&clones).expect("clone parent");
    let repository = GitRepository::default();
    let consumer = repository
        .clone_repository(&remote_url, &clones, Some("consumer"), &cancellation())
        .await
        .expect("local clone");
    git(&consumer, &["config", "user.name", "T4Code Coverage"]);
    git(
        &consumer,
        &["config", "user.email", "coverage@example.invalid"],
    );

    let unchanged = repository
        .pull_current_branch(&consumer, &cancellation())
        .await
        .expect("up-to-date pull");
    assert_eq!(unchanged.status, PullStatus::SkippedUpToDate);
    assert_eq!(unchanged.upstream_ref.as_deref(), Some("origin/main"));

    commit_file(
        &publisher,
        "tracked.txt",
        "remote change\n",
        "remote update",
    );
    git(&publisher, &["push"]);
    let pulled = repository
        .pull_current_branch(&consumer, &cancellation())
        .await
        .expect("fast-forward pull");
    assert_eq!(pulled.status, PullStatus::Pulled);
    assert_eq!(
        fs::read_to_string(consumer.join("tracked.txt"))
            .expect("pulled contents")
            .replace("\r\n", "\n"),
        "remote change\n"
    );

    repository
        .create_ref(&consumer, "feature/local-push", true, &cancellation())
        .await
        .expect("create feature branch");
    fs::write(consumer.join("feature.txt"), "feature\n").expect("feature file");
    repository
        .commit(&consumer, "feature commit", None, false, &cancellation())
        .await
        .expect("feature commit")
        .expect("commit sha");
    assert_eq!(
        repository
            .push_current_branch(&consumer, &cancellation())
            .await
            .expect("set upstream push"),
        "feature/local-push"
    );
    assert_eq!(
        git(&consumer, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/feature/local-push"
    );

    let remote_refs = repository
        .list_refs(
            &consumer,
            Some("feature"),
            0,
            200,
            true,
            Some("remote"),
            &cancellation(),
        )
        .await
        .expect("remote refs");
    assert!(
        remote_refs
            .refs
            .iter()
            .any(|reference| reference.name == "origin/feature/local-push")
    );

    let derived_parent = root.path().join("derived");
    fs::create_dir(&derived_parent).expect("derived clone parent");
    let derived = repository
        .clone_repository(&remote_url, &derived_parent, None, &cancellation())
        .await
        .expect("derived-name clone");
    assert_eq!(
        derived.file_name().and_then(|name| name.to_str()),
        Some("remote")
    );
}

#[tokio::test]
async fn existing_branch_worktree_can_be_force_removed_when_dirty() {
    if relaunch_with_isolated_git_config("existing_branch_worktree_can_be_force_removed_when_dirty")
    {
        return;
    }
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "base\n", "initial");
    let repository = GitRepository::default();
    repository
        .create_ref(repo.path(), "feature/existing", false, &cancellation())
        .await
        .expect("create branch without switching");
    assert_eq!(
        repository
            .rename_ref(
                repo.path(),
                "feature/existing",
                "feature/existing",
                &cancellation(),
            )
            .await
            .expect("same-name rename"),
        "feature/existing"
    );

    let worktree_root = tempfile::tempdir().expect("worktree parent");
    let worktree_path = worktree_root.path().join("existing");
    let created = repository
        .create_worktree(
            CreateWorktreeInput {
                cwd: repo.path().to_path_buf(),
                ref_name: "feature/existing".into(),
                new_ref_name: None,
                base_ref_name: None,
                path: Some(worktree_path.clone()),
            },
            &cancellation(),
        )
        .await
        .expect("worktree from existing branch");
    assert_eq!(created.worktree.ref_name, "feature/existing");
    fs::write(worktree_path.join("dirty.txt"), "dirty\n").expect("dirty worktree file");

    repository
        .remove_worktree(repo.path(), &worktree_path, true, &cancellation())
        .await
        .expect("force-remove dirty worktree");
    assert!(!worktree_path.exists());
    assert_eq!(
        repository
            .switch_ref(repo.path(), "feature/existing", &cancellation())
            .await
            .expect("switch to existing branch")
            .as_deref(),
        Some("feature/existing")
    );
}

#[tokio::test]
async fn modified_submodule_is_reported_and_malformed_metadata_has_diagnostics() {
    if relaunch_with_isolated_git_config(
        "modified_submodule_is_reported_and_malformed_metadata_has_diagnostics",
    ) {
        return;
    }
    let child = init_repo();
    commit_file(child.path(), "lib.txt", "base\n", "child initial");
    let parent = init_repo();
    commit_file(parent.path(), "README.md", "parent\n", "parent initial");
    git(
        parent.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            &child.path().to_string_lossy(),
            "modules/child",
        ],
    );
    git(parent.path(), &["commit", "-am", "add submodule"]);

    fs::write(
        parent.path().join("modules/child/lib.txt"),
        "modified in submodule\n",
    )
    .expect("submodule edit");
    let repository = GitRepository::default();
    let status = repository
        .local_status(parent.path(), &cancellation())
        .await
        .expect("submodule status");
    assert!(status.working_tree.files.iter().any(|file| {
        file.path == "modules/child"
            && file.area == Some(VcsStagingArea::Unstaged)
            && file.status == Some(VcsWorkingTreeFileStatus::Modified)
    }));

    fs::write(parent.path().join(".gitmodules"), "[submodule \"broken\"\n")
        .expect("malformed gitmodules");
    let error = repository
        .local_status(parent.path(), &cancellation())
        .await
        .expect_err("malformed submodule metadata must be actionable");
    assert_eq!(
        error.operation.as_ref(),
        "GitVcsDriver.statusDetailsLocal.status"
    );
    assert!(!error.detail.trim().is_empty());
    let diagnostics = error.diagnostics.expect("structured git diagnostics");
    assert!(
        diagnostics
            .exit_code
            .is_some_and(|exit_code| exit_code != 0)
    );
    assert_eq!(diagnostics.argument_count, Some(6));
    assert!(diagnostics.stderr_length.is_some_and(|length| length > 0));
}

#[tokio::test]
async fn broadcaster_cancellation_closes_subscription_and_missing_paths_report_errors() {
    if relaunch_with_isolated_git_config(
        "broadcaster_cancellation_closes_subscription_and_missing_paths_report_errors",
    ) {
        return;
    }
    let repo = init_repo();
    commit_file(repo.path(), "tracked.txt", "base\n", "initial");
    let broadcaster = StatusBroadcaster::new(
        Arc::new(GitRepository::default()),
        Duration::from_secs(3600),
        2,
    );
    let subscription_cancellation = cancellation();
    let mut subscription = broadcaster
        .subscribe(repo.path().to_path_buf(), subscription_cancellation.clone())
        .await
        .expect("status subscription");

    let snapshot = subscription.recv().await.expect("initial snapshot");
    assert!(matches!(
        snapshot,
        VcsStatusStreamEvent::Snapshot { ref local, .. } if local.is_repo
    ));
    assert_eq!(broadcaster.active_poller_count(), 1);

    subscription_cancellation.cancel();
    while subscription.recv().await.is_some() {}
    drop(subscription);

    let missing = repo.path().join("missing/repository");
    let error = match broadcaster.subscribe(missing, cancellation()).await {
        Ok(_) => panic!("missing repository path cannot start a subscription"),
        Err(error) => error,
    };
    assert_eq!(error.operation.as_ref(), "GitVcsDriver.detectRepository");
    assert!(error.detail.contains("failed to spawn git"));
}
