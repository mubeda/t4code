# 85 Percent Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Raise the repository-wide TypeScript and Rust coverage gates to 85% in every configured metric while preserving the current production-source inventory and adding deterministic behavioral tests.

**Architecture:** Treat coverage as two independently measured systems. Close the TypeScript gap with hook, component, relay, and fixture-exporter tests; close the Rust gap with lifecycle-oriented provider, desktop, VCS, and runtime tests. Keep production changes limited to small dependency-injection seams that make real behavior observable without network, process, keychain, updater, or window side effects. Raise the configured gates only after a clean report proves every metric is at or above 85%.

**Tech Stack:** Vite+, Vitest/V8 coverage, React Testing Library, Effect 4, Rust, Cargo, `cargo-llvm-cov`, Tokio, Axum, Tauri test doubles.

## Global Constraints

- TypeScript must reach at least 85% statements, branches, functions, and lines.
- Rust must reach at least 85% regions, functions, and lines.
- Preserve the production-source inventories in `coverageInclude` and the Cargo workspace. Do not add source exclusions, ignore pragmas, generated no-op calls, or tests whose only purpose is to execute lines without asserting behavior.
- Prefer tests at existing public or crate-visible seams. Extract a production seam only when nondeterministic I/O otherwise prevents a bounded test.
- Every asynchronous test must use fake time, a bounded timeout, a scripted peer, or an in-memory implementation; no live network, provider binary, OS credential store, updater endpoint, SSH host, or GitHub dependency is allowed.
- Keep `packages/contracts` schema-only. Any new runtime test utility belongs beside the consuming app or in `packages/shared` when both server and client need it.
- Run focused tests after each behavioral slice, run the relevant language coverage checkpoint after each cohort, and run `vp check` plus `vp run typecheck` before completion.
- Commit after each green cohort. Never commit `coverage/`, `target/llvm-cov*`, or other generated reports.

## Measured Baseline and Required Gain

The baseline was collected on 2026-07-16 with the unchanged source inventory.

| System | Metric | Baseline | Covered / Total | Minimum additional covered items at the current denominator |
| --- | --- | ---: | ---: | ---: |
| TypeScript | Statements | 81.49% | 30,770 / 37,756 | 1,322 |
| TypeScript | Branches | 75.27% | 21,009 / 27,909 | 2,715 |
| TypeScript | Functions | 77.71% | 7,196 / 9,259 | 675 |
| TypeScript | Lines | 82.47% | 29,018 / 35,183 | 889 |
| Rust | Regions | 77.09% | 48,491 / 62,904 | 4,978 |
| Rust | Functions | 73.40% | 3,731 / 5,083 | 590 |
| Rust | Lines | 79.35% | 36,020 / 45,396 | 2,567 |

Because small testability refactors can change denominators, these counts are planning guides. The acceptance criterion is the percentages from a fresh complete report.

---

### Task 1: Reproduce and Preserve the Coverage Baseline

**Files:**

- Read: `vite.config.shared.ts`
- Read: `scripts/check-rust-coverage.ts`
- Read: `scripts/coverage-config.test.ts`
- Read: `scripts/check-rust-coverage.test.ts`
- Generate locally: `coverage/coverage-final.json`
- Generate locally: `target/llvm-cov-report.json`

