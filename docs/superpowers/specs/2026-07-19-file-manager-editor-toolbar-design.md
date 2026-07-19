# File Manager Editor Toolbar Design

**Date:** 2026-07-19
**Status:** Approved design, pending implementation plan

## Summary

Add a dedicated editing toolbar below the existing file breadcrumb row in the
File Manager. The toolbar is visible whenever a file is selected and contains
icon-only Save, Undo, and Redo buttons.

Autosave remains enabled with the existing 500 ms debounce. Save provides an
immediate flush for pending edits. Undo and Redo use Pierre's native editor
history, and each open file retains its history while the user switches among
file tabs or temporarily opens another right-panel tool.

## Goals

- Show a stable top editing toolbar for every selected file.
- Save pending changes immediately when Save is clicked.
- Enable Save only while the active file has unsaved work that can be flushed.
- Expose native Undo and Redo actions with accurate enabled states.
- Preserve independent undo/redo history for each open file tab.
- Keep toolbar icons and states consistent with the active application theme.
- Preserve current autosave, keyboard shortcuts, pending-tab markers, and
  rename/delete safeguards.
- Keep resource usage bounded by mounting only the active file editor.

## Non-goals

- Replacing or disabling autosave.
- Changing the 500 ms autosave debounce.
- Persisting undo/redo history across application reloads, closed file tabs, or
  closed project/thread sessions.
- Adding undo/redo history to rendered Markdown task-list interactions.
- Adding editing support for truncated, binary, loading, or failed file views.
- Redesigning the existing breadcrumb row or its Open In, Markdown view,
  preview-browser, and file-explorer actions.
- Introducing application-wide Save, Undo, or Redo commands outside the File
  Manager.

## Confirmed Product Decisions

1. Autosave remains enabled.
2. Undo/redo history is independent per open file and survives file-tab
   switching.
3. The editing actions use a dedicated toolbar row beneath the breadcrumbs.
4. The row remains visible in non-editable states, with unavailable controls
   disabled.
5. Cached per-file editing sessions use Pierre's native history rather than a
   second application-owned history implementation.

## Visual Design

### Placement

The selected-file header becomes two rows:

1. The existing breadcrumb/action subheader remains unchanged.
2. A new compact editing toolbar sits directly below it and above any
   truncation banner or file content.

The toolbar is not shown when no file is selected and the full-width file
explorer is displayed.

### Action Order

The left side of the toolbar contains:

1. Save
2. Undo
3. Redo

The right side contains the active save-status message. The row keeps a stable
height across all file and loading states.

### Icons and Theme

- Use Lucide `Save`, `Undo2`, and `Redo2` icons.
- Icons inherit semantic colors through `currentColor`.
- Enabled buttons use the normal foreground and ghost-button hover treatment.
- Disabled buttons use the muted disabled foreground.
- A failed Save uses the existing destructive/error color.
- A write in flight replaces the Save glyph with a small animated loader.
- Do not hard-code light or dark icon colors.

Each icon-only button has:

- an accessible name;
- a tooltip containing the action and conventional platform shortcut;
- a visible keyboard focus ring;
- native disabled semantics when unavailable.

## Architecture

### File Editing Session

Introduce a focused `FileEditingSession` abstraction for one open file. It owns:

- a lazily created Pierre `Editor` instance and its native undo/redo timeline;
- the `FileSaveCoordinator` used for debounced and explicit persistence;
- the latest capability snapshot used by React:
  - `savePhase`;
  - `canSave`;
  - `canUndo`;
  - `canRedo`;
- subscription and notification behavior for toolbar updates.

The file contents loaded when the session is first created establish its clean
baseline. Session initialization does not schedule a save or create an undo
entry. The Pierre editor is created when source editing is first activated;
rendered Markdown can therefore use the session's save coordinator without
creating source-editing history.

The session is the single action target for the toolbar. Its public commands are
conceptually:

- `flush()`;
- `undo()`;
- `redo()`;
- `subscribe(listener)`;
- `getSnapshot()`;
- `dispose()`.

Undo and Redo delegate directly to Pierre. Their resulting editor changes pass
through the same `onChange` callback and autosave coordinator as typed edits.
This keeps toolbar actions and native keyboard shortcuts behaviorally
equivalent.

### Session Registry

