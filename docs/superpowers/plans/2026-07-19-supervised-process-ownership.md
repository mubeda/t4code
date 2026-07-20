# Supervised Process Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Git, shared-runner, and PTY process is owned before it
can create descendants and is killed and waited on along every post-spawn
failure path.

**Architecture:** Add a crate-internal supervised lifecycle engine that accepts
an already-configured Tokio command and owns spawn, pipes, stdin, output,
timeout, cancellation, and cleanup. Use process-wrap's built-in suspended
Windows Job Object for non-PTY commands. Patch a checked-in portable-pty 0.9.0
fork so ConPTY supplies `PROC_THREAD_ATTRIBUTE_JOB_LIST` to `CreateProcessW`.

**Tech Stack:** Rust 2024, Tokio, process-wrap 9.1.0, portable-pty 0.9.0,
windows-sys 0.61.2, Unix process groups, Windows Job Objects and ConPTY.

## Global Constraints

- `vp check` and `vp run typecheck` must pass.
- No production Node runtime, native helper sidecar, or post-spawn Job attach
  loop.
- Preserve Git's `PathBuf`/`OsString`, inherited environment, output, and
  public error behavior.
- Preserve the shared runner's public API and output behavior.
- Windows 10/11 is the supported Windows floor.
- Import the local dependency fork mechanically; author all changes with
  `apply_patch`.
- The local fork contains only build-required crate files, `LICENSE.md`, and
  `UPSTREAM.md`.

---

### Task 1: Import and document the portable-pty fork

**Files:**

- Create: `third_party/portable-pty/Cargo.toml`
- Create: `third_party/portable-pty/LICENSE.md`
- Create: `third_party/portable-pty/src/**`
- Create: `third_party/portable-pty/UPSTREAM.md`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`

**Interfaces:**

- Produces: a local crate still named `portable-pty` at version `0.9.0`.
- Produces: `[patch.crates-io] portable-pty = { path = "third_party/portable-pty" }`.

- [x] **Step 1: Mechanically copy build-required upstream files**

Copy the normalized upstream `Cargo.toml`, `LICENSE.md`, and `src/` directory
from Cargo's verified portable-pty 0.9.0 registry source.

- [x] **Step 2: Record provenance**

Add `UPSTREAM.md` containing version `0.9.0`, crates.io source, the registry
checksum from `Cargo.lock`, imported file inventory, the JOB_LIST-only
deviation, update commands, and removal condition.

- [x] **Step 3: Patch workspace resolution**

```toml
[patch.crates-io]
portable-pty = { path = "third_party/portable-pty" }
```

- [x] **Step 4: Verify the untouched fork builds**

Run:

```bash
cargo check -p t4code-server --lib
```

Expected: exit 0 with Cargo resolving `portable-pty` from `third_party`.

### Task 2: Make non-PTY background assignment race-free

**Files:**

- Modify: `apps/server/src/process/background.rs`
- Modify: `apps/server/src/process/windows_job.rs`
- Test: `apps/server/src/process/background.rs`
- Test: `apps/server/tests/windows_background_process.rs`

**Interfaces:**

- Produces:
  `configure_supervised_background_command_wrap(&mut CommandWrap)`.
- Windows implementation wraps `CreationFlags(CREATE_NO_WINDOW)`,
  `KillOnDrop`, then `process_wrap::tokio::JobObject`.
- `windows_job.rs` retains only the standalone Job handle needed by PTY.

- [x] **Step 1: Write the Windows wrapper test**

Assert the configured command retains no-console behavior while a fixture
process is suspended, assigned to a Job, resumed, and killed as a tree.

- [x] **Step 2: Run the target-gated test to establish RED**

On Windows:

```bash
cargo test -p t4code-server --test windows_background_process -- --nocapture
```

Expected before implementation: the immediate child can create a descendant
before custom `BackgroundJob::post_spawn` assigns the Job.

- [x] **Step 3: Replace the custom wrapper**

```rust
command.wrap(KillOnDrop);
#[cfg(windows)]
command.wrap(process_wrap::tokio::JobObject);
#[cfg(unix)]
command.wrap(ProcessGroup::leader());
```

Delete `BackgroundJob` and `BackgroundJobChild`; keep the PTY Job handle.

- [x] **Step 4: Cross-compile the exact wrapper API**

Compile a minimal Windows-target harness containing the exact wrapper order.
Expected: exit 0 for `x86_64-pc-windows-msvc`.

### Task 3: Add the shared supervised lifecycle engine

**Files:**

- Create: `apps/server/src/process/supervised.rs`
- Modify: `apps/server/src/process/mod.rs`
- Test: `apps/server/src/process/supervised.rs`

**Interfaces:**

- Produces:

```rust
pub(crate) struct SupervisedRunRequest {
    pub(crate) command: tokio::process::Command,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) timeout: Duration,
    pub(crate) max_output_bytes: usize,
    pub(crate) overflow: SupervisedOverflow,
}

