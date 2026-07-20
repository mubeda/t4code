use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(unix)]
use serde_json::Value;
use t4code_server::process::{
    OutputMode, ProcessError, ProcessRunInput, ProcessRunner, TimeoutBehavior,
};
use tempfile::TempDir;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
const WINDOWS_STDIN_FIXTURE_ROLE: &str = "T4CODE_PROCESS_RUNNER_STDIN_ROLE";
#[cfg(windows)]
const WINDOWS_STDIN_ROOT_READY: &str = "T4CODE_PROCESS_RUNNER_STDIN_ROOT_READY";
#[cfg(windows)]
const WINDOWS_STDIN_CHILD_READY: &str = "T4CODE_PROCESS_RUNNER_STDIN_CHILD_READY";
#[cfg(windows)]
const WINDOWS_STDIN_GRANDCHILD_READY: &str = "T4CODE_PROCESS_RUNNER_STDIN_GRANDCHILD_READY";
#[cfg(windows)]
const WINDOWS_STDIN_ROOT_SURVIVED: &str = "T4CODE_PROCESS_RUNNER_STDIN_ROOT_SURVIVED";
#[cfg(windows)]
const WINDOWS_STDIN_CHILD_SURVIVED: &str = "T4CODE_PROCESS_RUNNER_STDIN_CHILD_SURVIVED";
#[cfg(windows)]
const WINDOWS_STDIN_GRANDCHILD_SURVIVED: &str = "T4CODE_PROCESS_RUNNER_STDIN_GRANDCHILD_SURVIVED";
#[cfg(windows)]
const WINDOWS_STDIN_RELEASE: &str = "T4CODE_PROCESS_RUNNER_STDIN_RELEASE";

#[test]
fn process_run_input_builders_preserve_defaults_and_apply_overrides() {
    let input = ProcessRunInput::new("demo-command", ["alpha", "beta"]);
    assert_eq!(input.command, "demo-command");
    assert_eq!(input.args, vec!["alpha".to_string(), "beta".to_string()]);
    assert_eq!(input.cwd, None);
    assert_eq!(input.spawn_cwd, None);
    assert_eq!(input.timeout, Duration::from_secs(60));
    assert_eq!(input.env, None);
    assert_eq!(input.stdin, None);
    assert_eq!(input.max_output_bytes, 8 * 1024 * 1024);
    assert_eq!(input.output_mode, OutputMode::Error);
    assert!(input.truncated_marker.is_empty());
    assert_eq!(input.timeout_behavior, TimeoutBehavior::Error);

    let overridden = ProcessRunInput::new("demo-command", ["alpha"])
        .with_max_output_bytes(12)
        .with_output_mode(OutputMode::Truncate)
        .with_timeout(Duration::from_millis(125))
        .with_timeout_behavior(TimeoutBehavior::TimedOutResult);
    assert_eq!(overridden.max_output_bytes, 12);
    assert_eq!(overridden.output_mode, OutputMode::Truncate);
    assert_eq!(overridden.timeout, Duration::from_millis(125));
    assert_eq!(overridden.timeout_behavior, TimeoutBehavior::TimedOutResult);

    let output_probe = ProcessRunInput::for_test_output(7);
    let sleep_probe = ProcessRunInput::for_test_sleep(Duration::from_millis(90));
    assert!(!output_probe.command.is_empty());
    assert!(!sleep_probe.command.is_empty());
}

#[tokio::test]
async fn process_runner_captures_stdout_stderr_stdin_env_and_cwd_precedence() {
    let temp = TempDir::new().expect("temporary directory");
    let capture_script = write_capture_script(temp.path());
    let cwd_only = temp.path().join("cwd-only");
    let spawn_dir = temp.path().join("spawn");
    fs::create_dir(&cwd_only).expect("cwd directory");
    fs::create_dir(&spawn_dir).expect("spawn directory");

    let mut env_vars = BTreeMap::new();
    env_vars.insert("PROCESS_RUNNER_TEST".to_string(), "env-visible".to_string());
    #[cfg(windows)]
    if let Some(system_root) = env::var_os("SystemRoot") {
        env_vars.insert(
            "SystemRoot".to_string(),
            system_root.to_string_lossy().into_owned(),
        );
    }

    let runner = ProcessRunner;
    let mut input = capture_script_input(&capture_script);
    input.cwd = Some(cwd_only.clone());
    input.env = Some(env_vars.clone());
    input.stdin = Some(capture_stdin_payload());
    let cwd_only_output = runner.run(input).await.expect("cwd-only run");
    assert_eq!(cwd_only_output.stderr.trim(), "stderr-marker");
    let cwd_only_capture = parse_capture_output(&cwd_only_output.stdout);
    assert_eq!(cwd_only_capture.env, "env-visible");
    assert_eq!(cwd_only_capture.stdin, "stdin-visible");
    assert_eq!(
        canonical_path(&cwd_only_capture.cwd),
        canonical_path(&cwd_only)
    );

    let mut spawn_override_input = capture_script_input(&capture_script);
    spawn_override_input.cwd = Some(cwd_only);
    spawn_override_input.spawn_cwd = Some(spawn_dir.clone());
    spawn_override_input.env = Some(env_vars);
    spawn_override_input.stdin = Some(capture_stdin_payload());
    let spawn_override_output = runner
        .run(spawn_override_input)
        .await
        .expect("spawn override run");
    let spawn_override_capture = parse_capture_output(&spawn_override_output.stdout);
    assert_eq!(
        canonical_path(&spawn_override_capture.cwd),
        canonical_path(&spawn_dir)
    );
}

