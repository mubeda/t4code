# Resource Attribution in Resource Manager

## Goal

Make Resource Manager explain who consumed the reported CPU and memory without hiding the total
resource footprint of the selected T4Code environment.

The compact headline remains the combined monitored total. Every expanded view separates that
total into:

- **T4Code Core**: the native T4Code host/server plus local UI/WebView processes that the desktop
  host can associate reliably.
- **External Tooling**: AI provider CLIs, terminals, helpers, and other processes launched or
  supervised by T4Code.

The design prevents high provider usage from being presented as if it were T4Code's own usage,
while keeping the full operational cost visible.

## Current Problem

The native diagnostics sampler reads the server process and all of its descendants. Both the live
snapshot and history sum that tree into one number. The status bar and Resource Manager describe
the result as T4Code usage even though provider CLIs, terminal commands, Git, SSH, relay, and other
tools may dominate it.

The current model also has several internal inconsistencies:

- the live `processCount` includes the server root, while the UI labels it **Child Processes**;
- live CPU and memory tooltips describe child-only totals even though the server root is included;
- the compact process list is CPU-oriented even when memory is the resource under investigation;
- UI/WebView processes outside the server tree are explicitly excluded, so the displayed value is
  neither a pure T4Code number nor a complete local-application number; and
- ownership is inferred from ancestry and command text rather than recorded when T4Code launches
  the process.

## Chosen Approach

Use a **process-provenance registry with structural fallback**.

Process launchers register attributed root processes with stable metadata. The native sampler
continues to provide operating-system resource truth. An attribution layer joins the registry to
each sampled process set, assigns descendants through the nearest attributed ancestor, and falls
back to External Tooling for otherwise-unclassified descendants of the server.

This preserves current coverage when a launcher has not yet registered metadata, provides friendly
labels when metadata is available, and avoids command-name heuristics as the ownership authority.

OS resource containers such as cgroups and platform-specific job accounting are outside this
change. They may become useful later for enforcement or limits, but they are not required for
honest attribution.

## Scope

This design changes:

- native process sampling identity data;
- provider, terminal, helper, and desktop UI process registration;
- current resource diagnostics and history aggregation;
- typed resource-diagnostics contracts and RPC fixtures;
- the status-bar resource summary and popover;
- Diagnostics **Live Processes** and **Resource History**; and
- resource-diagnostics tests and packaged platform verification.

This design does not:

- add process resource limits or automatic termination;
- attribute resource usage to a specific T4Code thread or session;
- estimate memory for processes the operating system cannot identify reliably;
- sum processes from different machines;
- include unrelated machine-wide processes; or
- persist resource history across server restarts.

## Terminology

### Host scope

Every resource snapshot describes exactly one execution environment and therefore one machine.
The existing `environmentId` is the host-scope identity at the client boundary.

Local UI usage is included in the selected environment only when the desktop UI and native server
run on the same machine. When the selected environment is remote, its Core card describes that
remote T4Code server.

The desktop client also queries its always-present local environment when a remote environment is
selected. It renders the local environment's Core value separately as **This device**, including
its UI coverage state, and never adds that value to the remote total. Browser clients without a
local desktop environment omit **This device** because they have no local application process to
measure.

### Attribution scope

- `core`: T4Code-owned native host/server or reliably associated UI processes.
- `external`: a provider, terminal, helper, or fallback server descendant.

### Attribution kind

- `server`: the native T4Code server or combined Tauri host/server root.
- `ui`: a UI/WebView process claimed by the local desktop adapter.
- `provider`: a registered AI provider root or its descendants.
- `terminal`: a registered managed terminal root or its descendants.
- `helper`: another supervised process with registered launch metadata.
- `unknown`: an included server descendant without registered provenance.

### Attribution confidence

- `exact`: this observed process identity is a registered attributed root.
- `inherited`: the process is assigned through its nearest registered ancestor.
- `fallback`: the process is an unregistered descendant of the native server.

Confidence describes provenance quality, not metric accuracy. CPU and memory always come from the
native sampler.

## Architecture

### `ProcessAttributionRegistry`

Add a server-owned registry with one responsibility: retain bounded metadata for live attributed
process roots.

Each registration contains:

- PID;
- registration time;
- attribution scope;
- attribution kind;
- bounded display label;
- registration source; and
- lifecycle state needed to unregister the entry.

A registration initially knows the spawned PID. On the first matching sample, the registry binds
that entry to the operating system's process start identity. Future samples require both PID and
start identity to match. This prevents a reused PID from inheriting stale ownership.

