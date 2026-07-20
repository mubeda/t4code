# PTY Process-Tree Ownership Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Windows PTY targets and Unix post-spawn failures from leaving descendants outside terminal lifecycle ownership.

**Architecture:** Prepare the real Windows target command first, then place every PTY target behind one same-binary ready/authorization trampoline whose root is job-owned before user code runs. Extend the uncommitted child guard to own the Unix process group or Windows job until successful `PortablePtyProcess` construction.

**Tech Stack:** Rust 2024, `portable-pty`, Win32 job/event APIs, Unix process groups, Cargo tests, Vite+ repository gates.

## Global Constraints

- Keep provider commands as structured executable and argument values.
- Do not fork or patch `portable-pty`.
- Do not change terminal RPC contracts or non-PTY provider command semantics.
- Use real process descendants for lifecycle regressions.
- `vp check`, `vp run typecheck`, and `vp test` must pass.

---

### Task 1: Gate every Windows PTY target

**Files:**
- Modify: `apps/server/src/process/executable.rs`
- Modify: `apps/server/src/process/mod.rs`
- Modify: `apps/server/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/server/src/terminal/pty.rs`

**Interfaces:**
- Produces: `WINDOWS_PTY_TRAMPOLINE_ARG: &str`
- Produces: `run_windows_pty_trampoline() -> Option<i32>`
- Produces: `wrap_windows_pty_launch(PreparedLaunch, &Path, &OsStr, &OsStr) -> PreparedLaunch`
- Produces: `WindowsPtyLaunchGate`
- Consumes: existing `wrap_launch_program(...).prepare(...)` target preparation

- [ ] **Step 1: Write failing host-independent construction tests**

Change the PowerShell expectation and add a native executable case in
`terminal::pty::tests` so both require:

```rust
let expected = std::iter::once(trampoline.clone().into_os_string())
    .chain(
        [
            crate::process::WINDOWS_PTY_TRAMPOLINE_ARG,
            gate_name.to_str().unwrap(),
            ready_name.to_str().unwrap(),
            target_program.to_str().unwrap(),
        ]
        .map(std::ffi::OsString::from),
    )
    .chain(target_arguments)
    .collect::<Vec<_>>();
assert_eq!(command.get_argv(), &expected);
```

For `.ps1`, `target_program` is `powershell.exe` and `target_arguments` begins
with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`.
For native launch, `target_program` is the resolved `.exe` and target arguments
are unchanged.

- [ ] **Step 2: Run the construction tests and record RED**

Run:

```bash
cargo test -p t4code-server --lib \
  terminal::pty::tests::windows_pty_launch_discovers_and_wraps_powershell_shims \
  -- --exact
cargo test -p t4code-server --lib \
  terminal::pty::tests::windows_pty_launch_gates_native_executables \
  -- --exact
```

Expected: PowerShell reports direct `powershell.exe` argv instead of trampoline
argv; the new native test reports direct executable argv or fails to compile
because the generic trampoline helper is absent.

- [ ] **Step 3: Generalize target preparation and trampoline protocol**

In `process/executable.rs`, prepare batch, PowerShell, and native targets first,
then provide a generic wrapper:

```rust
pub const WINDOWS_PTY_TRAMPOLINE_ARG: &str =
    "--t4code-internal-windows-pty-trampoline";

pub(crate) fn wrap_windows_pty_launch(
    target: PreparedLaunch,
    trampoline: &Path,
    gate_name: &OsStr,
    ready_name: &OsStr,
) -> PreparedLaunch {
    PreparedLaunch {
        program: trampoline.to_path_buf(),
        args: [
            OsString::from(WINDOWS_PTY_TRAMPOLINE_ARG),
            gate_name.to_owned(),
            ready_name.to_owned(),
            target.program.into_os_string(),
        ]
        .into_iter()
        .chain(target.args)
        .collect(),
    }
}
```

Rename the entrypoint helper to `run_windows_pty_trampoline`. After the ready
event and authorization wait, run the parsed target program with the remaining
structured arguments through `std::process::Command`.

In `terminal/pty.rs`, create a `WindowsPtyLaunchGate` for every Windows PTY,
prepare the real target with `wrap_launch_program`, wrap that `PreparedLaunch`
with `wrap_windows_pty_launch`, and store the gate in `PreparedPtyCommand`.
Rename the Windows integration constructor to
`spawn_with_windows_pty_trampoline`.

Update both application entrypoints and process-module exports to the generic PTY
names. Rename `WindowsBatchLaunchGate` to `WindowsPtyLaunchGate` in
`process/windows_job.rs` without changing its two-event behavior.

- [ ] **Step 4: Run focused tests and record GREEN**

Run:

```bash
cargo test -p t4code-server --lib terminal::pty::tests
```

Expected: all PTY unit tests pass, including exact `.cmd`/`.bat`, `.ps1`, and
native trampoline argv.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/server/src/process/executable.rs \
  apps/server/src/process/mod.rs \
  apps/server/src/process/windows_job.rs \
  apps/server/src/main.rs \
  apps/desktop/src-tauri/src/main.rs \
  apps/server/src/terminal/pty.rs
git commit -m "fix(server): gate every Windows PTY launch"
```