#[tokio::test]
async fn process_runner_clears_inherited_environment_before_applying_overrides() {
    assert!(
        env::var_os("PATH").is_some(),
        "test host must provide an inherited PATH"
    );

    let mut env_vars = BTreeMap::new();
    env_vars.insert(
        "T4CODE_PROCESS_RUNNER_INJECTED".to_string(),
        "present".to_string(),
    );
    #[cfg(windows)]
    if let Some(system_root) = env::var_os("SystemRoot") {
        env_vars.insert(
            "SystemRoot".to_string(),
            system_root.to_string_lossy().into_owned(),
        );
    }

    let mut input = environment_probe_input();
    input.env = Some(env_vars);
    let output = ProcessRunner.run(input).await.expect("environment probe");
    let child_env = parse_environment(&output.stdout);

    assert_eq!(
        child_env
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("T4CODE_PROCESS_RUNNER_INJECTED"))
            .map(|(_, value)| value.as_str()),
        Some("present")
    );
    assert!(
        child_env
            .keys()
            .all(|name| !name.eq_ignore_ascii_case("PATH")),
        "child unexpectedly inherited PATH: {child_env:?}"
    );
}

#[tokio::test]
async fn process_runner_returns_nonzero_exit_and_captures_output() {
    let temp = TempDir::new().expect("temporary directory");
    let script = write_nonzero_script(temp.path());

    let output = ProcessRunner
        .run(script_input(&script, &[]))
        .await
        .expect("nonzero process still returns output");

    assert_eq!(output.code, Some(7));
    assert_eq!(output.stdout, "stdout-nonzero");
    assert_eq!(output.stderr, "stderr-nonzero");
    assert!(!output.timed_out);
    assert!(!output.stdout_truncated);
    assert!(!output.stderr_truncated);
}

#[tokio::test]
async fn process_runner_reports_spawn_errors() {
    let error = ProcessRunner
        .run(ProcessRunInput::new(
            "definitely-not-a-real-process-runner-command",
            Vec::<String>::new(),
        ))
        .await
        .expect_err("spawn should fail");

    match &error {
        ProcessError::Spawn { command, message } => {
            assert_eq!(command, "definitely-not-a-real-process-runner-command");
            assert!(!message.is_empty());
        }
        other => panic!("expected spawn error, got {other:?}"),
    }
    assert!(!error.is_cancelled());
    assert_eq!(error.output_limit(), None);
}

#[tokio::test]
async fn process_runner_enforces_output_limit_in_error_mode() {
    let error = ProcessRunner
        .run(
            ProcessRunInput::for_test_output(9)
                .with_max_output_bytes(4)
                .with_output_mode(OutputMode::Error),
        )
        .await
        .expect_err("output limit should fail");

    assert_eq!(error.output_limit(), Some(("stdout", 4)));
    match error {
        ProcessError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        } => {
            assert_eq!(stream, "stdout");
            assert_eq!(max_bytes, 4);
            assert!(observed_bytes > max_bytes);
        }
        other => panic!("expected output limit error, got {other:?}"),
    }
}

