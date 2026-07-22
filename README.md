# T4Code

T4Code is a minimal web GUI for coding agents. It is a different approach of T3 Code with some
nice features of Orca and Conductor.build (currently Codex, Claude, Cursor, and OpenCode, more
coming soon).

This project is a public GitHub fork of [T4Code](https://github.com/mubeda/t4code).

## Technology

- Desktop: Tauri 2 with a Rust host and the operating system WebView.
- Frontend: React 19, Vite, TypeScript, TanStack Router, Zustand, and Effect.
- Application server: Rust with Axum and Tokio, embedded in the desktop process
  and available as the native `t4code` headless server.
- Transport: typed WebSocket/RPC contracts shared by browser and desktop clients.

The React frontend is shared unchanged between browser and desktop modes. Tauri-specific behavior is
kept behind `window.desktopBridge`. Production builds contain no Electron,
Node.js runtime, or TypeScript server.

## Installation

> [!WARNING]
> Install and authenticate at least one configured provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Desktop app

Download the latest desktop build for your platform from
[GitHub Releases](https://github.com/mubeda/t4code/releases):

- macOS: `.dmg` (Apple Silicon `arm64` or Intel `x64`)
- Windows: `.exe` installer (x64)
- Linux: `.AppImage` (x64)

Desktop releases are built by the Tauri 2 pipeline in `apps/desktop`.

> [!NOTE]
> macOS releases are ad-hoc signed without an Apple Developer identity or
> notarization. On first launch, macOS will block the app; open System Settings
> → Privacy & Security and choose **Open Anyway** for T4Code. For local testing,
> the quarantine flag can instead be removed with
> `xattr -dr com.apple.quarantine "/Applications/T4Code (Alpha).app"`.
> Windows releases remain unsigned; choose "More info" → "Run anyway" if
> SmartScreen warns.

### Run from source

See [Getting started](./docs/getting-started/quick-start.md), or jump to the
[contributor setup](#if-you-really-want-to-contribute-still-read-this-first)
below to install the toolchain and run the app locally.

Source development uses Node.js only for frontend and repository tooling. It is
not shipped as part of the application runtime.

## Current UI

T4Code is organized around three work areas:

- The left panel groups projects, the primary checkout for each project, and
  eager worktree threads. Use it to add local projects, clone repositories,
  create worktrees, pin/unread rows, and switch between agent sessions.
- The center panel hosts the active chat. Its `+` menu can open additional AI
  chat panels, a terminal panel in the same worktree, or the custom action
  dialog. Extra chat panels are isolated sessions that share the host worktree.
- The right panel hosts project tools, including the Source Control panel and
  Files manager. Source Control supports staging, commit history, AI commit
  messages, per-file actions, and pull/push/PR flows. Files supports context
  menus, create/rename/delete/duplicate, external open/preview, and explicit
  Ctrl/Cmd+S saves.

See [Workspace UI](./docs/user/workspace-ui.md) for the detailed guide.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, so start with the markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Workspace UI](./docs/user/workspace-ui.md)
- [Source Control](./docs/integrations/source-control-providers.md#source-control-panel)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

T4Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.
