# POSIX Desktop Shell PATH Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packaged macOS and Linux T4Code desktop builds discover and launch executables from the user's interactive login-shell PATH.

**Architecture:** A new Rust desktop startup module will synchronously capture the login-shell PATH with bounded output and a five-second timeout, merge it ahead of the inherited GUI PATH, and install it before Tauri starts. Provider executable resolution remains centralized in the Rust server, with a new pure search-path helper so behavior can be tested without mutating global environment state.

**Tech Stack:** Rust 2024, `std::process`, Tauri 2, Cargo tests, Vite+, macOS DMG tooling, Computer Use.

## Global Constraints

- Apply hydration to packaged macOS and Linux desktop builds.
- Keep Windows behavior unchanged.
- Do not hardcode Homebrew, npm, pnpm, Cargo, or provider-specific installation directories.
- Do not modify persisted provider binary paths.
- Hydration must fail open and never prevent T4Code from starting.
- The shell probe timeout is five seconds.
- Timed-out children must be killed and reaped, and stdout-reader threads must be joined.
- Never log PATH contents, captured shell output, or other environment contents.
- Process environment mutation must occur before Tauri starts and while startup is single-threaded.
- Preserve the unrelated modification in `apps/desktop/src-tauri/src/bridge.rs`.
- `vp check` and `vp run typecheck` must pass before completion.
- Perform a packaged macOS UI test after automated verification.

---

### Task 1: Make Provider Executable Resolution Pure and Testable

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs:1449-1471`
- Test: `apps/server/src/production/provider_runtime.rs:3860-3890`

**Interfaces:**
- Consumes: a provider executable name and an optional explicit search PATH.
- Produces: `resolve_provider_executable_in_path(input: &str, search_path: Option<&OsStr>) -> Option<PathBuf>`.
- Preserves: `resolve_provider_executable(input: &str) -> Option<PathBuf>` as the production wrapper over `std::env::var_os("PATH")`.

- [ ] **Step 1: Add failing pure-resolution tests**

Extend the existing executable-resolution test module with tests equivalent to:

```rust
#[test]
fn executable_resolution_uses_supplied_search_path_without_global_environment() {
    let system = tempfile::TempDir::new().unwrap();
    let user = tempfile::TempDir::new().unwrap();
    let executable = user.path().join("codex");
    std::fs::write(&executable, b"fixture").unwrap();
    let minimal = std::env::join_paths([system.path()]).unwrap();
    let hydrated = std::env::join_paths([user.path(), system.path()]).unwrap();

    assert_eq!(
        super::resolve_provider_executable_in_path("codex", Some(&minimal)),
        None
    );
    assert_eq!(
        super::resolve_provider_executable_in_path("codex", Some(&hydrated)),
        Some(executable)
    );
}

#[test]
fn executable_resolution_keeps_explicit_paths_independent_of_search_path() {
    let directory = tempfile::TempDir::new().unwrap();
    let executable = directory.path().join("provider-fixture");
    std::fs::write(&executable, b"fixture").unwrap();

    assert_eq!(
        super::resolve_provider_executable_in_path(
            &executable.to_string_lossy(),
            Some(OsStr::new(""))
        ),
        Some(executable)
    );
}
```

- [ ] **Step 2: Run the tests and verify the red state**

Run:

```bash
cargo test -p t4code-server executable_resolution -- --nocapture
```

Expected: compilation fails because `resolve_provider_executable_in_path` does not exist.

- [ ] **Step 3: Extract the pure resolver**

Implement:

```rust
pub(crate) fn resolve_provider_executable(input: &str) -> Option<PathBuf> {
    let search_path = std::env::var_os("PATH");
    resolve_provider_executable_in_path(input, search_path.as_deref())
}

