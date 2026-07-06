# Repository layout

- `/apps/server`: Node.js WebSocket server. Coordinates provider runtimes, Git,
  filesystem operations, terminals, project/thread orchestration, and the built
  web app.
- `/apps/web`: React + Vite UI. Owns the left project/worktree panel, center
  chat and terminal panels, right tool surfaces, session UX, conversation/event
  rendering, and client-side state.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process and loads the shared web app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) — no barrel index.
- `/packages/client-runtime`: Shared client runtime state and RPC command atoms
  consumed by web and mobile clients.

## UI workspace model

- A project is a repository/workspace root in an environment.
- Every project has a primary row backed by an undeletable default thread for
  the main checkout.
- Worktree rows are workspace threads with `worktreePath` set.
- Center chat panels are hidden sibling threads with `kind: "panel"` that share
  the host worktree.
- Right-panel surfaces are per-thread tool tabs, such as Files, Source Control,
  Diff, Preview, and Terminal.

See [Workspace UI](../user/workspace-ui.md) for the user-facing model.