Launchers unregister entries when their owned process exits or their supervision object is
released. Sampling also prunes entries whose bound process identity no longer exists. Unbound
registrations have a short fixed expiry so a failed spawn or a process that exits before the first
sample cannot leak registry state.

Registry reads are snapshot-based. The sampler never holds a registry write lock while refreshing
operating-system process state.

### Launch registrations

#### Providers

Provider child wrappers expose the spawned root PID. The native provider driver registers the root
with:

- scope `external`;
- kind `provider`; and
- a label derived from the configured provider instance display name, falling back to the stable
  provider name.

The registration lifetime follows the provider child wrapper. Provider subprocesses inherit that
attribution through ancestry.

#### Terminals

`TerminalManager` already owns the terminal PID, thread ID, terminal ID, and label. It registers the
PTY root with:

- scope `external`;
- kind `terminal`; and
- the existing bounded terminal label.

Commands launched inside the PTY inherit the terminal attribution. Thread and session identifiers
remain internal and are not added to the resource RPC.

#### Other helpers

Long-lived supervised server helpers register when their launcher already owns a stable PID and
lifecycle. Short-lived commands do not need mandatory registration: they remain visible through
the External fallback. This keeps the design honest without requiring an unrelated process-runner
rewrite.

#### Desktop UI

The desktop host owns a `DesktopUiProcessObserver` platform boundary. It reports only process
identities that the platform implementation can associate with the running T4Code desktop
instance. Those identities register as scope `core`, kind `ui`.

The observer reports one of:

- `available`: all UI processes exposed by the supported platform mechanism were sampled;
- `partial`: some UI processes were sampled, but the observer also encountered a bounded,
  actionable failure; or
- `unavailable`: the platform cannot provide reliable association or the observation failed before
  any UI process could be identified; or
- `notApplicable`: this is a headless server runtime with no co-located T4Code UI.

The observer never guesses from a generic executable name such as `WebContent`, browser, or
renderer. If a platform cannot distinguish T4Code UI processes from unrelated applications, UI
coverage is `unavailable`.

Desktop UI observation follows the same demand signal and sampling interval as process diagnostics.
It does not introduce an independent polling loop.

### `ResourceAttributor`

`ResourceAttributor` is a pure server module that combines:

- the current `ProcessRow` set;
- the native server process identity;
- the registry snapshot; and
- desktop UI coverage.

It produces attributed process rows in linear time:

1. Index sampled rows by PID and children by parent PID.
2. Identify the native server root as exact `core/server`.
3. Match registered roots by PID and start identity.
4. Walk each included root's descendants.
5. Assign a descendant to its nearest exact registered ancestor.
6. Assign otherwise-unmatched server descendants to `external/unknown/fallback`.
7. Ignore processes that are neither included roots nor descendants of an included root.
8. Deduplicate by process identity so overlapping roots cannot double count a process.

An exact registered root remains included until its observed identity exits, even if the operating
system reparents it. This preserves attribution for a supervised process that temporarily leaves
the server's ancestry tree.

When exact roots overlap, the closest exact ancestor owns each descendant. An exact process always
owns itself. These rules make terminal-launched helpers or nested provider subprocesses
deterministic.

### Current and history aggregation

Current aggregation returns totals for:

- `combined`;
- `core`; and
- `external`.

Each total contains:

- current CPU percent;
- current RSS bytes; and
- process count.

For every current sample:

```text
combined.cpu = core.cpu + external.cpu
combined.rss = core.rss + external.rss
combined.processCount = core.processCount + external.processCount
```

History retains the attribution metadata with each process sample. Each time bucket calculates
Core, External, and Combined values from the same per-sample groups.

The stacked history visualization uses average Core and External values, for which the combined
average is additive. Each bucket also reports the combined peak and the Core/External decomposition
from the same sample that produced that peak. Independent group maxima are available for detail
and tests but are never added together or rendered as an additive stack.

The bucket contract represents CPU and RSS independently. Each metric contains:

- `average.combined`, `average.core`, and `average.external`; and
- `peak.combined`, `peak.core`, and `peak.external`.

For each metric, the peak's Core and External values come from the same sample that produced the
Combined peak. This adds average RSS data that the current history contract does not retain and
prevents a visually stacked peak from combining values observed at different times.

Approximate CPU time is split into Combined, Core, and External values using the existing sampling
interval calculation.

History remains in memory, demand-driven, bounded to the current retention window and maximum
sample count, and reset by a server restart.

## Typed Contract

The existing diagnostics contract is revised atomically rather than layering UI inference over
legacy totals.

### Shared resource values

Add schema-only contract structures equivalent to:

```ts
type ServerProcessAttributionScope = "core" | "external";

type ServerProcessAttributionKind =
  | "server"
  | "ui"
  | "provider"
  | "terminal"
  | "helper"
  | "unknown";

type ServerProcessAttributionConfidence = "exact" | "inherited" | "fallback";

interface ServerProcessResourceTotals {
  cpuPercent: number;
  rssBytes: number;
  processCount: number;
}

interface ServerProcessUiCoverage {
  status: "available" | "partial" | "unavailable" | "notApplicable";
  message?: string;
}
```

The bounded coverage message explains partial or unavailable UI accounting. Absence of UI coverage
is not encoded as zero resource usage.

### Process rows

Live entries and history summaries gain:

- an opaque `processKey` derived from PID and process start identity;
- `scope`;
- `kind`;
- `label`; and
- `confidence`.

The key no longer embeds the full command. Command remains a separate bounded diagnostic field.

The process start identity is used internally and need not be exposed separately unless required
by a process-action revalidation test.

### Live result

`ServerProcessDiagnosticsResult` replaces the ambiguous single totals with:

- `totals.combined`;
- `totals.core`;
- `totals.external`;
- `uiCoverage`;
- attributed `processes`;
- the existing server PID, read time, and structured error.

The client associates the result with the environment through the existing environment-scoped RPC
query. The result does not add a duplicate environment identifier.

### History result

`ServerProcessResourceHistoryResult` gains:

- split approximate CPU time;
- split bucket aggregates;
- `uiCoverage`; and
- attributed process summaries.

Rename misleading internal `topProcesses` APIs to `processes` when they contain every currently
represented process. Sorting and truncation belong to presentation helpers unless the server later
needs an explicit bounded result.

RPC wire fixtures and typed failure fixtures are regenerated in the same change.

## UI Design

### Compact status bar

The status-bar memory number remains the current Combined value for the selected environment. This
preserves visibility of the complete monitored footprint.

The accessible label and tooltip call it **combined monitored resources**, not T4Code-only
resources. A warning indicator appears when the latest snapshot is stale, failed, or has partial
UI coverage.

### Resource Manager popover

The popover uses the approved parallel-card hierarchy:

1. Combined memory, CPU, and process count as the headline.
2. Equal-width **T4Code Core** and **External Tooling** cards.
3. **Highest consumers**, ranked by current RSS memory.

Each consumer row shows:

- Core or External tag;
- attributed label;
- bounded command detail;
- current memory; and
- current CPU.

The mixed list allows the user to compare a provider against the native host without losing the
scope label. It defaults to memory order because the motivating failure is unexplained memory
usage.

When the desktop client has selected a remote environment, a **This device** row shows the local
environment's Core usage separately. It is visually outside the selected-host
Combined/Core/External totals and includes the local UI coverage state. Browser clients omit this
row because they do not own a local desktop runtime.

### Live Processes

Replace the misleading **Child Processes** and child-only tooltips with Combined, Core, and
External summaries. Keep server PID as secondary diagnostic metadata rather than one of the
primary accountability metrics.

The live table adds Scope, Kind, and attributed Label. It supports sorting by at least Memory, CPU,
Name, and Scope, with current Memory descending as the default.

Core rows never show process termination actions. Interrupt or Kill is available only for eligible
live External descendants, and the server revalidates identity, ancestry, and signal eligibility
immediately before signaling. UI state never grants signal authority.

### Resource History

History defaults to Memory and retains a CPU toggle. Its chart stacks Core and External averages
for each bucket and shows the Combined value plus same-sample peak decomposition in the tooltip.

History summary blocks expose Combined, Core, and External values. The process table retains CPU
time, current/average/peak CPU, maximum memory, command, and PID while adding attribution fields
and sortable columns.

The existing 5-minute, 15-minute, 30-minute, and 1-hour windows remain.

## Errors and Degraded Behavior

Resource diagnostics must not convert missing information into healthy zeroes.

- If a refresh fails after a successful sample, retain the last good snapshot, preserve its
  timestamp, mark it stale, and show the bounded failure.
- If no good sample exists, show unavailable placeholders instead of zero values.
- If UI coverage is `partial`, include the reliably observed UI processes and state that the Core
  and Combined totals are partial.
- If UI coverage is `unavailable`, report native server Core usage and explicitly state that local
  UI usage is not included.
- If UI coverage is `notApplicable`, report the headless server Core usage as complete for that
  host; do not present the lack of a co-located UI as a failure.
- If an attribution registration is missing, retain the process as External fallback.
- If a registered process identity disappears, remove it from the next snapshot and registry.
- If a PID is reused, treat it as a new process with no inherited registration.
- If the selected environment is remote, never merge local UI observation errors into the remote
  server RPC result.

