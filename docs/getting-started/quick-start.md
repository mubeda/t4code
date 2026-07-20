# Quick Start

Install Vite+ and workspace dependencies first (see the root README), then use:

```bash
# Browser development with hot reload
vp run dev

# Tauri 2 desktop development with hot reload
vp run dev:desktop

# Desktop development on an isolated port set
T4CODE_DEV_INSTANCE=feature-xyz vp run dev:desktop

# Production web assets and native Rust server
vp run build
cargo run -p t4code-server -- serve

# Host-native desktop installer
vp run dist:desktop:win     # Windows
vp run dist:desktop:dmg     # macOS
vp run dist:desktop:linux   # Linux

# Native CLI from this checkout
cargo run -p t4code-server -- --help
```

Desktop development requires Rust and the platform prerequisites documented by
Tauri 2. On Windows, the package script enters the installed Visual Studio x64
build environment automatically.

Node.js is required when developing the React frontend and running repository
scripts. Packaged desktop applications and the native `t4code` server do not ship
or require Node.js.

## First Run

1. Add a project from the left panel or Command Palette. The Add Project dialog
   supports local folder selection, folder-of-repos import, clone-from-URL, and
   creating a new local project.
2. Pick the project's primary row to work in the live checkout, or use the
   project `+` action to create a worktree thread.
3. Use the chat header `+` menu to open another AI chat panel, a shell terminal
   in the same worktree, a provider CLI terminal, or a custom action.
4. Use Files and Source Control in the right panel for filesystem, staging,
   commits, history, pull/push, and PR actions.

See [Workspace UI](../user/workspace-ui.md) for the full UI map.
