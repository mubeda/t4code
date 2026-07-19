# Resource Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Resource Manager headline as the combined monitored footprint while making every expanded view clearly and accurately separate T4Code Core from launched External Tooling.

**Architecture:** Extend native samples with stable process identity, join them to a bounded launcher-owned provenance registry, and run a pure nearest-ancestor attributor before any current or historical aggregation. A single demand-driven sampler becomes the source for both diagnostics RPCs. The contracts switch atomically to split totals, and the web UI renders parallel Core/External cards without ever merging local desktop usage into a selected remote host.

**Tech Stack:** Rust, Tokio, sysinfo, Axum RPC, Effect Schema contracts, React, TypeScript, Vitest/Vite+, Testing Library, Tauri 2.

## Global Constraints

- Every snapshot is scoped to one execution environment and one machine.
- `combined = core + external` must hold for current CPU, RSS, and process count.
- Historical average stacks are additive. Each peak decomposition must use Core and External from the same sample that produced the Combined peak.
- PID alone is never a stable process key. Use PID plus operating-system start time.
- Generic executable names such as `WebContent`, `renderer`, or browser names are never ownership evidence.
- Missing launcher metadata falls back to `external/unknown/fallback`; it must not hide a process.
- Desktop UI resource usage is included only when a desktop adapter returns exact process identities. The initial desktop adapter reports `unavailable` with a bounded explanation because the current public Tauri integration cannot reliably enumerate per-app WebView helper processes. Headless/web mode reports `notApplicable`.
- No second machine-wide process refresh, no independent UI polling loop, and no sampling without a diagnostics/history read.
- Registry entries, labels, messages, process commands, and history samples remain bounded.
- A registry, attribution, or UI-observer failure cannot terminate or block a provider, terminal, or native server process.
- Core rows are never signalable. External signal requests must revalidate process identity and server ancestry on the server immediately before signaling.
- The contract and all client consumers change in the same task sequence; do not ship a compatibility layer that guesses Core from legacy totals.
- Do not edit `.repos/`.

---

## File Structure

### New server modules

- `apps/server/src/diagnostics/attribution.rs`
  - Stable process identity and attribution enums.
  - Pure `ResourceAttributor`.
  - Current split-total aggregation.
  - Unit tests for ownership, ancestry, overlap, reparenting, PID reuse, and reconciliation.
- `apps/server/src/diagnostics/registry.rs`
  - Bounded `ProcessAttributionRegistry`.
  - RAII `ProcessRegistration`.
  - Unbound-entry expiry, identity binding, snapshot reads, and pruning.
- `apps/server/src/diagnostics/resource_sampler.rs`
  - `ResourceSampler` trait.
  - `DesktopUiProcessObserver` boundary.
  - `NativeResourceSampler` composition of the existing OS scan, registry, UI observation, and pure attributor.
  - Revalidate process key, External scope, and ancestry before a signal.

### Modified server files

- `apps/server/src/diagnostics/mod.rs`
  - Export the new types and stop exposing the old row-only sampler abstraction.
- `apps/server/src/diagnostics/model.rs`
  - Add process start time and attributed current/history models.
  - Replace ambiguous single totals and CPU-only history buckets.
- `apps/server/src/diagnostics/native.rs`
  - Populate process start time from `sysinfo`.
  - Expose one all-process snapshot method reused by diagnostics and signaling.
  - Keep the final platform signal primitive behind the diagnostics boundary.
- `apps/server/src/diagnostics/monitor.rs`
  - Consume attributed snapshots.
  - Coalesce current/history reads into one sample per interval.
  - Retain last-good data and split history aggregates.
- `apps/server/src/production/provider_runtime.rs`
  - Register provider roots and keep registration alive in the provider child wrapper.
- `apps/server/src/terminal/manager.rs`
  - Register PTY roots and release registration on exit, close, restart, and shutdown.
- `apps/server/src/production/runtime.rs`
  - Construct one registry/native resource sampler before provider and terminal services.
- `apps/server/src/production/server_terminal.rs`
  - Serve current and history from the same monitor.
  - Emit the new wire contract.
  - Validate `processKey` on signal requests.
- `apps/server/src/lifecycle.rs`
  - Supply the correct UI-observer default for desktop versus headless runtime.
- `apps/desktop/src-tauri/src/backend.rs`
  - Pass the honest unavailable desktop UI observer to an in-process desktop server.

### Contracts

- `packages/contracts/src/server.ts`
  - Replace legacy process totals/history with attributed schemas.
  - Add `processKey` to the signal input.
- `packages/contracts/src/rpcRustParity.test.ts`
  - Assert all scope/kind/confidence/coverage variants and new split shapes.
- `packages/contracts/fixtures/rpc-wire/`
  - Regenerated schema fingerprints, typed failures, stream shapes, and manifest from the existing fixture exporter.

### Web presentation

- `apps/web/src/components/status-bar/statusBarPresentation.ts`
  - Derive combined headline, parallel cards, consumers, warning state, and optional local Core row.
- `apps/web/src/components/status-bar/statusBarPresentation.test.ts`
  - Test reconciliation, memory-first sorting, warning states, and remote/local separation.
