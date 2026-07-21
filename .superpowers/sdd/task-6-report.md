# Task 6 Report: Atomic RPC Contract and Signal Revalidation

## Status

Implemented Task 6 on base `e821ffe98c`.

- Replaced the legacy process diagnostics wire contract with attributed
  Core/External totals, attribution metadata, UI coverage, split history
  metrics, and complete history process summaries.
- Added generated TypeScript-to-Rust wire fixtures for current diagnostics,
  resource history, and identity-bound signaling.
- Changed signaling from PID-only authorization to `{ pid, processKey,
  signal }` revalidation against one fresh native row scan, the current
  attribution pass, exact process identity, and current server ancestry.
- Kept the native platform signal primitive private to diagnostics and added a
  final target-specific identity refresh immediately before the platform
  signal.
- Applied the smallest web compatibility update required by the atomic
  contract switch. Existing combined-value presentation remains in place;
  split Core/External UI work is intentionally left for later tasks.

Source commit:

```text
0f78c77f27 feat(contracts): expose attributed resource diagnostics
```

## TDD Evidence

### RED: attributed TypeScript contract

Command:

```text
vp test packages/contracts/src/rpcRustParity.test.ts
```

Exit: `1`.

The new attributed diagnostics fixture decode failed against the legacy shape:

```text
SchemaError(Missing key at ["processCount"])
```

### RED: attributed Rust wire mapping

Command:

```text
cargo test -p t4code-server production::server_terminal::tests::attributed_current_wire_maps_every_variant_and_bounds_failures -- --nocapture
```

Exit: `101`.

The legacy adapter did not produce the split totals:

```text
assertion failed: wire totals combined cpuPercent
left: Null
right: 75.0
```

### RED: retained history metadata

Command:

```text
cargo test -p t4code-server --lib diagnostics::history::tests::attributed_history_retains_native_metadata_for_independent_roots -- --nocapture
```

Exit: `101`.

The attributed summary did not yet retain `ppid`, `command`, or `depth`.

### RED: signal identity and eligibility revalidation

Command:

```text
cargo test -p t4code-server --lib diagnostics::resource_sampler::tests::signal_revalidation_requires_current_external_identity_and_server_ancestry -- --nocapture
```

Exit: `101`.

The sampler had no `signal_external_descendant` method and no structured
`NotEligible` or `StaleIdentity` failures.

### RED: generated atomic fixtures

Command:

```text
vp test packages/contracts/src/rpcRustParity.test.ts
```

Exit: `1`.

The parity test reported the expected missing generated contract fixture:

```text
ENOENT: contract-shapes/server__getProcessDiagnostics-success.json
```

### RED: atomic consumer compatibility

Command:

```text
vp run typecheck
```

Exit: `1`.

The web diagnostics/status consumers still referenced removed flat totals,
`topProcesses`, `isServerRoot`, and PID-only signal input. The parent approved
a minimal mechanical compatibility adaptation rather than weakening the
atomic schema.

## Implementation Evidence

- Every attribution scope, kind, confidence, and UI coverage variant has an
  explicit Rust-to-wire match; no Rust debug strings are serialized.
- Current and historical RPC adapters use the precomputed attribution,
  split totals, split buckets, and split CPU seconds without recomputing
  attribution in the RPC layer.
- Combined CPU, RSS, and process-count totals are asserted equal to Core plus
  External.
- Effect `Option` wire values retain the existing `{ "_tag": "None" }` and
  `{ "_tag": "Some", "value": ... }` shapes.
- Current, history, UI coverage, and signal failure text is scalar-bounded.
- Current/history structural metadata is derived from the native rows already
  retained in the attributed snapshot; independently claimed roots are not
  dropped.
- Signal validation performs one full native row scan, binds the current
  registry snapshot, applies UI claims, runs the shared attributor, validates
  the exact `pid:started_at` identity, requires current server ancestry,
  requires current External attribution, and only then calls the private
  platform primitive.
- The private platform primitive refreshes only the target and checks its start
  identity again, closing the PID-reuse window between validation and signal.
- No timer, polling loop, or additional full scan was added; current/history
  demand coalescing remains unchanged.

## Focused Verification

```text
vp test packages/contracts/src/rpcRustParity.test.ts
Test Files 1 passed; Tests 3 passed

vp test packages/contracts/scripts/export-rust-rpc-fixtures.test.ts packages/contracts/src/rpcRustParity.test.ts apps/web/src/components/settings/DiagnosticsSettings.test.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/statusBarPresentation.test.ts
Test Files 5 passed; Tests 46 passed

cargo test -p t4code-server production::server_terminal::tests -- --nocapture
test result: ok. 7 passed; 0 failed

cargo test -p t4code-server diagnostics::resource_sampler::tests -- --nocapture
test result: ok. 8 passed; 0 failed

cargo test -p t4code-server production::server_terminal::tests
test result: ok. 7 passed; 0 failed

cargo test -p t4code-server diagnostics::resource_sampler::tests
test result: ok. 8 passed; 0 failed

cargo test -p t4code-server --lib diagnostics::history::tests -- --nocapture
test result: ok. 6 passed; 0 failed

cargo test -p t4code-server --lib diagnostics::native::tests -- --nocapture
test result: ok. 4 passed; 0 failed

cargo test -p t4code-server --test production_server_terminal_rpc -- --nocapture
test result: ok. 5 passed; 0 failed

cargo test -p t4code-server --test rpc_wire canonical_effect_fixtures_round_trip_without_losing_request_ids -- --nocapture
test result: ok. 1 passed; 0 failed
```

Fixture generation:

```text
vp run --filter @t4code/contracts generate:rust-rpc-fixtures
Finished in 117ms on 194 files
```

Only the three deterministic `contract-shapes` fixtures and their sorted
manifest entries were added.

## Required Gates

```text
cargo fmt --all -- --check
exit 0

vp check
pass: All 1535 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0
vp run: 0/11 cache hit (0%)

git diff --check
exit 0
```

## Fifth correction: bounded cleanup after termination failure

