# Final Review Fix Report: Provider Terminal Actions

## Outcome

All four Important findings and all four Minor findings from the final whole-branch
review are addressed. There were no Critical findings.

The implementation keeps provider commands as structured executable/argument
values, prevents an older terminal operation or detached publisher from surviving
close/restart, requires a resolved live-thread working directory before center
panel creation, shares Windows shim launch policy, preserves intentional v1 panel
state, and returns a bounded/redacted spawn error. Follow-up review also hardened
the cancellation window between PTY spawn and session registration, every
post-spawn PTY backend setup failure, Windows batch argument transport, and
Windows process-tree ownership before a batch shim can create descendants. A
publication review after `c845eb594f` then found two remaining Important
ownership gaps: PowerShell/native Windows PTY targets were not gated before job
attachment, and Unix post-spawn setup cleanup owned only the root child rather
than its process group. Both gaps are now closed. Every Windows PTY target waits
behind the same job-attachment gate, and the post-spawn guard owns the Unix
process group or Windows job until ownership transfers to the live process. A
subsequent independent review found that waiter-thread creation moved the root
child out of that guard too early. The setup guard now retains a panic-safe
cloned Windows root killer and a validated Unix root PID until waiter creation
succeeds. Failure cleanup terminates the process group/job first and then the
root, using explicit Unix `SIGKILL`; successful transfer disarms the temporary
root tokens.

One platform-verification limitation remains: this host is macOS, so the five
new `#[cfg(windows)]` real-process regressions could not execute here. The actual
production Windows executable, job-object, PTY modules, unit tests, and Windows
integration test pass an isolated `x86_64-pc-windows-msvc` typecheck.
Host-independent Windows construction tests also pass, and the real shim,
gate-ordering, and descendant-kill regressions are checked in for a Windows
runner. The final independent re-review reports no remaining Critical or
Important PTY process-tree ownership or launch-order findings.

## Commits and Files

### `837768a1f5fa35c0b7df0509e0dadebab7735a39`

`fix(server): harden terminal session generations`

- `apps/server/src/terminal/manager.rs`

### `bfdbf2c31b20fab01619655911141c4678a0aa37`

`fix(server): share Windows provider launch policy`

- `apps/server/src/process/executable.rs`
- `apps/server/src/process/mod.rs`
- `apps/server/src/production/provider_inventory.rs`
- `apps/server/src/production/provider_runtime.rs`
- `apps/server/src/terminal/pty.rs`

### `c44d6889d9d8c1686e833c806125d02514a6942a`

`fix(web): require resolved provider terminal cwd`