### Task 2: Make post-spawn setup guard own the process tree

**Files:**
- Modify: `apps/server/src/process/windows_job.rs`
- Modify: `apps/server/src/terminal/pty.rs`

**Interfaces:**
- Consumes: `WindowsJob` and Unix `MasterPty::process_group_leader`
- Produces: `SpawnedChildGuard` ownership transfer to `PortablePtyProcess`

- [ ] **Step 1: Write the failing Unix descendant cleanup regression**

Add a `#[cfg(unix)]` test that opens a real PTY, launches a shell whose descendant
ignores `SIGHUP`, writes its PID to a temporary file, then forces setup cleanup by
dropping the guard:

```rust
let pair = native_pty_system().openpty(PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
})?;
let mut command = CommandBuilder::new("/bin/sh");
command.args([
    "-c",
    "trap '' HUP; /bin/sh -c 'trap \"\" HUP; echo $$ > \"$T4CODE_CHILD_PID\"; exec sleep 30' & wait",
]);
command.env("T4CODE_CHILD_PID", child_pid_file.as_os_str());
let child = pair.slave.spawn_command(command)?;
let process_group = pair.master.process_group_leader();
let guard = SpawnedChildGuard::new(child, process_group);
wait_for_pid_file(&child_pid_file);
drop(guard);
assert_process_exits(child_pid);
```

The assertion must kill the leaked fixture before panicking so the RED run does
not leave a process behind.

- [ ] **Step 2: Run the Unix regression and record RED**

Run:

```bash
cargo test -p t4code-server --lib \
  terminal::pty::tests::setup_failure_kills_the_unix_process_group \
  -- --exact --nocapture
```

Expected: fail because the existing guard owns/kills only the root child (or
compile RED because it has no process-group constructor).

- [ ] **Step 3: Add early tree ownership and transfer**

On Unix, construct `SpawnedChildGuard` with
`pair.master.process_group_leader()` immediately after `spawn_command`, before
PID/reader/writer/thread setup. Its `Drop` calls a shared
`kill_unix_process_group` helper before root `child.kill()`.

On Windows, attach the job, transfer it into the guard, and only then signal the
launch gate. Guard drop terminates the job before root cleanup.

Expose guard operations with platform-specific signatures:

```rust
#[cfg(unix)]
fn new(
    child: Box<dyn portable_pty::Child + Send + Sync>,
    process_group: Option<i32>,
) -> Self;

#[cfg(windows)]
fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self;

fn take_child(&mut self) -> Box<dyn portable_pty::Child + Send + Sync>;

#[cfg(unix)]
fn commit_process_group(mut self) -> Option<i32>;

#[cfg(windows)]
fn own_job(&mut self, job: WindowsJob);

#[cfg(windows)]
fn commit_job(mut self) -> Result<WindowsJob, String>;
```

Take the child only for the successfully created wait-thread closure. Commit the
process group/job only after that thread starts and immediately move the token
into `PortablePtyProcess`.

- [ ] **Step 4: Run guard and PTY suites and record GREEN**

Run:

```bash
cargo test -p t4code-server --lib \
  terminal::pty::tests::setup_failure_kills_the_unix_process_group \
  -- --exact --nocapture
cargo test -p t4code-server --lib terminal::pty::tests
```