All error and coverage messages are bounded and must not contain environment variables,
credentials, prompts, provider payloads, or unrestricted command output.

## Performance and Reliability Constraints

- Reuse the current native OS process refresh; attribution must not add a second machine-wide
  process scan.
- Preserve demand-driven sampling. No process or UI polling runs without an active diagnostics or
  history consumer.
- Keep the existing sampling interval unless packaged measurements justify a deliberate change.
- Attribution is O(processes plus registry entries) per sample through indexed process identity and
  parent maps.
- Registry entries, labels, coverage messages, and history samples remain bounded.
- Registry lifecycle cleanup must not depend solely on periodic sampling; owning supervisors
  unregister on normal exit and shutdown.
- Sampling and registry failures cannot terminate provider, terminal, or desktop supervision.
- A slow or failed desktop UI observer cannot block the native server/process sample beyond a
  bounded observation timeout.
- Packaged-runtime comparison must show no material idle overhead and no extra process left behind
  after shutdown.

## Testing

### Rust unit tests

Test:

1. native server root becomes exact Core;
2. registered UI and provider roots become exact Core and External respectively;
3. descendants inherit the nearest registered root;
4. unregistered server descendants become External fallback;
5. unrelated machine processes are ignored;
6. overlapping roots count every process once;
7. a reparented exact root remains attributed until exit;
8. PID reuse cannot inherit stale attribution;
9. unregister and exit prune registry entries;
10. current Combined totals equal Core plus External;
11. history averages remain additive;
12. peak decomposition comes from one real sample rather than independent maxima;
13. available, partial, unavailable, and not-applicable UI coverage survive aggregation; and
14. sampling continues when attribution metadata is missing or malformed.

### RPC and contract tests

Cover:

- attributed live result serialization;
- attributed history result serialization;
- all attribution scope, kind, confidence, and coverage variants;
- bounded coverage failures;
- structured sampling failures;
- process-signal identity and ancestry revalidation; and
- regenerated wire fixtures.

### Web tests

Cover:

- Combined compact headline;
- parallel Core and External cards;
- memory-first consumer ordering with both memory and CPU values;
- attribution labels and tags;
- Live Processes default sort and sortable columns;
- stacked Memory and CPU history;
- stale last-good data;
- no-sample unavailable state;
- available, partial, unavailable, and not-applicable UI coverage;
- remote-host separation from local UI;
- no signal controls for Core rows; and
- refresh behavior across live and history queries.

### Packaged platform verification

On macOS, Windows, and Linux:

- launch a packaged desktop build;
- open Resource Manager to activate sampling;
- start at least one provider and terminal;
- verify their roots and descendants are External;
- verify Core includes the native server;
- verify the UI observer reports available, partial, unavailable, or not-applicable honestly;
- create a provider memory/CPU load and confirm the increase appears under External;
- close the app and confirm no supervised process tree remains.

Headless and remote verification confirms that Core contains the remote server only and local UI is
not added to the remote totals.

Run focused Rust and web tests followed by the repository gates:

```bash
cargo test -p t4code-server
vp test
vp check
vp run typecheck
```

## Rollout Sequence

The implementation plan should preserve reviewable internal milestones:

1. process start identity and pure attribution logic;
2. bounded registry and launcher lifecycle integration;
3. desktop UI observer and coverage result;
4. attributed current and history aggregation;
5. typed contracts, RPC wiring, and fixtures;
6. presentation helpers and status-bar popover;
7. Live Processes and Resource History UI;
8. packaged cross-platform validation.

The contract and UI switch land atomically. There is no interval where a new client silently
interprets old combined totals as Core usage.

## Acceptance Criteria

- The compact headline still reports the Combined monitored total for the selected host.
- Expanded views always show separate T4Code Core and External Tooling totals.
- Current Combined CPU, RSS, and process counts reconcile exactly with Core plus External.
- Provider and terminal roots use launcher-supplied labels; their descendants inherit ownership.
- An unregistered descendant remains visible as External fallback.
- Highest consumers defaults to current memory and shows both memory and CPU.
- Resource history can display stacked Core and External Memory or CPU.
- Reliably associated local UI processes are Core; unavailable UI attribution is stated explicitly.
- Remote host totals never include local desktop UI usage.
- Core processes cannot be signaled from Resource Manager.
- PID reuse, overlapping roots, stale samples, and partial failures cannot produce silent
  misattribution or healthy-looking zeroes.
- Attribution introduces no second OS-wide process scan and preserves demand-driven sampling.
- Focused tests, `vp check`, and `vp run typecheck` pass before implementation is considered
  complete.