- `apps/web/src/centerPanelStore.test.ts`
- `apps/web/src/centerPanelStore.ts`
- `apps/web/src/components/CenterTerminalPanel.test.tsx`
- `apps/web/src/components/CenterTerminalPanel.tsx`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.test.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx`
- `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx`
- `apps/web/src/components/chat/providerTerminalActions.test.ts`
- `apps/web/src/components/chat/providerTerminalActions.ts`
- `apps/web/src/lib/terminalLaunchCommand.ts`
- `apps/web/src/zero-coverage-routes.test.tsx`

### `9e2f1217857bdf237d5de7d6a66c949dd82d30c4`

`fix(contracts): add redacted terminal spawn errors`

- `apps/server/src/production/server_terminal.rs`
- `apps/server/src/terminal/mod.rs`
- `packages/contracts/src/terminal.ts`
- `packages/contracts/src/terminal.test.ts`
- `packages/contracts/fixtures/rpc-wire/manifest.json`
- six regenerated `packages/contracts/fixtures/rpc-wire/typed-failures/terminal__*.json`
  fixtures

### `dd012baa02c900f5d1874eb924f9677eec190128`

`fix(server): make provider launches failure-safe`

- `apps/desktop/src-tauri/src/main.rs`
- `apps/server/src/main.rs`
- `apps/server/src/process/executable.rs`
- `apps/server/src/process/mod.rs`
- `apps/server/src/production/provider_inventory.rs`
- `apps/server/src/production/provider_runtime.rs`
- `apps/server/src/provider_usage/mod.rs`
- `apps/server/src/terminal/manager.rs`
- `apps/server/src/terminal/pty.rs`
- `apps/server/tests/windows_terminal_shims.rs`

### `9ee43e1107dc10a73e6f67474de8aad26b7cb28b`

`fix(server): gate Windows process-tree startup`

- `apps/server/Cargo.toml`
- `apps/server/src/git/process.rs`
- `apps/server/src/process/executable.rs`
- `apps/server/src/process/mod.rs`
- `apps/server/src/process/windows_job.rs`
- `apps/server/src/production/provider_runtime.rs`
- `apps/server/src/terminal/pty.rs`
- `apps/server/tests/windows_terminal_shims.rs`

### `53ba79bbfe186e4426cc23992f3ec57a3497e79f`

`docs: design PTY process-tree ownership hardening`

- `docs/superpowers/specs/2026-07-19-pty-process-tree-ownership-design.md`

### `da2264568e9c4eceb2ddabf652f2038d53677be3`

`docs: plan PTY process-tree ownership hardening`

- `docs/superpowers/plans/2026-07-19-pty-process-tree-ownership.md`

### `2aecfba92212cf8724d6fe6c2856394276336a5b`

`fix(server): gate every Windows PTY launch`

- `apps/desktop/src-tauri/src/main.rs`
- `apps/server/src/main.rs`
- `apps/server/src/process/executable.rs`
- `apps/server/src/process/mod.rs`
- `apps/server/src/process/windows_job.rs`
- `apps/server/src/production/provider_runtime.rs`
- `apps/server/src/terminal/pty.rs`
- `apps/server/tests/windows_terminal_shims.rs`

### `953ee5ba1a0b41580d06764e4d282795ecdaa54a`

`fix(server): own PTY trees during spawn setup`

- `apps/server/src/terminal/pty.rs`

### `018c2e67f7afd5c52249e84ad8c3db7208b8befa`

`test(server): cover PTY descendant ownership`

- `apps/server/src/terminal/pty.rs`
- `apps/server/tests/windows_terminal_shims.rs`

### `77a37f07c76a1e588b0cb99a8879097c0e80a952`

`fix(server): retain PTY root through waiter startup`

- `apps/server/src/terminal/pty.rs`
- `apps/server/tests/windows_terminal_shims.rs`

### `b21862645816b6d0ba692920b5bbf960f3c5d50a`

`fix(server): preserve ordered PTY setup cleanup`

- `apps/server/src/terminal/pty.rs`

## Finding-by-Finding Changes and TDD Evidence

### Important 1: close versus an older attach-created launch

The manager now captures a per-key `SessionGeneration` at operation ingress.
`close` invalidates matching generations before it waits for the global lifecycle
mutex. Therefore an attach/open that began first but reaches creation after close
cannot spawn or register. A generation invalidated while a synchronous spawn is
in progress kills the returned process before registration or metadata
publication. A later deliberate reuse receives a new generation.

The deterministic tests hold the session-map read path to pause an older missing
attach, let close invalidate it, and then release it. A second test blocks inside
spawn and proves close invalidation kills the returned process.

RED:

```text
cargo test -p t4code-server --lib terminal::manager::tests
8 passed; 3 failed
```

The new missing-attach test observed an unexpected spawn, and the blocked-spawn
test observed an unexpected attachment before the generation coordination was
implemented.

GREEN:

```text
cargo test -p t4code-server --lib terminal::manager::tests
12 passed; 0 failed
```

### Important 2: Windows provider CLI shims

`launch_executable_extensions` and `wrap_launch_program` are now shared process
helpers used by provider-runtime discovery and PTY launch. Windows matching is
case-insensitive, fallback discovery includes `.ps1` even when `PATHEXT` omits it,
and `.ps1` launches through profile-free non-interactive PowerShell.

Native provider/background `.cmd`/`.bat` launches pass the script and structured
arguments directly to `std::process::Command`/Tokio. Rust's Windows implementation
constructs the command-processor invocation with delayed expansion disabled,
escapes batch metacharacters, and rejects invalid CR/LF arguments. The process
root is created suspended, attached to a kill-on-close Windows job, and resumed
only after successful attachment.

Portable PTY does not expose a pre-spawn creation-flags hook, so every Windows
PTY target starts the current T4Code executable with an internal marker, unique
supervision gate, ready-event name, prepared target executable, and target
arguments as structured argv. Both the server CLI and Tauri desktop entrypoints
recognize the marker. The target is prepared first using the shared shim policy:
`.cmd`/`.bat` uses the existing safe command-processor construction, `.ps1` uses
profile-free non-interactive PowerShell, and native executables stay direct. The
trampoline signals that it reached the gate and cannot start any prepared target
until the PTY parent has attached the trampoline root to its Windows job, made
the setup guard own that job, and signaled authorization. This avoids transport
environment variables that could clobber or leak caller state and prevents
PowerShell/native as well as batch descendants from escaping the terminal job
during the spawn window. Script paths containing spaces and `!` remain
structured values; script paths containing control characters are rejected.
Unix still launches the resolved executable directly.

RED:

```text
cargo test -p t4code-server --lib terminal::pty::tests
```

The test-first run exposed the missing `build_pty_command_on` construction seam
(`E0425`) and `.ps1` discovery returned `None` instead of the fixture. The
case-insensitive `PATHEXT` fixture also exposed the previous extension-policy
split. A follow-up metacharacter regression exposed raw `.cmd`/`.bat` arguments
after `/c`; the first environment-based correction was rejected during independent
review because it enabled delayed expansion in the target shim and reserved fixed
child-environment names. The replacement same-binary trampoline test initially
failed to compile because its marker/helper did not exist, then passed after the
transport was implemented. A later ownership-race regression began RED with
`E0061` because the PTY construction helper had no supervision gate; it passed
after the gate and ready-event protocol was added. Publication-review tests then
began RED because PowerShell and native commands still appeared as the PTY root
instead of the T4Code gate:

```text
windows_pty_launch_discovers_and_wraps_powershell_shims
actual argv[0]: powershell.exe; expected: t4code PTY trampoline