pub(crate) fn resolve_provider_executable_in_path(
    input: &str,
    search_path: Option<&OsStr>,
) -> Option<PathBuf> {
    let path = PathBuf::from(input);
    if path.is_file() {
        return Some(path);
    }
    if path.components().count() > 1 {
        return None;
    }
    let extensions = provider_executable_extensions();
    search_path
        .into_iter()
        .flat_map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .find_map(|directory| {
            extensions.iter().find_map(|extension| {
                let candidate = if extension.is_empty() {
                    directory.join(input)
                } else {
                    directory.join(format!("{input}.{extension}"))
                };
                candidate.is_file().then_some(candidate)
            })
        })
}
```

Add `OsStr` to the existing `std::ffi` import.

- [ ] **Step 4: Run the targeted server tests**

Run:

```bash
cargo test -p t4code-server executable_resolution -- --nocapture
```

Expected: all executable-resolution tests pass.

- [ ] **Step 5: Commit the pure provider resolver**

```bash
git add apps/server/src/production/provider_runtime.rs
git commit -m "refactor: make provider PATH resolution testable"
```

### Task 2: Implement Pure Shell Selection, Parsing, and PATH Merging

**Files:**
- Create: `apps/desktop/src-tauri/src/shell_environment.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `pub(crate) fn hydrate_process_path() -> PathHydrationReport`.
- Produces: `PathHydrationReport::record(self)` for privacy-safe startup logging.
- Internal pure functions: `select_shell`, `parse_captured_path`, and `merge_path_values`.

- [ ] **Step 1: Register the module and add failing pure unit tests**

Add `mod shell_environment;` beside the other module declarations in `lib.rs`.

Create `shell_environment.rs` with the report/failure enums and unit tests for:

```rust
#[test]
fn parses_path_between_delimiters_and_ignores_shell_output() {
    let output = b"welcome\n__T4CODE_PATH_START__/opt/homebrew/bin:/usr/bin\
__T4CODE_PATH_END__\nlogout";
    assert_eq!(
        parse_captured_path(output, false).unwrap(),
        OsString::from("/opt/homebrew/bin:/usr/bin")
    );
}

#[test]
fn rejects_missing_reversed_and_empty_delimiters() {
    assert_eq!(
        parse_captured_path(b"/usr/bin", false),
        Err(PathHydrationFailure::MalformedOutput)
    );
    assert_eq!(
        parse_captured_path(
            b"__T4CODE_PATH_END__/usr/bin__T4CODE_PATH_START__",
            false
        ),
        Err(PathHydrationFailure::MalformedOutput)
    );
    assert_eq!(
        parse_captured_path(
            b"__T4CODE_PATH_START__  __T4CODE_PATH_END__",
            false
        ),
        Err(PathHydrationFailure::EmptyPath)
    );
    assert_eq!(
        parse_captured_path(
            b"__T4CODE_PATH_START__/usr/bin__T4CODE_PATH_END__",
            true
        ),
        Err(PathHydrationFailure::OutputTooLarge)
    );
}

#[test]
fn merges_shell_path_first_preserving_spaces_and_unique_inherited_entries() {
    let shell = std::env::join_paths([
        Path::new("/Users/test/My Tools"),
        Path::new("/opt/homebrew/bin"),
        Path::new("/usr/bin"),
        Path::new("/opt/homebrew/bin"),
    ])
    .unwrap();
    let inherited =
        std::env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).unwrap();

    let prepared = merge_path_values(&shell, Some(&inherited)).unwrap();
    assert_eq!(
        std::env::split_paths(&prepared.value).collect::<Vec<_>>(),
        [
            PathBuf::from("/Users/test/My Tools"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]
    );
    assert_eq!(prepared.added_segments, 2);
}

#[test]
fn selects_trusted_configured_shell_then_platform_default() {
    let exists = |path: &Path| {
        matches!(
            path.to_str(),
            Some("/opt/homebrew/bin/fish" | "/bin/zsh" | "/bin/bash")
        )
    };
    assert_eq!(
        select_shell(
            Some(OsStr::new("/opt/homebrew/bin/fish")),
            PosixPlatform::MacOs,
            exists
        ),
        Some(PathBuf::from("/opt/homebrew/bin/fish"))
    );
    assert_eq!(
        select_shell(
            Some(OsStr::new("relative/zsh")),
            PosixPlatform::MacOs,
            exists
        ),
        Some(PathBuf::from("/bin/zsh"))
    );
    assert_eq!(
        select_shell(
            Some(OsStr::new("/bin/nushell")),
            PosixPlatform::Linux,
            exists
        ),
        Some(PathBuf::from("/bin/bash"))
    );
}

#[test]
fn windows_platform_skips_hydration() {
    assert_eq!(
        platform_action(DesktopPlatform::Windows),
        PlatformAction::Skip
    );
}
```

