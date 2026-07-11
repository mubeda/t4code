# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T4Code is a web and Tauri desktop GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/desktop`: Tauri 2 desktop host written in Rust. Owns native windows,
  menus, dialogs, updates, WSL/SSH launch, and the `DesktopBridge`
  implementation. It starts the Rust server as an in-process runtime.
- `apps/server`: Rust/Axum/Tokio application server and native `t4code` CLI.
  Owns HTTP/WebSocket RPC, authentication, persistence, orchestration,
  providers, terminals, Git, files, diagnostics, relay integration, and process
  supervision.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t4code/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared connection, RPC, cache, and environment runtime used by browser and Tauri clients.

Node.js and TypeScript are development dependencies for the frontend and
repository tooling only. Do not add a production Node runtime, Electron host,
TypeScript server, or native helper sidecar.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vp run sync:repos`; use `vp run sync:repos -- --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
