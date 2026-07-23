# Task 7 Report: Canonicalize Legacy Drafts at the Send Boundary

## Status

Implemented the outgoing-draft compatibility migration on the Task 6 send path.

- `ChatView` now canonicalizes `promptRef.current` with
  `canonicalizeLegacyComposerFileReferences` before deriving send state.
- The canonical value drives terminal-context expansion, optimistic/outgoing
  message text, provider turn start, titles, and failed-send restoration.
- Historical timeline messages and Markdown rendering are untouched:
  `MessagesTimeline.tsx` and `ChatMarkdown.tsx` do not import or call the
  canonicalizer.

## TDD Evidence

### RED

The prescribed command from the task brief could not run because this checkout
has no Vitest project named `unit`:

```text
vp test run --project unit ...
Error: No projects matched the filter "unit".
```

The equivalent focused invocation was then run:

```text
vp test run apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Exit: `1`.

The two intended regressions failed:

- provider turn payload retained `Inspect [main.ts](src/main.ts)` instead of
  `Inspect @src/main.ts`; and
- failed-send restoration retained the legacy Markdown link rather than the
  canonical `@` reference.

The external-link/historical-message test passed in RED, confirming it was
not inadvertently testing the missing behavior.

### GREEN

After changing the send boundary to canonicalize the current draft, the focused
send suite passed:

```text
vp test run apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
Test Files 2 passed
Tests 142 passed
```

The shared reference and inline-token suites also passed:

```text
vp test run packages/shared/src/composerReferences.test.ts packages/shared/src/composerInlineTokens.test.ts
Test Files 2 passed
Tests 20 passed
```

## Coverage

- Successful sends canonicalize legacy file links while preserving native `@`
  references.
- Failed sends restore canonical draft text to both the composer ref and draft
  store.
- External Markdown links remain verbatim.
- A legacy historical message remains exactly as stored.

## Required Gates

```text
vp check
pass: All 1604 files are correctly formatted
pass: Found no warnings or lint errors in 1220 files

vp run typecheck
exit 0; Result: 0 errors, 0 warnings, 0 hints
```

`vp run typecheck` emitted pre-existing Effect `Schema.Number` suggestions,
but no type errors and exited successfully.

## Files

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.test.tsx`
- `apps/web/src/components/ChatView.hooks.test.tsx`

## Self-review

- Confirmed the canonicalizer is applied once to the current composer draft,
  before send-state derivation.
- Confirmed no migration call was added to `MessagesTimeline.tsx` or
  `ChatMarkdown.tsx`.
- Confirmed all Task 6 send ordering and draft-discard ownership paths remain
  intact.
- `git diff --check` passed.

## Concerns

The task brief's `--project unit` test command is stale for this checkout; the
equivalent non-project focused invocation was used. No implementation concerns.
