# Task 1 Report: Contract — host-managed `DesktopPreviewBridge`

## Implementation

- Added `DesktopPreviewBounds` and `DesktopPreviewBoundsSchema` to the IPC contract. The schema accepts numeric `x`/`y` and rejects negative `width`/`height`.
- Made the Electron-only `registerWebview` and `getPreviewConfig` bridge members optional, with documentation that they are absent from the Tauri host.
- Added required `setBounds(tabId, bounds, visible)` to `DesktopPreviewBridge`.
- Guarded the web preview-config loader so a host that lacks `getPreviewConfig` produces the existing typed load failure rather than a synchronous undefined-method error.
- Added the focused schema test and checked Task 1 plan steps 1–5.

## TDD evidence

RED command:

```text
pnpm --filter @t4code/contracts test -- ipc.preview
```

Result: failed as expected before the export existed. The focused test attempted to decode the undefined `DesktopPreviewBoundsSchema` and failed with `TypeError: Cannot read properties of undefined (reading 'ast')` at `ipc.preview.test.ts:9` (1 failed test; exit status 1).

GREEN command:

```text
pnpm --filter @t4code/contracts test -- ipc.preview && pnpm --filter @t4code/web typecheck
```

Result: passed after implementation: 29 contract test files / 351 tests passed; web typecheck completed with no errors. The compiler emits pre-existing `effect(schemaNumber)` suggestions, but no failures.

## Verification commands and results

```text
pnpm --filter @t4code/contracts typecheck && pnpm --filter @t4code/web typecheck
```

Result: contracts typecheck passed; web typecheck initially failed at the expected optional `bridge.getPreviewConfig` call. After adding the guard, the GREEN command passed.

```text
vp check
vp run typecheck
```

Result: both passed. `vp check` reported all 1,563 files formatted and no lint warnings/errors. `vp run typecheck` completed with `0 errors`; pre-existing Effect number-schema suggestions remained informational.

## Files changed

- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/ipc.preview.test.ts`
- `apps/web/src/browser/previewWebviewConfigState.ts`
- `docs/superpowers/plans/2026-07-20-embedded-ai-browser-phase-1.md`
- `.superpowers/sdd/task-1-report.md`

## Self-review

- Confirmed only the required bridge members changed: `registerWebview` is optional, `setBounds` directly follows it, and `getPreviewConfig` is optional.
- Confirmed the bridge bounds type is an Effect Schema contract and the test covers round-trip and negative dimensions.
- Confirmed the optional web call is guarded and remains mapped through `PreviewWebviewConfigLoadError` on rejection.
- Ran `git diff --check`; no whitespace errors.

## Concerns

None. The global typecheck emits existing informational `effect(schemaNumber)` suggestions outside this task; they do not cause command failures.
