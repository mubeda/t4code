# T4Code

T4Code is a web and desktop GUI for coding agents (currently Codex, Claude, Cursor,
Grok, and OpenCode, more coming soon).

This project is a public GitHub fork of [T3 Code](https://github.com/pingdotgg/t3code).

## Installation

> [!WARNING]
> Install and authenticate at least one configured provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

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

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
