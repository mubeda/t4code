# Provider Shutdown Cleanup Report

## Scope

This correction is limited to the packaged-provider shutdown leak recorded in
Task 9. It changes the Unix desktop termination path and its desktop tests only:

- `apps/desktop/src-tauri/src/backend.rs`
- `apps/desktop/src-tauri/src/lib.rs`

It does not change process attribution, provider supervision, terminal
supervision, Task 9 documentation, or the dependency ledger.

Commit subject: `fix(desktop): clean providers on termination`.

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

All verification below ran after the final deferred-listener implementation:

- Focused termination tests: 2 passed, 0 failed.
- `cargo test -p t4code-desktop`: 166 unit tests passed, 1 bridge public
  contract test passed, 4 SSH public contract tests passed, and doc tests
  passed; no failures.
- `vp run build:desktop`: passed.
- `vp check`: passed; 1,543 files correctly formatted and no lint warnings or
  errors in 1,163 files.
- `vp run typecheck`: passed, including `cargo check -p t4code-desktop` and the
  repository TypeScript checks. Existing Effect schema suggestions were
  informational and did not fail the command.
- `git diff --check`: passed.

This report claims only the Unix desktop termination correction and its scoped
verification. It does not claim Windows/Linux packaged verification or
whole-feature completion.
