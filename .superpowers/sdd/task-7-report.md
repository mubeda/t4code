# Task 7 Report: Status-Bar Core and External Resource Usage

## Status

Implemented Task 7 on base `7cf70b3ed8ae52aaf619a9100a55aa814711950c`.

- Kept the compact resource headline tied to the selected host's Combined
  totals and updated its accessible name and tooltip to say "combined
  monitored resources."
- Added one typed presentation model for Combined, T4Code Core, External
  Tooling, highest consumers, selected-host UI coverage, separate local Core,
  and warnings.
- Rendered equal-width Core and External cards, a memory-first mixed consumer
  list with scope/label/command/RSS/CPU, and an optional out-of-band **This
  device** Core row.
- Preserved stale last-good values with warnings and presented no-good-sample
  states as unavailable rather than healthy zeroes.
- Removed the status bar's resource-history query and refresh. A remote
  selection in the desktop client now makes one additional live diagnostics
  query for the primary local environment and passes only local `totals.core`
  plus UI coverage to the separate row.
- Browser clients and primary-local selections use a null local query and do
  not call the local diagnostics RPC builder.

## TDD Evidence

### RED: typed resource presentation

Command:

```text
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts
```

Exit: `1`.

Result:

```text
Test Files 1 failed
Tests 10 failed | 2 passed
```

The failures were the expected legacy combined-only behavior. Representative
failure:

```text
expected vm.headline to match
{ memoryLabel: "700.0 MB", cpuLabel: "10.0%", processCountLabel: "5" }
received undefined
```

The same RED run proved that the legacy presentation had no split cards,
RSS-first consumers, deterministic label/process-key ties, warnings,
unavailable state, separate local Core, or reconciliation assertion.

### RED: hierarchy and query behavior

Command:

```text
vp test apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx
```

Exit: `1`.

Result after keeping the legacy callback callable so failures remained
behavior assertions:

```text
Test Files 2 failed
Tests 9 failed | 9 passed
```

Failures showed:

- the old "T4Code native process resources" accessible copy;
- no parallel Core/External cards, mixed consumer rows, unavailable marks, or
  **This device** row;
- no primary-local selector;
- the third query was still resource history;
- the local diagnostics hook/query/prop was absent; and
- refresh handlers still refreshed history instead of optional local live
  diagnostics.

### RED: tooltip copy

After the main GREEN pass, acceptance review found that the native `title`
tooltip included the metrics but not the literal required phrase.

```text
vp test apps/web/src/components/status-bar/AppStatusBar.test.tsx
Test Files 1 failed
Tests 1 failed | 8 passed
expected title="Combined monitored resources..."
```

The title was updated, and the focused suite returned to GREEN.

## Behavior Coverage

The pure fixtures contain:

- Core server and UI rows;
- External provider, terminal, and fallback rows;
- independent Combined/Core/External totals; and
- a separate local Core input.

Assertions cover:

- Combined compact/headline memory, CPU, and process count;
- independent Core and External totals;
- RSS-descending consumer order;
- RSS and CPU on every consumer;
- deterministic ties by label and then process key;
- partial and unavailable UI coverage warnings;
- no warning for `notApplicable`;
- stale last-good values plus failure warning;
- unavailable values when no good sample exists;
- local Core separation from remote totals; and
- rejection of totals that do not reconcile.

Component and behavior assertions cover:

- approved hierarchy and equal two-column scope cards;
- attribution tags, labels, bounded/truncated command detail, memory, and CPU;
- combined accessible and tooltip wording;
- unavailable marks instead of zero-valued health;
- local Core rendered after and outside selected-host sections;
- desktop-only primary-local selection;
- selected and local live diagnostics queries without status-bar history; and
- no local diagnostics RPC for browser/local selection paths.

## Focused Verification

```text
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx

Test Files 3 passed
Tests 30 passed
exit 0
```

The Node test process prints an existing experimental notice that
`localStorage` is unavailable without `--localstorage-file`; it does not
produce a test warning or failure.

## Required Gates

```text
vp check
pass: All 1538 files are correctly formatted
pass: Found no warnings or lint errors in 1158 files

vp run typecheck
exit 0
vp run: 0/11 cache hit (0%)

git diff --check
exit 0
```

`vp run typecheck` continues to print repository-wide Effect
`Schema.Number` suggestions that predate Task 7; it reports no type errors and
exits successfully.