- [ ] **Step 2: Run desktop tests and verify the red state**

Run:

```bash
cargo test -p t4code-desktop shell_environment -- --nocapture
```

Expected: compilation fails because the pure helpers do not exist.

- [ ] **Step 3: Implement the pure model**

Implement these exact boundaries:

```rust
const PATH_CAPTURE_START: &[u8] = b"__T4CODE_PATH_START__";
const PATH_CAPTURE_END: &[u8] = b"__T4CODE_PATH_END__";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathHydrationFailure {
    ShellUnavailable,
    SpawnFailed,
    WaitFailed,
    TimedOut,
    NonZeroExit,
    OutputReadFailed,
    OutputTooLarge,
    MalformedOutput,
    EmptyPath,
    InvalidPath,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathHydrationReport {
    Applied { added_segments: usize },
    Unchanged { reason: PathHydrationFailure },
    Skipped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopPlatform {
    MacOs,
    Linux,
    Windows,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlatformAction {
    Hydrate(PosixPlatform),
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PosixPlatform {
    MacOs,
    Linux,
}

#[derive(Debug, Eq, PartialEq)]
struct PreparedPath {
    value: OsString,
    added_segments: usize,
}
```

`parse_captured_path` must locate the first start delimiter, then the first end
delimiter after it, trim ASCII whitespace, and convert the enclosed Unix bytes
to `OsString`.

`merge_path_values` must use `std::env::split_paths` and
`std::env::join_paths`, de-duplicate with `HashSet<PathBuf>`, place unique shell
entries first, append inherited-only entries, and count shell entries absent
from the inherited set.

`select_shell` must accept only absolute `zsh`, `bash`, `fish`, `sh`, or `dash`
paths for which the supplied availability predicate returns true, then fall
back to `/bin/zsh` for macOS or `/bin/bash` for Linux.

- [ ] **Step 4: Run the pure desktop tests**

Run:

```bash
cargo test -p t4code-desktop shell_environment -- --nocapture
```

Expected: parsing, merge, selection, and platform tests pass.

- [ ] **Step 5: Commit the pure desktop environment model**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/shell_environment.rs
git commit -m "feat: model POSIX desktop PATH hydration"
```

### Task 3: Add the Bounded Shell Probe and Pre-Tauri Integration

**Files:**
- Modify: `apps/desktop/src-tauri/src/shell_environment.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:59-86`

**Interfaces:**
- Consumes: the selected login shell, inherited PATH, timeout, and output limit.
- Produces: a merged process PATH installed before `tauri::Builder::new`.
- Records: only success/failure category and added segment count.

- [ ] **Step 1: Add failing process-behavior tests**

Use temporary executable shell fixtures and add tests that assert:

```rust
fn write_executable(
    directory: &tempfile::TempDir,
    name: &str,
    contents: &str,
) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;

    let path = directory.path().join(name);
    std::fs::write(&path, contents).unwrap();
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&path, permissions).unwrap();
    path
}

#[test]
fn probe_accepts_noisy_successful_shell_output() {
    let directory = tempfile::TempDir::new().unwrap();
    let fixture = write_executable(
        &directory,
        "success-shell",
        "#!/bin/sh\nprintf 'banner\\n__T4CODE_PATH_START__/user/bin:/usr/bin\
__T4CODE_PATH_END__\\nlogout\\n'\n",
    );
    assert_eq!(
        probe_shell_path(&fixture, Duration::from_secs(1), 4096).unwrap(),
        OsString::from("/user/bin:/usr/bin")
    );
}

#[test]
fn probe_rejects_non_zero_and_oversized_output() {
    let directory = tempfile::TempDir::new().unwrap();
    let failing = write_executable(&directory, "failing-shell", "#!/bin/sh\nexit 7\n");
    assert_eq!(
        probe_shell_path(&failing, Duration::from_secs(1), 4096),
        Err(PathHydrationFailure::NonZeroExit)
    );

    let oversized = write_executable(
        &directory,
        "oversized-shell",
        "#!/bin/sh\nprintf '__T4CODE_PATH_START__';\
head -c 8192 /dev/zero;printf '__T4CODE_PATH_END__'\n",
    );
    assert_eq!(
        probe_shell_path(&oversized, Duration::from_secs(1), 128),
        Err(PathHydrationFailure::OutputTooLarge)
    );
}

