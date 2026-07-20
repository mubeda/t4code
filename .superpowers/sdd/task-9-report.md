# Task 9 Report: Resource Attribution Documentation and Verification

## Scope

Task 9 started from `bb576e1f32c7a3a6daa4620c98eab96f4e945604`.

- Updated `docs/operations/observability.md` with the implemented
  Combined/Core/External model, host scoping, UI-coverage states, launcher
  registration and fallback behavior, PID/start identity, last-good/stale
  behavior, and signal safeguards.
- Verified the existing desktop runtime harness rather than adding a second CPU
  implementation. Its summary already contains idle process count,
  private-memory or POSIX RSS approximation, working set, highest-memory
  processes, and the exact process IDs needed for cleanup checks.
- Added the 15 vendored `portable-pty` manifest dependencies to the dependency
  upgrade ledger after the full repository test exposed the missing Task 6
  integration. These entries remain `pending`; this task did not perform or
  claim a dependency audit.
- Corrected a branch-exposed Rust test-stack overflow in the shared supervised
  process reader. The correction changes scratch-buffer storage only, not
  process output limits, truncation, read semantics, or cleanup behavior.

## Documentation Result

The operations guide now states that:

- Combined is exactly T4Code Core plus External Tooling for the selected host.
- A remote environment reports only the remote host. An always-present local
  desktop environment may appear separately as This device and is never folded
  into the remote total.
- `available`, `partial`, `unavailable`, and `notApplicable` qualify desktop UI
  coverage. The initial desktop adapter reports UI usage unavailable instead of
  estimating from process names.
- Production provider and terminal roots own descendants by nearest-root
  attribution. The schema reserves the `helper` kind, but no production helper
  launcher currently registers it. Native-server descendants without a
  registered provider or terminal ancestor remain visible as
  External/unknown/fallback rather than silently becoming Core.
- PID plus operating-system start identity prevents ownership transfer on PID
  reuse.
- A refresh failure retains and marks the last good sample stale; the initial
  failure renders unavailable placeholders rather than zeroes.
- Core rows cannot request Interrupt or Kill. External requests are resampled
  and revalidated by the server immediately before signaling.
- The native sampler remains the only source of CPU and memory data.

## Measurement Harness and Packaged macOS Result

`vp test scripts/measure-desktop-runtime.test.ts` passed 33/33 tests.
No harness code changed.

`vp run build:desktop` completed successfully and produced:

- `target/release/t4code-desktop` (about 25 MiB);
- `target/release/bundle/macos/T4Code (Alpha).app`;
- `target/release/bundle/dmg/T4Code (Alpha)_0.2.2_aarch64.dmg`
  (about 12 MiB).

The command copied literally from the brief, with `--` before the measurement
arguments, failed before launch because Vite+ forwarded the separator and
Node's strict argument parser treated `--label` as positional. The repository's
working invocation omits that separator.

The working macOS measurement was:

```text
vp run measure:desktop-runtime --label resource-attribution-macos --command target/release/t4code-desktop --ready-url http://127.0.0.1:3773/.well-known/t4code/environment --idle-ms 30000
```

It passed in 33.11 seconds and reported:

- root PID `11318`;
- startup `520.672125 ms`;
- one idle process;
- `188,760,064` bytes private memory using the documented
  `rss-approximation` metric;
- `188,760,064` bytes working set;
- the T4Code desktop root as the highest-memory process;
- recorded process IDs `[11318]`.

After harness cleanup, exact PID lookup, executable lookup, and the listener on
port 3773 were all absent. A window-title readiness run was also attempted, but
the POSIX process parser exposed an empty `mainWindowTitle` and the harness
timed out after about 123 seconds; its recorded process and listener were still
cleaned up. Ready-URL readiness was therefore used for the valid measurement.