Introduce a project-scoped `FileEditingSessionRegistry`, owned above the active
file view. The right-panel host keeps the registry alive while the user switches
among open file tabs or temporarily activates another right-panel tool.

The registry:

- creates a session the first time an open file needs one;
- reuses the same session when the file becomes active again;
- exposes only the active session to `FilePreviewPanel`;
- reconciles sessions with the open file surfaces;
- remaps a session after a successful rename;
- flushes and disposes a session when its file tab closes;
- removes sessions after successful deletion;
- flushes and disposes all sessions when their project/thread lifetime ends.

Only the active Pierre file view is mounted. Inactive sessions retain their
editor history and save state without retaining virtualized DOM.

### Save Coordinator State

Extend `FileSaveCoordinator` with an observable snapshot rather than
duplicating revision state in React. Its persistence phases are:

- `clean`: latest revision is confirmed;
- `pending`: an unsaved revision is waiting for autosave or explicit Save;
- `saving`: a write is in flight;
- `failed`: the latest write failed and remains retryable.

The coordinator keeps its existing revision guarantees:

- only the newest known contents are persisted;
- a change made during an in-flight write schedules a follow-up write;
- failure never advances the persisted revision;
- successful confirmation updates the project-file query cache;
- explicit Save cancels the outstanding debounce before writing.

React consumes session state with an external-store subscription so the toolbar,
tab pending marker, and save-status copy observe one authoritative state.

### Component Boundaries

- `FileEditorToolbar` is presentational. It renders the dedicated row from a
  session snapshot and invokes supplied Save, Undo, and Redo callbacks.
- `FileEditingSession` and `FileEditingSessionRegistry` contain lifecycle and
  action logic without rendering concerns.
- `FileSaveCoordinator` remains responsible for persistence scheduling and
  revision correctness.
- `FilePreviewPanel` selects the appropriate toolbar state and mounts the active
  editable, rendered Markdown, truncated, loading, or error surface.
- The right-panel/`ChatView` integration owns the project-scoped registry and
  reconciles it against open file surfaces.

## Interaction and State Model

### Clean

- Save is disabled.
- Undo and Redo reflect Pierre's native history.
- Saving does not clear undo/redo history.
- After a successful write, show `Saved` for 1.5 seconds, then clear the status.

### Pending Autosave

- Save enables immediately after an edit.
- Show `Unsaved changes`.
- Clicking Save or pressing Ctrl/Cmd+S cancels the remaining debounce and
  flushes immediately.
- Undo and Redo remain available according to native history.

### Saving

- Save is disabled to prevent duplicate writes.
- Replace the Save glyph with an animated loader.
- Show `Saving…`.
- Undo/redo remain usable. Any edit they produce while a write is in flight is
  queued as a later revision.

### Save Failure

- Keep the revision pending and keep the file tab's pending marker.
- Re-enable Save as a retry action.
- Show `Save failed — retry` using the error color.
- Preserve the existing detailed error toast.
- A successful retry transitions through `saving` to `clean`.

### Undo and Redo

- Undo enables only when `Editor.canUndo` is true.
- Redo enables only when `Editor.canRedo` is true.
- Clicking an unavailable action is prevented by native disabled semantics.
- Commands also guard against a session disappearing between render and
  invocation.
- A new edit after Undo clears the native redo branch as Pierre normally does.
- Autosave does not create or clear history entries.

### Rendered Markdown

- The toolbar remains visible.
- A task-list checkbox edit can put the shared save coordinator into `pending`,
  enabling Save until autosave succeeds.
- Undo and Redo remain disabled while the rendered view is active.
- Switching to Markdown source uses the file's Pierre editing session and its
  native history from that source-editing session.

### Truncated, Loading, Error, and Other Read-only Views

- The toolbar remains visible.
- Save, Undo, and Redo are disabled when no editable/saveable session exists.
- Show `Editing unavailable` for a definitively read-only view.
- Loading and error copy remain owned by the existing file-content area.

## Data Flow

1. The active editable surface reports new contents to its
   `FileEditingSession`.
2. The session refreshes Pierre history capabilities and calls
   `FileSaveCoordinator.change(contents)`.
3. The coordinator enters `pending`, notifies subscribers, and schedules the
   existing 500 ms autosave.
4. The toolbar enables Save and the right-panel tab retains its pending marker.
5. Autosave expiry, a Save click, or Ctrl/Cmd+S starts one write and enters
   `saving`.