Source baseline: `0f054caad24905647ef7f75303dfdb6abfd198e2`. The
correction is recorded by the commit containing this section.

### Root cause and bounded ownership cleanup

The shared cleanup path attempted `ChildWrapper::start_kill` and then awaited
`ChildWrapper::wait` without a deadline. If ownership-unit termination failed,
a live child could therefore wedge cancellation, timeout, stdin, read, output
limit, and provider shutdown paths indefinitely. Provider inventory contained
the same unbounded process-wrap sequence.

Cleanup now:

1. attempts the Job/process-group ownership-unit kill;
2. attempts direct-root kill through `ChildWrapper::inner_mut` if the owner
   kill fails;
3. waits for at most two seconds;
4. preserves the primary operation error while recording bounded secondary
   cleanup failures.

Git, the shared runner, provider runtime, and provider inventory all consume
this bounded process-wrap cleanup.

The async RED regression launches a real non-exiting test process, injects
failures for both kill attempts, and force-cleans the fixture after its outer
guard proves the old wait did not return:

```text
RED
cargo test -p t4code-server --lib process::supervised::tests::live_child_with_failed_owner_and_root_kills_returns_bounded_report -- --nocapture
cleanup must return within its bounded wait deadline: Elapsed(())
test result: FAILED. 0 passed; 1 failed; finished in 3.01s

GREEN
test process::supervised::tests::live_child_with_failed_owner_and_root_kills_returns_bounded_report ... ok
test result: ok. 1 passed; 0 failed; finished in 2.01s
```

### Bounded PTY initialization cleanup

PTY initialization cleanup called portable-pty's blocking `Child::wait` after
Job/process-group/root termination attempts. On Windows, portable-pty 0.9.0
also reversed the `TerminateProcess` result check and discarded
`WinChild::do_kill` errors, so a failed Job termination plus failed root
termination could enter its infinite wait while reporting the root kill as
successful.

PTY initialization cleanup now polls `Child::try_wait` for at most two seconds
and never calls blocking `Child::wait`. The local fork makes both Windows
child-killer implementations propagate the actual Win32 success or error.
`UPSTREAM.md` records this second minimal fork deviation.

The PTY RED regression launches a real `/bin/sh` portable-pty child, injects
root kill failure, then externally kills and reaps the fixture after proving
the old cleanup missed its deadline. It also verifies that the primary
initialization error is preserved and secondary failure counts and strings are
bounded.

```text
RED
cargo test -p t4code-server --lib terminal::pty::tests::failed_live_pty_kill_cannot_block_initialization_cleanup -- --nocapture
PTY cleanup did not return within its deadline: timed out waiting on channel
test result: FAILED. 0 passed; 1 failed; finished in 3.01s

GREEN
test terminal::pty::tests::failed_live_pty_kill_cannot_block_initialization_cleanup ... ok
test result: ok. 1 passed; 0 failed; finished in 2.01s
```

### Fifth-cycle verification

```text
cargo test -p t4code-server --lib process:: -- --nocapture
test result: ok. 13 passed; 0 failed

cargo test -p t4code-server --test process_runner -- --nocapture
test result: ok. 13 passed; 0 failed

cargo test -p t4code-server --test git_coverage -- --nocapture
test result: ok. 19 passed; 0 failed

cargo test -p t4code-server --test git_rpc -- --nocapture
test result: ok. 21 passed; 0 failed

cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
test result: ok. 7 passed; 0 failed

cargo test -p t4code-server --lib terminal::manager::tests -- --nocapture
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server --lib production::provider_inventory::tests -- --nocapture
test result: ok. 15 passed; 0 failed

cargo test -p t4code-server --lib production::provider_runtime::tests -- --nocapture
test result: ok. 19 passed; 0 failed

cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml -- --nocapture
test result: ok. 103 library tests and 11 integration tests passed

RUSTC=/Users/admin/.rustup/toolchains/1.97.1-aarch64-apple-darwin/bin/rustc \
RUSTFLAGS='-A dead_code' \
rustup run 1.97.1-aarch64-apple-darwin cargo check \
  --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml \
  --tests --target x86_64-pc-windows-msvc
Finished `dev` profile

cargo fmt --all -- --check
exit 0

vp check
pass: All 1538 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0

git diff --check
exit 0
```

No helper sidecar or production Node runtime was added. Packaged Windows
runtime verification remains explicitly deferred to Task 9.

## Fourth correction: race-free process ownership

Source baseline: `dd76c8beacbb`. The correction is recorded by the commit that
contains this section.

### Shared lifecycle and non-PTY ownership

- Added one crate-internal supervised lifecycle for the shared process runner
  and Git runner. Spawn, required pipes, stdin, concurrent output collection,
  wait, timeout, cancellation, and cleanup are now one ownership unit.
- Every post-spawn pipe, stdin, read, output-limit, wait, timeout, and
  cancellation failure terminates and waits for the whole process tree.
  Cleanup continues to `wait` even when `start_kill` fails, and cleanup
  diagnostics have bounded counts and strings.
- Windows non-PTY processes now use process-wrap 9.1's built-in Job Object
  wrapper, whose suspended create/assign/resume sequence closes the old
  post-spawn assignment race. A duplicated process-handle guard terminates and
  bounded-waits the suspended child when a later wrapper hook fails.
- Unix non-PTY processes continue to use process groups. Public Git and shared
  runner request, result, error, environment, and output behavior is
  preserved.

TDD evidence:

```text
RED
cargo test -p t4code-server --lib process::supervised::tests -- --nocapture
error[E0583]: file not found for module `supervised`

GREEN
cargo test -p t4code-server --lib process::supervised::tests -- --nocapture
test result: ok. 4 passed; 0 failed
```

Real regressions use the current test executable as a fixture and create a
leader, child, and grandchild. Cancellation, timeout, and broken-stdin paths
assert that no descendant writes a post-cleanup survival sentinel. Equivalent
target-gated Windows fixture code is included in the exact Windows harness.

### ConPTY at-creation Job assignment