- [ ] Run the existing policy tests and confirm the current inventory and 74% gates are internally consistent:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts
```

Expected result: the existing policy tests pass. No source inventory or threshold file changes in this task.

- [ ] Run `PATH="$PWD/node_modules/.bin:$PATH" vp test --coverage` and confirm the TypeScript totals match the baseline table within ordinary instrumentation drift.
- [ ] Run the two Rust report commands from Task 10 and confirm the Rust totals match the baseline table within ordinary instrumentation drift.
- [ ] Treat the difference from 85% in each metric as the red acceptance state. Preserve both JSON reports locally for hotspot selection, but do not stage them.
- [ ] Verify the existing Rust command contains the complete ordered argument tail:

```ts
"--fail-under-lines", "74",
"--fail-under-functions", "74",
"--fail-under-regions", "74",
"--jobs", "1",
```

---

### Task 2: Cover TypeScript Query-State Branches

**Files:**

- Create: `apps/web/src/state/queries.test.tsx`
- Test: `apps/web/src/state/queries.ts`
- Reference: `apps/web/src/components/BranchToolbarBranchSelector.test.tsx`
- Reference: `apps/web/src/components/ChatView.hooks.test.tsx`

**Interfaces under test:**

- `useThreadDetail()`
- `useBranches()`
- `usePaginatedBranches()`
- `useComposerPathSearch()`
- `useCheckpointDiff()`

- [ ] Build a minimal React hook harness that renders the hook result into a captured variable and rerenders when the target changes.
- [ ] Mock `useEnvironmentThread`, `useEnvironmentQuery`, `useAtomValue`, environment descriptor factories, and `appAtomRegistry.refresh` at module boundaries. Return descriptors carrying their operation and input so every assertion verifies the exact request rather than an opaque mock call count.
- [ ] Test `useThreadDetail` for ready, synchronizing, deleted, and error states, including `Option.none()` to `null` conversion.
- [ ] Test `useBranches` with a disabled target, whitespace-only query, and trimmed query. Assert the limit is `100` and blank queries omit the `query` property.
- [ ] Test paginated branches with two pages containing a duplicate ref name. Assert stable de-duplication, maximum `totalCount`, first-page repository flags, last-page cursor, aggregate pending state, and duplicate-cursor suppression.
- [ ] Test paginated failure causes for a non-empty `Error.message`, an empty `Error.message`, and a non-`Error` cause; the latter two must return `"Failed to load refs."`.
- [ ] Test `refresh()` resets pagination and refreshes the first-page atom, while an empty target performs neither action.
- [ ] Use `vi.useFakeTimers()` for `useComposerPathSearch`. Assert no request before 120 ms, the request at 120 ms with limit `80`, pending state while normalized and debounced queries differ, whitespace trimming, disabled empty queries, and timer cancellation on target replacement/unmount.
- [ ] Test `useCheckpointDiff` for disabled/incomplete targets, `fromTurnCount === 0` full-thread diffs, nonzero turn diffs, whitespace flag propagation, and `{ enabled: false }`.
- [ ] Run the focused test:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test apps/web/src/state/queries.test.tsx
```

Expected result: all query-state cases pass with no real RPC or timers left pending.

- [ ] Commit the cohort:

```bash
git add apps/web/src/state/queries.test.tsx
git commit -m "test: cover query state behavior"
```

---

### Task 3: Make Fixture Exporters Deterministic and Directly Testable

**Files:**

- Create: `packages/contracts/scripts/rustFixtureExporter.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Modify: `packages/contracts/scripts/export-rust-auth-fixtures.ts`
- Create: `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
- Create: `packages/contracts/scripts/export-rust-auth-fixtures.test.ts`
- Verify generated fixtures: `packages/contracts/fixtures/rpc-wire/**`
- Verify generated fixtures: `packages/contracts/fixtures/auth-http/**`

**Production seam:**

Extract only filesystem/formatter orchestration into a shared helper. Schema construction, fingerprints, fixture values, method counts, and route reflection remain in their current scripts.

```ts
export interface FixtureExporterServices {
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly writeText: (path: string, value: string) => Promise<void>;
  readonly formatDirectory: (path: string) => number | null;
}

export function writeFixtureTree(
  outputDirectory: string,
  files: ReadonlyMap<string, string>,
  services?: Partial<FixtureExporterServices>,
): Promise<void>;

export function exportRpcFixtures(options?: {
  readonly outputDirectory?: string;
  readonly services?: Partial<FixtureExporterServices>;
}): Promise<void>;

export function exportAuthFixtures(options?: {
  readonly outputDirectory?: string;
  readonly services?: Partial<FixtureExporterServices>;
}): Promise<void>;
```