The packaged app was then launched with an isolated
`T4CODE_HOME=/tmp/t4code-task9-ui.CBtSy6`. The Tauri UI initially appeared
white to automation because the window was tiny; maximizing it confirmed that
the UI was rendered. Tauri's embedded custom-scheme assets completed in WebKit
logs. The server's HTTP `/` response of `503 No static directory configured and
no dev URL set` is expected for this packaged topology; the environment
readiness endpoint remained HTTP 200.

Before final shutdown, the packaged root was PID `15146` and its live terminal
shell descendant was PID `25501`. After SIGTERM, both exact PIDs were absent
and port 3773 had no listener.

## Packaged Manual Checks

At 1296 by 768 in the packaged macOS app:

- The status popover showed parallel Combined, Core, and External cards. At
  idle it showed approximately 187–190 MiB Combined, the same Core value, zero
  External, an explicit unavailable UI-coverage warning, and the Core server as
  the highest consumer.
- Diagnostics Live showed separate Combined/Core/External summaries. The Core
  row had no signal control. A transient `/usr/bin/security` process appeared
  as External fallback with eligible controls and disappeared after exit.
- History retained External processes separately (including opencode, Claude,
  and unregistered fallback descendants) while Core remained the server.
  Memory/CPU switching, sortable headers, dark theme, truncation, and overflow
  layout were visually usable. One observed CPU sample reconciled exactly:
  Combined `9.0%` = Core `4.8%` + External `4.2%`.
- Adding the current worktree as a project and opening Terminal 1 showed Core
  server `204.8 MiB / 3.2% / 1 process` and External terminal shell
  `3.6 MiB / 0% / 1 process`.
- A bounded terminal Python workload allocated 100,000,000 bytes and ran a
  20-second CPU loop. During load, Combined was
  `314.1 MiB / 102.9% / 3`, Core stayed
  `206.5 MiB / 2.7% / 1`, and External rose to
  `107.6 MiB / 100.2% / 2`; the Python row accounted for
  `103.7 MiB / 100.1%` and zsh for about `3.9 MiB`.
- After the load process exited, Combined fell to
  `211.1 MiB / 4.3% / 2`; the terminal shell remained until app shutdown.

No paid or external provider prompt was sent, avoiding unapproved API spend and
data transmission. Provider exact-root/descendant attribution was initially
covered by automated backend tests only. The correction pass below records the
separate zero-network packaged-provider attempt and its outcome.

Polling cadence was not instrumented manually in the packaged app. Source and
tests show that the always-mounted status bar owns the intended two-second
current-resource refresh; its existing 30-second usage refresh also requests
current diagnostics. Resource Manager does not add an independent timer, and
the server serializes/cache-coalesces reads inside the native sample interval.
Consequently, the brief's literal “no diagnostics polling while Resource
Manager is closed” check was not confirmed and does not describe the
always-mounted status-bar consumer. No second machine-wide process refresh or
independent desktop-UI observer loop exists.

Windows and Linux packaged checks were not run on this macOS host. Both remain
required pre-release checks using the same idle/load, attribution, signal,
coverage, polling, and cleanup checklist. Unit tests are not presented as
cross-platform packaged verification.

## Packaged Provider Correction Pass

The correction pass exercised the production provider launcher in the exact
packaged worktree bundle without a paid or external provider request. The app
ran as PID `80100` with an isolated
`T4CODE_HOME=/tmp/t4code-task9-provider.YCYTVj/state`. Both the persisted Codex
`binaryPath` and `CODEX_BIN` resolved to the absolute temporary fixture shim,
and `CODEX_HOME` pointed to an empty temporary directory. The fixture speaks the
Codex app-server JSONL protocol over stdio, makes no network requests, and
starts a bounded local Node child only after `thread/start`.

Before that safe launch, an initial attempt exposed that the status-bar usage
probe resolves `CODEX_BIN` or `PATH` independently of provider settings and
briefly started the real Codex executable. That process was identified by its
usage-probe arguments and terminated before any thread or turn was sent. The
packaged app was relaunched with the explicit fixture `CODEX_BIN` and empty
`CODEX_HOME`; the successful run below used only the temporary fixture.

Adding the temporary Git project and sending a deterministic prompt through the
normal packaged UI completed a real provider session in 3 ms and rendered
`T4Code deterministic streamed fixture response.` The launcher process and its
load descendant were:

- PID `86600`, PPID `80100`: Node running
  `provider-shims/codex-fixture.mjs ... app-server`;
- PID `86625`, PPID `86600`: the fixture's 100,000,000-byte allocation and
  bounded CPU loop.

At about 11 seconds, `ps` reported the root at 48,320 KiB RSS and 0% CPU and the
child at 146,208 KiB RSS and 99.9% CPU. Resource Manager reconciled the same
sample as Combined `344.1 MiB / 101.8% / 3` = Core
`154.2 MiB / 1.3% / 1` + External `190.0 MiB / 100.4% / 2`. The highest
consumers were the External Codex child at `142.8 MiB / 100.4%` and External
Codex root at `47.2 MiB / 0%`; the server stayed Core.

Diagnostics Live independently showed Combined
`344.6 MiB / 89.2% / 3` = Core `154.6 MiB / 1.4% / 1` + External
`190.0 MiB / 87.8% / 2`. Both fixture PIDs were External,
`kind=provider`, `label=codex`, and signalable; the Core server was not
signalable. The registered root has exact confidence and the child inherits the
nearest registered root. The UI exposes scope/kind/label rather than the
confidence enum, so the confidence distinction was corroborated by the exact
PID/PPID ancestry and production registration semantics. History also
reconciled approximately `34.1 s` Combined CPU = `5.44 s` Core + `28.6 s`
External and a same-sample `344.6 MiB` peak = `154.6 MiB` Core +
`190.0 MiB` External. The UI-coverage-unavailable warning remained explicit in
both views.

The initial provider cleanup check failed: after terminating app PID `80100`,
the app and port 3773 were absent, but zero-network fixture provider PID `86600`
and child PID `86625` survived for more than 10 seconds. Terminating the exact
fixture root then removed both.

Commit `64c9633626` added graceful SIGTERM handling, and the follow-up
supervisor-lifecycle correction in the same provider-shutdown work closes the
reviewed concurrent-stop and start-versus-stop races. The complete diagnosis,
RED/GREEN evidence, and verification are in the
[provider shutdown cleanup report](provider-shutdown-cleanup-report.md).

The earlier attribution and load measurements above used only the zero-network
fixture. The post-fix live cleanup proof was a separate run that accidentally
launched the real installed Codex provider: its local turn was stopped as soon
as the mismatch was recognized, and SIGTERM of only desktop PID `33630` removed
that desktop, provider PIDs `42216` and `43498`, and port 3775 while unrelated
installed T4Code PID `13930` remained alive. That run is cleanup evidence only;
it is not represented as fixture or zero-network attribution evidence.

## Supervised Process Stack Regression

The first full `cargo test -p t4code-server` attempt aborted in
`production::git_vcs::tests::native_git_vcs_service_covers_repository_lifecycle_and_validation_paths`
with a stack overflow. The exact default-stack test reproduced the abort.

The unchanged test passed at implementation base `0a2c4ed826`, Task 6 commit
`e821ffe98c`, contracts commit `0f78c77f27`, diagnostics commit `1e8af71330`,
and ownership commit `dd76c8beac`. It first failed at
`0f054caad2`, which introduced the shared supervised process runner.
The current test passed unchanged with `RUST_MIN_STACK=33554432`, isolating the
failure to async/test-thread state size rather than recursive Git behavior.

`collect_output` held an inline `[u8; 8192]` across an await. The supervisor joins
two such reader futures inside another async select, and that state was embedded
through the Git RPC lifecycle future. A focused RED test measured one
`collect_output` future at 8,336 bytes and asserted that it remain below the
8 KiB inline-buffer boundary.

The fix heap-backs the same 8 KiB scratch buffer with a `Vec`. The focused
future-size test passed, and the formerly crashing Git lifecycle test passed on
the default stack in 1.93 seconds. Focused follow-up results:

- supervised unit tests: 7/7 passed;
- process-runner integration tests: 13/13 passed;
- Git integration tests: 19/19 passed;
- Git unit filter: 2/2 passed.

The final full server run passed with exit 0 in 128.83 seconds: the main library
binary passed 325/325 tests and every integration binary passed.

## Dependency Ledger Integration

The first full `vp test` run failed only the dependency-ledger validation and
reported exactly 15 missing `third_party/portable-pty/Cargo.toml` registry
dependencies. A focused RED reproduced that list. The ledger now has one entry
per manifest inventory key, grouped under `vendored-portable-pty`, with
platform applicability and update policy pointing to
`third_party/portable-pty/UPSTREAM.md`. The expected registry inventory count
changed from 51 to 66.

The correction pass made the ledger's `inventorySummary` authoritative. A RED
test changed each of its six fields in turn and demonstrated that the validator
previously accepted every stale value. The validator now compares all six
declared counts with fresh repository discovery, and the repository test
compares the complete summary object instead of pinning individual counts.

Fresh discovery reports:

- JavaScript direct entries: 79;
- JavaScript ledger keys: 78;
- Rust registry entries: 66;
- Rust path entries: 1;
- GitHub Actions references: 9;
- toolchain entries: 9.

The focused ledger suite passed 11/11 tests and
`vp run check:dependency-ledger` reported zero unaccounted inventory entries.
No `current` audit status was fabricated; all new vendored entries remain
`pending`.

## Automated Verification

Completed before the final commit:

- `vp test scripts/measure-desktop-runtime.test.ts`: 33/33 passed.
- `vp test packages/contracts/src/rpcRustParity.test.ts`: 3/3 passed.
- Status-bar focused suite: 37/37 passed.
- Diagnostics-settings focused suite: 78/78 passed.
- Dependency-ledger focused suite: 11/11 passed.
- `cargo test -q -p t4code-server`: passed with zero failures.
- `vp test`: 482/482 files and 6,375/6,375 tests passed.
- `vp run typecheck`: passed.
- `vp check`: passed.

The web test output included existing localStorage warnings; no test failed.

## Final Invariant Review

- Production code has no reads of legacy `totalRssBytes`, `totalCpuPercent`,
  `topProcesses`, or `isServerRoot` resource-contract fields.
- No generic executable-name attribution was added for WebContent, browser, or
  renderer processes.
- Attribution consumes one native sample; the monitor serializes refreshes and
  reuses samples inside the interval. Resource Manager and desktop UI
  observation add no independent polling or process-refresh loop.
- Core rows cannot construct signal mutations, and the server revalidates
  identity, ancestry, and eligibility for External requests.
- No generated contract fixture changed in Task 9.
- The measurement harness has a single cleanup owner and exposes the exact
  recorded PIDs needed for post-cleanup liveness checks.

## Files

- `apps/server/src/process/supervised.rs`
- `docs/operations/observability.md`
- `docs/dependency-upgrades/2026-07-17-ledger.json`
- `scripts/check-dependency-upgrade-ledger.ts`
- `scripts/check-dependency-upgrade-ledger.test.ts`
- `.superpowers/sdd/task-9-report.md`

The ignored `.superpowers/sdd/progress.md` coordination ledger was preserved
and was not staged.