windows_pty_launch_gates_native_executables
actual argv[0]: provider.exe; expected: t4code PTY trampoline
```

Both pass after the generic PTY trampoline was applied to every prepared Windows
target.

GREEN:

```text
cargo test -p t4code-server --lib terminal::pty::tests
22 passed; 0 failed
```

The green suite covers host-independent `.cmd`/`.bat` and `.ps1` argv
construction, case-insensitive extensions, `.ps1` fallback discovery, relative
PATH behavior, Unix direct launch, caller-environment preservation, script-path
control-character rejection, and the existing PTY lifecycle. Provider
executable-resolution focused tests also pass. A `#[cfg(windows)]` integration
test uses the actual `t4code` binary to perform real PTY spawns of `.cmd`, `.bat`,
and `.ps1` shims. Its shim deliberately does not disable delayed expansion and
verifies spaces, `&`, `%PATH%`, `!literal!`, a path containing spaces/`!`, and an
unchanged caller-owned `T4CODE_INTERNAL_BATCH_SCRIPT` value. Four more Windows
tests prove that the generic trampoline reaches but cannot pass its supervision
gate before authorization, and that killing batch, PowerShell-shim, and native
terminals terminates each spawned PowerShell descendant.

Windows cross-target attempt:

```text
RUSTC="$(rustup which --toolchain 1.97.1 rustc)" \
  cargo check -p t4code-server --target x86_64-pc-windows-msvc --tests
```

The full server check passed Rust standard-library resolution and stopped while
building `aws-lc-sys` because this macOS host has no Windows SDK C headers. (An
earlier invocation accidentally selected a non-rustup compiler and produced
`E0463`; the explicit rustup compiler corrected that tool selection.) A temporary
isolated crate then imported the actual production `process/executable.rs`,
`process/windows_job.rs`, and `terminal/pty.rs` modules and successfully ran:

```text
RUSTC="$(rustup which --toolchain 1.97.1 rustc)" \
  rustup run 1.97.1 cargo check --offline \
    --target x86_64-pc-windows-msvc --tests
PASS
```

The final temporary check crate imported the actual Windows integration test
file, production executable, job-object, PTY modules, and their unit tests; all
passed the same target check. The temporary check crate and artifacts were
removed after verification. The real-process tests still require a Windows host.

### Important 3: worktree readiness

`resolveCenterPanelLaunchContext` is now the single readiness decision used by
chat-panel and terminal-panel creation. It requires a live server thread and
project CWD. Explicit local/project-root mode resolves to the project root;
worktree mode resolves only after `worktreePath` exists and never falls back to
the project root. `ChatView` computes this from the effective mode, including a
pending new-worktree override, disables the menu through the existing tooltip
affordance, guards callbacks, and passes the resolved launch context into
`CenterTerminalPanel`. The panel no longer independently invents a fallback CWD.

RED:

```text
vp test \
  apps/web/src/components/ChatView.logic.test.ts \
  apps/web/src/centerPanelStore.test.ts \
  apps/web/src/components/chat/providerTerminalActions.test.ts
66 passed; 7 failed
```

The new readiness cases had no resolver, so draft and pending-worktree behavior
could not satisfy the required results.

GREEN:

```text
vp test \
  apps/web/src/centerPanelStore.test.ts \
  apps/web/src/components/CenterTerminalPanel.test.tsx \
  apps/web/src/components/ChatView.logic.test.ts \
  apps/web/src/components/ChatView.test.tsx \
  apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/zero-coverage-routes.test.tsx
126 passed; 0 failed
```

The cases cover a local draft, a live server thread waiting for its new worktree,
and ready project-root and worktree threads, plus the disabled menu reason and
null-context panel behavior.

### Important 4: invalidate every detached session publisher

Every output, activity, and exit supervisor captures its session generation.
Mutation and event/metadata publication are serialized by a per-generation
publication mutex and rejected after invalidation. `close` invalidates/cancels
the generation, then waits for that generation's publication gate before removing
the pointer-identical session and publishing `Closed`/metadata removal. This keeps
the hot output path local to one session; there is no global output publication
mutex.

The deterministic regression pauses old-generation output before publication,
closes and reopens the same key, releases the stale output, and proves it is
discarded while replacement output is accepted.

RED:

```text
cargo test -p t4code-server --lib terminal::manager::tests
8 passed; 3 failed
```

The stale-output regression received the old generation's high-sequence output
after replacement.

GREEN:

```text
cargo test -p t4code-server --lib terminal::manager::tests
12 passed; 0 failed
```

### Minor 1: explicit activity-test completion

Test-only generation completion tokens acknowledge output/activity supervisor
termination. The race coverage waits on the acknowledgement rather than inferring
completion from 100 ms of silence. Same-key replacement and stale-output release
are covered by the Important 4 regression.

RED/GREEN evidence is the manager suite above.

### Minor 2: v1 to v2 center-panel migration

Migration records whether the host surface was actually persisted before
normalizing/deduplicating. It preserves explicit empty state and host-closed state
with sibling surfaces, while ordinary host-present state retains host-first
ordering. Launch metadata is still sanitized.

The web RED bundle above failed because migration resurrected the host; the GREEN
bundle covers empty, host-closed-with-siblings, and ordinary host-present v1
states.

### Minor 3: spawn error mapping

The contract adds `TerminalSpawnError` with a non-empty reason bounded to 512
characters. Rust maps `TerminalError::Spawn` explicitly to the fixed generic
reason `Terminal process could not be started.` and never serializes the attempted
path, process error, token, or other spawn detail. Existing terminal error mappings
remain explicit. Rust RPC fixtures were regenerated because the union fingerprint
changed.

RED:

```text
vp test packages/contracts/src/terminal.test.ts
34 passed; 2 failed
```

The decoder rejected the unknown spawn-error tag before the contract existed, and
the over-bound reason assertion had no matching schema path.

```text
cargo test -p t4code-server --lib \
  production::server_terminal::tests::terminal_spawn_errors_are_explicit_bounded_and_redacted
0 passed; 1 failed
```

The old mapping returned `TerminalCwdStatError` and exposed the spawn cause.

After the schema change, RPC parity initially reported fingerprint mismatches for
the six terminal typed-failure fixtures. They were regenerated with:

```text
vp run generate:rust-rpc-fixtures
```

from `packages/contracts`.

GREEN:

```text
vp test packages/contracts/src/terminal.test.ts
36 passed; 0 failed
```

```text
cargo test -p t4code-server --lib \
  production::server_terminal::tests::terminal_spawn_errors_are_explicit_bounded_and_redacted
1 passed; 0 failed
```

```text
vp test \
  packages/contracts/src/rpcRustParity.test.ts \
  packages/contracts/src/terminal.test.ts
37 passed; 0 failed
```

### Minor 4: provider action command bounds

Provider terminal actions now use the shared Effect Schema decoder for
`TerminalLaunchCommand` before an action can be enabled, persisted, or launched.
Invalid executable/argument-count/argument-length/label values keep the menu item
visible but disabled with a reason. The same decoder sanitizes persisted terminal
surface commands.

The web RED bundle above lacked the decoder and failed the executable, argument,
count, and label boundary cases. The GREEN bundle passes at-boundary values and
rejects each one-past-boundary value, including an oversized configured binary
path and display-derived label.

## Follow-up Independent Review Hardening

An independent review of the eight finding fixes identified two additional
process-ownership windows and rejected the first metacharacter transport:

1. Cancellation after `PtyBackend::spawn` returned but before registration could
   drop the open future without killing the new process. `UncommittedPtyProcess`
   now owns that process until it is registered and supervised; every early
   return, cancellation, or unwind kills it. The deterministic RED test failed
   with `abandoned process was not killed`; the GREEN manager suite passes 12/12.