6. On success, the coordinator confirms that written revision and updates the
   file query cache. If it is still the latest revision, clear the pending
   marker and briefly show `Saved`; otherwise remain pending and schedule the
   newer revision.
7. On failure, the coordinator keeps the revision pending, enters `failed`, and
   allows an explicit retry.
8. Undo or Redo runs through Pierre, produces normal changed contents, and
   returns to step 2.

## Lifecycle and Filesystem Safeguards

### Tab Switching

Switching files detaches the active view but does not dispose its session. When
the tab becomes active again, the same Pierre editor and history are reused.

### File Close

Closing a file tab requests an immediate flush of pending work, then disposes
the session and clears its history. Failure is reported through the normal save
error path. Reopening the closed file starts a new history timeline.

### Rename

Before rename, flush pending work for the exact file or a descendant of the
renamed directory. If the pre-mutation flush fails, do not continue the
filesystem mutation.

After a successful rename:

- remap the right-panel file surface;
- remap the registry key;
- keep the same editor history and capability state;
- ensure no unmount-time write targets the old path.

### Delete

Before delete, settle pending work through the existing path-mutation guard. If
that preparation fails, do not continue the filesystem mutation.

After successful deletion:

- close matching file surfaces;
- remove and dispose matching sessions;
- prevent any delayed or disposal-time write from recreating the deleted path.

### Project or Thread Lifetime End

Flush pending sessions, cancel timers, and dispose editors. Session histories
are intentionally not persisted beyond this lifetime.

## Error Handling

- Save failures never report the file as clean.
- Multiple clicks cannot create concurrent writes.
- A late completion from a disposed or inactive React surface cannot overwrite
  the current toolbar state.
- Edits arriving during a write use revision comparison and cannot be mistaken
  for the confirmed contents.
- Rename/delete mutation failures leave the session at its current path and
  retain its history.
- Toolbar commands are safe no-ops when no compatible active session exists.
- User-facing details continue to use the existing stacked toast system.

## Testing Strategy

### Unit Tests

Extend `fileSaveCoordinator.test.ts` to cover:

- every phase transition;
- capability notifications;
- explicit Save during the debounce;
- edits during an in-flight write;
- failure and retry;
- disposal and stale completion behavior.

Add registry/session tests for:

- create and reuse by path;
- independent histories for multiple files;
- active-file switching;
- rename remapping;
- file and directory deletion;
- close and project disposal;
- failed pre-mutation flush behavior.

### Component Tests

Extend `FilePreviewPanel.test.tsx` and add focused toolbar tests for:

- dedicated placement below breadcrumbs;
- Save, Undo, and Redo order and icons;
- enabled and disabled states;
- Save click and Ctrl/Cmd+S parity;
- Undo/Redo delegation and snapshot refresh;
- saving loader and all status messages;
- rendered Markdown behavior;
- truncated, loading, error, and no-file states;
- tooltips, accessible names, focus styles, and disabled semantics;
- theme-token classes rather than fixed colors.

### Integration Tests

Cover:

- editing file A, switching to file B, returning to A, and undoing A's edit;
- independent undo/redo histories across two files;
- undo after a successful autosave, followed by autosaving the undone contents;
- rename preserving history under the new path;
- delete/close disposal without recreating the old file;
- retry after an autosave or explicit-save failure.

### Required Verification

Run relevant tests with `vp test`, then run:

```sh
vp check
vp run typecheck
```

Both repository-required commands must pass before implementation is considered
complete.

## Acceptance Criteria

1. Selecting any file displays a dedicated toolbar row beneath its breadcrumb
   row.
2. The row contains theme-aware Save, Undo, and Redo icons with tooltips and
   accessible names.
3. Save is enabled only for retryable unsaved work and disabled when clean or
   while a write is in flight.
4. Clicking Save immediately flushes pending contents without disabling
   autosave.
5. Undo and Redo exactly mirror Pierre's native history and keyboard behavior.
6. Each open file preserves independent history across file-tab switches.
7. Only the active file editor is mounted.
8. Read-only and unavailable views retain the toolbar with unavailable actions
   disabled.
9. Failed saves remain pending, are visibly retryable, and do not lose edits.
10. Rename, delete, close, and project-lifetime transitions do not resurrect old
    paths or leak cached sessions.
11. Relevant tests, `vp check`, and `vp run typecheck` pass.