#[tokio::test]
async fn process_runner_handles_stderr_limits_and_truncation() {
    let temp = TempDir::new().expect("temporary directory");
    let script = write_stderr_output_script(temp.path());

    let limit_error = ProcessRunner
        .run(
            script_input(&script, &[])
                .with_max_output_bytes(4)
                .with_output_mode(OutputMode::Error),
        )
        .await
        .expect_err("stderr output limit should fail");
    match limit_error {
        ProcessError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        } => {
            assert_eq!(stream, "stderr");
            assert_eq!(max_bytes, 4);
            assert!(observed_bytes > max_bytes);
        }
        other => panic!("expected stderr output limit error, got {other:?}"),
    }

    let mut truncate_input = script_input(&script, &[])
        .with_max_output_bytes(5)
        .with_output_mode(OutputMode::Truncate);
    truncate_input.truncated_marker = "++".to_string();
    let truncated = ProcessRunner
        .run(truncate_input)
        .await
        .expect("stderr truncation");
    assert_eq!(truncated.stdout, "");
    assert_eq!(truncated.stderr, "yyy++");
    assert!(!truncated.stdout_truncated);
    assert!(truncated.stderr_truncated);
}

#[tokio::test]
async fn process_runner_truncates_output_and_handles_marker_edge_cases() {
    let runner = ProcessRunner;

    let mut marker_input = ProcessRunInput::for_test_output(7)
        .with_max_output_bytes(5)
        .with_output_mode(OutputMode::Truncate);
    marker_input.truncated_marker = "++".to_string();
    let marker_output = runner.run(marker_input).await.expect("marker output");
    assert_eq!(marker_output.stdout, "xxx++");
    assert!(marker_output.stdout_truncated);

    let mut short_marker_input = ProcessRunInput::for_test_output(7)
        .with_max_output_bytes(1)
        .with_output_mode(OutputMode::Truncate);
    short_marker_input.truncated_marker = "XYZ".to_string();
    let short_marker_output = runner
        .run(short_marker_input)
        .await
        .expect("short marker output");
    assert_eq!(short_marker_output.stdout, "X");
    assert!(short_marker_output.stdout_truncated);

    let mut zero_limit_input = ProcessRunInput::for_test_output(3)
        .with_max_output_bytes(0)
        .with_output_mode(OutputMode::Truncate);
    zero_limit_input.truncated_marker = "XYZ".to_string();
    let zero_limit_output = runner.run(zero_limit_input).await.expect("zero limit");
    assert_eq!(zero_limit_output.stdout, "");
    assert!(zero_limit_output.stdout_truncated);
}

#[tokio::test]
async fn process_runner_times_out_or_returns_timed_out_result() {
    let timeout_error = ProcessRunner
        .run(
            ProcessRunInput::for_test_sleep(Duration::from_millis(250))
                .with_timeout(Duration::from_millis(50)),
        )
        .await
        .expect_err("timeout error");
    match &timeout_error {
        ProcessError::Timeout { timeout_ms } => assert_eq!(*timeout_ms, 50),
        other => panic!("expected timeout error, got {other:?}"),
    }
    assert!(!timeout_error.is_cancelled());
    assert_eq!(timeout_error.output_limit(), None);

    let timed_out_result = ProcessRunner
        .run(
            ProcessRunInput::for_test_sleep(Duration::from_millis(250))
                .with_timeout(Duration::from_millis(50))
                .with_timeout_behavior(TimeoutBehavior::TimedOutResult),
        )
        .await
        .expect("timed-out result");
    assert!(timed_out_result.timed_out);
    assert_eq!(timed_out_result.code, None);
    assert_eq!(timed_out_result.stdout, "");
    assert_eq!(timed_out_result.stderr, "");
    assert!(!timed_out_result.stdout_truncated);
    assert!(!timed_out_result.stderr_truncated);
}

#[tokio::test]
async fn process_runner_returns_cancelled_for_pre_cancelled_tokens() {
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    let error = ProcessRunner
        .run_with_cancellation(
            ProcessRunInput::for_test_sleep(Duration::from_millis(250)),
            cancellation,
        )
        .await
        .expect_err("pre-cancelled run should fail");

    assert!(error.is_cancelled());
    assert!(matches!(error, ProcessError::Cancelled));
}

