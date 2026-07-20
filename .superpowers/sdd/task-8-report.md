# Task 8 Report: Attributed Live Processes and Resource History

## Status

Implemented Task 8 on base `e414c2453794478b74520676104f940e92f29efb`.

- Added pure live/history projections with closed sort/metric unions, stable
  process-key tie breaking, bounded error and coverage presentation, and
  server-timestamp preservation for stale and unavailable samples.
- Kept summary totals sourced from server-provided Combined/Core/External
  values rather than visible process rows.
- Extracted only Live Processes and Resource History rendering into
  `ResourceDiagnosticsSections`; trace diagnostics, query orchestration,
  refresh callbacks, and the signal mutation remain in
  `DiagnosticsSettings`.
- Added the approved Combined headline and parallel T4Code Core / External
  Tooling cards, memory-first attributed live table, Memory/CPU history
  toggle, stacked average history bars, same-sample peak tooltips, and the
  complete attributed history table.
- Limited signal controls to External rows whose complete current PID ancestry
  reaches the current server. Core rows and reparented External roots and
  children are never offered controls. The mutation carries
  `{ pid, processKey, signal }`, and stale identity results refresh live data.

Commit message:

```text
feat(web): add attributed resource diagnostics
```

## TDD Evidence

### RED: pure live projection

Command:

```text
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts
```

Exit: `1`.

The live projection test suite failed for the expected missing production
module:

```text
Cannot find module './resourceDiagnosticsPresentation'
```

The live RED covered server-backed Combined/Core/External summaries, memory
default sorting, Memory/CPU/Name/Scope toggles, process-key tie breaking,
attributed columns, timestamp/error states, and current-ancestry signal
eligibility including a reparented root and child.

### RED: pure history projection

The same focused command remained red for the missing module after adding
history coverage for Memory default, CPU selection, additive average stacks,
same-sample split peaks, split CPU-time summaries, full attributed process
rows, unchanged 5m/15m/30m/1h inputs, and UI coverage semantics.

### RED: extracted resource component

Command:

```text
vp test apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx
```

Exit: `1`.

The component suite failed for the expected missing production module:

```text
Cannot find module './ResourceDiagnosticsSections'
```

The component RED covered the card hierarchy, sort and metric interactions,
stacked Core/External bars, same-sample peak tooltip, coverage banners, full
columns, and signal-control absence for Core and reparented External rows.

### RED: exact live Label column

The post-extraction requirement audit tightened the live-column assertion to
the Live Processes section only. It failed because the sortable heading still
displayed `Name`:

```text
expected Live Processes markup to contain '>Label<'
```

The heading now displays `Label` while retaining the accessible
`Sort by Name` action.

## Focused Verification

```text
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx

Test Files 3 passed (3)
Tests 56 passed (56)
```

The integration assertions cover the exact
`{ pid: 100, processKey: "100:100", signal }` mutation payload, refresh after
stale descendant and stale identity responses, Windows interrupt behavior,
and unchanged Trace Diagnostics/latest-failure rendering.

The test runner emits its existing Node `ExperimentalWarning` about the
missing `--localstorage-file`; all focused tests pass.

## Required Gates

```text
vp check
pass: All 1543 files are correctly formatted
pass: Found no warnings or lint errors in 1163 files

vp run typecheck
exit 0

git diff --check
exit 0
```

`vp run typecheck` continues to print repository-wide TS377098 suggestions
about existing `Schema.Number` declarations. It reports no typecheck failure,
and Task 8 adds no schema declarations.

## Scope Audit

- Task 8 changes are limited to the six requested web files and this report.
- `.repos/` and `third_party/` were not modified.
- The ignored, root-owned `.superpowers/sdd/progress.md` remains untouched and
  is not included in the commit.

## Reviewer Correction

The reviewer correction adds the omitted history-process sorting contract and
makes live signal eligibility conservative when a diagnostics sample contains
duplicate PID identities.

- Added the closed `HistoryProcessSortKey` union for Label, Scope, Kind, CPU
  time, Current CPU, Average CPU, Peak CPU, and Max memory.
- History defaults to Max memory descending. Selecting a new text key defaults
  ascending, selecting a new numeric key defaults descending, selecting the
  active key toggles direction, and every comparison uses `processKey`
  ascending as its deterministic final tie break.
- The history table exposes sortable buttons and `aria-sort` on each supported
  attribution/metric header. Command and PID remain visible and unsorted.
- Removed Current Memory from the history table because the approved process
  table requires CPU time, current/average/peak CPU, maximum memory, command,
  and PID.
- Signal eligibility is now represented by `processKey`, not PID. A duplicated
  target PID, duplicated ancestor PID, duplicated server PID, ancestry cycle,
  or reparented root makes the affected path unsignalable. The existing server
  command still receives `{ pid, processKey, signal }` and revalidates the live
  descendant identity before signaling.

### Correction RED

Focused pure tests failed as expected before implementation:

```text
duplicate target PID:
expected signalEligibility["200:1"] false, received true

ambiguous parent PID:
expected signalEligibility["700:1"] false, received true

history default:
expected processSort { key: "maxMemory", direction: "desc" }, received undefined
```

The cycle regression also exposed an existing synchronous loop: `Set.add()`
returns the Set rather than a membership boolean. The ancestry traversal now
checks `Set.has()` before adding the PID.

The component interaction RED failed because the history table still rendered
static headings and had no `aria-sort="descending"` Max Memory control.

### Correction Verification

```text
vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts --run

Test Files 1 passed (1)
Tests 35 passed (35)

vp test apps/web/src/components/settings/resourceDiagnosticsPresentation.test.ts \
  apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx \
  apps/web/src/components/settings/DiagnosticsSettings.test.tsx --run

Test Files 3 passed (3)
Tests 71 passed (71)

vp test apps/web/src/components/settings --run

Test Files 21 passed (21)
Tests 317 passed (317)
```

The 71 focused tests include the original 56 cases plus the new pure and
interaction regressions. The adjacent settings suite also passes. The test
runner continues to emit its existing Node `ExperimentalWarning` about the
missing `--localstorage-file`.

Correction gates:

```text
vp check
pass: All 1543 files are correctly formatted
pass: Found no warnings or lint errors in 1163 files

vp run typecheck
exit 0

git diff --check
exit 0
```

Typecheck continues to emit the same repository-wide TS377098 suggestions
documented above and reports no typecheck failure.