2. `PortablePtyBackend` could leak a child if process-id/job/reader/writer/thread
   setup failed after `spawn_command`. `SpawnedChildGuard` now kills on every
   post-spawn failure and transfers ownership only inside the successfully
   created wait thread. The guard test was introduced RED (the guard type did not
   exist) and passes GREEN.
3. The original `/v:on` plus fixed-environment-name transport was rejected because
   delayed expansion would alter ordinary target shims and reserved names would
   overwrite/leak caller state. It was removed completely in favor of the
   same-binary structured-argv trampoline described under Important 2.
4. A second review found that the batch trampoline could start its target before
   the PTY parent attached the trampoline process to a job, allowing a descendant
   to escape kill-on-close ownership. PTY batch launches were first changed to
   wait on a named authorization gate until after attachment. The later
   publication review generalized that gate to every Windows PTY target, as
   recorded below. Native/process-wrap background launches use
   `CREATE_SUSPENDED`, attach the root to a job, and resume its thread only after
   successful attachment. The provider inventory's Git process runner uses the
   same supervised background policy.
5. Final re-review found two test-only timing assumptions. The gate regression now
   waits for an explicit child ready event instead of 300 ms of silence, and the
   descendant regression subscribes to exit before issuing kill. The final
   independent verdict reports no Critical, Important, or Minor findings.

The close-during-spawn regression also now explicitly waits until the operation's
generation reports invalidation before allowing the backend to return, removing a
remaining scheduler-timing assumption.

## Publication-Review Ownership Blockers

A publication review after `c845eb594f` identified two additional Important
process-tree ownership gaps. Both were reproduced test-first and fixed:

1. `.ps1` and native Windows PTY launches bypassed the batch-only gate, so user
   code could create a descendant before the root joined its job. The two new
   host-independent construction tests failed with PowerShell/native as the
   direct PTY root. Launch preparation is now separate from supervision wrapping:
   every prepared Windows target is carried as structured argv through one
   generic same-binary trampoline, the setup guard owns the attached job, and
   only then does the parent signal authorization.
2. A Unix failure after `spawn_command` owned only the root child even though the
   PTY had already established a process group. A deterministic real-process
   regression created a HUP-resistant descendant, forced setup failure, and
   began RED when that descendant remained alive for the full three-second
   assertion. `SpawnedChildGuard` now captures the Unix process-group ID
   immediately after spawn and kills the group before the root on every setup
   failure. On Windows the same guard owns the attached job before the target
   gate opens. Tree ownership transfers to `PortablePtyProcess` only after the
   wait thread is successfully established.

The Windows-only integration tests now cover real descendant cleanup for batch,
PowerShell-shim, and native PTY targets. A target-only compilation first exposed
and fixed a Windows `cfg` tail-expression error in `build_pty_command`; the final
isolated `x86_64-pc-windows-msvc` check compiled both the actual production
modules and the actual integration test.

The independent review of those fixes found one further Important handoff gap:
`take_child()` removed the root fallback from `SpawnedChildGuard` before
`thread::Builder::spawn` had succeeded. If waiter creation failed and Unix group
discovery or termination was unavailable, dropping the raw child did not
guarantee termination. The injected regression began RED with the missing
`handoff_child_to_waiter` and `spawn_pty_thread_with` seam (`E0599`/`E0425`).
The first fix carried a kill-on-drop child into the waiter task, but re-review
showed that a failed thread spawn would kill the root before the outer guard
terminated the process group/job. The final design instead keeps the fallback in
the outer guard: it clones the killer before taking the raw child, retains the
validated Unix root PID, terminates the process group/job first, and then
`SIGKILL`s the Unix root or uses the Windows cloned handle. The clone-before-take
ordering leaves the raw child guarded even if Windows handle duplication panics.
Successful waiter creation commits the group/job and disarms both temporary root
tokens.

Three more deterministic regressions cover this path:

1. Injected waiter-spawn failure proves root cleanup stays with the outer guard.
2. A cleanup observer proves the exact `tree`, then `root` order.
3. A real HUP-resistant Unix root with no process-group token survives raw-child
   drop but is terminated by the guard's explicit root `SIGKILL`.

