# Workspace UI

T4Code is split into left, center, and right work areas. The left panel chooses
the project/worktree thread, the center panel runs chats and terminals, and the
right panel hosts project tools.

## Left Panel

Projects are shown as groups of workspace rows:

- The primary row represents the project's live checkout. Its branch label is
  refreshed from the checkout, not from a stale thread title.
- The primary row is backed by an undeletable default thread. Attempts to delete
  it should guide the user to remove the project instead.
- Worktree rows represent eager worktree threads. Creating a worktree creates
  both the Git worktree and its thread before the first message.
- Rows can show pinned/unread state and nested agent activity such as provider,
  running state, and elapsed time.

Use the project `+` action to create a worktree. The Create Worktree dialog has a
project selector, Smart/GitHub/Branch/Name modes, an agent picker, advanced
options, a Create more toggle, and Ctrl+Enter submit.

Use Add Project to select a connected host, open one existing project folder,
clone a Git URL, or create a new Git repository. Local and mapped WSL hosts use
the native folder picker; remote and browser-only hosts accept an explicit host
path. Selecting a folder adds that folder as one project and does not scan for
nested repositories.

Workspace row context menus include update/open/copy/pin/unread actions, plus
delete worktree for worktree rows and remove project for primary rows.

## Center Panel

The active thread's main chat is always the first center tab and cannot be
closed. The chat header `+` menu contains:

- enabled AI providers, which create new chat panels
- Open Terminal, which creates a shell terminal panel in the current worktree
- enabled provider terminal actions, which launch the selected provider CLI in
  the current worktree using that provider instance's configured binary path
- Add custom action, which opens the custom action dialog

Each extra chat panel is an isolated AI session. For contributors, this is
implemented as a hidden sibling thread with `kind: "panel"` that shares the host
thread's project, branch, and worktree. Panel threads are hidden from the left
panel and are deleted when their tab closes.

Tabs persist across reloads. The host chat remains mounted while another center
tab is active, so its transcript, scroll state, and composer state are preserved.

## Right Panel

The right panel hosts persistent tool surfaces for the active thread.

### Source Control

The Source Control panel is Orca-parity for the shipped local Git workflow:

- The primary action is adaptive. With staged files it defaults to Commit. With
  only unstaged or untracked files it becomes Stage All Changes. Clean-tree
  states then move through pull, push, publish, and PR actions when available.
- The dropdown is always rendered and disables unavailable actions instead of
  hiding them.
- Files are grouped into staged, unstaged, and untracked sections with status
  badges.
- Per-file hover actions support stage, unstage, discard, restore deleted files,
  and delete untracked files. Destructive actions require confirmation.
- Row context menus are navigation-only: view, copy path, copy relative path,
  and open in external editor.
- Commit history and AI commit-message generation are available in the panel.

Stash and amend are intentionally not present; this matches the Orca reference
behavior for this pass.

### Files

The Files surface is a full file manager for the active workspace:

- Right-click files, folders, or the tree background to create files/folders,
  rename, delete, duplicate, copy paths, add a folder as a project, open in an
  external editor, or open previewable files in the preview browser.
- Open file tabs follow renames and close when their file is deleted.
- Autosave remains enabled, and Ctrl/Cmd+S explicitly flushes pending changes.

## Known Limitations

These are documented follow-ups, not shipped behavior:

- Staged-row diff viewing does not yet use a true `git diff --cached` source.
- Center panel creation from local draft hosts is not fully defined.
- Terminal center tabs still use raw IDs instead of friendly labels.
