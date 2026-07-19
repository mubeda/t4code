# Task 4: Dedicated toolbar component

## Implementation

Added `FileEditorToolbar`, a presentational 36 px editor action row with stable Save, Undo, and Redo ordering. It uses the existing `Button` and tooltip primitives, Lucide icons, semantic theme colors, disabled actions, and an accessible polite status region.

The status priority is `pending` → `saving` → `failed` → transient `Saved` → `cleanStatus`. A ref initialized from the first `confirmedRevision` prevents a clean remount from displaying `Saved`; later clean revision increases show `Saved` for 1,500 ms. Existing timeout cleanup handles subsequent phase/revision changes and unmounts.

## Files

- `apps/web/src/components/files/FileEditorToolbar.tsx`
- `apps/web/src/components/files/FileEditorToolbar.test.tsx`

## Tests and results

- `vp test run apps/web/src/components/files/FileEditorToolbar.test.tsx`
  - RED: failed as expected because `./FileEditorToolbar` did not exist.
  - GREEN: passed, 1 test file and 2 tests.
  - Final rerun: passed, 1 test file and 2 tests.
- `vp test`
  - Passed: 482 test files and 6,322 tests.
- `vp check`
  - Passed: 1,538 files correctly formatted; no warnings or lint errors in 1,164 files.
- `vp run typecheck`
  - Passed with exit code 0.

## TDD evidence

Created the real-DOM toolbar test before the component and ran it. The expected missing-module RED result was observed. The component was then implemented minimally to satisfy rendering/actions, phase status mapping, and the 1,500 ms timer test. The test required the project-standard `// @vitest-environment happy-dom` directive for its DOM setup; after adding that test-environment configuration, the focused suite passed.

## Self-review

Reviewed the final rendered hierarchy, action order, disabled behavior, semantic color classes, `currentColor` icon styling, phase precedence, revision gating, and timeout cleanup. No concerns found.