The first `vp check` identified formatting-only changes in five Task 7 files.
`vp check --fix` completed successfully, and the final `vp check` above is
clean.

## File Summary

- `apps/web/src/components/status-bar/statusBarPresentation.ts`
  - Added the typed split view model, memory-first deterministic consumers,
    coverage/stale/no-sample interpretation, local coverage presentation, and
    totals reconciliation.
- `apps/web/src/components/status-bar/statusBarPresentation.test.ts`
  - Added the pure Core/External attribution and degraded-state regression
    matrix.
- `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
  - Rendered the Combined headline, parallel cards, consumer list, warnings,
    unavailable marks, combined copy, and separate local Core row.
- `apps/web/src/components/status-bar/AppStatusBar.tsx`
  - Removed the history query, added selected/local live diagnostics wiring,
    and kept local Core outside selected totals.
- `apps/web/src/components/status-bar/AppStatusBar.test.tsx`
  - Added hierarchy, copy, unavailable, selector, and refresh unit coverage.
- `apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx`
  - Added desktop/local query routing, no-history, and no-extra-RPC behavior
    coverage.
- `apps/web/src/state/environments.ts`
  - Added the desktop-only primary-local selector and presentation hook.

No files under `.repos/` or `third_party/` were modified. The ignored,
root-owned `.superpowers/sdd/progress.md` ledger was preserved and is not part
of the Task 7 commit.

## Reviewer Correction: Independent Query Failures

Follow-up review identified that `AppStatusBar` discarded
`useEnvironmentQuery().error` for both selected and local diagnostics, and
reduced local diagnostics to totals before the presentation layer could
interpret structured failure/freshness metadata.

The correction:

- carries typed `{ diagnostics, queryError }` states for the selected host and
  optional primary-local host;
- presents initial selected query failures as unavailable and retained
  selected data as stale;
- carries the full local diagnostics result so structured `result.error`, UI
  coverage, and query-layer failure can produce a separate local warning;
- renders an expected local query's initial failure as an unavailable **This
  device** row rather than omitting it or showing zeroes;
- keeps selected and local warnings independent, including separate status
  regions and accessible copy;
- appends the selected warning state to the trigger `aria-label` and `title`
  without leaking local-only warnings into the trigger; and
- adds a real React rerender regression using the real `useEnvironmentQuery`
  and atom hooks. It transitions browser/desktop and remote/local selections,
  exercises initial and retained query failures, verifies stable hook
  execution, and verifies that no local diagnostics descriptor is requested
  on the browser path.

### Correction RED

```text
vp test apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx

Test Files 2 failed
Tests 18 failed | 9 passed
exit 1
```

The new failures demonstrated that production still accepted only the legacy
`{ diagnostics, localCore }` input, had no query-error status, could not retain
local failure metadata, and did not include stale/unavailable status in the
selected trigger's accessible copy.

The real rerender test was authored before production changes in a separate
happy-dom file so the existing behavior harness could retain its intentionally
mocked React implementation. Its final harness uses real React hooks, the real
`useEnvironmentQuery`, real mutable Effect atoms, deterministic unmount
cleanup, and mocks only environment selection, RPC atom factories, commands,
terminal data, and leaf UI.

### Correction Coverage

New assertions cover:

- initial and retained selected query-layer failures;
- initial and retained local query-layer failures;
- retained local structured diagnostics failures;
- local UI-coverage warnings remaining local;
- selected stale status in trigger `aria-label` and `title`;
- local-only failure copy excluded from the selected trigger;
- browser-to-desktop and remote-to-local rerenders without conditional hook
  failure; and
- absence of a primary-local diagnostics request until the desktop-local
  environment is in scope.

### Correction Verification

```text
vp test apps/web/src/components/status-bar/statusBarFormat.test.ts apps/web/src/components/status-bar/statusBarPresentation.test.ts apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx

Test Files 5 passed
Tests 43 passed
exit 0

vp check
pass: All 1539 files are correctly formatted
pass: Found no warnings or lint errors in 1159 files

vp run typecheck
exit 0
vp run: 0/11 cache hit (0%)
```

The existing Node `localStorage` experimental notice and repository-wide
Effect `Schema.Number` suggestions remain non-failing. No files under
`.repos/` or `third_party/` were modified, and the ignored
`.superpowers/sdd/progress.md` ledger remains untouched.