- `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
  - Render the approved parallel-card popover.
- `apps/web/src/components/status-bar/AppStatusBar.tsx`
  - Use live attributed diagnostics and query local Core only for a remote desktop selection.
- `apps/web/src/components/status-bar/AppStatusBar.test.tsx`
- `apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx`
  - Update query harnesses and observable behavior.
- `apps/web/src/state/environments.ts`
  - Expose the desktop primary/local resource environment without changing the selected environment.
- `apps/web/src/components/settings/resourceDiagnosticsPresentation.ts`
  - Pure live/history sort, filter, chart, and coverage helpers.
- `apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts`
  - Test memory defaults, sortable columns, chart stacks, and same-sample peaks.
- `apps/web/src/components/settings/ResourceDiagnosticsSections.tsx`
  - Render attributed Live Processes and Resource History sections.
- `apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx`
  - Test cards, tables, chart toggles, degraded states, and signal controls.
- `apps/web/src/components/settings/DiagnosticsSettings.tsx`
  - Retain query/action orchestration and delegate resource presentation.
- `apps/web/src/components/settings/DiagnosticsSettings.test.tsx`
  - Update integration expectations and process-signal payloads.

### Documentation and measurements

- `docs/operations/observability.md`
  - Define Core, External, Combined, UI coverage, host scope, and signal safeguards.
- `scripts/measure-desktop-runtime.ts`
- `scripts/measure-desktop-runtime.test.ts`
  - Add attributed idle-sampling and clean-shutdown observations only if the existing measurement output cannot express them.

---

## Task 1: Stable Process Identity and Pure Attribution

**Files:**

- Create: `apps/server/src/diagnostics/attribution.rs`
- Modify: `apps/server/src/diagnostics/model.rs`
- Modify: `apps/server/src/diagnostics/native.rs`
- Modify: `apps/server/src/diagnostics/mod.rs`

### Step 1: Write failing native identity tests

- [ ] Add a `started_at: u64` assertion to the existing native sampler tests. Assert that the current process has a non-zero start time and that two rows with the same PID but different start times produce different keys.

Use this identity shape:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: u64,
}

impl ProcessIdentity {
    #[must_use]
    pub fn key(self) -> String {
        format!("{}:{}", self.pid, self.started_at)
    }
}
```

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::native::tests -- --nocapture
```

Expected: compilation fails because `ProcessRow` has no `started_at` field.

### Step 2: Add start identity to the native scan

- [ ] Add `started_at: u64` to `ProcessRow` and populate it with `process.start_time()` inside the existing `collect_rows` pass. Do not add another `System::refresh_processes_specifics` call.
- [ ] Replace PID-plus-command keys in `ProcessSample` with `ProcessIdentity::key()`. Keep command as its own bounded diagnostic value.
- [ ] Run the native/model tests:

```bash
cargo test -p t4code-server diagnostics::native::tests -- --nocapture
cargo test -p t4code-server diagnostics::model::tests -- --nocapture
```

Expected: pass.

### Step 3: Write the attribution behavior tests

- [ ] In `attribution.rs`, add table-driven tests for:
  - server root → exact `core/server`;
  - registered UI → exact `core/ui`;
  - registered provider → exact `external/provider`;
  - nested descendants → nearest registered ancestor with `inherited`;
  - unregistered server descendant → `external/unknown/fallback`;
  - unrelated process → omitted;
  - overlapping roots → one output row per identity;
  - reparented exact registered root → retained;
  - same PID/new start time → stale claim rejected;
  - totals reconcile for CPU, RSS, and process count.

The tests should build rows with a helper like:

```rust
fn row(pid: u32, ppid: u32, started_at: u64, cpu: f32, rss: u64) -> ProcessRow
```

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::attribution::tests -- --nocapture
```

Expected: compilation fails because the attribution types and `ResourceAttributor` do not exist.

### Step 4: Implement the pure attributor

- [ ] Add these domain types in `attribution.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttributionScope {
    Core,
    External,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttributionKind {
    Server,
    Ui,
    Provider,
    Terminal,
    Helper,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttributionConfidence {
    Exact,
    Inherited,
    Fallback,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcessClaim {
    pub identity: ProcessIdentity,
    pub scope: AttributionScope,
    pub kind: AttributionKind,
    pub label: String,
}
```