#[tokio::test]
async fn process_runner_cancels_in_flight_requests_and_cleans_up_children() {
    let temp = TempDir::new().expect("temporary directory");
    let script = write_process_tree_script(temp.path());
    let parent_ready_path = temp.path().join("parent.ready");
    let child_ready_path = temp.path().join("child.ready");
    let grandchild_ready_path = temp.path().join("grandchild.ready");
    let parent_survived_path = temp.path().join("parent.survived");
    let child_survived_path = temp.path().join("child.survived");
    let grandchild_survived_path = temp.path().join("grandchild.survived");
    let release_path = temp.path().join("release");

    let cancellation = CancellationToken::new();
    let task = tokio::spawn({
        let cancellation = cancellation.clone();
        let input = script_input(
            &script,
            &[
                parent_ready_path.to_string_lossy().as_ref(),
                child_ready_path.to_string_lossy().as_ref(),
                grandchild_ready_path.to_string_lossy().as_ref(),
                parent_survived_path.to_string_lossy().as_ref(),
                child_survived_path.to_string_lossy().as_ref(),
                grandchild_survived_path.to_string_lossy().as_ref(),
                release_path.to_string_lossy().as_ref(),
            ],
        );
        async move {
            ProcessRunner
                .run_with_cancellation(input, cancellation)
                .await
        }
    });

    wait_for_file(&parent_ready_path).await;
    wait_for_file(&child_ready_path).await;
    wait_for_file(&grandchild_ready_path).await;

    cancellation.cancel();

    let error = task
        .await
        .expect("join cancellation task")
        .expect_err("cancelled");
    assert!(error.is_cancelled());
    assert_cleanup_sentinels_remain_absent(
        &release_path,
        &[
            &parent_survived_path,
            &child_survived_path,
            &grandchild_survived_path,
        ],
    )
    .await;
}