- [ ] Add failing unit tests for `writeFixtureTree`: deterministic lexical write order, nested-directory creation, trailing-newline preservation, formatter success, formatter nonzero status, and formatter `null` status.
- [ ] Implement the helper with Node defaults and injected test services. Keep `NodeChildProcess.spawnSync` configured with `shell: false` and repository-root `cwd`.
- [ ] Refactor each exporter to build its complete `ReadonlyMap<string, string>` and call its exported entry function. Guard the CLI invocation with `if (import.meta.main)`. Do not change file names, manifests, schema samples, seeds, expected method/shape counts, or fingerprints.
- [ ] Test the RPC exporter through a temporary output directory. Assert 80 methods, 14 stream methods, 54 stream-shape fixtures, 122 typed-failure fixtures, 22 orchestration event shapes, the three known stale method identifiers, sorted fixture paths, and byte-for-byte stable output across two runs.
- [ ] Test the auth exporter through a temporary output directory. Assert the ten route manifests in declared order, unique response/error shapes, stable SHA-256 fingerprints, all request/response/error samples, sorted fixture paths, and byte-for-byte stable output across two runs.
- [ ] Add negative tests by injecting a failed formatter and a rejected write. Assert the surfaced error retains the original cause or exit status.
- [ ] Run focused tests and then regenerate the committed fixtures:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test packages/contracts/scripts/export-rust-rpc-fixtures.test.ts packages/contracts/scripts/export-rust-auth-fixtures.test.ts
PATH="$PWD/node_modules/.bin:$PATH" vp run --filter @t4code/contracts generate:rust-rpc-fixtures
PATH="$PWD/node_modules/.bin:$PATH" vp run --filter @t4code/contracts generate:rust-auth-fixtures
git diff --exit-code -- packages/contracts/fixtures
```

Expected result: tests pass and regeneration produces no fixture diff.

- [ ] Commit the cohort:

```bash
git add packages/contracts/scripts
git commit -m "test: cover deterministic Rust fixture export"
```

---

### Task 4: Cover Untested Web Hooks and Focused Components

**Files:**

- Create: `apps/web/src/hooks/useResizableWidth.test.tsx`
- Create: `apps/web/src/components/preview/usePreviewSession.test.tsx`
- Create: `apps/web/src/components/preview/usePreviewBridge.test.tsx`
- Create: `apps/web/src/components/preview/PreviewChromeRow.test.tsx`
- Create: `apps/web/src/components/diffs/AnnotatableCodeView.test.tsx`
- Create: `apps/web/src/components/chat/ModelPickerSidebar.test.tsx`
- Create: `apps/web/src/components/chat/ProviderModelPicker.test.tsx`
- Create: `apps/web/src/components/chat/ComposerCommandMenu.test.tsx`
- Create: `apps/web/src/components/chat/ComposerBannerStack.test.tsx`
- Test corresponding production modules with the same base names.

**Behavior matrix:**

- `useResizableWidth`: initial/default width, stored width parsing, min/max clamp, left/right drag direction, pointer capture/release, resize listener cleanup, double-click reset, and disabled state.
- `usePreviewSession`: no environment/workspace, session creation, reuse, target change, create failure, stop/unmount cleanup, stale completion suppression, and refresh.
- `usePreviewBridge`: disconnected/connected bridge, request forwarding, rejection mapping, event subscription/unsubscription, and target replacement.
- `PreviewChromeRow`: navigation enablement, reload/stop state, URL submit/normalization, invalid URL retention, keyboard submit, and external-open callback.
- `AnnotatableCodeView`: empty and populated hunks, line/range selection, reverse selection, annotation add/cancel, deleted/context line metadata, keyboard escape, and callback payloads.
- Model/command components: empty/loading/error states; keyboard wraparound; disabled entries; current selection; provider/model grouping; search filtering; escape/outside close; exact select payload; banners for permission, reconnect, provider update, and pending input variants.

- [ ] Use the uncovered contract in the V8 report as the red state for tests of unchanged behavior. If a production seam or behavior fix is required, write a failing behavior assertion before changing production code; otherwise add the characterization cases one at a time and verify their branch delta.
- [ ] Prefer accessible roles/names and user events. Avoid snapshot-only assertions and CSS-class-only assertions.
- [ ] Use fake timers for debounce/animation paths and restore real timers in `afterEach`.
- [ ] Run the cohort:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test \
  apps/web/src/hooks/useResizableWidth.test.tsx \
  apps/web/src/components/preview/usePreviewSession.test.tsx \
  apps/web/src/components/preview/usePreviewBridge.test.tsx \
  apps/web/src/components/preview/PreviewChromeRow.test.tsx \
  apps/web/src/components/diffs/AnnotatableCodeView.test.tsx \
  apps/web/src/components/chat/ModelPickerSidebar.test.tsx \
  apps/web/src/components/chat/ProviderModelPicker.test.tsx \
  apps/web/src/components/chat/ComposerCommandMenu.test.tsx \
  apps/web/src/components/chat/ComposerBannerStack.test.tsx
```

