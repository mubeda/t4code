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
- `:model`, `:plan`, and `:default` execute locally; submitted local actions clear prompt/cursor/menu state without reaching the send boundary. Pending custom answers remain in the pending-answer flow.
- `ChatView` retains a parent-level safety boundary for only `:plan` and `:default`; `:model` remains composer-owned.
- Capability and provider-instance changes re-detect the live editor snapshot without rewriting draft text.
- `ComposerPromptEditor` receives only mentionable agents, and all cursor conversions use the same mentionable-agent set.
- The placeholder is provider-neutral.
- Removed `LegacyComposerTrigger`, `LegacyComposerCommandItem`, `searchLegacySlashCommandItems`, the slash parser alias, and the bivariant command-menu selection handler.

## Files

- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/chat/ChatComposer.test.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.hooks.test.tsx`
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
- Confirmed pending custom answers use their dedicated callback and submitted action-shaped answers are not intercepted.
- Confirmed provider switches preserve prompt text while stale unsupported triggers and highlight state are cleared.
- Confirmed stale menu objects are rejected unless their ID still exists in the current menu and their semantic type matches the live trigger.
- Confirmed capability changes are owned by the live-snapshot layout effect and cannot run the thread/draft reset that moves the cursor to EOF.
- Confirmed local actions do not call `onSend` or dispatch `thread.startTurn`.
- Confirmed Task 7's send-boundary legacy Markdown canonicalization remains untouched.

The structured code review found two Important races (stale item application and provider-switch cursor reset); both were fixed and re-reviewed. No Critical or Important issues remain. The reviewer assessed the change as ready after fresh verification.

## Concerns

- The brief's `--project unit` commands are not runnable in this checkout because no such Vitest project is configured; equivalent file-scoped Vite+ commands were used.
- Vite+ prints the existing Node experimental warning about unavailable `localStorage`; it does not affect results.
- The SSR composer harness cannot model a persistent React provider-switch rerender with a mid-draft cursor. It verifies live-snapshot re-detection, stale-menu closure, and draft-text preservation; a future DOM-level rerender regression would strengthen this coverage.