#[test]
fn timeout_kills_and_reaps_shell_before_returning() {
    let directory = tempfile::TempDir::new().unwrap();
    let pid_path = directory.path().join("pid");
    let fixture = write_executable(
        &directory,
        "sleeping-shell",
        &format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec sleep 30\n",
            pid_path.display()
        ),
    );

    assert_eq!(
        probe_shell_path(&fixture, Duration::from_millis(100), 4096),
        Err(PathHydrationFailure::TimedOut)
    );
    let pid = std::fs::read_to_string(pid_path).unwrap();
    let alive = Command::new("/bin/kill")
        .args(["-0", pid.trim()])
        .status()
        .is_ok_and(|status| status.success());
    assert!(!alive, "timed-out shell process was not reaped");
}
```

Also test spawn failure with a removed fixture and verify that preparing a
hydrated PATH never mutates `std::env::PATH`.

- [ ] **Step 2: Run the process tests and verify the red state**

Run:

```bash
cargo test -p t4code-desktop shell_environment -- --nocapture
```

Expected: compilation fails because `probe_shell_path` and fixture helpers do
not exist.

- [ ] **Step 3: Implement bounded command execution**

Implement:

- `Command::new(shell).args(["-ilc", PATH_PROBE_COMMAND])`;
- null stdin/stderr and piped stdout;
- a reader thread that drains all stdout while retaining at most 256 KiB and
  setting `exceeded_limit` when more bytes arrive;
- a `try_wait` loop with a five-second production deadline;
- kill, wait, and reader join on timeout or wait failure;
- status validation before parsing;
- fixed-category errors without captured output.

The production probe command must be:

```rust
const PATH_PROBE_COMMAND: &str = concat!(
    "printf '%s' '__T4CODE_PATH_START__'; ",
    "command printenv PATH; ",
    "printf '%s' '__T4CODE_PATH_END__'"
);
```

Use this bounded reader and wait-loop structure:

```rust
#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

fn drain_stdout(
    mut stdout: std::process::ChildStdout,
    limit: usize,
) -> std::io::Result<CapturedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded_limit = false;
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        exceeded_limit |= retained < read;
    }
    Ok(CapturedOutput {
        bytes,
        exceeded_limit,
    })
}

fn stop_and_join(
    child: &mut std::process::Child,
    reader: std::thread::JoinHandle<std::io::Result<CapturedOutput>>,
) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
}