Expected result: all cases pass without `act()` warnings, leaked listeners, or unresolved promises.

- [ ] Commit the cohort:

```bash
git add apps/web/src/hooks apps/web/src/components
git commit -m "test: cover preview and composer interaction states"
```

---

### Task 5: Cover Client Runtime State and Connection Failure Paths

**Files:**

- Modify: `packages/client-runtime/src/state/runtime.test.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Create: `packages/client-runtime/src/state/connections.test.ts`
- Create: `packages/client-runtime/src/state/threadDetail.test.ts`
- Modify: `packages/client-runtime/src/state/threadReducer.test.ts`
- Modify: `packages/client-runtime/src/operations/commands.test.ts`
- Modify: `packages/client-runtime/src/state/shell.test.ts`
- Modify: `packages/client-runtime/src/state/vcsAction.test.ts`
- Modify: `packages/client-runtime/src/connection/onboarding.test.ts`
- Modify: `packages/client-runtime/src/relay/managedRelay.test.ts`
- Test the corresponding production modules with the same base names.

**Required state and failure slices:**

- Runtime/registry: first registration, duplicate id, replacement, active-environment removal, disconnected environment retention, registry disposal, observer failure, reconnecting state, and concurrent environment updates.
- Connection state: initial snapshot, incremental upsert/remove, stale revision rejection, reconnect snapshot replacement, transport failure, auth-required state, last-good data retention, and clear/reset.
- Thread detail/reducer: snapshot, delta ordering, duplicate event, missing predecessor, compaction, deletion, restart synchronization, typed provider failure, usage accumulation, pending user input, and unknown forward-compatible event.
- Commands/shell/VCS actions: disabled target, success, typed error, transport error, cancellation, optimistic state rollback, duplicate command suppression, stale completion, refresh, and cleanup.
- Onboarding/managed relay: discovery none/one/many, invalid endpoint, pairing cancellation/expiry, credential rejection, reconnect backoff, token refresh, unlink during connection, supervisor shutdown, and late result suppression.

- [ ] Extend existing Effect/Vitest patterns and use `it.effect` for Effect-returning tests. Supply services with test `Layer`s; do not call `Effect.runPromise` inside an Effect test.
- [ ] Use `TestClock` or existing injectable clocks for reconnect and expiry behavior. Assert fibers are interrupted and scoped resources finalize.
- [ ] Assert public state snapshots and typed errors rather than internal atom subscription counts.
- [ ] Run the cohort:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test \
  packages/client-runtime/src/state/runtime.test.ts \
  packages/client-runtime/src/connection/registry.test.ts \
  packages/client-runtime/src/state/connections.test.ts \
  packages/client-runtime/src/state/threadDetail.test.ts \
  packages/client-runtime/src/state/threadReducer.test.ts \
  packages/client-runtime/src/operations/commands.test.ts \
  packages/client-runtime/src/state/shell.test.ts \
  packages/client-runtime/src/state/vcsAction.test.ts \
  packages/client-runtime/src/connection/onboarding.test.ts \
  packages/client-runtime/src/relay/managedRelay.test.ts
```

Expected result: all state transitions and failure cases pass with no live endpoint or leaked Effect fiber.

- [ ] Commit the cohort:

```bash
git add packages/client-runtime/src
git commit -m "test: cover client runtime state failures"
```

---

### Task 6: Close Branch Gaps in the Large Web Interaction Surfaces

**Files:**

- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interaction.test.tsx`
- Modify: `apps/web/src/components/ChatMarkdown.test.tsx`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.test.tsx`
- Modify: `infra/relay/src/http/Api.test.ts`

**Required branch slices:**