Expected: the real descendant exits and the full PTY suite passes.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/server/src/process/windows_job.rs apps/server/src/terminal/pty.rs
git commit -m "fix(server): own PTY trees during spawn setup"
```

### Task 3: Add Windows real-process regressions and finish verification

**Files:**
- Modify: `apps/server/tests/windows_terminal_shims.rs`
- Modify: `.superpowers/sdd/final-review-fix-report.md`

**Interfaces:**
- Consumes: `PortablePtyBackend::spawn_with_windows_pty_trampoline`
- Produces: Windows `.ps1` and native descendant cleanup evidence

- [ ] **Step 1: Add Windows-only `.ps1` and native descendant tests**

Extract a helper that spawns a PTY, waits for the descendant PID file, subscribes
to exit, kills the terminal, and requires the descendant handle to signal:

```rust
async fn assert_terminal_kills_descendant(
    input: PtySpawnInput,
    child_pid_file: &Path,
) {
    let process = PortablePtyBackend
        .spawn_with_windows_pty_trampoline(
            &input,
            Path::new(env!("CARGO_BIN_EXE_t4code")),
        )
        .unwrap();
    wait_for_file(&child_pid_file).await;
    let child_pid = std::fs::read_to_string(child_pid_file)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    let mut exit = process.subscribe_exit();
    process.kill().unwrap();
    if exit.borrow().is_none() {
        tokio::time::timeout(Duration::from_secs(10), exit.changed())
            .await
            .unwrap()
            .unwrap();
    }
    let child = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child_pid) };
    if child.is_null() {
        assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_PARAMETER);
        return;
    }
    let child = OwnedHandle(child);
    assert_eq!(
        unsafe { WaitForSingleObject(child.0, 10_000) },
        WAIT_OBJECT_0,
        "PTY descendant survived terminal kill"
    );
}
```

The `.ps1` test starts a child PowerShell process and waits for it. The native test
launches `powershell.exe` directly with a command that starts and waits for a
second PowerShell process. Both descendants write their own PID through
`T4CODE_TEST_CHILD_PID`.

- [ ] **Step 2: Cross-typecheck the actual Windows modules**

Use a temporary ignored crate that imports the production executable,
Windows-job, and PTY modules, then run:

```toml
[package]
name = "t4code-windows-module-check"
version = "0.0.0"
edition = "2024"

[dependencies]
portable-pty = "0.9.0"
process-wrap = { version = "9.1.0", features = ["tokio1"] }
tokio = { version = "1.53.0", features = ["process", "sync"] }
tracing = "0.1.44"
uuid = { version = "1.24.0", features = ["v4"] }
windows = { version = "0.62.2", features = ["Win32_System_Threading"] }
windows-sys = { version = "0.61.2", features = [
  "Win32_Foundation",
  "Win32_System_Diagnostics_ToolHelp",
  "Win32_System_JobObjects",
  "Win32_System_Threading",
] }

[workspace]
```

Its `src/lib.rs` defines the two-value `Platform` enum with `current()` returning
`Windows`, imports the three production files through absolute `#[path]`
attributes, and re-exports the process symbols consumed by `terminal/pty.rs`.
Then run:

```bash
RUSTC="$(rustup which --toolchain 1.97.1 rustc)" \
  rustup run 1.97.1 cargo check --offline \
  --target x86_64-pc-windows-msvc
```

Expected: PASS. Remove the temporary crate and all generated artifacts.

- [ ] **Step 3: Run final host verification**

Run:

```bash
cargo test -p t4code-server --lib --no-fail-fast
cargo test -p t4code-server --test production_server_terminal_rpc
cargo clippy -p t4code-server --all-targets -- -D warnings
cargo check -p t4code-desktop
vp test
vp check
vp run typecheck
git diff --check
```

Expected: all commands exit zero. Record exact test counts.

- [ ] **Step 4: Re-review lifecycle invariants**

Verify:

- no Windows PTY target program appears before the trampoline gate;
- the gate is signaled only after the guard owns the Windows job;
- Unix process-group ownership is captured before fallible setup;
- every guard failure kills the tree before the root;
- successful transfer leaves exactly one process-tree owner.

Expected: no Critical or Important findings remain.

- [ ] **Step 5: Update report and commit**

Update `.superpowers/sdd/final-review-fix-report.md` with RED/GREEN evidence,
commits, final counts, review outcome, and the macOS caveat that Windows
real-process tests were compiled but not executed.

```bash
git add apps/server/tests/windows_terminal_shims.rs
git add -f .superpowers/sdd/final-review-fix-report.md
git commit -m "test(server): cover PTY descendant ownership"
```