fn probe_shell_path(
    shell: &Path,
    timeout: Duration,
    output_limit: usize,
) -> Result<OsString, PathHydrationFailure> {
    let mut child = Command::new(shell)
        .args(["-ilc", PATH_PROBE_COMMAND])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| PathHydrationFailure::SpawnFailed)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(PathHydrationFailure::OutputReadFailed);
    };
    let reader = std::thread::spawn(move || drain_stdout(stdout, output_limit));
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                stop_and_join(&mut child, reader);
                return Err(PathHydrationFailure::TimedOut);
            }
            Ok(None) => {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Err(_) => {
                stop_and_join(&mut child, reader);
                return Err(PathHydrationFailure::WaitFailed);
            }
        }
    };

    let captured = reader
        .join()
        .map_err(|_| PathHydrationFailure::OutputReadFailed)?
        .map_err(|_| PathHydrationFailure::OutputReadFailed)?;
    if !status.success() {
        return Err(PathHydrationFailure::NonZeroExit);
    }
    parse_captured_path(&captured.bytes, captured.exceeded_limit)
}
```

- [ ] **Step 4: Implement startup hydration and privacy-safe reporting**

`hydrate_process_path` must:

1. return `Skipped` outside macOS/Linux;
2. select an available trusted shell;
3. probe and merge PATH;
4. update PATH in one documented unsafe block; and
5. return `Applied` or `Unchanged`.

Use this safety comment at the mutation boundary:

```rust
pub(crate) fn hydrate_process_path() -> PathHydrationReport {
    let Some(platform) = PosixPlatform::current() else {
        return PathHydrationReport::Skipped;
    };
    let configured_shell = std::env::var_os("SHELL");
    let Some(shell) = select_shell(
        configured_shell.as_deref(),
        platform,
        is_executable_file,
    ) else {
        return PathHydrationReport::Unchanged {
            reason: PathHydrationFailure::ShellUnavailable,
        };
    };
    let shell_path = match probe_shell_path(&shell, Duration::from_secs(5), 256 * 1024) {
        Ok(path) => path,
        Err(reason) => return PathHydrationReport::Unchanged { reason },
    };
    let inherited = std::env::var_os("PATH");
    let prepared = match merge_path_values(&shell_path, inherited.as_deref()) {
        Ok(prepared) => prepared,
        Err(reason) => return PathHydrationReport::Unchanged { reason },
    };

// SAFETY: `hydrate_process_path` is the first operation in `run`, before
// Tauri creates worker threads. The shell child and stdout reader are fully
// joined before this mutation, so no other thread in this process can read or
// write the environment concurrently.
    unsafe {
        std::env::set_var("PATH", &prepared.value);
    }
    PathHydrationReport::Applied {
        added_segments: prepared.added_segments,
    }
}
```

`PathHydrationReport::record` must log only `added_segments` or the fixed
failure enum.

Change `run()` to:

```rust
pub fn run() {
    let shell_path_hydration = shell_environment::hydrate_process_path();
    tauri::Builder::<bridge::DesktopRuntime>::new()
        // existing builder configuration
        .setup(move |app| {
            shell_path_hydration.record();
            // existing setup body
        })
        // existing build/run body
}
```

- [ ] **Step 5: Run targeted Rust tests and checks**

Run:

```bash
cargo test -p t4code-desktop shell_environment -- --nocapture
cargo test -p t4code-server executable_resolution -- --nocapture
cargo check -p t4code-desktop
```

Expected: all tests and the desktop check pass.

- [ ] **Step 6: Commit the bounded probe and startup integration**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/shell_environment.rs
git commit -m "fix: hydrate POSIX desktop shell PATH"
```

### Task 4: Repository Verification and Packaged macOS UI Test

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: the fixed source and local macOS provider installations.
- Produces: automated test evidence, a fresh arm64 DMG, and UI evidence that
  provider inventory and provider launch both work from a GUI-launched app.

- [ ] **Step 1: Run required automated verification**

Run:

```bash
./node_modules/.bin/vp check
./node_modules/.bin/vp run typecheck
./node_modules/.bin/vp test
./node_modules/.bin/vp run test
```

Expected: all commands exit 0.

- [ ] **Step 2: Build the arm64 macOS DMG**

Run:

```bash
./node_modules/.bin/vp run dist:desktop:dmg:arm64
```

Expected: a new `T4Code (Alpha)_0.2.2_aarch64.dmg` under
`release/desktop/mac-arm64/`.

- [ ] **Step 3: Replace the installed app safely**

Quit `T4Code (Alpha)`, mount the new DMG, preserve the current application as
`/Applications/T4Code (Alpha).app.pre-path-hydration`, copy the new app with
`ditto`, unmount the DMG, and launch it through Launch Services with:

```bash
open -a "T4Code (Alpha)"
```

If installation fails, restore the preserved application before continuing.

- [ ] **Step 4: Verify the GUI-launched process environment**

Read only the running app's PATH from `ps eww`. Confirm it contains the
login-shell entries needed for `/opt/homebrew/bin/codex` and
`~/.local/bin/claude` while retaining `/usr/bin` and `/bin`. Do not print any
other environment variables.

- [ ] **Step 5: Perform the provider UI test**

Use Computer Use against the installed app:

1. Open Settings and refresh provider status.
2. Confirm Codex and Claude no longer show **Provider executable was not
   found**.
3. Confirm persisted binary settings remain `codex` and `claude`, not absolute
   paths.
4. Create a disposable Codex thread in an existing test project.
5. Send `Reply with OK only.` and verify a response arrives.
6. Remove the disposable thread when practical.

- [ ] **Step 6: Review final scope**

Run:

```bash
git status --short
git diff --check
git log -6 --oneline
```

Expected: the task commits contain only provider resolver testability, the
desktop shell-environment module, startup integration, and design/plan
documentation. `apps/desktop/src-tauri/src/bridge.rs` remains an unrelated
unstaged modification.