- `ChatView`: deleted/synchronizing/reconnecting thread transitions; send rejection and retry; pending user-input accept/reject; checkpoint diff unavailable/loading/failure; model/environment replacement; terminal/script launch failure; right-panel and narrow-layout keyboard paths; stale async completion after thread switch.
- `Sidebar`: empty/loading/error environment rows; collapsed/expanded groups; rename validation and rejection; delete/restore; provider update progress/failure; unread counts; keyboard context menu; dragged item cancellation; disconnected environment actions.
- `ThreadTerminalDrawer`: zero/one/multiple sessions; active-session deletion; split orientation and size persistence; focus handoff; failed open/close/write/resize; sidebar labels; keyboard traversal; stale terminal output after selection change.
- `ChatMarkdown`: inline/fenced code, language fallback, unsafe/safe links, copy success/failure, collapsed/expanded long blocks, tables/lists/task items, diff annotations, missing syntax highlighter, and malformed input fallback.
- `ConnectionsSettings`: create/edit/delete success and failure; validation; OAuth/device-code states; reconnect; provider-model refresh; duplicate connection names; unavailable capabilities; stale response after environment switch.
- Relay `Api`: missing/invalid auth, DPoP nonce/replay/method/URL failures, unlink authorization, upstream typed failure, malformed upstream response, abort propagation, trace headers, and fallback response.

- [ ] Use the V8 report to identify uncovered branch locations before editing each test file:

```bash
node -e 'const c=require("./coverage/coverage-final.json"); for (const [f,v] of Object.entries(c)) if (/ChatView|Sidebar|ThreadTerminalDrawer|ChatMarkdown|ConnectionsSettings|infra\/relay\/src\/http\/Api/.test(f)) console.log(f, v.b)'
```

- [ ] Add one behavioral assertion per uncovered conditional family. When several branches map to the same user-visible state, use a table-driven test with named cases.
- [ ] Run the eight focused test files, then the TypeScript coverage checkpoint:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test \
  apps/web/src/components/ChatView.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/Sidebar.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.test.tsx \
  apps/web/src/components/ThreadTerminalDrawer.interaction.test.tsx \
  apps/web/src/components/ChatMarkdown.test.tsx \
  apps/web/src/components/settings/ConnectionsSettings.test.tsx \
  infra/relay/src/http/Api.test.ts
PATH="$PWD/node_modules/.bin:$PATH" vp test --coverage
```

Expected result: focused tests pass. Record all four totals from the complete report in the commit body.

- [ ] If any TypeScript metric is below 85%, consume the reserve cohort in this fixed order, testing the named behaviors before moving to the next file:

  1. `apps/web/src/components/PlanSidebar.tsx`: empty/loading/populated/error, active item, keyboard selection, dismiss.
  2. `apps/web/src/components/CenterPanelTabs.tsx`: add/select/close, pinned tab, dirty close refusal, keyboard traversal.
  3. `apps/web/src/routes/_chat.tsx`: invalid/missing thread id, redirect, loading, ready and deleted thread.
  4. `apps/web/src/observability/clientTracing.ts`: disabled/enabled exporters, resource attributes, flush success/failure and shutdown idempotence.
  5. `apps/web/src/components/files/FileEntryDialog.tsx`: create/rename modes, validation, overwrite refusal, cancel and submit failure.

  Create a same-directory `.test.tsx` or `.test.ts` file for each reserve module used. After each file, rerun `vp test --coverage`; stop only when statements, branches, functions, and lines are all at least 85%.

- [ ] Commit the cohort:

```bash
git add apps/web/src infra/relay/src
git commit -m "test: close web interaction coverage gaps"
```

---

### Task 7: Cover Rust Provider Runtime Lifecycle and Protocol Failures

**Files:**

- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/provider_grok.rs`
- Modify: `apps/server/tests/provider_opencode.rs`
- Modify: `apps/server/tests/provider_cursor.rs`
- Modify when a seam is required: `apps/server/src/production/provider_runtime.rs`
- Modify when a seam is required: `apps/server/src/provider/codex/runtime.rs`
- Modify when a seam is required: `apps/server/src/provider/grok/runtime.rs`
- Modify when a seam is required: `apps/server/src/provider/opencode/runtime.rs`
- Modify when a seam is required: `apps/server/src/provider/cursor/runtime.rs`

**Test seam rule:**

Extend the existing scripted provider peer/factory. If new injection is needed, pass a crate-visible trait/object for process launch, clock, or event sink into the runtime constructor; production constructors continue supplying the real implementation.

