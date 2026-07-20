# Bounded Process Cleanup Correction Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that cleanup returns within a fixed deadline even when
both ownership-unit termination and direct-root termination fail.

**Architecture:** Keep the existing process ownership units. Add a bounded
async wait with direct-root fallback to the process-wrap lifecycle, and replace
blocking PTY cleanup waits with bounded `try_wait` polling. Correct the local
portable-pty Windows kill-result propagation so fallback failures are visible.

**Tech Stack:** Rust 2024, Tokio, process-wrap 9.1.0, portable-pty 0.9.0,
Unix process groups, Windows Job Objects.

## Global Constraints

- Preserve the primary spawn/read/stdin/timeout/cancellation/initialization
  error; cleanup errors remain secondary and bounded.
- Do not add a helper process or production Node runtime.
- `vp check` and `vp run typecheck` must pass.
- Packaged Windows runtime verification remains deferred to Task 9.

---

### Task 1: Bound process-wrap cleanup

**Files:**

- Modify: `apps/server/src/process/supervised.rs`
- Modify: `apps/server/src/production/provider_inventory.rs`
- Test: `apps/server/src/process/supervised.rs`

**Interfaces:**

- Produces: `terminate_and_wait` with ownership-unit kill, direct-root fallback,
  and a bounded wait.
- Consumes: `ChildWrapper::inner_mut` to reach the root child only after the
  ownership-unit kill fails.

- [x] **Step 1: Add a real live-child RED regression**

Launch the current test executable as a non-exiting fixture, inject failures
for both kill attempts, and guard cleanup with a three-second test timeout.

- [x] **Step 2: Run RED**

```bash
cargo test -p t4code-server --lib process::supervised::tests::live_child_with_failed_owner_and_root_kills_returns_bounded_report -- --nocapture
```

Expected before the fix: failure at the outer three-second timeout.

- [x] **Step 3: Implement bounded cleanup**

Record ownership kill, root fallback, and `tokio::time::timeout` wait results in
`ProcessCleanupReport`. Reuse it for the provider-inventory process-wrap path.

- [x] **Step 4: Run GREEN**

Run the Step 2 command and the full `process::supervised::tests` module.

### Task 2: Bound PTY initialization cleanup

**Files:**

- Modify: `apps/server/src/terminal/pty.rs`
- Modify: `third_party/portable-pty/src/win/mod.rs`
- Modify: `third_party/portable-pty/UPSTREAM.md`
- Test: `apps/server/src/terminal/pty.rs`

**Interfaces:**

- Produces: bounded `portable_pty::Child::try_wait` polling after every
  Job/process-group/root termination sequence.
- Produces: correct Win32 `TerminateProcess` result propagation.

- [x] **Step 1: Add a real live-child RED regression**

Spawn a real portable-pty child, inject root kill failure, and prove current
initialization cleanup misses a three-second deadline while preserving the
primary error string.

- [x] **Step 2: Run RED**

```bash
cargo test -p t4code-server --lib terminal::pty::tests::failed_live_pty_kill_cannot_block_initialization_cleanup -- --nocapture
```

Expected before the fix: failure at the outer three-second timeout.

- [x] **Step 3: Implement bounded polling and accurate Windows kill errors**

Poll `try_wait` until exit, error, or a fixed deadline. Never call blocking
`Child::wait` in initialization cleanup. Make both WinChild killer
implementations return `Err(last_os_error())` only when `TerminateProcess`
returns zero.

- [x] **Step 4: Run GREEN**

Run the Step 2 command, PTY tests, Task 8 harness tests, and the exact Windows
target compile.

### Task 3: Verify and commit

**Files:**

- Modify: `.superpowers/sdd/task-6-report.md`

- [x] **Step 1: Run focused ownership suites**

Run process, runner, Git, PTY, terminal-manager, and provider-runtime suites.

- [x] **Step 2: Run repository gates**

```bash
cargo fmt --all -- --check
vp check
vp run typecheck
git diff --check
```

- [x] **Step 3: Append RED/GREEN and platform evidence**

Record the two deterministic RED failures, focused GREEN results, exact
Windows compile, full gate output, and Task 9 packaged-runtime deferral.

- [x] **Step 4: Commit only this correction**

```bash
git commit -m "fix(process): bound failed termination cleanup"
```
