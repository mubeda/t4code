# Selected Project Worktree Action

## Goal

The Projects toolbar's **New Worktree** action must only be available when a project is selected. A selected project is the project that owns the thread or workspace currently routed in the application and highlighted in the sidebar.

## Behavior

- Disable **New Worktree** when the current route does not resolve to a project.
- This includes the empty-project state, settings routes, and routes whose thread is unavailable.
- Enable the action when the current route resolves to a project.
- Opening the action must preselect that project in `CreateWorktreeDialog`.
- The disabled appearance and pointer behavior must match the adjacent **New main-branch chat** action.

## State Flow

`Sidebar` already resolves the routed thread and its active logical project for sidebar highlighting. It will also retain the routed thread's physical `ProjectId` as the selected project ID.

`Sidebar` will pass that ID to `SidebarProjectsContent`. The toolbar button will derive its disabled state from whether the ID is present and pass the same ID to `openCreateWorktreeDialog` when clicked. No additional selection store or toolbar-local state will be introduced.

Using the routed thread's physical project ID keeps grouped or legacy multi-repository data compatible with the existing dialog contract while ensuring the visible active project remains the source of truth.

## Testing

Component tests will verify:

1. **New Worktree** is disabled when no route project is selected.
2. It is enabled when the routed thread resolves to a project.
3. Clicking it opens `CreateWorktreeDialog` with that project's ID as the default.

The implementation will follow a red-green-refactor cycle and must pass the targeted sidebar tests, `vp check`, and `vp run typecheck`.