- [ ] Add table-driven factory tests for every supported provider, unknown provider, missing executable, invalid resume metadata, unsupported control request, and launch failure before a session id exists.
- [ ] Add lifecycle tests for first turn, resume, restart reconciliation, concurrent send rejection/serialization, shutdown before launch, shutdown during a turn, child exit before handshake, child exit after partial stream, cancellation, timeout, and late events after shutdown.
- [ ] Assert event ordering for user message, provider delta, tool start/update/end, plan updates, usage, completion, typed failure, and checkpoint projection. Verify persistence state after every terminal outcome.
- [ ] Add protocol tests for malformed JSON, unknown notification, duplicate response id, response without request, EOF with pending request, invalid typed failure, stderr-only failure, and oversized/partial frames where supported by the parser.
- [ ] Use paused Tokio time for timeout/backoff behavior and bounded channels for backpressure. Every spawned task must be joined or explicitly aborted and awaited.
- [ ] Run focused tests:

```bash
cargo test -p t4code-server --test production_provider_runtime -- --nocapture
cargo test -p t4code-server --test provider_codex -- --nocapture
cargo test -p t4code-server --test provider_grok -- --nocapture
cargo test -p t4code-server --test provider_opencode -- --nocapture
cargo test -p t4code-server --test provider_cursor -- --nocapture
```

Expected result: all scripted-provider cases pass without live provider executables.

- [ ] Commit the cohort:

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/provider apps/server/tests
git commit -m "test: cover provider runtime lifecycle failures"
```

---

### Task 8: Cover Rust Desktop Backend, Bridge, SSH, and Updates

**Files:**

- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/ssh.rs`
- Modify: `apps/desktop/src-tauri/src/updates.rs`
- Modify as coverage requires: `apps/desktop/src-tauri/src/window.rs`
- Modify as coverage requires: `apps/desktop/src-tauri/src/config.rs`

**Production seams:**

- Represent process launch/termination, HTTP transport, SSH command execution, updater operations, and window emission behind the smallest existing trait or function parameter.
- Keep public Tauri command signatures unchanged. Production entrypoints construct real adapters; tests use scripted in-memory adapters.

- [ ] Backend tests: port selection, readiness success/timeout, child early exit, stdout/stderr capture, auth bootstrap, graceful shutdown, forced kill fallback, double shutdown, environment override precedence, and restart after failure.
- [ ] Bridge tests: URL/path/query/header construction, JSON encode/decode, non-2xx mapping, malformed body, connection refusal, timeout, cancellation, streaming event order, listener removal, remote HTTP authorization, and secret redaction.
- [ ] SSH tests: config parsing, host aliases, IPv4/IPv6/user/port combinations, quoting of spaces and metacharacters, WSL routing, known-host/credential failures, child exit, cancellation, tunnel readiness, reconnect backoff, and cleanup idempotence.
- [ ] Update tests: disabled updater result, no update, available update, download progress, download failure, signature/install failure, relaunch request, cancellation, duplicate check coalescing, and platform-specific unavailable updater.
- [ ] Window/config tests: persisted bounds validation, off-screen recovery, maximize/fullscreen state, malformed configuration fallback, atomic save failure, event emission failure, and multiple-window selection.
- [ ] Run the desktop crate tests under the workspace’s supported feature set:

```bash
cargo test -p t4code-desktop --all-targets -- --nocapture
```

Expected result: desktop tests pass without opening a real window, contacting an update endpoint, or connecting to SSH.

- [ ] Commit the cohort:

```bash
git add apps/desktop/src-tauri/src
git commit -m "test: cover desktop failure and lifecycle paths"
```

---

### Task 9: Cover Rust VCS, Preview, Relay, and Orchestration Boundaries

**Files:**

- Modify: `apps/server/tests/production_git_vcs_rpc.rs`
- Modify: `apps/server/tests/production_workspace_preview_rpc.rs`
- Modify: `apps/server/tests/production_relay.rs`
- Modify: `apps/server/tests/production_orchestration_effects.rs`
- Modify: `apps/server/tests/production_control.rs`
- Modify as seams require: `apps/server/src/production/git_vcs.rs`
- Modify as seams require: `apps/server/src/source_control/pull_request.rs`
- Modify as seams require: `apps/server/src/production/workspace_preview.rs`
- Modify as seams require: `apps/server/src/production/relay.rs`
- Modify as seams require: `apps/server/src/production/orchestration_effects.rs`
- Modify as seams require: `apps/server/src/orchestration/engine.rs`

