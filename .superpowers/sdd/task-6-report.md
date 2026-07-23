# Task 6 Report: Integrate Native Triggers and Local Actions

## RED evidence

- The brief's exact command, `vp test run --project unit apps/web/src/components/chat/ChatComposer.test.tsx`, could not start because this checkout has no Vitest project named `unit`.
- The equivalent runnable command, `vp test run apps/web/src/components/chat/ChatComposer.test.tsx`, then failed 19 of 90 tests for the expected legacy behavior:
  - colon actions did not open a menu;
  - `/model`, `/plan`, and `/default` leaked into the slash menu;
  - file and agent selections used Markdown/prose replacements;
  - unsupported `$` text still opened a menu;
  - capability changes did not close stale triggers;
  - standalone `:model` reached `onSend`;
  - the old placeholder and legacy item IDs remained.

## GREEN evidence

- `vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx`
  - 3 test files passed, 227 tests passed on the final post-review source.
- `vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/composerCapabilities.test.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/composer-logic.test.ts apps/web/src/components/chat/composerSlashCommandSearch.test.ts`
  - 6 test files passed, 172 tests passed on the final post-review source.
- `vp check`
  - all 1,603 files correctly formatted; no lint warnings or errors across 1,219 files.
- `vp run typecheck`
  - all 11 package checks passed.

## Implementation

- `ChatComposer` now derives one capability profile per selected provider snapshot and passes its canonical trigger profile to every trigger detection.
- Menu construction is centralized through `buildComposerCommandItems`, including path-search state, semantic groups, preferred agent highlighting, and provider-instance-specific replacements.
- File and agent insertion uses native `@path` and `@name` references. Slash and dollar skills remain separated by provider invocation metadata.
- `:model`, `:plan`, and `:default` execute locally; submitted local actions clear prompt/cursor/menu state without reaching the send boundary. Ordinary pending custom answers remain in the pending-answer flow, while standalone pending local actions execute locally.
- `ChatView` retains a parent-level safety boundary for only `:plan` and `:default`; `:model` remains composer-owned.
- Capability and provider-instance changes re-detect the live editor snapshot without rewriting draft text.
- `ComposerPromptEditor` receives only mentionable agents, and all cursor conversions use the same mentionable-agent set.
- The placeholder is provider-neutral.
- Removed `LegacyComposerTrigger`, `LegacyComposerCommandItem`, `searchLegacySlashCommandItems`, the slash parser alias, and the bivariant command-menu selection handler.

## Files

- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ChatComposer.test.tsx`
- `apps/web/src/components/chat/ChatComposer.rerender.test.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.hooks.test.tsx`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/components/chat/ComposerCommandMenu.tsx`
- `apps/web/src/components/chat/composerCapabilities.ts`
- `apps/web/src/components/chat/composerCapabilities.test.ts`
- `apps/web/src/components/chat/composerCommandItems.ts`
- `apps/web/src/components/chat/composerCommandItems.test.ts`
- `apps/web/src/components/chat/composerSlashCommandSearch.ts`
- `apps/web/src/components/chat/composerSlashCommandSearch.test.ts`
- `apps/web/src/composer-logic.ts`
- `apps/web/src/composer-logic.test.ts`

## Self-review

- Confirmed concurrent editor/store range validation remains in `applyPromptReplacement`.
- Confirmed the re-entrant selection lock remains held until the next animation frame.
- Confirmed keyboard navigation, Enter/Tab selection, Shift+Tab mode toggle, and Shift+Enter behavior remain covered.
- Confirmed pending custom answers use their dedicated callback, ordinary answers still advance, and standalone action-shaped answers execute locally before pending-input advancement.
- Confirmed provider switches preserve prompt text while stale unsupported triggers and highlight state are cleared.
- Confirmed stale menu objects are rejected unless their ID still exists in the current menu and their semantic type matches the live trigger.
- Confirmed capability changes are owned by the live-snapshot layout effect and cannot run the thread/draft reset that moves the cursor to EOF.
- Confirmed local actions do not call `onSend` or dispatch `thread.startTurn`.
- Confirmed Task 7's send-boundary legacy Markdown canonicalization remains untouched.