pub(crate) async fn run_supervised(
    request: SupervisedRunRequest,
    cancellation: &CancellationToken,
) -> Result<SupervisedRunOutput, SupervisedRunError>;
```

- `SupervisedRunOutput` carries `ExitStatus` and retained/observed bytes for
  both streams.
- `SupervisedRunError` distinguishes spawn, missing pipe, stdin, read,
  output-limit, timeout, cancellation, and wait failures.
- Every error after spawn calls `terminate_and_wait`; cleanup failures are
  bounded and logged without replacing the primary error.

- [x] **Step 1: Write failing cleanup tests**

Add tests proving:

1. a missing required stream calls both `start_kill` and `wait`;
2. a failed `start_kill` still calls `wait`;
3. stdin failure calls cleanup before returning;
4. cleanup error strings and counts are bounded.

- [x] **Step 2: Run focused tests and capture RED**

```bash
cargo test -p t4code-server --lib process::supervised::tests -- --nocapture
```

Expected: compile failure because the lifecycle types and function do not
exist.

- [x] **Step 3: Implement one selected execution future**

Acquire required pipes, write/shutdown stdin concurrently with stdout/stderr
collection and child wait, and put that complete future under the timeout and
cancellation select. Route all non-success outcomes through
`terminate_and_wait`.

- [x] **Step 4: Add Windows spawn failure guarding**

Use `CommandWrap::spawn_with` to duplicate the raw process handle after the
suspended spawn. If a later process-wrap hook fails, terminate and bounded-wait
that duplicate before returning the spawn error. Disarm the guard on success.

- [x] **Step 5: Run focused tests and capture GREEN**

Run the Step 2 command. Expected: all supervised lifecycle tests pass.

### Task 4: Migrate the shared runner

**Files:**

- Modify: `apps/server/src/process/runner.rs`
- Test: `apps/server/src/process/runner.rs`
- Test: `apps/server/tests/process_runner.rs`

**Interfaces:**

- Consumes: `run_supervised`, `SupervisedRunRequest`, and
  `SupervisedRunError`.
- Preserves: `ProcessRunInput`, `ProcessRunOutput`, and public `ProcessError`.

- [x] **Step 1: Extend real process-tree regressions**

Extend the fixture to three levels: leader, child, and grandchild. Assert
cancellation and timeout leave no survival sentinel.

- [x] **Step 2: Add a real broken-stdin regression**

Launch a fixture that creates child and grandchild, closes stdin, and remains
alive. Write a payload larger than pipe capacity. Assert `ProcessError::Stdin`
and no survival sentinel.

- [x] **Step 3: Run tests and capture RED**

```bash
cargo test -p t4code-server --test process_runner -- --nocapture
```

Expected: the post-spawn stdin error can return before tree cleanup.

- [x] **Step 4: Map shared lifecycle results**

Build the Tokio command exactly as today, invoke `run_supervised`, map internal
failures to existing public errors, and preserve truncation marker and timeout
result behavior.

- [x] **Step 5: Run tests and capture GREEN**

Run the Step 3 command. Expected: all process-runner tests pass.

### Task 5: Migrate the Git runner

**Files:**

- Modify: `apps/server/src/git/process.rs`
- Test: `apps/server/tests/git_coverage.rs`
- Test: `apps/server/tests/git_rpc.rs`

**Interfaces:**

- Consumes: the same supervised lifecycle engine.
- Preserves: Git `ProcessRequest`, `ProcessOutput`, and `ProcessError`.

- [x] **Step 1: Add a real Git-runner tree cancellation regression**

Use the existing test executable fixture to launch leader, child, and
grandchild, wait for readiness, cancel, release possible survivors, and assert
all survival sentinels remain absent.

- [x] **Step 2: Run the regression and capture RED**

```bash
cargo test -p t4code-server --test git_coverage process_runner_cancellation_kills_child_and_grandchild -- --nocapture
```

Expected: the root exits while a descendant writes its survival sentinel.

- [x] **Step 3: Replace the duplicate lifecycle**

Keep Git command construction and public rendering/error mapping in
`git/process.rs`; delegate spawn, pipes, stdin, bounded collection,
timeout/cancellation, kill, and wait to `run_supervised`.

- [x] **Step 4: Run Git suites and capture GREEN**

```bash
cargo test -p t4code-server --test git_coverage -- --nocapture
cargo test -p t4code-server --test git_rpc -- --nocapture
```

Expected: both suites pass.

### Task 6: Assign ConPTY children to a Job at creation

**Files:**

- Modify: `third_party/portable-pty/src/cmdbuilder.rs`
- Modify: `third_party/portable-pty/src/win/procthreadattr.rs`
- Modify: `third_party/portable-pty/src/win/psuedocon.rs`
- Modify: `apps/server/src/process/windows_job.rs`
- Modify: `apps/server/src/terminal/pty.rs`
- Test: `apps/server/src/terminal/pty.rs`
- Test: `apps/server/tests/fixtures/task8-harness/tests/task8.rs`

**Interfaces:**

- Produces on Windows:

```rust
CommandBuilder::job_list(&[std::os::windows::io::RawHandle])
```

- portable-pty builds an attribute list with both
  `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` and
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
- T4 creates a configured kill-on-close Job before `spawn_command`, passes its
  handle, and owns it in `PortablePtyProcess`.

- [x] **Step 1: Add target-gated at-creation tests**

Add a Windows fixture whose first instruction opens a uniquely named test Job
and calls `IsProcessInJob`. Assert it reports membership. Add child/grandchild
termination and injected post-spawn initialization failure tests.

- [x] **Step 2: Run on Windows and capture RED**

```bash
cargo test -p t4code-server terminal::pty::tests -- --nocapture
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml -- --nocapture
```

Expected: current post-spawn attach cannot guarantee first-instruction
membership, and attach failure does not wait.

- [x] **Step 3: Patch the local fork**

Store a Windows-only list of raw Job handles in `CommandBuilder`, allocate an
attribute list of capacity two, and add JOB_LIST before `CreateProcessW`.

- [x] **Step 4: Make PTY initialization transactional**

Create/configure the Job before spawn. On every error after child creation,
terminate the Job, attempt root kill as fallback, call `child.wait`, aggregate
bounded cleanup errors, then return the primary initialization error.

- [x] **Step 5: Cross-compile the exact fork/API**

Compile a minimal Windows-target harness importing the local fork and using the
new `job_list` API. Expected: exit 0.

- [x] **Step 6: Run available PTY tests**

Run PTY and terminal tests on macOS/Linux. Record that packaged Windows runtime
verification is deferred to Task 9.

### Task 7: Full verification, report, and commit

**Files:**

- Modify: `.superpowers/sdd/task-6-report.md`

- [x] **Step 1: Run ownership suites**

```bash
cargo test -p t4code-server --lib process:: -- --nocapture
cargo test -p t4code-server --test process_runner -- --nocapture
cargo test -p t4code-server --test git_coverage -- --nocapture
cargo test -p t4code-server --test git_rpc -- --nocapture
cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
cargo test -p t4code-server --lib terminal::manager::tests -- --nocapture
cargo test -p t4code-server --lib production::provider_runtime::tests -- --nocapture
```

Expected: all pass with zero failures or hangs.

- [x] **Step 2: Run repository gates**

```bash
cargo fmt --all -- --check
vp check
vp run typecheck
git diff --check
```

Expected: all exit 0.

- [x] **Step 3: Append evidence**

Record every RED/GREEN cycle, the local fork provenance, target-gated Windows
tests, exact cross-compile evidence, packaged-runtime Task 9 deferral, and gate
output in `.superpowers/sdd/task-6-report.md`.

- [x] **Step 4: Commit one focused correction**

```bash
git add Cargo.toml Cargo.lock apps/server third_party/portable-pty docs/superpowers/plans/2026-07-19-supervised-process-ownership.md
git commit -m "fix(process): guarantee supervised child ownership"
```