- [ ] VCS tests: non-repository, unborn branch, detached head, no remote, primary/secondary remotes, paginated refs, Unicode paths, stage/unstage/discard conflicts, empty commit, commit failure, pull divergence, clone cancellation, worktree collision, subprocess timeout, and Git stderr mapping. Use temporary repositories only.
- [ ] Pull-request tests: missing remote/provider, URL parsing variants, existing PR, create success, API typed failures, malformed response, auth failure, head/base selection, and cancellation through a fake HTTP client.
- [ ] Workspace preview tests: create/reuse/stop, port collision, invalid command, process early exit, readiness timeout, output stream, environment merge, root-path validation, duplicate request coalescing, and shutdown cleanup through a scripted process runner.
- [ ] Relay/control tests: disconnected and reconnecting states, authentication rejection, malformed envelope, backpressure, subscription replacement, cancellation, graceful shutdown, retry exhaustion, duplicate sequence handling, and persistence failure.
- [ ] Orchestration tests: enqueue/start/complete/fail/cancel/retry transitions, dependency blocking/unblocking, duplicate event idempotence, restart recovery, stale lease, checkpoint rollback failure, provider loss, and concurrent command serialization.
- [ ] Run focused tests:

```bash
cargo test -p t4code-server --test production_git_vcs_rpc -- --nocapture
cargo test -p t4code-server --test production_workspace_preview_rpc -- --nocapture
cargo test -p t4code-server --test production_relay -- --nocapture
cargo test -p t4code-server --test production_orchestration_effects -- --nocapture
cargo test -p t4code-server --test production_control -- --nocapture
```

Expected result: all cases pass with temporary repositories and in-memory/scripted I/O.

- [ ] Commit the cohort:

```bash
git add apps/server/src apps/server/tests
git commit -m "test: cover server integration boundaries"
```

---

### Task 10: Reach the Rust 85% Checkpoint with the Fixed Reserve Cohort

**Files:**

- Coverage report: `target/llvm-cov-report.json` (generated, never committed)
- Reserve production modules and their existing same-domain tests:
  - `apps/server/src/auth/service.rs`
  - `apps/server/src/auth/secret_store.rs`
  - `apps/server/src/production/runtime.rs`
  - `apps/server/src/production/server_terminal.rs`
  - `apps/server/src/production/operational_logs.rs`
  - `apps/server/src/diagnostics/trace.rs`
  - `apps/server/src/terminal/manager.rs`
  - `apps/server/src/production/managed_endpoint.rs`
  - `apps/server/src/lifecycle.rs`
- Existing reserve tests to extend:
  - inline `mod tests` in `apps/server/src/auth/service.rs`
  - inline `mod tests` in `apps/server/src/auth/secret_store.rs`
  - inline `mod tests` in `apps/server/src/production/runtime.rs`
  - `apps/server/tests/production_server_terminal_rpc.rs`
  - inline `mod tests` in `apps/server/src/production/operational_logs.rs`
  - `apps/server/tests/production_operational_logs.rs`
  - `apps/server/tests/trace_diagnostics.rs`
  - `apps/server/tests/terminal_rpc.rs`
  - `apps/server/tests/terminal_default_shell.rs`
  - `apps/server/tests/server_runtime.rs`

- [ ] Run a complete summary and JSON report:

```bash
PATH="/Users/admin/.cargo/bin:$PWD/node_modules/.bin:$PATH" \
LLVM_COV="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-cov" \
LLVM_PROFDATA="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-profdata" \
cargo llvm-cov --workspace --all-targets --include-build-script --jobs 1 --summary-only

PATH="/Users/admin/.cargo/bin:$PWD/node_modules/.bin:$PATH" \
LLVM_COV="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-cov" \
LLVM_PROFDATA="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-profdata" \
cargo llvm-cov report --json --output-path target/llvm-cov-report.json
```