- Checked in a narrow portable-pty 0.9.0 fork under
  `third_party/portable-pty`. `UPSTREAM.md` records the crates.io version,
  checksum `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`,
  file inventory, update procedure, removal condition, and JOB_LIST
  deviation.
- The fork adds a Windows-only `CommandBuilder::job_list` API and supplies
  `PROC_THREAD_ATTRIBUTE_JOB_LIST` alongside the pseudoconsole attribute to
  `CreateProcessW`.
- PTY startup creates and configures the Job before spawn. Every initialization
  error after child creation terminates the Job, attempts root-child kill as a
  fallback, waits for the child, and reports bounded cleanup failures without
  replacing the primary initialization error.
- Target-gated Windows tests cover first-instruction Job membership,
  initialization cleanup, and leader/child/grandchild termination.
- No helper sidecar or production Node runtime was added.

The full server Windows cross-check remains blocked before reaching T4Code by
the host C toolchain lacking Windows SDK headers for `aws-lc-sys`. The exact
portable-pty, process-wrap, application API, and real Windows process-runner
test source compile in the Task 8 harness:

```text
RUSTC=/Users/admin/.rustup/toolchains/1.97.1-aarch64-apple-darwin/bin/rustc \
RUSTFLAGS='-A dead_code' \
rustup run 1.97.1-aarch64-apple-darwin cargo check \
  --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml \
  --tests --target x86_64-pc-windows-msvc
Finished `dev` profile
```

The local Task 8 harness passes 100 library tests and 11 integration tests.
Packaged Windows runtime verification remains explicitly deferred to Task 9.

### Fourth-cycle verification

```text
cargo test -p t4code-server --lib process:: -- --nocapture
test result: ok. 11 passed; 0 failed

cargo test -p t4code-server --test process_runner -- --nocapture
test result: ok. 13 passed; 0 failed

cargo test -p t4code-server --test git_coverage -- --nocapture
test result: ok. 19 passed; 0 failed

cargo test -p t4code-server --test git_rpc -- --nocapture
test result: ok. 21 passed; 0 failed

cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
test result: ok. 6 passed; 0 failed

cargo test -p t4code-server --lib terminal::manager::tests -- --nocapture
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server --lib production::provider_runtime::tests -- --nocapture
test result: ok. 19 passed; 0 failed

cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml -- --nocapture
test result: ok. 111 passed; 0 failed

cargo fmt --all -- --check
exit 0

vp check
pass: All 1538 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0

git diff --check
exit 0
```

The full typecheck continues to print the repository's existing non-fatal
Effect `Schema.Finite` suggestions.

## Files

Contract and generated wire fixtures:

