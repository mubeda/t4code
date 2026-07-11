# Repository Layout

- `/apps/desktop`: Tauri 2 desktop host. Rust owns native lifecycle, windows,
  settings, menus, dialogs, updates, WSL/SSH preparation, and the in-process
  server lifecycle.
- `/apps/server`: Rust/Axum/Tokio server and native `t4code` CLI. The crate
  owns provider runtimes, Git, filesystem operations, terminals, persistence,
  orchestration, HTTP/WebSocket RPC, authentication, diagnostics, and relay
  integration.
- `/apps/web`: Shared React 19 + Vite UI for browser and Tauri WebView modes.
- `/packages/contracts`: Schema-only Effect/Schema contracts for desktop bridge,
  WebSocket/RPC, providers, models, sessions, and persisted protocol values.
- `/packages/client-runtime`: Shared connection supervision, RPC sessions,
  environment caches, and client state used by browser and desktop clients.
- `/packages/shared`: Cross-runtime TypeScript utilities exposed through explicit
  package subpaths.
- `/scripts`: Frontend development, build, release, measurement, and repository
  tooling. Scripts may use Node.js at development time; production does not.

## Runtime Boundaries

The frontend talks to the server through typed WebSocket/RPC contracts. In a
packaged desktop build, the Tauri Rust host starts the server in-process,
installs `window.desktopBridge`, and exposes only native host
capabilities through Tauri commands/events. Browser mode connects directly to a
native `t4code` server and has no native bridge.

## UI Workspace Model

- A project is a repository/workspace root in an environment.
- Every project has a primary row backed by an undeletable default thread for
  the main checkout.
- Worktree rows are workspace threads with `worktreePath` set.
- Center chat panels are sibling threads with `kind: "panel"` that share the
  host worktree.
- Right-panel surfaces are per-thread tools such as Files, Source Control, Diff,
  Preview, and Terminal. Preview is hidden when the active host does not report
  native preview support.

See [Workspace UI](../user/workspace-ui.md) for the user-facing model.