On a host whose Rustup target differs from `stable-aarch64-apple-darwin`, resolve the two binaries from `rustc --print sysroot`; keep the Cargo arguments unchanged.

- [ ] If regions, functions, or lines remain below 85%, consume reserve modules in the listed order. Add these behavioral cases to their existing integration or inline test modules:

  1. Auth service/secret store: issue, refresh, revoke, expiry, wrong scope, corrupt secret, missing secret, store failure, concurrent refresh.
  2. Production runtime/lifecycle: partial startup rollback, signal shutdown, double shutdown, child failure, task join failure, configuration rejection, resource cleanup order.
  3. Server terminal/manager: spawn failure, resize validation, write-after-exit, exit stream, cancellation, duplicate close, shell discovery and bounded output.
  4. Operational logs/trace: rotate, truncate, malformed record, subscriber lag, disabled tracing, exporter failure, flush and shutdown.
  5. Managed endpoint: bind collision, invalid host, readiness timeout, handler failure, graceful drain, forced termination and idempotent close.

- [ ] After each reserve module, rerun its focused test target and then the complete summary. Stop only after regions, functions, and lines are all at least 85%.
- [ ] Commit reserve tests, if any:

```bash
git add apps/server/src apps/server/tests
git commit -m "test: close remaining Rust coverage gaps"
```

---

### Task 11: Raise the Gates and Make the Acceptance Tests Green

**Files:**

- Modify: `vite.config.shared.ts`
- Modify: `scripts/check-rust-coverage.ts`
- Verify: `scripts/coverage-config.test.ts`
- Verify: `scripts/check-rust-coverage.test.ts`

- [ ] Confirm the immediately preceding complete reports show all seven metrics at or above 85%. Do not proceed from focused or merged/stale reports.
- [ ] First change the policy tests: require all four TypeScript thresholds to equal `85`, and change both Unix and Windows Rust command expectations so every `--fail-under-*` value is `85`.
- [ ] Run the focused policy tests and confirm they fail only because the two production files still contain `74`:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp test scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts
```

Expected result: assertions report `74` where `85` is required.

- [ ] Change the four Vite+ thresholds from `74` to `85`.
- [ ] Change the three `cargo llvm-cov` `--fail-under-*` values from `74` to `85`.
- [ ] Rerun the same focused command.

Expected result: the policy tests now pass, including both Unix and Windows command construction and the unchanged inventory assertions. The TypeScript threshold assertion is:

```ts
expect(config.test?.coverage?.thresholds).toEqual({
  lines: 85,
  statements: 85,
  functions: 85,
  branches: 85,
});
```

- [ ] Commit the gate:

```bash
git add vite.config.shared.ts scripts/check-rust-coverage.ts scripts/coverage-config.test.ts scripts/check-rust-coverage.test.ts
git commit -m "test: enforce 85 percent repository coverage"
```

---

### Task 12: Full Verification and Coverage Evidence

**Files:**

- Verify all files changed by Tasks 1–11.
- Do not modify generated reports to make this task pass.

- [ ] Run the complete coverage package script with the new gates:

```bash
PATH="/Users/admin/.cargo/bin:$PWD/node_modules/.bin:$PATH" \
LLVM_COV="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-cov" \
LLVM_PROFDATA="/Users/admin/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-profdata" \
vp run test:coverage
```

Expected result: TypeScript statements, branches, functions, and lines are each at least 85%; Rust regions, functions, and lines are each at least 85%; exit status is zero.

- [ ] Run the repository-mandated checks:

```bash
PATH="$PWD/node_modules/.bin:$PATH" vp check
PATH="$PWD/node_modules/.bin:$PATH" vp run typecheck
```

Expected result: both commands exit zero.

- [ ] Inspect the worktree and generated-file boundary:

```bash
git status --short
git diff --check
git diff --stat HEAD~1
```

Expected result: no whitespace errors and no tracked coverage/LLVM artifacts. Review every remaining uncommitted file as intentional or remove the generated artifact without touching user-owned changes.

- [ ] Record in the final handoff:

  - the seven final percentages;
  - the exact successful commands;
  - any production seams introduced and why;
  - all commits created;
  - confirmation that the source inventories and ignore lists were not narrowed.