- [ ] Implement `ResourceAttributor::attribute(rows, server_identity, claims, ui_coverage)` with PID and child indexes plus memoized nearest-owner resolution. The output row must carry `process_key`, `scope`, `kind`, `label`, and `confidence`.
- [ ] Keep registered exact roots in the included set even when no longer descended from the server. Include their descendants, and let the nearest exact root win.
- [ ] Deduplicate on `ProcessIdentity`, never on PID or command.
- [ ] Aggregate current totals in the same module:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ProcessResourceTotals {
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub process_count: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ProcessAttributionTotals {
    pub combined: ProcessResourceTotals,
    pub core: ProcessResourceTotals,
    pub external: ProcessResourceTotals,
}
```

Construct `combined` by adding the two group totals, not by an independent third fold.

### Step 5: Verify and commit the first review unit

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::attribution::tests
cargo test -p t4code-server diagnostics::native::tests
cargo test -p t4code-server diagnostics::model::tests
```

Expected: pass.

- [ ] Commit:

```bash
git add apps/server/src/diagnostics/attribution.rs apps/server/src/diagnostics/model.rs apps/server/src/diagnostics/native.rs apps/server/src/diagnostics/mod.rs
git commit -m "feat(diagnostics): add stable process attribution"
```

---

## Task 2: Bounded Provenance Registry

**Files:**

- Create: `apps/server/src/diagnostics/registry.rs`
- Modify: `apps/server/src/diagnostics/attribution.rs`
- Modify: `apps/server/src/diagnostics/mod.rs`

### Step 1: Write failing registry lifecycle tests

- [ ] Add tests for:
  - a PID registration appears in a snapshot;
  - the first matching row binds the registration to its exact start identity;
  - a bound registration refuses the same PID with a different start identity;
  - dropping `ProcessRegistration` unregisters immediately;
  - explicit unregister is idempotent;
  - unbound registrations expire after 10 seconds;
  - missing bound identities are pruned after a sample;
  - a maximum of 512 live entries is enforced without evicting a still-owned entry silently;
  - labels are normalized and bounded to 80 UTF-8 characters;
  - registry reads do not retain the mutex guard while attribution runs.

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::registry::tests -- --nocapture
```

Expected: compilation fails because `ProcessAttributionRegistry` does not exist.

### Step 2: Implement registration metadata and RAII cleanup

- [ ] Implement:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistrationSource {
    Provider,
    Terminal,
    DesktopUi,
    Helper,
}

#[derive(Clone, Debug)]
pub struct ProcessRegistrationMetadata {
    pub scope: AttributionScope,
    pub kind: AttributionKind,
    pub label: String,
    pub source: RegistrationSource,
}

#[derive(Clone, Debug)]
pub struct ProcessAttributionRegistry {
    inner: Arc<std::sync::Mutex<RegistryState>>,
}

#[derive(Debug)]
pub struct ProcessRegistration {
    registration_id: u64,
    registry: Weak<std::sync::Mutex<RegistryState>>,
}
```

- [ ] Make `register_pid(pid, metadata)` synchronous and non-failing for launchers. Return `Option<ProcessRegistration>`; return `None` only when the bounded capacity is exhausted, log a bounded warning, and allow the process to continue as External fallback.
- [ ] Record a monotonic registration deadline. During `bind_and_snapshot(rows, now)`, bind an unbound entry only to the current row with the same PID, then require the bound `ProcessIdentity` on all later samples.
- [ ] Return an owned `Vec<ProcessClaim>` snapshot before calling `ResourceAttributor`.
- [ ] Prune expired unbound entries and bound identities missing from the current OS sample without relying on that pruning for normal cleanup.

### Step 3: Verify PID reuse and missing-metadata fallback together

- [ ] Extend the attribution test fixture so an expired or stale registry claim is omitted and the same observed server descendant becomes `external/unknown/fallback`.
- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::registry::tests
cargo test -p t4code-server diagnostics::attribution::tests
```

Expected: pass.

### Step 4: Commit the registry review unit

- [ ] Commit:

```bash
git add apps/server/src/diagnostics/registry.rs apps/server/src/diagnostics/attribution.rs apps/server/src/diagnostics/mod.rs
git commit -m "feat(diagnostics): track process launch provenance"
```

---

## Task 3: Register Provider and Terminal Lifecycles

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `apps/server/src/production/runtime.rs`

### Step 1: Write failing provider registration tests

- [ ] Add a provider-runtime unit test that spawns the existing test child through the native factory, samples registry claims, and asserts:
  - scope `external`;
  - kind `provider`;
  - label uses the configured provider instance `display_name` when non-empty and otherwise the stable provider name;
  - registration disappears when the child wrapper is consumed or dropped.

- [ ] Run:

```bash
cargo test -p t4code-server production::provider_runtime::tests -- --nocapture
```

Expected: the new test fails because the factory has no registry.

### Step 2: Carry the display label and wrap provider children with a registration lease

- [ ] Add `provider_label: String` to `ProviderLaunchRequest`. In `build_launch_request`, set it from the trimmed `ProviderInstanceState.display_name`, falling back to the stable `provider` value. Update the local test request helper in the same file.
- [ ] Add `ProcessAttributionRegistry` to `NativeProviderDriverFactory`, pass it through the five native driver constructors, and make `spawn_child` accept it.
- [ ] Immediately after `CommandWrap::spawn`, read `child.id()` and register it. Do not fail provider startup if registration returns `None`.
- [ ] Preserve the registration for exactly the child wrapper lifetime:

```rust
#[derive(Debug)]
struct AttributedChild {
    inner: Box<dyn ChildWrapper>,
    registration: Option<ProcessRegistration>,
}

impl ChildWrapper for AttributedChild {
    fn inner(&self) -> &dyn ChildWrapper {
        self.inner.as_ref()
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.inner.as_mut()
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        let Self { inner, .. } = *self;
        inner
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.inner.try_wait()?;
        if status.is_some() {
            self.registration.take();
        }
        Ok(status)
    }

    fn wait(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<std::process::ExitStatus>> + Send + '_>> {
        Box::pin(async move {
            let status = self.inner.wait().await?;
            self.registration.take();
            Ok(status)
        })
    }
}
```

The trait's default stdin/stdout/stderr/id/kill/wait-with-output delegation remains intact; the
two wait methods release the lease as soon as exit is observed.

### Step 3: Write failing terminal lifecycle tests

- [ ] Extend `terminal::manager::tests` to inject a registry and assert:
  - a started PTY registers as `external/terminal`;
  - its bounded label matches the existing terminal label;
  - exit releases the registration;
  - restart replaces the prior registration;
  - close and manager shutdown release registrations.

- [ ] Run:

```bash
cargo test -p t4code-server terminal::manager::tests -- --nocapture
```

Expected: the new tests fail because `TerminalManager` does not accept a registry.

### Step 4: Attach the terminal registration to `Session`

- [ ] Add `attribution_registration: Option<ProcessRegistration>` to `Session`.
- [ ] Add a production constructor that accepts the shared registry while preserving the current `new` constructor for isolated tests:

```rust
pub fn with_process_attribution(
    backend: Arc<dyn PtyBackend>,
    options: TerminalManagerOptions,
    attribution: ProcessAttributionRegistry,
) -> Self
```

- [ ] Register `process.pid()` immediately after a successful PTY spawn and before inserting the session.
- [ ] `take()` the registration in the exit supervisor before clearing `pid` and `process`. Ensure restart, close, and shutdown also drop the old session registration.

### Step 5: Construct one shared registry before launch services

- [ ] In `ProductionRuntime::start`, create the registry before `TerminalManager` and `NativeProviderDriverFactory`. Pass the same clone to both.
- [ ] Preserve existing test constructors with an isolated default registry; do not use a global singleton.
- [ ] Run:

```bash
cargo test -p t4code-server production::provider_runtime::tests
cargo test -p t4code-server terminal::manager::tests
cargo test -p t4code-server production::runtime::tests
```

Expected: pass.

### Step 6: Commit the launcher integration

- [ ] Commit:

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/terminal/manager.rs apps/server/src/production/runtime.rs
git commit -m "feat(diagnostics): attribute provider and terminal processes"
```

---

## Task 4: Shared Native Resource Sampler and UI Coverage

**Files:**

- Create: `apps/server/src/diagnostics/resource_sampler.rs`
- Modify: `apps/server/src/diagnostics/native.rs`
- Modify: `apps/server/src/diagnostics/mod.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`

### Step 1: Write failing UI-observer and sampler tests

- [ ] Add a fake `DesktopUiProcessObserver` and test:
  - exact returned UI identities become `core/ui`;
  - `available`, `partial`, `unavailable`, and `notApplicable` survive the sample;
  - `partial` includes exact rows plus a bounded message;
  - an observer error becomes `unavailable` without losing the native server sample;
  - an observer taking longer than 250 ms is timed out and does not block native diagnostics;
  - malformed/unknown UI identities are ignored rather than guessed;
  - the native OS rows are collected once per `NativeResourceSampler::sample`.

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::resource_sampler::tests -- --nocapture
```

Expected: compilation fails because the sampler and observer boundary do not exist.

### Step 2: Define UI coverage and the observer boundary

- [ ] Add:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UiCoverageStatus {
    Available,
    Partial,
    Unavailable,
    NotApplicable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UiCoverage {
    pub status: UiCoverageStatus,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DesktopUiObservation {
    pub identities: Vec<ProcessIdentity>,
    pub coverage: UiCoverage,
}

pub trait DesktopUiProcessObserver: std::fmt::Debug + Send + Sync + 'static {
    fn observe(
        &self,
    ) -> Pin<Box<dyn Future<Output = DesktopUiObservation> + Send + '_>>;
}
```

- [ ] Bound observer identities to 64 and messages to 160 UTF-8 characters.
- [ ] Provide `UnavailableDesktopUiProcessObserver` and `NotApplicableUiProcessObserver`. The unavailable message must say that native server usage is included but local UI/WebView usage could not be associated reliably.
- [ ] Do not add executable-name matching.

### Step 3: Compose one native resource sample

- [ ] Replace the old row-only `ProcessSampler` with:

```rust
pub trait ResourceSampler: std::fmt::Debug + Send + Sync + 'static {
    fn sample(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<AttributedProcessSnapshot, SamplingError>> + Send + '_>>;
}
```

- [ ] `NativeResourceSampler` must:
  1. start the bounded UI observation;
  2. call the existing native all-process refresh exactly once;
  3. identify the current server row by `std::process::id()`;
  4. bind/prune the registry against those rows;
  5. add exact UI claims only for identities present in those same rows;
  6. call `ResourceAttributor`;
  7. return split totals, rows, coverage, sample time, and server identity.

- [ ] Keep `NativeProcessSampler` as the owner of the shared `System` and of native signal/cleanup methods.

### Step 4: Wire runtime-specific coverage honestly

- [ ] Add a `ServerRuntime::start_with_ui_process_observer` path used by the in-process desktop backend. Pass `UnavailableDesktopUiProcessObserver` from `apps/desktop/src-tauri/src/backend.rs`.
- [ ] Keep `ServerRuntime::start` as the headless/external entry point. It selects:
  - `NotApplicableUiProcessObserver` for `ServerMode::Web`;
  - `UnavailableDesktopUiProcessObserver` for an externally launched `ServerMode::Desktop`.
- [ ] Pass the observer through lifecycle startup into `ProductionRuntime::start`.
- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::resource_sampler::tests
cargo test -p t4code-server lifecycle::tests
cargo test -p t4code-server production::runtime::tests
cargo test -p t4code-desktop backend
```

Expected: pass.

### Step 5: Commit the shared sampler

- [ ] Commit:

```bash
git add apps/server/src/diagnostics/resource_sampler.rs apps/server/src/diagnostics/native.rs apps/server/src/diagnostics/mod.rs apps/server/src/lifecycle.rs apps/server/src/production/runtime.rs apps/desktop/src-tauri/src/backend.rs
git commit -m "feat(diagnostics): sample attributed resources once"
```

---

## Task 5: Coalesced Current and Split History Aggregation

**Files:**

- Modify: `apps/server/src/diagnostics/model.rs`
- Modify: `apps/server/src/diagnostics/monitor.rs`
- Modify: `apps/server/src/production/server_terminal.rs`

### Step 1: Write failing demand and last-good tests

- [ ] Replace the old background-loop expectations with tests proving:
  - construction performs zero samples;
  - the first current read samples once;
  - concurrent current and history reads share one in-flight sample;
  - reads within the 2-second interval reuse the latest sample;
  - a read after the interval samples again;
  - no timer continues sampling after reads stop;
  - a failed refresh retains the last-good snapshot and its timestamp;
  - a first-read failure returns no snapshot, not healthy zero totals.

Use a deterministic fake sampler with an atomic call count and controllable clock.

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::monitor::tests -- --nocapture
```

Expected: the new tests fail against the current background sampling loop.

### Step 2: Refactor the monitor into an on-demand single-flight source

- [ ] Remove `SamplingLease`, `Demand`, the spawned `sample_loop`, and the permanent `_process_history_lease` in `ServerTerminalServices`.
- [ ] Store:

```rust
struct MonitorState {
    current: Option<AttributedProcessSnapshot>,
    samples: VecDeque<AttributedProcessSample>,
    last_error: Option<String>,
    last_attempt: Option<Instant>,
}
```

- [ ] Guard refresh with one async mutex. `sample_current()` refreshes only when there is no sample or it is older than the configured interval. `read_history()` calls the same refresh method before aggregating.
- [ ] On failure, update only `last_error` and `last_attempt`; preserve `current` and retained samples.
- [ ] Keep retention at one hour and 20,000 samples.

### Step 3: Write failing split-history tests

- [ ] Add three-sample fixtures where Core and External peaks occur at different times. Assert:
  - average Combined equals average Core plus average External;
  - CPU peak Core and External values come from the sample with maximum Combined CPU;
  - RSS peak Core and External values come from the sample with maximum Combined RSS;
  - CPU and RSS can select different peak samples;
  - split approximate CPU seconds reconcile;
  - process summaries retain scope/kind/label/confidence and stable process key;
  - all UI coverage states survive aggregation;
  - sorting is not baked into the server's complete `processes` result.

- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::monitor::tests -- --nocapture
```

Expected: failures until bucket and summary aggregation are replaced.

### Step 4: Implement attributed history models

- [ ] Replace CPU-only buckets with:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SplitMetric<T> {
    pub combined: T,
    pub core: T,
    pub external: T,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BucketMetric<T> {
    pub average: SplitMetric<T>,
    pub peak: SplitMetric<T>,
}

pub struct ProcessResourceBucket {
    pub started_at_ms: i128,
    pub ended_at_ms: i128,
    pub cpu_percent: BucketMetric<f64>,
    pub rss_bytes: BucketMetric<u64>,
    pub max_process_count: SplitMetric<usize>,
}
```

- [ ] Retain attribution on each historical sample and rename `top_processes` to `processes`.
- [ ] Calculate Combined averages from group sums. Round RSS group averages to whole bytes, then derive Combined from the rounded Core plus External values so the wire invariant remains exact. When selecting a Combined peak, copy the Core and External values from that exact source sample.

### Step 5: Serve both RPCs from the monitor

- [ ] Change `server.getProcessDiagnostics` to call `monitor.sample_current()` instead of directly sampling `NativeProcessSampler`.
- [ ] Keep `server.getProcessResourceHistory` on the same monitor so status-bar and settings reads coalesce.
- [ ] Preserve structured failure tags and last-good timestamps.
- [ ] Run:

```bash
cargo test -p t4code-server diagnostics::monitor::tests
cargo test -p t4code-server production::server_terminal::tests
```

Expected: pass.

### Step 6: Commit the aggregation refactor

- [ ] Commit:

```bash
git add apps/server/src/diagnostics/model.rs apps/server/src/diagnostics/monitor.rs apps/server/src/production/server_terminal.rs
git commit -m "feat(diagnostics): split current and historical resources"
```

---

## Task 6: Atomic RPC Contract and Signal Revalidation

**Files:**

- Modify: `packages/contracts/src/server.ts`
- Modify: `packages/contracts/src/rpcRustParity.test.ts`
- Modify: `apps/server/src/production/server_terminal.rs`
- Modify: `apps/server/src/diagnostics/resource_sampler.rs`
- Modify: `packages/contracts/fixtures/rpc-wire/`

### Step 1: Write failing contract parity assertions

- [ ] Replace the old fixture expectations with schemas equivalent to:

```ts
export const ServerProcessAttributionScope = Schema.Literals(["core", "external"]);
export const ServerProcessAttributionKind = Schema.Literals([
  "server",
  "ui",
  "provider",
  "terminal",
  "helper",
  "unknown",
]);
export const ServerProcessAttributionConfidence = Schema.Literals([
  "exact",
  "inherited",
  "fallback",
]);

export const ServerProcessResourceTotals = Schema.Struct({
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});

export const ServerProcessAttributionTotals = Schema.Struct({
  combined: ServerProcessResourceTotals,
  core: ServerProcessResourceTotals,
  external: ServerProcessResourceTotals,
});

export const ServerProcessUiCoverage = Schema.Struct({
  status: Schema.Literals(["available", "partial", "unavailable", "notApplicable"]),
  message: Schema.Option(TrimmedNonEmptyString),
});
```

- [ ] Extend live entries and history summaries with `processKey`, `scope`, `kind`, `label`, and `confidence`; remove `isServerRoot`.
- [ ] Replace `processCount`, `totalRssBytes`, and `totalCpuPercent` with `totals`.
- [ ] Replace legacy history bucket fields with independent CPU and RSS `{ average, peak }` split metrics. CPU split values use `Schema.Number`; RSS and process-count split values use `NonNegativeInt`.
- [ ] Rename `totalCpuSecondsApprox` to split `cpuSecondsApprox` and `topProcesses` to `processes`.
- [ ] Add `processKey` to `ServerSignalProcessInput`.
- [ ] Run:

```bash
vp test packages/contracts/src/rpcRustParity.test.ts
```

Expected: fail because Rust wire fixtures still use the legacy contract.

### Step 2: Map attributed Rust models to the new wire shape

- [ ] Add explicit enum-to-camelCase mapping helpers in `server_terminal.rs`. Do not serialize Rust debug strings.
- [ ] Map live and history models without recomputing attribution or totals in the RPC layer.
- [ ] Assert in Rust tests that:
  - all scope/kind/confidence variants serialize;
  - all four UI coverage statuses serialize;
  - missing coverage messages use the existing Effect `Option` wire shape;
  - failure messages are bounded;
  - `combined == core + external`.

### Step 3: Write failing signal safety tests

- [ ] Change server-terminal signal tests to submit `{ pid, processKey, signal }` and cover:
  - exact current External descendant succeeds;
  - Core root is rejected;
  - Core UI is rejected;
  - stale key after PID reuse is rejected;
  - reparented External process is rejected because current ancestry no longer reaches the server;
  - unknown PID and unsupported signal remain structured failures.

- [ ] Run:

```bash
cargo test -p t4code-server production::server_terminal::tests -- --nocapture
cargo test -p t4code-server diagnostics::resource_sampler::tests -- --nocapture
```

Expected: failures because signal handling accepts PID only.

### Step 4: Revalidate identity, attribution, and ancestry before signaling

- [ ] Add `NativeResourceSampler::signal_external_descendant(expected_identity, signal)`. Refresh native rows once, bind the current registry snapshot, run the same attributor, require an exact identity match, require current server ancestry, and require the attributed row to be External before calling the native platform signal.
- [ ] Keep the native signal primitive private to diagnostics. `ServerTerminalServices` holds the shared `NativeResourceSampler` for signaling and the monitor holds the same sampler for reads.
- [ ] Keep the final platform signal operation after validation and return a structured stale/not-eligible error if any check fails.

### Step 5: Regenerate and verify RPC fixtures

- [ ] Run:

```bash
vp run --filter @t4code/contracts generate:rust-rpc-fixtures
vp test packages/contracts/src/rpcRustParity.test.ts
cargo test -p t4code-server production::server_terminal::tests
cargo test -p t4code-server diagnostics::resource_sampler::tests
```

Expected: pass with only intentional generated fixture changes.

### Step 6: Commit the atomic wire change

- [ ] Commit:

```bash
git add packages/contracts/src/server.ts packages/contracts/src/rpcRustParity.test.ts apps/server/src/production/server_terminal.rs apps/server/src/diagnostics/resource_sampler.rs packages/contracts/fixtures/rpc-wire
git commit -m "feat(contracts): expose attributed resource diagnostics"
```

---

## Task 7: Status-Bar Headline and Parallel Core/External Cards

**Files:**

- Modify: `apps/web/src/components/status-bar/statusBarPresentation.ts`
- Modify: `apps/web/src/components/status-bar/statusBarPresentation.test.ts`
- Modify: `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.tsx`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.test.tsx`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx`
- Modify: `apps/web/src/state/environments.ts`

### Step 1: Write failing pure presentation tests

- [ ] Add fixtures with Core server/UI rows and External provider/terminal/fallback rows. Assert:
  - compact memory and CPU use `totals.combined`;
  - Core and External cards use their own totals;
  - highest consumers sort by RSS descending by default;
  - every consumer shows both RSS and CPU;
  - ties are deterministic by label then process key;
  - partial/unavailable UI coverage creates a warning;
  - `notApplicable` does not create a warning;
  - stale last-good data retains values and creates a warning;
  - no-good-sample state returns unavailable presentation, not zeroes;
  - local Core is separate from remote selected-host totals.

- [ ] Run:

```bash
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts
```

Expected: fail against the legacy combined-only presentation.

### Step 2: Implement one typed status-bar view model

- [ ] Return a view model with this separation:

```ts
type ResourceUsagePresentation = {
  headline: ResourceTotalsPresentation | null;
  core: ResourceTotalsPresentation | null;
  external: ResourceTotalsPresentation | null;
  consumers: ReadonlyArray<ResourceConsumerPresentation>;
  uiCoverage: ServerProcessUiCoverage;
  localCore: ResourceTotalsPresentation | null;
  warning: ResourceWarningPresentation | null;
};
```

- [ ] Keep all sorting, stale/error interpretation, coverage wording, and reconciliation assertions in `statusBarPresentation.ts`; keep JSX declarative.

### Step 3: Render the approved popover hierarchy

- [ ] Update `ResourceUsageSegment.tsx`:
  1. Combined memory, CPU, and process count headline.
  2. Equal-width **T4Code Core** and **External Tooling** cards.
  3. **Highest consumers** mixed list with scope tag, label, bounded command, memory, and CPU.
  4. Optional **This device** Core row visually outside selected-host totals.

- [ ] Update accessible names and tooltip copy to say “combined monitored resources.”
- [ ] Show unavailable marks when there is no last-good sample.

### Step 4: Query selected and local hosts without merging

- [ ] Add a selector in `state/environments.ts` that returns the primary local environment only when the client is desktop and the selected environment is different.
- [ ] In `AppStatusBar.tsx`, use only the selected environment's live diagnostics query for resource totals and consumers. Remove its resource-history query; the popover does not render history. Settings may still request live and history concurrently, and the server monitor coalesces those reads.
- [ ] When a remote environment is selected in desktop mode, query the primary local environment and pass only its `totals.core` plus UI coverage as `localCore`.
- [ ] Browser clients and local selections omit the extra query and the **This device** row.

### Step 5: Verify behavior and commit

- [ ] Run:

```bash
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx
```

Expected: pass.

- [ ] Commit:

```bash
git add apps/web/src/components/status-bar/statusBarPresentation.ts apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/ResourceUsageSegment.tsx apps/web/src/components/status-bar/AppStatusBar.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx apps/web/src/state/environments.ts
git commit -m "feat(web): separate core and external resource usage"
```

---

## Task 8: Attributed Live Processes and Resource History

**Files:**

- Create: `apps/web/src/components/settings/resourceDiagnosticsPresentation.ts`
- Create: `apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts`
- Create: `apps/web/src/components/settings/ResourceDiagnosticsSections.tsx`
- Create: `apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx`
- Modify: `apps/web/src/components/settings/DiagnosticsSettings.tsx`
- Modify: `apps/web/src/components/settings/DiagnosticsSettings.test.tsx`

### Step 1: Write failing live-process presentation tests

- [ ] Test a pure `presentLiveProcesses` helper for:
  - Combined/Core/External summary cards;
  - memory descending default sort;
  - Memory, CPU, Name, and Scope sort toggles;
  - stable tie breaking by process key;
  - Scope, Kind, Label, Command, CPU, Memory, PID columns;
  - Core rows never eligible for signal controls;
  - External rows eligible only when the row is a current server descendant;
  - unavailable and stale states preserve the server timestamp semantics.

- [ ] Run:

```bash
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts
```

Expected: fail because the helper does not exist.

### Step 2: Write failing history projection tests

- [ ] Test a `presentResourceHistory` helper for:
  - Memory is the default metric;
  - CPU toggle selects the CPU split metric;
  - each bar stacks Core and External averages;
  - tooltip shows Combined average and same-sample Combined/Core/External peak;
  - summary values split Combined/Core/External;
  - process table retains CPU time/current/average/peak/max memory plus attribution;
  - 5m, 15m, 30m, and 1h window inputs are unchanged;
  - `partial` and `unavailable` explain that Core/Combined omit unobserved UI;
  - `notApplicable` is neutral.

- [ ] Run the same test file again and keep it red until both live and history helpers compile.

### Step 3: Implement pure projections and sort state

- [ ] Keep formatting shared with existing status-bar formatters where possible; extract a shared utility only if both files currently duplicate the same conversion.
- [ ] Model sort keys as closed unions, not arbitrary strings:

```ts
type LiveProcessSortKey = "memory" | "cpu" | "name" | "scope";
type HistoryMetric = "memory" | "cpu";
```

- [ ] Do not recompute totals from truncated rows. Summary cards always consume server totals.

### Step 4: Extract the resource diagnostics JSX

- [ ] Move only Live Processes and Resource History rendering out of `DiagnosticsSettings.tsx` into `ResourceDiagnosticsSections.tsx`. Leave trace diagnostics, latest failures, query setup, refresh actions, and mutations in the parent.
- [ ] Render:
  - parallel Core/External cards under the Combined summary;
  - attributed live columns and memory-first default;
  - Memory/CPU history toggle;
  - stacked Core/External bars;
  - complete attributed history table;
  - bounded coverage/error banners.
- [ ] Change signal callbacks to `(pid, processKey, signal)` and pass the key to the mutation.

### Step 5: Write and pass component/integration tests

- [ ] In `ResourceDiagnosticsSections.test.tsx`, assert the visual hierarchy, sorting interactions, chart toggle, coverage banners, and absence of signal controls on Core rows.
- [ ] In `DiagnosticsSettings.test.tsx`, assert the mutation includes `processKey`, stale identity errors trigger a refresh, and trace diagnostics remain unchanged.
- [ ] Run:

```bash
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx
```

Expected: pass.

### Step 6: Commit the diagnostics UI

- [ ] Commit:

```bash
git add apps/web/src/components/settings/resourceDiagnosticsPresentation.ts apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts apps/web/src/components/settings/ResourceDiagnosticsSections.tsx apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/settings/DiagnosticsSettings.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx
git commit -m "feat(web): add attributed resource diagnostics"
```

---

## Task 9: Documentation, Performance Checks, and Final Verification

**Files:**

- Modify: `docs/operations/observability.md`
- Verify: `scripts/measure-desktop-runtime.ts`
- Verify: `scripts/measure-desktop-runtime.test.ts`

### Step 1: Document the operational meaning

- [ ] Update `docs/operations/observability.md` with:
  - Combined, T4Code Core, and External Tooling definitions;
  - host-scoped remote/local behavior;
  - UI coverage statuses;
  - launcher registration plus fallback semantics;
  - stable PID/start identity;
  - last-good/stale behavior;
  - Core signal prohibition and server-side revalidation;
  - the fact that the initial desktop observer reports UI usage unavailable rather than estimating.

### Step 2: Verify the measurement harness

- [ ] Run:

```bash
vp test scripts/measure-desktop-runtime.test.ts
```

Expected: pass.

- [ ] Use the existing measurement summary for idle process count, private/RSS approximation, working set, highest-memory processes, and verified process-tree cleanup. Use Resource Manager's attributed CPU display for the active-load check; do not duplicate cross-platform CPU accounting in this script.

### Step 3: Run focused backend verification

- [ ] Run:

```bash
cargo test -p t4code-server
```

Expected: pass with zero failures.

### Step 4: Run focused and full web/contract verification

- [ ] Run:

```bash
vp test packages/contracts/src/rpcRustParity.test.ts
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx
vp test
```

Expected: pass with zero failures.

### Step 5: Run repository completion gates

- [ ] Run:

```bash
vp check
vp run typecheck
```

Expected: both exit successfully. These are mandatory repository completion gates.

### Step 6: Perform packaged manual verification

- [ ] On macOS, build and run the existing packaged runtime measurement:

```bash
vp run build:desktop
vp run measure:desktop-runtime -- --label resource-attribution-macos --command target/release/t4code-desktop --ready-url http://127.0.0.1:3773/.well-known/t4code/environment --window-title "T4Code (Alpha)" --idle-ms 30000
```

- [ ] With the packaged app:
  - leave Resource Manager closed and confirm no diagnostics polling;
  - open it and confirm one sample per interval;
  - start one provider and one terminal;
  - confirm both roots and descendants are External;
  - create provider CPU/RSS load and confirm only External rises materially;
  - confirm native server remains Core;
  - confirm UI coverage explicitly says unavailable on the initial adapter;
  - close the app and confirm no supervised descendants remain.

- [ ] Record Windows and Linux packaged verification as required pre-release platform checks using the same list. Do not claim cross-platform packaged verification from unit tests alone.

### Step 7: Review the final diff for invariants

- [ ] Run:

```bash
git diff --check
git status --short
```

- [ ] Confirm:
  - no legacy `totalRssBytes`, `totalCpuPercent`, `topProcesses`, or `isServerRoot` resource-contract reads remain;
  - no generic executable-name UI attribution exists;
  - no second process refresh or diagnostics polling loop was added;
  - no Core row can construct a signal mutation;
  - every changed contract fixture is generated;
  - unrelated user changes are not staged.

### Step 8: Commit documentation and any measurement changes

- [ ] Commit:

```bash
git add docs/operations/observability.md
git commit -m "docs: explain resource attribution diagnostics"
```
