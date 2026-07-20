# Provider Shutdown Cleanup Report

## Scope

This correction is limited to the packaged-provider shutdown leak recorded in
Task 9. It changes the Unix desktop termination path, its desktop tests, and the
Task 9 resolution note:

- `apps/desktop/src-tauri/src/backend.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `.superpowers/sdd/task-9-report.md`

It does not change process attribution, provider supervision, terminal
supervision, or the dependency ledger.

Initial commit: `64c9633626` (`fix(desktop): clean providers on termination`).
Concurrency correction commit subject:
`fix(desktop): coordinate backend shutdown races`.

## Root Cause

The working interactive Tauri exit path handles `RunEvent::ExitRequested`,
awaits `BackendSupervisor::stop`, and therefore reaches the in-process server's
normal shutdown path. `ProductionRuntime::shutdown` then shuts down providers
and terminals. Their existing supervised-process wrappers own Unix process
groups (and Windows jobs) and kill them on drop.

The failing Task 9 check used `SIGTERM`. The Unix desktop process did not
intercept that signal, so the operating system terminated it before Tauri's
`ExitRequested` path ran. POSIX termination does not run Rust destructors.
Consequently, neither the managed server shutdown nor provider `KillOnDrop`
cleanup ran. The Task 9 app PID `80100` and port 3773 disappeared while fixture
provider PID `86600` and child PID `86625` survived for more than ten seconds.

The fix installs a Unix termination listener through Tauri's async runtime.
After `SIGTERM`, it awaits the existing `BackendSupervisor::stop` path and only
then asks Tauri to exit. This preserves one shutdown implementation instead of
duplicating provider or terminal cleanup in the signal handler.

## TDD and Debugging Evidence

The first RED test,
`termination_waits_for_in_process_backend_cleanup_before_exit`, injects a real
managed in-process server and a controllable termination future. It asserts
that:

1. exit is not requested before termination;
2. backend state is drained after termination;
3. the in-process server port is closed before exit is requested.

Before production code existed, the focused test failed to compile with
`E0425`, because `shutdown_backend_after_termination` did not exist.

The first implementation created Tokio's Unix signal receiver synchronously
during Tauri setup. Its focused ordering test passed, but the release executable
then panicked at startup in `backend.rs`:

```text
there is no reactor running, must be called from the context of a Tokio 1.x runtime
```

That result invalidated the implementation. A second RED test,
`termination_signal_listener_can_be_created_without_tokio_reactor`, was added.
It initially failed with `E0425` because the deferred
`wait_for_termination_signal` future did not yet exist.

The corrected implementation constructs the signal receiver only when the
future is polled inside `tauri::async_runtime`. Both focused tests then passed.
Signal-registration or closed-stream failures are logged and leave the handler
pending rather than causing an unsolicited application exit.

## Concurrency Review Correction

Review of the initial correction exposed two additional races:

1. `BackendSupervisor::stop` removed and cleared all backend slots before
   awaiting cleanup. A concurrent `ExitRequested` or SIGTERM stop therefore saw
   an empty supervisor and returned, allowing Tauri to exit while the first
   cleanup was still running.
2. `start_with_options_inner` completed backend startup before acquiring the
   supervisor state lock. A stop could finish during that await, after which
   the late start unconditionally published a new live backend.

The deterministic RED test
`concurrent_stop_callers_wait_for_the_same_cleanup_completion` blocks the first
cleanup on the runtime result mutex, starts a second terminal stop, and proves
the second returned early. It failed with:

```text
a concurrent stop must wait for the cleanup already in progress
```

The supervisor now stores one shared, cloneable shutdown-result receiver.
The first caller owns a detached cleanup operation; every concurrent caller
waits for the same result, including cleanup failures. Lifecycle state changes
to Stopped or Terminated only after cleanup completes, and no standard mutex is
held across an await.

The deterministic RED test
`start_racing_stop_cleans_late_backend_without_publishing_it` uses a
`cfg(test)`-only oneshot gate after a real in-process backend reaches readiness
and before it is published. Stop completes while startup is gated. Before the
fix, releasing the gate returned `Ok(BackendRunConfig)` and published the
backend after shutdown.

Each start now captures an active lifecycle epoch before launch. Publication is
atomic under the state lock and succeeds only if that epoch is still active. A
late backend is shut down before the start returns an error. A completed normal
stop permits a later explicit start to open a new epoch; automatic restarts do
not reopen a stopped lifecycle. Terminal stops used by both SIGTERM and
`ExitRequested` remain terminal, so an early SIGTERM also rejects a not-yet
started desktop backend.

Additional passing coverage verifies:

- a normal explicit start after completed stop opens a reachable new lifecycle;
- an early terminal stop rejects a late startup before it launches;
- concurrent terminal callers share the exact same cleanup error;
- the existing termination helper waits for server cleanup before requesting
  exit.

## Release and Live Process Evidence

`vp run build:desktop` succeeded after the final correction. The direct release
executable and bundled app executable were byte-identical:

```text
d51cd09286cd17a1b76b2cdde799c71a24cf4eb955987200acf36145a5d5865b
```

A direct isolated release launch used desktop PID `32769`, owned port 3773, and
reached readiness. I deliberately sent `SIGTERM` to that exact PID. It exited
with code 0; the exact PID and port 3773 were absent afterward.

One Computer Use launch by bundle path was ambiguous and created a separate
desktop PID `33630` on port 3775. Despite the intended fixture environment,
that instance resolved the real installed Codex provider. A local prompt
(`Run the local resource attribution fixture.`) was accidentally submitted to
that real provider. The turn was stopped immediately after the mismatch was
recognized, at about 47 seconds. This run is not represented as a fixture or
zero-network check.

The ambiguous instance still supplied the live provider-tree shutdown proof:
after sending `SIGTERM` only to desktop PID `33630`, the desktop, provider PIDs
`42216` and `43498`, and port 3775 were absent within the approximately
3.5-second polling window. The user's separately installed T4Code PID `13930`
remained alive and was not signaled. No further packaged UI launch was made.

Final cleanup polling confirmed:

- desktop PIDs `32769` and `33630` absent;
- provider PIDs `42216` and `43498` absent;
- ports 3773 and 3775 closed;
- unrelated installed T4Code PID `13930` still alive.

## Verification

The release build and live process evidence below ran after the deferred-listener
implementation in `64c9633626`; no packaged UI was launched during the
concurrency review correction.

- Focused shutdown/lifecycle tests: 6 passed, 0 failed.
- `cargo test -p t4code-desktop`: 170 unit tests passed, 1 bridge public
  contract test passed, 4 SSH public contract tests passed, and doc tests
  passed; no failures.
- `vp run build:desktop`: passed.
- `vp check`: passed; 1,543 files correctly formatted and no lint warnings or
  errors in 1,163 files.
- `vp run typecheck`: passed, including `cargo check -p t4code-desktop` and the
  repository TypeScript checks. Existing Effect schema suggestions were
  informational and did not fail the command.
- `git diff --check`: passed.

After the concurrency correction, the full desktop suite, `vp check`,
`vp run typecheck`, and `git diff --check` were rerun with the results above.
The packaged application was not launched again.

This report claims only the Unix desktop termination correction and its scoped
verification. It does not claim Windows/Linux packaged verification or
whole-feature completion.