#[tokio::test]
async fn process_runner_times_out_and_cleans_up_children() {
    let temp = TempDir::new().expect("temporary directory");
    let script = write_process_tree_script(temp.path());
    let parent_ready_path = temp.path().join("parent-timeout.ready");
    let child_ready_path = temp.path().join("child-timeout.ready");
    let grandchild_ready_path = temp.path().join("grandchild-timeout.ready");
    let parent_survived_path = temp.path().join("parent-timeout.survived");
    let child_survived_path = temp.path().join("child-timeout.survived");
    let grandchild_survived_path = temp.path().join("grandchild-timeout.survived");
    let release_path = temp.path().join("timeout.release");

    let mut input = script_input(
        &script,
        &[
            parent_ready_path.to_string_lossy().as_ref(),
            child_ready_path.to_string_lossy().as_ref(),
            grandchild_ready_path.to_string_lossy().as_ref(),
            parent_survived_path.to_string_lossy().as_ref(),
            child_survived_path.to_string_lossy().as_ref(),
            grandchild_survived_path.to_string_lossy().as_ref(),
            release_path.to_string_lossy().as_ref(),
        ],
    );
    input.timeout = Duration::from_secs(5);

    let task = tokio::spawn(async move { ProcessRunner.run(input).await });
    wait_for_file(&parent_ready_path).await;
    wait_for_file(&child_ready_path).await;
    wait_for_file(&grandchild_ready_path).await;

    let error = task
        .await
        .expect("join timeout task")
        .expect_err("timed out");
    match error {
        ProcessError::Timeout { timeout_ms } => assert_eq!(timeout_ms, 5_000),
        other => panic!("expected timeout error, got {other:?}"),
    }
    assert_cleanup_sentinels_remain_absent(
        &release_path,
        &[
            &parent_survived_path,
            &child_survived_path,
            &grandchild_survived_path,
        ],
    )
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn process_runner_cleans_up_tree_after_broken_stdin() {
    let temp = TempDir::new().expect("temporary directory");
    let script = write_broken_stdin_tree_script(temp.path());
    let parent_ready_path = temp.path().join("stdin-parent.ready");
    let child_ready_path = temp.path().join("stdin-child.ready");
    let grandchild_ready_path = temp.path().join("stdin-grandchild.ready");
    let parent_survived_path = temp.path().join("stdin-parent.survived");
    let child_survived_path = temp.path().join("stdin-child.survived");
    let grandchild_survived_path = temp.path().join("stdin-grandchild.survived");
    let release_path = temp.path().join("stdin.release");

    let mut input = script_input(
        &script,
        &[
            parent_ready_path.to_string_lossy().as_ref(),
            child_ready_path.to_string_lossy().as_ref(),
            grandchild_ready_path.to_string_lossy().as_ref(),
            parent_survived_path.to_string_lossy().as_ref(),
            child_survived_path.to_string_lossy().as_ref(),
            grandchild_survived_path.to_string_lossy().as_ref(),
            release_path.to_string_lossy().as_ref(),
        ],
    );
    input.stdin = Some("x".repeat(8 * 1024 * 1024));

    let task = tokio::spawn(async move { ProcessRunner.run(input).await });
    wait_for_file(&parent_ready_path).await;
    wait_for_file(&child_ready_path).await;
    wait_for_file(&grandchild_ready_path).await;

    let error = task
        .await
        .expect("join broken-stdin task")
        .expect_err("closed stdin should fail");
    assert!(matches!(error, ProcessError::Stdin(_)));
    assert_cleanup_sentinels_remain_absent(
        &release_path,
        &[
            &parent_survived_path,
            &child_survived_path,
            &grandchild_survived_path,
        ],
    )
    .await;
}

#[cfg(windows)]
#[test]
fn process_runner_windows_broken_stdin_fixture() {
    let Some(role) = std::env::var_os(WINDOWS_STDIN_FIXTURE_ROLE) else {
        return;
    };
    let (ready, survived) = match role.to_string_lossy().as_ref() {
        "root" => {
            spawn_windows_stdin_fixture_role("child");
            wait_for_windows_stdin_fixture_path(WINDOWS_STDIN_CHILD_READY);
            wait_for_windows_stdin_fixture_path(WINDOWS_STDIN_GRANDCHILD_READY);
            (WINDOWS_STDIN_ROOT_READY, WINDOWS_STDIN_ROOT_SURVIVED)
        }
        "child" => {
            spawn_windows_stdin_fixture_role("grandchild");
            wait_for_windows_stdin_fixture_path(WINDOWS_STDIN_GRANDCHILD_READY);
            (WINDOWS_STDIN_CHILD_READY, WINDOWS_STDIN_CHILD_SURVIVED)
        }
        "grandchild" => (
            WINDOWS_STDIN_GRANDCHILD_READY,
            WINDOWS_STDIN_GRANDCHILD_SURVIVED,
        ),
        other => panic!("unknown Windows stdin fixture role: {other}"),
    };
    fs::write(
        std::env::var_os(ready).expect("Windows stdin fixture ready path"),
        "ready",
    )
    .expect("write Windows stdin fixture ready");
    if role == "root" {
        // SAFETY: the standard-input handle belongs to this disposable fixture
        // process. Closing it is the injected failure under test.
        let stdin = unsafe {
            windows_sys::Win32::System::Console::GetStdHandle(
                windows_sys::Win32::System::Console::STD_INPUT_HANDLE,
            )
        };
        assert!(!stdin.is_null(), "fixture stdin handle should exist");
        // SAFETY: the fixture closes its standard-input handle exactly once.
        assert_ne!(
            unsafe { windows_sys::Win32::Foundation::CloseHandle(stdin) },
            0,
            "fixture stdin handle should close"
        );
    }
    let release = PathBuf::from(
        std::env::var_os(WINDOWS_STDIN_RELEASE).expect("Windows stdin fixture release path"),
    );
    while !release.is_file() {
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::write(
        std::env::var_os(survived).expect("Windows stdin fixture survived path"),
        "survived",
    )
    .expect("write Windows stdin fixture survived");
    loop {
        std::thread::park();
    }
}

#[cfg(windows)]
fn spawn_windows_stdin_fixture_role(role: &str) {
    std::process::Command::new(std::env::current_exe().expect("current test executable"))
        .args([
            "--exact",
            "process_runner_windows_broken_stdin_fixture",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(WINDOWS_STDIN_FIXTURE_ROLE, role)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn Windows stdin fixture role");
}

#[cfg(windows)]
fn wait_for_windows_stdin_fixture_path(key: &str) {
    let path = PathBuf::from(
        std::env::var_os(key)
            .unwrap_or_else(|| panic!("missing Windows stdin fixture path: {key}")),
    );
    for _ in 0..1_000 {
        if path.is_file() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {}", path.display());
}

#[cfg(windows)]
#[tokio::test]
async fn process_runner_cleans_up_windows_tree_after_broken_stdin() {
    let temp = TempDir::new().expect("Windows stdin fixture directory");
    let root_ready = temp.path().join("root.ready");
    let child_ready = temp.path().join("child.ready");
    let grandchild_ready = temp.path().join("grandchild.ready");
    let root_survived = temp.path().join("root.survived");
    let child_survived = temp.path().join("child.survived");
    let grandchild_survived = temp.path().join("grandchild.survived");
    let release = temp.path().join("release");
    let mut environment = std::env::vars().collect::<BTreeMap<_, _>>();
    environment.extend([
        (WINDOWS_STDIN_FIXTURE_ROLE.to_string(), "root".to_string()),
        (
            WINDOWS_STDIN_ROOT_READY.to_string(),
            root_ready.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_CHILD_READY.to_string(),
            child_ready.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_GRANDCHILD_READY.to_string(),
            grandchild_ready.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_ROOT_SURVIVED.to_string(),
            root_survived.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_CHILD_SURVIVED.to_string(),
            child_survived.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_GRANDCHILD_SURVIVED.to_string(),
            grandchild_survived.to_string_lossy().into_owned(),
        ),
        (
            WINDOWS_STDIN_RELEASE.to_string(),
            release.to_string_lossy().into_owned(),
        ),
    ]);
    let mut input = ProcessRunInput::new(
        std::env::current_exe()
            .expect("current test executable")
            .to_string_lossy()
            .into_owned(),
        [
            "--exact",
            "process_runner_windows_broken_stdin_fixture",
            "--nocapture",
            "--test-threads=1",
        ],
    );
    input.env = Some(environment);
    input.stdin = Some("x".repeat(8 * 1024 * 1024));

    let task = tokio::spawn(async move { ProcessRunner.run(input).await });
    wait_for_file(&root_ready).await;
    let error = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("broken-stdin runner should finish")
        .expect("join Windows broken-stdin runner")
        .expect_err("closed stdin should fail");
    assert!(matches!(error, ProcessError::Stdin(_)));
    assert_cleanup_sentinels_remain_absent(
        &release,
        &[&root_survived, &child_survived, &grandchild_survived],
    )
    .await;
}

#[cfg(windows)]
#[tokio::test]
async fn process_runner_resolves_cmd_and_bat_scripts() {
    let temp = TempDir::new().expect("temporary directory");
    let cmd_script = temp.path().join("echo-script.cmd");
    fs::write(
        &cmd_script,
        "@echo off\r\necho cmd:%1:%2\r\necho cmd-stderr 1>&2\r\n",
    )
    .expect("write cmd script");

    let bat_script = temp.path().join("echo-script.bat");
    fs::write(
        &bat_script,
        "@echo off\r\necho bat:%1:%2\r\necho bat-stderr 1>&2\r\n",
    )
    .expect("write bat script");

    let cmd_output = ProcessRunner
        .run(ProcessRunInput::new(
            cmd_script.to_string_lossy().into_owned(),
            ["alpha", "beta"],
        ))
        .await
        .expect("cmd output");
    assert_eq!(cmd_output.stdout.trim(), "cmd:alpha:beta");
    assert_eq!(cmd_output.stderr.trim(), "cmd-stderr");

    let bat_output = ProcessRunner
        .run(ProcessRunInput::new(
            bat_script.to_string_lossy().into_owned(),
            ["left", "right"],
        ))
        .await
        .expect("bat output");
    assert_eq!(bat_output.stdout.trim(), "bat:left:right");
    assert_eq!(bat_output.stderr.trim(), "bat-stderr");
}

fn script_input(script: &Path, extra_args: &[&str]) -> ProcessRunInput {
    let mut args = platform_script_prefix(script);
    args.extend(extra_args.iter().map(|arg| (*arg).to_string()));
    ProcessRunInput::new(platform_interpreter().to_string_lossy().into_owned(), args)
}

#[cfg(windows)]
fn environment_probe_input() -> ProcessRunInput {
    ProcessRunInput::new(
        Path::new(&env::var_os("SystemRoot").expect("SystemRoot"))
            .join("System32")
            .join("cmd.exe")
            .to_string_lossy()
            .into_owned(),
        ["/D", "/C", "set"],
    )
}

#[cfg(unix)]
fn environment_probe_input() -> ProcessRunInput {
    ProcessRunInput::new("/usr/bin/env", Vec::<String>::new())
}

#[cfg(windows)]
fn capture_script_input(script: &Path) -> ProcessRunInput {
    ProcessRunInput::new(script.to_string_lossy().into_owned(), Vec::<String>::new())
}

#[cfg(unix)]
fn capture_script_input(script: &Path) -> ProcessRunInput {
    script_input(script, &[])
}

fn platform_script_prefix(script: &Path) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script.to_string_lossy().into_owned(),
        ]
    }
    #[cfg(unix)]
    {
        vec![script.to_string_lossy().into_owned()]
    }
}

#[cfg(windows)]
fn platform_interpreter() -> PathBuf {
    Path::new(&env::var_os("SystemRoot").expect("SystemRoot"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg(unix)]
fn platform_interpreter() -> PathBuf {
    PathBuf::from("/bin/sh")
}

#[cfg(windows)]
fn write_capture_script(directory: &Path) -> PathBuf {
    let path = directory.join("capture.cmd");
    fs::write(
        &path,
        r#"@echo off
setlocal EnableExtensions DisableDelayedExpansion
set /p STDIN_CONTENT=
echo cwd=%CD%
echo env=%PROCESS_RUNNER_TEST%
echo stdin=%STDIN_CONTENT%
<nul set /p =stderr-marker 1>&2
"#,
    )
    .expect("write capture script");
    path
}

#[cfg(unix)]
fn write_capture_script(directory: &Path) -> PathBuf {
    write_script(
        directory,
        "capture",
        "",
        r#"stdin_content=$(cat)
printf '{"cwd":"%s","env":"%s","stdin":"%s"}' "$PWD" "$PROCESS_RUNNER_TEST" "$stdin_content"
printf 'stderr-marker' >&2
"#,
    )
}

fn write_nonzero_script(directory: &Path) -> PathBuf {
    write_script(
        directory,
        "nonzero",
        r#"[Console]::Out.Write('stdout-nonzero')
[Console]::Error.Write('stderr-nonzero')
exit 7
"#,
        r#"printf 'stdout-nonzero'
printf 'stderr-nonzero' >&2
exit 7
"#,
    )
}

fn write_stderr_output_script(directory: &Path) -> PathBuf {
    write_script(
        directory,
        "stderr-output",
        r#"[Console]::Error.Write('yyyyyyy')
"#,
        r#"printf 'yyyyyyy' >&2
"#,
    )
}

#[cfg(windows)]
fn write_process_tree_script(directory: &Path) -> PathBuf {
    let windows = format!(
        r#"
param(
    [string]$parentReadyPath,
    [string]$childReadyPath,
    [string]$grandchildReadyPath,
    [string]$parentSurvivedPath,
    [string]$childSurvivedPath,
    [string]$grandchildSurvivedPath,
    [string]$releasePath
)
$env:T4CODE_PROCESS_RUNNER_CHILD_READY = $childReadyPath
$env:T4CODE_PROCESS_RUNNER_GRANDCHILD_READY = $grandchildReadyPath
$env:T4CODE_PROCESS_RUNNER_CHILD_SURVIVED = $childSurvivedPath
$env:T4CODE_PROCESS_RUNNER_GRANDCHILD_SURVIVED = $grandchildSurvivedPath
$env:T4CODE_PROCESS_RUNNER_RELEASE = $releasePath
$grandchildCommand = 'Set-Content -LiteralPath $env:T4CODE_PROCESS_RUNNER_GRANDCHILD_READY -Value ready -NoNewline; while (-not (Test-Path -LiteralPath $env:T4CODE_PROCESS_RUNNER_RELEASE)) {{ Start-Sleep -Milliseconds 25 }}; Set-Content -LiteralPath $env:T4CODE_PROCESS_RUNNER_GRANDCHILD_SURVIVED -Value survived -NoNewline; Start-Sleep -Seconds 30'
$childCommand = '$grandchild = Start-Process -FilePath ''{}'' -ArgumentList @(''-NoProfile'', ''-NonInteractive'', ''-Command'', $env:T4CODE_PROCESS_RUNNER_GRANDCHILD_COMMAND) -PassThru -WindowStyle Hidden; Set-Content -LiteralPath $env:T4CODE_PROCESS_RUNNER_CHILD_READY -Value ready -NoNewline; while (-not (Test-Path -LiteralPath $env:T4CODE_PROCESS_RUNNER_RELEASE)) {{ Start-Sleep -Milliseconds 25 }}; Set-Content -LiteralPath $env:T4CODE_PROCESS_RUNNER_CHILD_SURVIVED -Value survived -NoNewline; Start-Sleep -Seconds 30'
$env:T4CODE_PROCESS_RUNNER_GRANDCHILD_COMMAND = $grandchildCommand
$child = Start-Process -FilePath '{}' -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $childCommand) -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $parentReadyPath -Value ready -NoNewline
while (-not (Test-Path -LiteralPath $releasePath)) {{
    Start-Sleep -Milliseconds 25
}}
Set-Content -LiteralPath $parentSurvivedPath -Value survived -NoNewline
while ($true) {{
    Start-Sleep -Milliseconds 100
}}
"#,
        escape_powershell_single_quoted(platform_interpreter().to_string_lossy().as_ref()),
        escape_powershell_single_quoted(platform_interpreter().to_string_lossy().as_ref())
    );
    write_script(directory, "process-tree", &windows, "")
}

#[cfg(unix)]
fn write_process_tree_script(directory: &Path) -> PathBuf {
    let grandchild = write_script(
        directory,
        "process-tree-grandchild",
        "",
        r#"printf ready > "$1"
while [ ! -f "$3" ]; do
    sleep 0.05
done
printf survived > "$2"
sleep 30
"#,
    );
    let child = write_script(
        directory,
        "process-tree-child",
        "",
        &format!(
            r#"sh '{}' "$3" "$4" "$5" </dev/null &
printf ready > "$1"
while [ ! -f "$5" ]; do
    sleep 0.05
done
printf survived > "$2"
sleep 30
"#,
            grandchild.display()
        ),
    );
    let unix = format!(
        r#"parent_ready_path=$1
child_ready_path=$2
grandchild_ready_path=$3
parent_survived_path=$4
child_survived_path=$5
grandchild_survived_path=$6
release_path=$7
sh '{}' "$child_ready_path" "$child_survived_path" "$grandchild_ready_path" "$grandchild_survived_path" "$release_path" </dev/null &
printf ready > "$parent_ready_path"
while [ ! -f "$release_path" ]; do
    sleep 0.05
done
printf survived > "$parent_survived_path"
while true; do
    sleep 0.1
done
"#,
        child.display()
    );
    write_script(directory, "process-tree", "", &unix)
}

#[cfg(unix)]
fn write_broken_stdin_tree_script(directory: &Path) -> PathBuf {
    let process_tree = write_process_tree_script(directory);
    let unix = format!(
        r#"sh '{}' "$@" </dev/null &
tree_pid=$!
while [ ! -f "$1" ] || [ ! -f "$2" ] || [ ! -f "$3" ]; do
    sleep 0.01
done
exec 0<&-
wait "$tree_pid"
"#,
        process_tree.display()
    );
    write_script(directory, "broken-stdin-tree", "", &unix)
}

#[cfg(windows)]
fn write_script(directory: &Path, stem: &str, windows: &str, _unix: &str) -> PathBuf {
    let path = directory.join(format!("{stem}.ps1"));
    fs::write(&path, windows.trim_start()).expect("write script");
    path
}

#[cfg(unix)]
fn write_script(directory: &Path, stem: &str, _windows: &str, unix: &str) -> PathBuf {
    let path = directory.join(format!("{stem}.sh"));
    fs::write(&path, unix.trim_start()).expect("write script");
    path
}

#[derive(Debug)]
struct CaptureOutput {
    cwd: String,
    env: String,
    stdin: String,
}

#[cfg(windows)]
fn parse_capture_output(stdout: &str) -> CaptureOutput {
    let mut cwd = None;
    let mut env = None;
    let mut stdin = None;
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("cwd=") {
            cwd = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("env=") {
            env = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("stdin=") {
            stdin = Some(value.to_string());
        }
    }
    CaptureOutput {
        cwd: cwd.expect("cwd line"),
        env: env.expect("env line"),
        stdin: stdin.expect("stdin line"),
    }
}

#[cfg(unix)]
fn parse_capture_output(stdout: &str) -> CaptureOutput {
    let value: Value = serde_json::from_str(stdout).expect("capture JSON output");
    CaptureOutput {
        cwd: value["cwd"].as_str().expect("cwd string").to_string(),
        env: value["env"].as_str().expect("env string").to_string(),
        stdin: value["stdin"].as_str().expect("stdin string").to_string(),
    }
}

#[cfg(windows)]
fn capture_stdin_payload() -> String {
    "stdin-visible\r\n".to_string()
}

#[cfg(unix)]
fn capture_stdin_payload() -> String {
    "stdin-visible".to_string()
}

async fn wait_for_file(path: &Path) {
    for _ in 0..160 {
        if path.is_file() {
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {}", path.display());
}

async fn assert_cleanup_sentinels_remain_absent(release: &Path, sentinels: &[&Path]) {
    fs::write(release, "release").expect("write survivor release file");
    sleep(Duration::from_secs(1)).await;
    for sentinel in sentinels {
        assert!(
            !sentinel.exists(),
            "process remained alive long enough to write {}",
            sentinel.display()
        );
    }
}

fn parse_environment(stdout: &str) -> BTreeMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(name, value)| (name.to_string(), value.trim_end_matches('\r').to_string()))
        .collect()
}

#[cfg(windows)]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

fn canonical_path(path: impl AsRef<Path>) -> PathBuf {
    fs::canonicalize(path).expect("canonical test path")
}
