# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx t3
```

## First Run

1. Add a project from the left panel or Command Palette. The Add Project dialog
   supports local folder selection, folder-of-repos import, clone-from-URL, and
   creating a new local project.
2. Pick the project's primary row to work in the live checkout, or use the
   project `+` action to create a worktree thread. Worktree threads are created
   eagerly before the first message.
3. Use the chat header `+` menu to open another AI chat panel, open a terminal
   panel in the same worktree, or add a custom action.
4. Use the right panel for Files and Source Control. Files handles normal file
   operations and explicit Ctrl/Cmd+S saves. Source Control handles staging,
   commits, commit history, AI commit messages, pull/push, and PR actions.

See [Workspace UI](../user/workspace-ui.md) for the full UI map.
