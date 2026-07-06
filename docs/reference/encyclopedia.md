# Encyclopedia

This is a living glossary for T4Code. It explains common terms used in the
codebase and UI.

## Project And Workspace

### Project

The top-level workspace record in an environment. A project points at a
workspace root and owns the visible primary/worktree rows in the left panel.

### Workspace Root

The filesystem path for a project checkout. Git, file, terminal, and provider
operations run relative to this root unless a thread has a worktree path.

### Primary Workspace Row

The left-panel row for a project's live checkout. It is backed by the project's
default thread, shows the live checkout branch, and cannot be deleted as a
normal thread.

### Default Thread

The undeletable thread that backs a project primary row. Removing it is modeled
as removing the project, not deleting a thread.

### Worktree

A Git worktree used as an isolated workspace. Worktree threads have
`worktreePath` set and run chats, terminals, filesystem, and source-control
operations in that path.

### Workspace Thread

A normal visible thread for a project primary checkout or worktree. It owns
conversation history, provider session state, activities, checkpoints, and
workspace metadata.

### Panel Thread

A hidden sibling thread with `kind: "panel"`. Panel threads share the host
thread's project, branch, and worktree but own an isolated provider session and
transcript. They appear as center-panel tabs, not left-panel rows.

## UI Surfaces

### Left Panel

The project/worktree navigator. It shows project groups, primary rows, worktree
rows, pin/unread state, context menus, and running agent sub-rows.

### Center Panel

The main chat area. The host chat is the first unclosable tab. Extra AI chat
panels and terminal panels are opened from the chat header `+` menu.

### Right Panel

The tool surface area for the active thread. It hosts Files, Source Control,
Diff, Preview, Terminal, and related project tools.

### Source Control

The right-panel Git UI for the active project/worktree. It groups files by
staged, unstaged, and untracked state; exposes stage/unstage/discard/delete
actions; provides commit history and AI commit messages; and drives commit,
pull, push, publish, and PR actions.

### Files Manager

The right-panel filesystem UI for the active project/worktree. It supports
context menus for files, folders, and background space; create, rename, delete,
duplicate, copy path, add folder as project, external editor, preview, and
explicit Ctrl/Cmd+S saves.

### Custom Action

A project script/action exposed through the chat header `+` menu and script
commands. Script keybindings use the `script.{id}.run` command shape.

## Orchestration

### Command

A typed request to change domain state, such as creating a project, creating a
thread, starting a turn, or deleting a panel thread.

### Domain Event

A persisted fact that something happened. The server projects domain events
into read models and pushes user-visible updates to clients.

### Projection

A read-optimized view derived from events. Browser clients consume projections
through the WebSocket transport and typed contracts.

### Receipt

A lightweight runtime signal emitted when async work reaches a stable milestone,
such as checkpoint capture, diff finalization, or turn quiescence.

### Quiesced

A turn has gone quiet and stable: provider work and follow-up processing have
settled far enough for tests and orchestration to continue deterministically.

## Provider Runtime

### Provider

The backend agent driver/runtime, such as Codex, Claude, Cursor, Grok, or
OpenCode.

### Provider Instance

A configured provider entry with its own display name, settings, credentials,
home path, environment variables, and model availability.

### Session

The live provider-backed runtime attached to a thread. Workspace threads and
panel threads each own their own session.

### Runtime Mode

The safety/access mode for a session, such as full access or supervised mode.

### Interaction Mode

The agent interaction style for a session, such as default or plan mode.

## Checkpointing

### Checkpoint

A saved snapshot of workspace state at a particular turn.

### Checkpoint Baseline

The starting checkpoint used to compute later diffs for a thread timeline.

### Turn Diff

The changed-file summary and patch for one turn.

## Related Docs

- [Workspace UI](../user/workspace-ui.md)
- [Repository layout](./workspace-layout.md)
- [Architecture overview](../architecture/overview.md)
- [Runtime modes](../architecture/runtime-modes.md)