The structured code review found two Important races (stale item application and provider-switch cursor reset); both were fixed and re-reviewed. No Critical or Important issues remain. The reviewer assessed the change as ready after fresh verification.

## Concerns

- The brief's `--project unit` commands are not runnable in this checkout because no such Vitest project is configured; equivalent file-scoped Vite+ commands were used.
- Vite+ prints the existing Node experimental warning about unavailable `localStorage`; it does not affect results.

## Formal review fixes

### RED evidence

- `vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ChatComposer.rerender.test.tsx apps/web/src/components/ChatView.hooks.test.tsx`
  - 2 test files failed and 1 passed; 4 tests failed and 197 passed.
  - Exact-agent regression: highlight sync persisted `file-reference:file:code-reviewer.ts` instead of `agent-reference:codex:code-reviewer`.
  - Pending Submit regression: standalone pending `:model` did not prevent submission or execute locally.
  - Parent-boundary regressions: attachment-bearing `:plan` and `:default` each dispatched one `thread.startTurn`.
  - The new persistent same-component capability rerender test already passed, replacing the previous seeded-hook approximation with the required real React lifecycle.
- The focused code review then identified a blob-preview ownership regression. With the initial safety-boundary fix applied, `vp test run apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx` failed 3 tests and passed 345:
  - `discardComposerContent` did not exist at the store boundary;
  - attachment-bearing `:plan` and `:default` cleared their image drafts without calling `URL.revokeObjectURL("blob:colon-action")`.

### Fixes

- Threaded `composerMenuResult.preferredItemId` into the highlight-sync resolver and its dependencies, matching the active-item resolver. The regression flushes the sync effect, seeds its result into the rerender, and then presses Enter.
- Removed the pending-input exception from standalone local-action submission. The shared `applyPromptReplacement` path now clears either the normal draft or the pending custom answer through the correct callback before executing the action.
- Parsed standalone local action text at the `ChatView` safety boundary independently of images, terminal contexts, element contexts, preview annotations, and review comments. `:plan` and `:default` now clear the complete composer draft and never reach provider dispatch even with all five context kinds attached.
- Replaced the direct form-handler `:model` test with the real `ComposerPromptEditor` keyboard Enter path.
- Added `ChatComposer.rerender.test.tsx`, which mounts one component instance, opens a supported dollar-skill menu at a mid-draft cursor, rerenders with unsupported capabilities, and verifies menu closure, settled null highlight state, unchanged draft text, and unchanged cursor.
- Added a distinct `discardComposerContent` store operation for local discard semantics. It shares the normal content-clearing implementation but revokes draft-owned blob previews; the normal send clear remains non-revoking because optimistic messages assume URL ownership.

### GREEN evidence

- `vp test run apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx`
  - 3 test files passed; 348 tests passed after the discard/revoke review fix.
- `vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ChatComposer.rerender.test.tsx apps/web/src/components/ChatView.hooks.test.tsx`
  - 3 test files passed; 205 tests passed.
- `vp test run apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ChatComposer.rerender.test.tsx apps/web/src/components/chat/composerCapabilities.test.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/components/chat/composerMenuHighlight.test.ts apps/web/src/composer-logic.test.ts`
  - 9 test files passed; 456 tests passed.
- `vp check`
  - all 1,604 files correctly formatted; no warnings or lint errors across 1,220 files.
- `vp run typecheck`
  - all 11 package checks passed.

### Formal review self-review

- All production calls to `resolveComposerMenuActiveItemId` now receive the preferred item when one exists.
- Both pending submission entry points are covered: keyboard Enter and the form submission generated by the pending Submit button. Provider menu replacements and ordinary pending answers retain their previous paths.
- Direct-parent tests attach every relevant context kind simultaneously, assert zero turn starts, and verify prompt, attachment slices, interaction mode, and cursor reset behavior.
- The provider capability regression uses `createRoot` and rerenders the same mounted `ChatComposer`; it does not seed `useState` ordinals.
- No assertions were weakened. The strengthened FileReader stub ensures the attachment-bearing tests would reach and fail at provider dispatch before the safety-boundary fix.
- Local action discard now has both store-level and direct-parent URL-revocation assertions, while the existing normal-send non-revocation contract remains unchanged.

The focused re-review found no remaining Critical or Important issues and assessed the formal fixes as merge-ready.