- `packages/contracts/src/server.ts`
- `packages/contracts/src/rpcRustParity.test.ts`
- `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- `packages/contracts/fixtures/rpc-wire/manifest.json`
- `packages/contracts/fixtures/rpc-wire/contract-shapes/*.json`

Rust wire, history metadata, runtime ownership, and signal safety:

- `apps/server/src/diagnostics/history.rs`
- `apps/server/src/diagnostics/mod.rs`
- `apps/server/src/diagnostics/model.rs`
- `apps/server/src/diagnostics/native.rs`
- `apps/server/src/diagnostics/resource_sampler.rs`
- `apps/server/src/production/runtime.rs`
- `apps/server/src/production/server_terminal.rs`
- `apps/server/tests/production_server_terminal_rpc.rs`

Parent-approved out-of-brief compatibility files:

- `apps/web/src/components/settings/DiagnosticsSettings.tsx`
- `apps/web/src/components/settings/DiagnosticsSettings.test.tsx`
- `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
- `apps/web/src/components/status-bar/statusBarPresentation.ts`
- `apps/web/src/components/status-bar/statusBarPresentation.test.ts`
- `apps/web/src/components/status-bar/AppStatusBar.test.tsx`

These web edits only consume the new atomic names, carry `processKey` through
signal actions, and continue presenting Combined values. They do not add the
later split-attribution UI.

## Self-Review and Concerns

- The worktree started clean and the source commit contains only Task 6 and
  its required compatibility changes.
- Generated fixtures round-trip through Rust and decode through the executable
  TypeScript schemas.
- Unsupported signal names remain invalid structured RPC requests; unsupported
  platform signals remain structured signal results.
- Stale identity, Core server/UI, reparented External, and unknown PID cases
  are all rejected before the platform primitive.
- No known blocker or generated-fixture concern remains.

## Review Correction Cycle

Review corrections were implemented on source base `0f78c77f27`.

Source correction commit:

```text
1e8af71330 fix(diagnostics): harden attributed process diagnostics
```

### Security: high-fidelity identity and identity-bound signaling

- Native rows no longer use sysinfo's second-granularity start timestamp.
  Linux reads `/proc/<pid>/stat` start ticks, macOS reads
  `proc_bsdinfo` start seconds plus microseconds, and Windows reads the full
  process-creation `FILETIME`.
- The final signal path no longer performs any numeric-PID signal. Linux opens
  and owns a pidfd, verifies the high-fidelity creation identity after
  acquisition, then calls `pidfd_send_signal`. Windows opens and owns a process
  HANDLE, verifies creation `FILETIME` on that handle, then terminates through
  the same handle.
- macOS returns structured `Unsupported` because this implementation has no
  identity-bound signal primitive there. Unsupported targets likewise fail
  safely rather than falling back to a check-then-signal PID race.
- Descendant cleanup uses the same identity-bound primitive.
- Signal authorization still performs exactly one full native-row scan.
  Replacement immediately before the final primitive is rejected without
  recording a signal.

TDD evidence:

```text
RED
cargo test -p t4code-server --lib diagnostics::native::tests::native_sampler_uses_the_platform_creation_identity -- --nocapture
error[E0425]: cannot find function `platform_process_creation_identity`

GREEN
test diagnostics::native::tests::native_sampler_uses_the_platform_creation_identity ... ok

RED
cargo test -p t4code-server --lib diagnostics::native::tests::same_second_process_replacements_have_distinct_creation_identities -- --nocapture
error[E0425]: cannot find function `macos_process_creation_identity`

GREEN
test diagnostics::native::tests::same_second_process_replacements_have_distinct_creation_identities ... ok

RED
cargo test -p t4code-server --lib diagnostics::native::tests::final_signal_stays_bound_to_the_verified_process_after_pid_replacement -- --nocapture
error[E0405]: cannot find trait `IdentityBoundProcess`
error[E0425]: cannot find function `signal_identity_bound_process`

GREEN
test diagnostics::native::tests::final_signal_stays_bound_to_the_verified_process_after_pid_replacement ... ok

RED
cargo test -p t4code-server --lib diagnostics::resource_sampler::tests::signal_revalidation_rejects_replacement_after_attribution -- --nocapture
error[E0599]: no method named `replace_identity_before_signal`

GREEN
test diagnostics::resource_sampler::tests::signal_revalidation_rejects_replacement_after_attribution ... ok
```

The current macOS host ran the native tests. Linux start-tick parsing and
Windows FILETIME tests are target-gated. A Windows cross-check reached native
build dependencies but the local cross compiler lacks the Windows C headers
required by `aws-lc-sys`; it failed before compiling `t4code-server`.
The `windows-sys 0.61.2` declarations used here were inspected against the
implementation. A Linux Rust target was not installed on this host.

### UI: strictly current compact resources

- The compact headline reads only
  `diagnostics.totals.combined`; retained history cannot inflate current CPU,
  RSS, or process count.
- Top rows come only from current live diagnostics and have explicit ordering:
  descending current CPU, then ascending process key for stable ties.
- An exited process with very high retained usage now has no effect on the
  current headline or live top-process selection.

TDD evidence:

```text
RED
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts
expected current memory "0 B"; received retained-history memory "50.0 MB"

GREEN
Test Files 1 passed; Tests 7 passed
```

### Retention: remove the legacy duplicate projection

- Removed legacy retained-process models, per-snapshot projection,
  aggregation, buckets, summaries, exports, and tests.
- Retained samples contain attributed processes and only the process metadata
  required to build complete attributed history: parent PID, command, and
  depth. They no longer retain duplicate native status, elapsed, pgid, or child
  data.
- Age and count retention bounds remain covered.

TDD evidence:

```text
RED
cargo test -p t4code-server --lib diagnostics::history::tests::retained_samples_do_not_copy_unattributed_native_rows -- --nocapture
debug-retained sample contained `unattributed-secret-command`

GREEN
test diagnostics::history::tests::retained_samples_do_not_copy_unattributed_native_rows ... ok

RED
cargo test -p t4code-server --lib diagnostics::history::tests::retained_samples_keep_only_metadata_required_by_attributed_history -- --nocapture
debug-retained sample contained unneeded native status and elapsed fields

GREEN
test diagnostics::history::tests::retained_samples_keep_only_metadata_required_by_attributed_history ... ok
```

### Wire coverage correction

The all-variants wire test now supplies a 500-scalar Unicode UI-coverage
message, asserts Effect Option `{ "_tag": "Some" }`, and asserts the emitted
value is exactly 160 Unicode scalars. The same loop retains all four coverage
statuses and verifies `{ "_tag": "None" }` for missing messages.

```text
cargo test -p t4code-server production::server_terminal::tests -- --nocapture
test result: ok. 7 passed; 0 failed
```

### Correction verification

```text
vp test packages/contracts/src/rpcRustParity.test.ts
Test Files 1 passed; Tests 3 passed

cargo test -p t4code-server diagnostics::resource_sampler::tests -- --nocapture
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server diagnostics::native::tests -- --nocapture
test result: ok. 7 passed; 0 failed

cargo test -p t4code-server diagnostics::history::tests -- --nocapture
test result: ok. 8 passed; 0 failed

cargo test -p t4code-server --test production_server_terminal_rpc -- --nocapture
test result: ok. 5 passed; 0 failed

vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts
Test Files 1 passed; Tests 7 passed

vp check
pass: All 1535 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0
vp run: 0/11 cache hit (0%)

git diff --check
exit 0
```

The RPC schema and generated wire fixture shapes did not change in this
correction cycle, so fixtures were intentionally not regenerated.

## Third correction cycle: coherent rows and owned shutdown

Source commit before this cycle:

```text
1e8af71330 fix(diagnostics): harden attributed process diagnostics
```

Correction commit:

```text
dd76c8beac fix(diagnostics): make process ownership coherent
```

### Coherent platform process records

- Security-sensitive creation identity and parent ancestry now come from one
  coherent platform record per PID. Sysinfo supplies only presentation data:
  CPU, RSS, status, elapsed time, and command.
- Linux parses parent PID and start ticks from the same
  `/proc/<pid>/stat` read.
- macOS reads parent PID and microsecond-resolution creation identity from the
  same `proc_bsdinfo` record.
- Windows opens one query handle with `PROCESS_QUERY_INFORMATION`, then reads
  creation `FILETIME` and `PROCESS_BASIC_INFORMATION` parent PID through that
  handle. The exact Windows API fragment cross-compiles against
  `windows-sys 0.61.2` for `x86_64-pc-windows-msvc`.
- A failed platform record query omits the row; cached sysinfo ancestry is
  never mixed into the security model.

TDD evidence:

```text
RED
cargo test -p t4code-server --lib diagnostics::native::tests::collection_window_replacement_cannot_inherit_cached_ancestry
error[E0422]: cannot find struct `ProcessPresentation`
error[E0422]: cannot find struct `PlatformProcessRecord`
error[E0425]: cannot find function `combine_process_observations`

GREEN
test diagnostics::native::tests::collection_window_replacement_cannot_inherit_cached_ancestry ... ok
```

The deterministic A/B replacement test combines presentation cached for A
with a coherent platform record for B and proves that both security fields
come only from B.

### Windows process error classification

`OpenProcess` and `GetProcessTimes` failures now preserve their Win32 error:
missing process errors map to `NotFound`, access denial maps to `Rejected`,
and unexpected query failures map to structured `Read` errors. Pure mapping
tests run on the macOS host.

```text
RED
cargo test -p t4code-server --lib diagnostics::native::tests::windows_process_errors_distinguish_missing_denied_and_unexpected_failures
error[E0425]: cannot find function `classify_windows_process_error`
error[E0433]: failed to resolve `WindowsProcessOperation`

GREEN
test diagnostics::native::tests::windows_process_errors_distinguish_missing_denied_and_unexpected_failures ... ok
```

The full server Windows cross-check remains blocked before reaching T4Code by
the host C toolchain lacking `stdlib.h` and `windows.h` for `aws-lc-sys`.
An isolated crate containing the exact `OpenProcess`, `GetProcessTimes`, and
`NtQueryInformationProcess` calls completes:

```text
cargo check --target x86_64-pc-windows-msvc
Finished `dev` profile
```

### Owned process-tree shutdown

- Terminal PTYs retain their existing Unix process-group and Windows Job
  ownership. Shutdown attempts every terminal owner, continues after
  individual failures, and emits a bounded aggregate failure report.
- Provider sessions and process-runner commands retain the shared supervised
  process-group/Job configuration. Their cleanup failures and timeouts are now
  bounded and visible rather than silently discarded.
- Production shutdown logs a bounded provider failure and continues through
  terminal, log, and orchestration cleanup.
- The descendant fallback attempts every coherent identity, aggregates
  bounded failures, and never changes the macOS user-facing signal RPC:
  macOS signaling remains structured `Unsupported` because no identity-bound
  signal primitive is available.

TDD evidence:

```text
RED
cargo test -p t4code-server --lib diagnostics::native::tests::cleanup_fallback_continues_after_failures_and_bounds_its_report
error[E0425]: cannot find function `cleanup_process_identities`

GREEN
test diagnostics::native::tests::cleanup_fallback_continues_after_failures_and_bounds_its_report ... ok

RED
cargo test -p t4code-server --lib terminal::manager::tests::shutdown_attempts_every_terminal_owner_and_bounds_failures
error[E0609]: no field `attempted` on type `()`
error[E0609]: no field `failure_count` on type `()`

GREEN
test terminal::manager::tests::shutdown_attempts_every_terminal_owner_and_bounds_failures ... ok
```

The real macOS-capable regression launches a child and grandchild through a
portable PTY and verifies neither survives terminal-manager shutdown. It was
added as a characterization of the existing process-group ownership and
passed on its first run:

```text
test terminal::manager::tests::owner_shutdown_leaves_no_child_or_grandchild_processes ... ok
```

### Explicit history-only top-row exclusion

The status-bar regression now explicitly proves that an exited process may
remain in retained history while being absent from current top-process rows.
Current totals and top rows remain derived only from the live diagnostics
snapshot.

```text
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts
Test Files 1 passed; Tests 7 passed
```

### Third-cycle verification

```text
cargo test -p t4code-server --lib diagnostics::native::tests
test result: ok. 10 passed; 0 failed

cargo test -p t4code-server --lib diagnostics::resource_sampler::tests
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server --lib diagnostics::history::tests
test result: ok. 8 passed; 0 failed

cargo test -p t4code-server --lib diagnostics::monitor::tests
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server --lib production::server_terminal::tests
test result: ok. 7 passed; 0 failed

cargo test -p t4code-server --lib terminal::manager::tests
test result: ok. 9 passed; 0 failed

cargo test -p t4code-server --lib terminal::pty::tests
test result: ok. 6 passed; 0 failed

cargo test -p t4code-server --test process_runner
test result: ok. 12 passed; 0 failed

cargo test -p t4code-server --lib production::provider_runtime::tests
test result: ok. 19 passed; 0 failed

cargo test -p t4code-server --lib production::lifecycle::tests
test result: ok. 2 passed; 0 failed

cargo test -p t4code-server --test production_server_terminal_rpc
test result: ok. 5 passed; 0 failed

vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts packages/contracts/src/rpcRustParity.test.ts
Test Files 4 passed; Tests 44 passed

cargo fmt --all -- --check
exit 0

vp check
pass: All 1535 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0
vp run: 0/11 cache hit (0%)

git diff --check
exit 0
```

---

# Provider Defaults Stability QA — Task 6 Addendum

Status: **DONE WITH CONCERNS**
Source HEAD before/after QA: `779108a12f8b8f9e251b1865fceb74e864a423e6`

Task 6 was executed without production or test edits. The current-worktree native app was launched
twice with the exact isolated environment, controlled through fresh accessibility snapshots by
exact PID, quit normally, and fully stopped.

## Passed

- Rust provider-inventory focused suite: 18 tests passed.
- Shared defaults focused suite: 29 tests passed.
- Named settings tests without the stale project filter: 44 tests passed.
- Named chat/terminal tests without the stale project filter: 139 tests passed.
- `vp check` and `vp run typecheck` passed.
- Provider enable/disable and three refresh cycles kept supported controls mounted, ordered, and
  value-stable.
- All five Codex models and all eight Claude models were exercised; invalid cross-model effort
  values fell back to a nonblank valid default.
- Claude Fast was shown only on its four supported Opus descriptors and persisted while moving
  among those models.
- Closing/reopening Settings and a normal full app restart preserved the last valid Codex and
  Claude defaults.
- Both native dev commands exited 0 and final process cleanup found nothing left running.

## Concerns and blocked cases

1. The exact web commands containing `--project unit` fail before test collection because no Vite+
   project named `unit` exists. The identical file lists pass without that filter.
2. Rich Codex inventory does not expose `Fast by default` for any available model. This fails the
   required always-mounted Codex Fast control and prevents Fast-on terminal validation.
3. Rich-only Claude effort values are rewritten by the quick inventory after selection. A direct
   native example is Sonnet 5 `ultrathink` immediately reverting to `high`.
4. `T4CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1` does not add a project. The isolated app stays at
   `No projects yet`, disabling chat creation. Therefore existing/new chat immutability, added
   panels, and live terminal argv cases could not be executed.

Full command outcomes, model inventories, lifecycle PIDs, screenshot names, and blocked-case
details are in `.superpowers/qa/provider-defaults-stability/results.md`.

---

# Task 6 blocker fixes

Implementation commit: `abdd938982144e6838d5a622f00a962b68648e4c`

## Files changed and behavior

- `packages/shared/src/model.ts` adds an explicit provider-default opt-in for preserving
  prompt-injected descriptor selections. The default path still resets those raw values for the
  live composer.
- `packages/shared/src/providerSessionDefaults.ts` opts provider session defaults into that path
  and merges a missing Codex `serviceTier` descriptor into live model metadata without replacing
  authoritative effort or other descriptors.
- `packages/shared/src/model.test.ts` and `packages/shared/src/providerSessionDefaults.test.ts`
  cover the default reset behavior, explicit prompt-injected preservation, all three provider
  default APIs, Codex-only Fast exposure, and model-change compatibility.
- `apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx` covers the Fast switch
  for rich Codex metadata that omits `serviceTier`.
- `apps/web/src/hooks/useHandleNewThread.test.tsx`,
  `apps/web/src/components/ChatView.hooks.test.tsx`, and
  `apps/web/src/components/chat/providerTerminalActions.test.ts` cover Codex Fast and Claude
  `ultrathink` across new-chat, panel, and native terminal command boundaries.

## Red and green evidence

- RED: `vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts`
  reported 7 expected failures: the opt-in still reset `ultrathink`, Codex Fast was absent from
  controls/resolve/update, and Claude `ultrathink` was rewritten in controls/resolve/update.
- RED: `vp test apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx`
  reported the expected missing `Fast by default` failure.
- RED: the new-chat, panel, and provider-terminal focused tests showed Codex `serviceTier` being
  dropped and Claude `ultrathink` becoming the descriptor default. After correcting the Claude
  new-chat fixture to select the Claude instance, its focused red run failed only on the expected
  `ultrathink` rewrite (alongside the expected Codex Fast loss).
- GREEN: shared focused command passed 85 tests; settings UI passed 11 tests; new-chat, panel, and
  provider-terminal command passed 141 tests.

## Final command outcomes

- `vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts`:
  85 passed, 0 failed.
- `vp test apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx`: 11 passed,
  0 failed.
- `vp test apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts`:
  141 passed, 0 failed.
- `vp check`: exit 0; all 1562 files formatted and 1182 files linted with no warnings or errors.
- `vp run typecheck`: exit 0.
- `git diff --check`: exit 0.

## Residual concerns

None. Native UI QA was intentionally deferred to the root task as requested.

---

# Task 6 review fixes

Implementation commit: `2b713467e9caa30475f367185bf8a56e3ab76ed6`

## Behavior fixed

- `getComposerProviderState` now keeps ordinary descriptor normalization unchanged for provider
  dispatch while separately resolving a raw prompt-injected session default through the model's
  `promptInjectedValues` metadata. A seeded Claude `ultrathink` default therefore supplies
  `promptEffort: "ultrathink"`, while dispatched model options contain the native descriptor
  default.
- The first-send production boundary is covered through `ChatView`: a new draft seeded with the
  Claude default sends `Ultrathink:\n...` and bootstraps the provider with native `high` effort.
- Claude provider terminals omit metadata-declared prompt-injected efforts. With live metadata,
  declared native values remain authoritative; during empty discovery, only the documented native
  fallback values (`low`, `medium`, `high`, `xhigh`, and `max`) are emitted.
- Existing live-composer/TraitsPicker prompt-controlled behavior remains unchanged.

## RED evidence

- Initial focused run: 126 passed and 3 failed as expected. The composer returned `high` instead of
  raw `ultrathink`, the first `thread.startTurn` message lacked the `Ultrathink:` prefix, and the
  provider terminal emitted `--effort ultrathink`.
- Conservative fallback cycle: 22 passed and 1 failed as expected. With an empty model discovery
  snapshot, the Claude terminal still emitted `--effort ultrathink`.

## GREEN evidence

- The initial focused composer, first-send, and terminal command passed all 129 tests after the
  metadata-driven fix.
- The conservative terminal-focused suite passed all 23 tests after adding the bounded native
  fallback.
- One test-fixture exact-optional-property type error and one descriptor-union narrowing type error
  were corrected without changing the tested runtime behavior; the affected suites and type gate
  were rerun successfully.

## Final command outcomes

- `vp test apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx`:
  18 passed, 0 failed.
- `vp test apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts`:
  120 passed, 0 failed.
- `vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts`:
  85 passed, 0 failed.
- `vp check`: exit 0; all 1562 files formatted and 1182 files linted with no warnings or errors.
- `vp run typecheck`: exit 0.
- `git diff --check`: exit 0.

## Residual concerns

None for the requested semantics. During empty discovery, an unknown future Claude native effort is
intentionally omitted until authoritative model metadata is available; this is the conservative
failure mode and prevents unsupported flags from reaching the CLI.

---

# Task 6 live Codex Fast fix

Implementation commit: `be6bbc1846a0c35fe7ce05b7b130ca97c8268049`

## Behavior fixed

- Codex provider-default normalization now augments a live `serviceTier` select descriptor with
  missing invariant `default` and `fast` choices instead of treating the descriptor ID alone as
  sufficient. Existing descriptor metadata, labels, choices, selection, and surrounding live
  descriptors remain intact, and existing choices are not duplicated.
- An incompatible Codex descriptor with the `serviceTier` ID is replaced in place with the safe
  invariant select shape. The normalization remains Codex-only.
- Shared controls, session resolution, settings rendering, and provider-terminal resolution now
  keep Fast available when rich Codex metadata advertises only Standard/default. Explicit Standard
  remains off, configured Fast remains `serviceTier=fast`, and terminal launch emits
  `service_tier="fast"`.

## RED evidence

- `vp test packages/shared/src/providerSessionDefaults.test.ts apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts`:
  70 passed and 6 failed as expected before the implementation. The failures showed partial Codex
  metadata reporting Fast unsupported, resolving Fast back to `default`, dropping the Fast update
  and terminal config, omitting the settings switch, and retaining an incompatible boolean
  descriptor.
- The partial non-Codex regression passed during RED, confirming that the failing behavior was
  scoped to the missing Codex invariant rather than general `serviceTier` handling.

## GREEN evidence

- The same focused shared/settings/terminal command passed all 76 tests after the normalization
  fix.
- The broader focused command including shared model normalization passed all 126 tests.

## Final command outcomes

- `vp test packages/shared/src/model.test.ts packages/shared/src/providerSessionDefaults.test.ts apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx apps/web/src/components/chat/providerTerminalActions.test.ts`:
  126 passed, 0 failed.
- `vp check`: exit 0; all 1562 files formatted and 1182 files linted with no warnings or errors.
- `vp run typecheck`: exit 0.
- `git diff --check`: exit 0.

## Residual concerns

None for the requested code paths. Native UI QA was intentionally not launched; the root task owns
the exact-worktree retest.

---

# Task 6 session precedence fix

Implementation commit: `6dfd3ec0a9c7bf679b938633ea5b9745422ba0c4`

## Root cause and behavior fixed

- `resolveProviderSessionDefault` ranked a matching `projectSelection` ahead of the configured
  provider session default. Projects therefore carried their add-project model/options snapshot
  into every later new-session boundary, even after the provider-wide defaults changed.
- The resolver now chooses one complete source in this order: matching explicit selection,
  configured provider default, matching project fallback, then live model fallback. Model and
  options always come from that same source.
- Project selection still determines provider-instance routing at the creation boundaries. When
  no configured provider default exists, the matching project selection remains the fallback.
- Existing-session immutability, provider fallback reporting, custom-instance routing, offline
  behavior, and Claude prompt-injected handling remain covered by the focused suites.

## RED evidence

Command:

```text
vp test packages/shared/src/providerSessionDefaults.test.ts apps/web/src/hooks/useHandleNewThread.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx apps/web/src/components/Sidebar.test.tsx
```

Exit: `1`. Five test files reported 7 expected failures and 259 passing tests. The shared resolver,
normal new-thread, routed-provider new-thread, added chat panel, new worktree, and default-thread
boundaries all received stale project model/options instead of the configured provider source.
Representative failures received `gpt-stale` + Low + Standard where the assertions required
`gpt-configured` + Medium + Fast. The existing immutable-session and no-config project-fallback
tests remained green.

## GREEN and final verification

- Focused command above: 5 files passed; 266 tests passed; exit 0.
- `vp check`: all 1562 files correctly formatted; no warnings or lint errors in 1182 files; exit 0.
- `vp run typecheck`: exit 0.
- `git diff --check`: exit 0.

No native UI was launched. Existing QA artifacts and report content were preserved.

---

# Task 6 composer Fast invariant fix

Implementation commit: `f20ce3d3c54c35488eb0ebaf1f53cef77012c480`

## Root cause and behavior fixed

- Live Codex model parsing omitted the `serviceTier` descriptor when the CLI returned no tiers and
  duplicated `default` when partial metadata already contained it. Parsing now always emits one
  explicit `default` and one `fast`, deduplicates every live tier ID, and preserves live labels,
  descriptions, extra tiers, and the valid live default/current value.
- Client normalization previously enforced this invariant only inside provider session defaults.
  The shared model layer now owns Codex capability normalization, and Settings, ChatComposer, and
  TraitsPicker all consume it. Partial and older snapshots keep configured Fast; empty/custom
  snapshots recover it when a selection exists; non-Codex capabilities remain untouched.
- A service-tier-only selection is excluded from prompt-effort inference, so the defensive empty
  snapshot path dispatches Fast without interpreting `fast` as reasoning effort.
- Canonical Codex discovery/probe fixtures now record the invariant Fast choice. Existing settings,
  session defaults, Claude prompt injection, added panels, worktrees, and provider-terminal paths
  remain covered.

## RED evidence

- `cargo test -p t4code-server --lib provider::codex::model::tests::live_models_always_expose_unique_standard_and_fast_service_tiers -- --nocapture`:
  exit 101. The no-tier live model had no `serviceTier` descriptor and panicked at `Codex service
  tier invariant`.
- `vp test apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/ChatView.hooks.test.tsx`:
  115 passed and 3 failed. Composer state and the real first-send `thread.startTurn` boundary both
  changed configured `{ serviceTier: "fast" }` to `default`; Traits visibility was false for an
  empty Codex snapshot with configured Fast.
- The follow-up empty-snapshot regression failed with `promptEffort: "fast"` instead of `null`,
  proving that a service-tier-only descriptor needed to stay out of effort inference.

## GREEN and final verification

- Rust Codex model unit tests: 4 passed, 0 failed.
- Rust provider inventory tests: 18 passed, 0 failed.
- Rust `provider_codex` integration/fixture corpus: 8 passed, 0 failed.
- Shared model/session-default plus settings, composer, TraitsPicker, ChatView first-send, panel,
  worktree, add-project, and terminal tests: 13 files passed; 347 tests passed; 0 failed.
- `vp check`: all 1562 files correctly formatted; no warnings or lint errors in 1182 files; exit 0.
- `vp run typecheck`: exit 0. Existing finite-number suggestions were unchanged and non-failing.
- `git diff --check`: exit 0.

No native UI was launched. Existing QA screenshots and all prior report content were preserved.

---

# Task 6 Claude panel visible default fix

Implementation commit: `91275d13aef0fe089eb48a25eac1e73ede900755`

## Root cause and behavior fixed

- The live composer correctly kept a raw prompt-injected Claude session default separate from the
  normalized native dispatch options, but only prompt text activated the Ultrathink presentation.
  `TraitsPicker` therefore rendered the normalized native default, High, and
  `getComposerProviderState` omitted the Ultrathink frame/icon classes until a prefix was present.
- Traits presentation now resolves the raw primary selection through the model descriptor's
  `promptInjectedValues` metadata. A newly seeded Sonnet 5 panel with an empty prompt visibly shows
  Ultrathink in both the trigger and selected radio item.
- Composer presentation treats the resolved raw `ultrathink` value as active before first send.
  The full `ChatComposer` boundary verifies the frame, surface, picker-icon class, prompt effort,
  and native High dispatch options together.
- Prompt-body locking remains based only on actual prompt text. Choosing High from the raw default
  persists High without adding or stripping a prefix. Existing manual prefix insertion,
  body-protection, first-send formatting, one-shot reset, and terminal argument behavior are
  unchanged.

## RED evidence

Command:

```text
vp test apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Exit: `1`. The command reported 4 expected failures and 104 passing tests:

- both raw-default Traits tests rendered High instead of Ultrathink;
- composer state returned `promptEffort: "ultrathink"` and native High dispatch options but omitted
  all three Ultrathink presentation classes;
- the full ChatComposer boundary rendered High and omitted the Ultrathink frame, surface, and
  provider-icon presentation.

## GREEN and final verification

- Initial focused GREEN: the three RED suites passed all 108 tests.
- Broader composer/Traits/ChatView/panel/terminal/shared-model command: 8 files passed; 323 tests
  passed; 0 failed. This includes the added-panel seed, first-send prefix and native High dispatch,
  manual prefix/body protection, one-shot reset, center-panel state/actions, and provider terminal
  vectors.
- `vp check`: all 1562 files correctly formatted; no warnings or lint errors in 1182 files; exit
  0.
- `vp run typecheck`: exit 0. Existing finite-number suggestions remained non-failing.
- `git diff --check`: exit 0.

No native UI was launched. Existing QA artifacts and all prior report content were preserved.

---

# Task 6 final native retest

Final QA source: `0b9df1349c3bee16aa93d2c4491ce5d794b53cbf`

Full-matrix parent source: `0497caa3a308c9a85b3ebd0c6de5729ae98ef89d`

Outcome: **PASS**

The complete native workflow ran first on `0497caa3a3` using an isolated home and exact
current-worktree desktop PIDs. It covered visible hidden-worktree project addition, Chat A
immutability, Chat B and added-panel defaults, all five Codex and eight Claude models, provider
off/on controls, three immediate/settled refresh cycles, settings-file and restart persistence,
Claude prompt injection, and every requested terminal vector. That run exposed the final affected
defect: a new Sonnet 5 panel displayed native High rather than the persisted prompt-injected
Ultrathink default.

The affected diff was retested at exact final HEAD after a normal close/reopen and exact-command
restart. A genuine new Claude panel showed Sonnet 5 and `Ultrathink · 200k · claude` before any
prompt text existed. Without touching the effort picker, typing `Reply with OK only.` and sending
produced `Ultrathink: Reply with OK only.`, returned `OK`, reset the one-shot UI to High, and
launched Claude with `--model claude-sonnet-5` and no unsupported Ultrathink effort flag. A fresh
Codex panel showed Spark/High/Fast and its UI-launched terminal emitted model, High effort, and
`service_tier="fast"`.

The full terminal matrix passed: Codex Fast maps to `service_tier="fast"`, Standard maps to
`service_tier="default"`, Claude High maps to native `--effort high`, Claude Ultrathink omits the
unsupported effort flag, and OpenCode omits unsupported effort/Fast arguments. Exact identities,
screenshots, redacted argv, superseded-evidence exclusions, and lifecycle cleanup are recorded in
`.superpowers/qa/provider-defaults-stability/results.md`.

Final gates passed: `vp check`, `vp run typecheck`, and `git diff --check`. No production/test
source was edited during native QA, no QA commit was created, and final cleanup left no installed
or worktree T4Code process.

---

# Task 6 final reviewed native verification

Final reviewed source: `7ce2163bcb`

Outcome: **PASS**

The full provider-defaults change was reviewed after the final reconciliation fixes. No critical,
important, or minor findings remained. The exact reviewed source then passed `vp test` (492 files,
6,634 tests), `vp check` (1,562 formatted files and 1,182 linted files), `vp run typecheck` (11
tasks), and `git diff --check`.

Native verification used only the current worktree binaries. The desktop process was
`/Users/admin/.codex/worktrees/6f54/t4code/target/debug/t4code-desktop` and the matching server was
`/Users/admin/.codex/worktrees/6f54/t4code/target/debug/t4code serve --no-browser`; no installed
T4Code application process was present.

The Providers page preserved Codex GPT-5.5, xhigh, and Fast together with Claude Sonnet 5 and high
through cross-provider edits, Codex disable/enable, provider refresh, and a normal application
restart. Disabled provider controls stayed mounted but disabled, and Codex effort remained visible
through every transition. A draft created before enabling Fast remained Standard, while the next
new chat showed `GPT-5.5 / Extra High / Fast` and returned `OK`.

UI-created provider terminals inherited the same defaults. The Codex process launched with
`--model gpt-5.5`, `model_reasoning_effort="xhigh"`, and `service_tier="fast"`; the Claude process
launched with `--model claude-sonnet-5 --effort high`. Final screenshots are retained in the
gitignored `.superpowers/qa/provider-defaults-stability/final-evidence/` directory.

---

# Task 6 uniform provider controls follow-up

Outcome: **PASS**

Every provider card now keeps the same Default model, Default effort, and Fast by default controls
mounted in the same row. Unsupported effort controls remain visible, disabled, and display `Not
supported`; unsupported Fast switches remain visible, off, and disabled. When no selectable model
inventory exists, the model control also remains visible but disabled. Disabling a provider
disables its supported controls without changing the card layout or removing any control.

The exact current-worktree desktop PID was visually verified across Codex, Claude, Cursor, Grok,
and OpenCode. Codex exposed all three enabled controls, Claude exposed its enabled model/effort and
disabled Fast control, and the remaining unsupported effort/Fast controls stayed visible and
disabled. Claude off/on and a provider refresh preserved the full row.

Verification passed: 492 test files and 6,636 tests, `vp check`, `vp run typecheck`, and `git diff
--check`. The final screenshot is retained as
`.superpowers/qa/provider-defaults-stability/final-evidence/uniform-controls-all-providers.png`.