The clone-panic regression began RED with the panic caught but the root-killed
flag still false; the fixed clone-before-take order passes. The HUP-resistant
regression began RED at the missing root-PID ownership seam and passes after PID
capture and explicit `SIGKILL`. The same review's Minor PID-file race was removed
by polling until the fixture file contains a parseable PID rather than returning
as soon as the path exists. The final independent re-review reported no Critical
or Important PTY ownership or launch-order findings.

## Lifecycle and Locking Self-Review

The intended lock order is:

1. Capture/invalidate the generation through the short synchronous generation
   registry mutex.
2. Serialize create/restart/close decisions with the manager lifecycle mutex.
3. Serialize one generation's mutations/publications with its publication mutex.
4. Access the session map, then an individual session when required.

Detached publishers never acquire the global lifecycle mutex or the session-map
lock. They acquire only their generation's publication mutex and their own
session. Close invalidates before waiting for lifecycle ownership, then waits for
the affected generation's publication mutex before removing the session. This
prevents post-removal publication without putting unrelated high-volume terminal
output behind one global lock.

The post-spawn invalidation checks cover both the interval immediately after the
backend returns and the final publication/registration gate. A process returned
for an invalidated generation is killed. Independently, the uncommitted-process
guard owns any successfully spawned process until registration and supervision,
so task cancellation cannot bypass cleanup. Replacement removal is pointer-checked
so an old close path cannot remove a newer session with the same key. Inside the
portable backend, a second guard covers all child setup before the wait thread
is established. It captures the Unix process group immediately after spawn or
owns the attached Windows job before authorization, then transfers that tree
token to the live process only after wait-thread setup. Before taking the raw
child for the waiter task, the guard clones the root killer while the original
child remains protected and records the validated Unix root PID. A failed waiter
creation therefore leaves the outer guard responsible for process-group/job
termination followed by the root fallback; a successful creation disarms these
temporary tokens only as tree ownership transfers.

On Windows, no portable-PTY target can start until its already-spawned trampoline
root belongs to the terminal job and the setup guard owns that job. Every
supervised native background root is suspended before user code runs, attached
to a job, and only then resumed. Attachment/resume failures terminate both the
job and root. The job's `KILL_ON_JOB_CLOSE` policy covers descendants on explicit
kill and on later setup failures. On Unix, setup failure targets the process
group before explicitly `SIGKILL`ing the captured root PID, covering
HUP-resistant roots and descendants even when group discovery or termination
fails.

## Full Verification

Focused and integrated checks:

```text
cargo test -p t4code-server --lib
283 passed; 0 failed
```

```text
vp test <nine affected web/contracts test files>
163 passed; 0 failed
```

Required final gates:

```text
cargo test -p t4code-server --lib terminal::manager::tests
12 passed; 0 failed
```

```text
cargo test -p t4code-server --lib terminal::pty::tests
22 passed; 0 failed
```

```text
cargo test -p t4code-server --test production_server_terminal_rpc
5 passed; 0 failed
```

```text
vp test
481 files passed; 6,342 tests passed
```

The first full `vp test` attempt had one transport-level failure in
`scripts/mock-update-server.test.ts` (`UND_ERR_SOCKET`) while 6,341 tests passed.
The failing file immediately passed 13/13 in isolation, and the immediate full
rerun passed 6,342/6,342. This is recorded as unavoidable baseline/flaky-network
noise; no source change was made for it.

```text
vp check
All 1,536 files correctly formatted.
No warnings or lint errors in 1,162 files.
```

```text
vp run typecheck
PASS (11 workspace tasks; 0/11 cache hits)
```

Typecheck emitted the repository's existing non-failing `TS377098` suggestions
about finite-number schemas. It reported no type errors.

```text
cargo clippy -p t4code-server --all-targets -- -D warnings
PASS
```

```text
cargo check -p t4code-desktop
PASS
```

```text
git diff --check fa28ef67db..HEAD
PASS
```

## Remaining Concern

The implementation is ready subject to one explicit platform caveat: a Windows
runner still needs to execute
`portable_backend_runs_windows_command_and_powershell_shims`,
`pty_trampoline_waits_for_the_parent_supervision_gate`,
`killing_a_batch_terminal_terminates_its_descendant_process`,
`killing_a_powershell_shim_terminal_terminates_its_descendant_process`, and
`killing_a_native_windows_terminal_terminates_its_descendant_process`. The macOS
host validated exact Windows argv construction, cross-platform behavior, and
cross-compiled the actual Windows-specific production modules and integration
test, but cannot prove `cmd.exe`/PowerShell/ConPTY runtime behavior. No code,
test, lint, typecheck, or wire-parity failure remains on the available host.
