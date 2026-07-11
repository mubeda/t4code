# Full Tauri 2 And Rust Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron shell and the long-lived TypeScript/Node backend
with Tauri 2 and Rust, while retaining the React/Vite frontend and preserving
all browser, desktop, provider, orchestration, persistence, terminal, Git, SSH,
remote-access, and release behavior.

**Architecture:** A root Cargo workspace owns a reusable `t4code-server` Rust
library, a headless Rust CLI, and the Tauri desktop host. Desktop mode runs the
server library inside the Tauri process; browser/headless mode runs the same
library through the CLI. The React frontend keeps the existing Effect RPC JSON
wire protocol until every client can move together, so backend replacement does
not require a UI rewrite.

**Tech Stack:** Rust 2024, Tauri 2, Tokio, Axum, Serde, SQLite, React 19, Vite,
Effect RPC-compatible JSON over WebSocket, operating-system WebView.

## Global Constraints

- The final packaged desktop application MUST NOT bundle, launch, or require
  Node.js, Bun, Electron, JavaScript server code, or `server-node_modules`.
- Node.js and pnpm remain development-time tools for building the retained
  React/Vite frontend; this does not permit a Node production backend.
- The final default process tree MUST contain the Tauri/Rust host, the operating
  system WebView processes, and provider CLIs only when a user starts them.
- React 19, Vite, TanStack Router, Zustand, and the shared client runtime remain
  the frontend. Do not rewrite the UI in Rust.
- Preserve the current 80-method `WsRpcGroup` method names, JSON envelopes,
  stream chunk/ack/interrupt semantics, error shapes, authentication flows, and
  persisted SQLite behavior until an explicitly versioned protocol migration.
- Preserve browser/headless mode. Desktop-only Tauri commands cannot replace
  server RPCs that the browser client consumes.
- Preserve Codex, Claude, Cursor, Grok, and OpenCode provider behavior,
  cancellation, reconnect, restart, partial-stream, and failure semantics.
- Preserve Windows, macOS, and Linux support, including WSL and SSH remote
  environments where supported today.
- New behavior is implemented test-first. Every production change must have a
  failing regression or contract test before implementation.
- `vp check`, `vp run typecheck`, `vp test`, `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, and
  `cargo test --workspace` must pass before completion.
- Production builds must contain zero warnings. Chrome must complete the core
  browser workflow with zero console errors, warnings, or failed requests.
- Completion requires fresh cold/warm and idle/active measurements on every
  release operating system; a single Windows idle sample is not sufficient.

## Current State And Remaining Validation

The production migration is implemented. `apps/server` is the canonical
Rust/Axum/Tokio server and native `t4code` CLI, while `apps/desktop` is the Tauri 2
host that starts the same server library in-process. The TypeScript server,
Electron host, Node sidecar staging, native Node modules, and obsolete helper
packages have been removed. React/Vite remains the shared browser and desktop
frontend and initializes its Tauri bridge before resolving the primary server
target.

The 80 RPC methods and 14 streams are registered in Rust, and completeness,
wire-parity, migration-parity, auth, persistence, orchestration, provider,
terminal, Git, workspace, preview, relay, and lifecycle tests run in the Cargo
workspace. Windows release bundles contain one Rust host plus WebView2 and no
Node backend. Current cold/warm reports are linked from
`docs/architecture/desktop-performance-baseline.md`.

As of 2026-07-11, Windows release builds, first-launch Tauri UI automation, and
Chrome browser mode are verified with zero build warnings, console warnings,
console errors, or failed observed requests. Cross-platform release performance
captures and active terminal/large-thread responsiveness measurements remain
release-validation work; they do not require another architecture migration.

---

### Task 1: Establish The Canonical Rust Workspace

**Files:**

- Create: `Cargo.toml`
- Create: `scripts/rust-workspace.test.ts`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `packages/native-command-runner/Cargo.toml`
- Modify: `packages/native-process-diagnostics/Cargo.toml`
- Modify: `apps/desktop/package.json`
- Modify: `packages/native-command-runner/package.json`
- Modify: `packages/native-process-diagnostics/package.json`
- Delete: `apps/desktop/src-tauri/Cargo.lock`
- Delete: `packages/native-command-runner/Cargo.lock`
- Delete: `packages/native-process-diagnostics/Cargo.lock`
- Create: `Cargo.lock`

**Interfaces:**

- Produces one Cargo workspace with shared package metadata, dependency
  versions, release profile, lints, lock file, and target directory.
- Existing package scripts continue to expose `build`, `test`, and `typecheck`.

- [ ] Write `scripts/rust-workspace.test.ts` asserting all Rust packages are
      workspace members, child lock files are absent, release LTO/strip settings
      are enabled, and every package script selects a Cargo package with `-p`.
- [ ] Run `vp test run scripts/rust-workspace.test.ts` and verify it fails
      because the root workspace does not exist.
- [ ] Add the root workspace and inherit `edition = "2024"`,
      `rust-version = "1.88"`, shared dependencies, and warning-deny lints.
- [ ] Configure release builds with `lto = "thin"`, `codegen-units = 1`,
      `strip = "symbols"`, and `panic = "abort"`.
- [ ] Generate the root lock file and remove child lock files.
- [ ] Run the focused test, `cargo check --workspace`, and
      `cargo test --workspace`.

### Task 2: Add The Reusable Rust Server Core And Headless Binary

**Files:**

- Create: `apps/server-rust/Cargo.toml`
- Create: `apps/server-rust/package.json`
- Create: `apps/server-rust/src/lib.rs`
- Create: `apps/server-rust/src/main.rs`
- Create: `apps/server-rust/src/config.rs`
- Create: `apps/server-rust/src/http.rs`
- Create: `apps/server-rust/src/lifecycle.rs`
- Modify: `Cargo.toml`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**

- Produces `t4code_server::ServerRuntime::start(ServerConfig)` and
  `ServerHandle::{local_addr, shutdown, join}`.
- Produces a `t4code` Rust binary using the same `serve`, `--host`, `--port`,
  `--base-dir`, and desktop bootstrap inputs as the current CLI.

- [ ] Write failing router tests for `/.well-known/t4code/environment`, desktop
      shutdown token validation, static-file traversal rejection, graceful
      shutdown, and binding port `0`.
- [ ] Implement a Tokio/Axum runtime with explicit cancellation and owned task
      joins; do not detach lifecycle-critical tasks.
- [ ] Implement streamed immutable static assets with CSP, `nosniff`, and cache
      headers instead of reading complete files into memory per request.
- [ ] Define typed router composition points and a golden route-inventory test
      for the complete HTTP surface: the 20 typed Environment API routes, `/ws`,
      OTLP trace ingestion, signed assets, desktop shutdown, current MCP POST and
      session-DELETE methods, and SPA/static fallback behavior. Task 2 may use explicit `501`
      handlers for domains owned by later tasks; every placeholder must be
      replaced before cutover. Keep traversal rejection, extensionless
      `index.html` resolution, and loopback dev redirects including the original
      path and query.
- [ ] Add CLI parsing with structured errors and no process-global mutable
      configuration.
- [ ] Run `cargo test -p t4code-server` and a process-level CLI smoke test.

### Task 3: Preserve The Effect RPC WebSocket Wire Protocol

**Files:**

- Create: `apps/server-rust/src/rpc/mod.rs`
- Create: `apps/server-rust/src/rpc/message.rs`
- Create: `apps/server-rust/src/rpc/session.rs`
- Create: `apps/server-rust/tests/rpc_wire.rs`
- Create: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`
- Create: `packages/contracts/fixtures/rpc-wire/*.json`
- Modify: `packages/contracts/package.json`

**Interfaces:**

- Consumes the existing Effect RPC JSON envelopes: `Request`, `Ack`,
  `Interrupt`, `Eof`, `Ping`, `Chunk`, `Exit`, `Defect`, and `Pong`.
- Produces a bounded, cancellation-aware Rust RPC session and method registry.

- [x] Export canonical request, success, typed-failure, defect, stream,
      acknowledgement, interruption, ping, and pong fixtures from the TypeScript
      client implementation.
- [x] Write Rust tests that fail until every fixture round-trips byte-for-byte
      or as canonical JSON.
- [x] Implement Serde envelopes with request IDs represented losslessly as
      decimal strings.
- [x] Implement concurrent socket read/write loops, bounded outbound queues,
      stream backpressure, per-request cancellation, and connection cleanup.
- [x] Add a manifest test that compares all 80 active methods in `WsRpcGroup`
      with the Rust registry and reports unported methods explicitly. Delete or
      explicitly quarantine the stale `projects.list`, `projects.add`, and
      `projects.remove` identifiers, which are not registered RPCs.
- [x] Cover all 14 streaming methods and their 54 schema-derived top-level item shapes,
      including the 22 nested orchestration-event variants. Require one `Ack` per
      chunk, five-second ping/pong liveness, and prompt `Interrupt` cancellation.

### Task 4: Port Environment Authentication And HTTP APIs

**Files:**

- Create: `apps/server-rust/src/auth/*`
- Create: `apps/server-rust/src/environment/*`
- Create: `apps/server-rust/tests/auth_http.rs`
- Reference: `apps/server/src/auth/*`
- Reference: `packages/contracts/src/auth.ts`
- Reference: `packages/contracts/src/environmentHttp.ts`

**Interfaces:**

- Produces pairing, bootstrap token exchange, bearer sessions, DPoP validation,
  WebSocket tickets, access streams, environment descriptors, and secure secret
  persistence with current response/error shapes.

- [ ] Convert current TypeScript auth tests into language-neutral HTTP fixtures
      and write failing Rust integration tests for every success, expiry, replay,
      scope, malformed-token, and revocation case.
- [ ] Implement cryptographic validation using maintained RustCrypto/JWT crates;
      preserve clock-skew and replay-window semantics exactly.
- [ ] Implement secure secret storage and atomic file replacement on all
      supported operating systems.
- [ ] Preserve the remote bootstrap sequence, five-minute WebSocket tickets,
      30-day sessions, port-qualified desktop cookie names, per-method scope map,
      atomic pairing consumption, and DPoP replay rejection. Raw session tokens in
      the WebSocket query string must remain rejected.
- [ ] Run Rust auth tests and the existing client-runtime authorization tests
      against the Rust server.

### Task 5: Port SQLite Persistence And Migrations

**Files:**

- Create: `apps/server-rust/src/persistence/*`
- Create: `apps/server-rust/tests/persistence_compat.rs`
- Reference: `apps/server/src/persistence/*`

**Interfaces:**

- Opens existing databases without destructive conversion.
- Preserves migration order, transactionality, IDs, timestamps, event rows,
  projection snapshots, provider settings, and checkpoint semantics.

- [ ] Generate golden SQLite databases for empty, current, interrupted, and
      legacy migration states using the TypeScript implementation.
- [ ] Write failing Rust compatibility tests that open each golden database and
      compare logical snapshots.
- [ ] Port migrations and repositories using one explicit transaction boundary
      per current use case.
- [ ] Port all 33 ordered migrations and retain the existing 15 application
      tables plus migration ledger. Preserve JSON-in-TEXT encodings, ISO
      timestamps, sequence values, IDs, and command receipt idempotency.
- [ ] Preserve `settings.json`, `keybindings.json`, attachments, environment and
      anonymous IDs, `server-runtime.json`, provider secret blobs, and the existing
      server and asset signing keys so upgrades do not invalidate credentials or
      signed URLs. Malformed keybinding files must not be overwritten.
- [ ] Add concurrent writer, crash recovery, WAL, busy-timeout, backup, and
      corruption tests.
- [ ] Run both implementations against the same fixture corpus until their
      normalized snapshots match.

### Task 6: Port Projects, Workspaces, Files, Search, Assets, And Review

**Files:**

- Create: `apps/server-rust/src/project/*`
- Create: `apps/server-rust/src/workspace/*`
- Create: `apps/server-rust/src/assets/*`
- Create: `apps/server-rust/src/review/*`
- Create: `apps/server-rust/tests/workspace_rpc.rs`
- Reference: matching directories under `apps/server/src`

**Interfaces:**

- Implements every project, workspace, filesystem, search, asset, favicon, and
  review RPC with existing path normalization and workspace-boundary rules.

- [ ] Port the existing path traversal, symlink, ignore, pagination, binary
      file, large output, watcher, and cancellation tests as failing Rust tests.
- [ ] Implement async bounded filesystem operations and watcher coalescing.
- [ ] Implement incremental search indexes with cancellation and memory limits.
- [ ] Verify the existing browser client can create projects, browse files,
      search, load assets, and open review data against Rust.

### Task 7: Port Git And Source-Control Services

**Files:**

- Create: `apps/server-rust/src/git/*`
- Create: `apps/server-rust/src/vcs/*`
- Create: `apps/server-rust/src/source_control/*`
- Create: `apps/server-rust/tests/git_rpc.rs`
- Reference: `apps/server/src/git/*`, `apps/server/src/vcs/*`, and
  `apps/server/src/sourceControl/*`

**Interfaces:**

- Implements repository discovery, status streams, branches, worktrees,
  staging, discard, commit, push, pull, PR flows, provider discovery, history,
  and AI commit context without changing RPC contracts.

- [ ] Port the current real-repository test matrix, including unborn branches,
      rename/copy porcelain records, untracked discard safety, worktrees, and
      cancellation.
- [ ] Implement one bounded Rust process runner shared by Git and external VCS
      CLIs; never invoke a shell for structured argument arrays.
- [ ] Preserve cache invalidation and subscriber-driven status polling.
- [ ] Run all Rust Git tests against temporary real repositories.

### Task 8: Port Terminals, Processes, Diagnostics, And External Launching

**Files:**

- Create: `apps/server-rust/src/process/*`
- Create: `apps/server-rust/src/terminal/*`
- Create: `apps/server-rust/src/diagnostics/*`
- Create: `apps/server-rust/tests/terminal_rpc.rs`
- Reference: `apps/server/src/processRunner.ts`
- Reference: `apps/server/src/terminal/*`
- Reference: `apps/server/src/diagnostics/*`

**Interfaces:**

- Implements PTY create/attach/resize/input/metadata streams, bounded process
  output, descendant signaling, resource history, and external editor/browser
  launching.

- [ ] Port process timeout, output limit, shell resolution, PTY lifecycle,
      reconnect, resize, metadata, and descendant-signal tests first.
- [ ] Use a maintained cross-platform PTY crate and Tokio process supervision.
- [ ] Move diagnostics into the persistent Rust process and sample only while a
      subscriber or retention consumer exists; remove five-second helper spawning.
- [ ] Use Windows Job Objects and Unix process groups so forced shutdown cannot
      orphan provider or terminal descendants.

### Task 9: Port Event-Sourced Orchestration And Checkpointing

**Files:**

- Create: `apps/server-rust/src/orchestration/*`
- Create: `apps/server-rust/src/checkpointing/*`
- Create: `apps/server-rust/tests/orchestration.rs`
- Reference: matching directories under `apps/server/src`

**Interfaces:**

- Preserves command validation, event metadata, ordering, idempotency,
  projections, receipts, replay, rollback, checkpoint restore, and push order.

- [ ] Export golden command/event/projection traces from every existing
      orchestration test.
- [ ] Write failing Rust replay tests that compare normalized snapshots and
      emitted pushes after every event.
- [ ] Implement a single-writer command loop with bounded queues and explicit
      cancellation; avoid holding locks across I/O.
- [ ] Keep event append, every affected projection update, and the accepted
      command receipt in one SQLite transaction. Publish only after commit and in
      sequence order; each of the nine projectors must resume from its own
      transactionally advanced sequence.
- [ ] Preserve subscription-before-worker startup where required and the exact
      startup order: settings, keybindings, reactors/reaper, welcome, command-gate
      release, listener readiness, then ready. Lifecycle streams replay their
      latest welcome/ready snapshots.
- [ ] Run deterministic restart, duplicate, partial-stream, and failure tests.

### Task 10: Port Codex Provider Runtime

**Files:**

- Create: `apps/server-rust/src/provider/codex/*`
- Create: `apps/server-rust/tests/provider_codex.rs`
- Reference: `apps/server/src/provider/Layers/Codex*`
- Reference: `.repos/codex`
- Delete after parity: `packages/effect-codex-app-server`

**Interfaces:**

- Speaks Codex app-server JSON-RPC directly from Rust and emits the same
  normalized provider and orchestration events.

- [ ] Port initialization, model discovery, thread start/resume/send/cancel,
      approvals, tools, partial streams, reconnect, rollback, and shutdown fixtures.
- [ ] Implement framed JSON-RPC with bounded stdout/stderr readers and strict
      request correlation.
- [ ] Verify normalized event traces match TypeScript golden fixtures.

### Task 11: Port Claude Provider Runtime

**Files:**

- Create: `apps/server-rust/src/provider/claude/*`
- Create: `apps/server-rust/tests/provider_claude.rs`
- Reference: `apps/server/src/provider/Layers/Claude*`
- Reference: `apps/server/src/provider/Drivers/ClaudeDriver.ts`

**Interfaces:**

- Replaces `@anthropic-ai/claude-agent-sdk` with direct supported CLI/protocol
  integration; no persistent Node compatibility worker is permitted.

- [ ] Capture sanitized native SDK/CLI event fixtures for every currently
      supported interaction and failure mode.
- [ ] Implement process startup, control input, stream decoding, permissions,
      tools, cancellation, and teardown in Rust.
- [ ] Compare canonical event traces and provider state snapshots.

### Task 12: Port Cursor, Grok, And OpenCode Provider Runtimes

**Files:**

- Create: `apps/server-rust/src/provider/cursor/*`
- Create: `apps/server-rust/src/provider/grok/*`
- Create: `apps/server-rust/src/provider/opencode/*`
- Create: `apps/server-rust/tests/provider_cursor.rs`
- Create: `apps/server-rust/tests/provider_grok.rs`
- Create: `apps/server-rust/tests/provider_opencode.rs`
- Reference: matching drivers, layers, and adapters under `apps/server/src/provider`
- Delete after parity: `packages/effect-acp`

**Interfaces:**

- Preserves discovery, health, model lists, sessions, stream normalization,
  maintenance, upgrades, reconnect, and errors for all three providers.

- [ ] Export current provider-native and canonical fixture corpora.
- [ ] Implement direct CLI, ACP, HTTP, or WebSocket protocols in Rust as each
      provider currently requires.
- [ ] Run fixture parity plus opt-in installed-provider smoke tests.

### Task 13: Port Remaining Server Domains And Register All RPCs

**Files:**

- Create or complete Rust modules for `cloud`, `mcp`, `preview`,
  `provider_usage`, `telemetry`, `observability`, `text_generation`, and
  `server_settings` under `apps/server-rust/src`
- Create: `apps/server-rust/tests/rpc_completeness.rs`

**Interfaces:**

- Produces a Rust handler for every method in the exported `WS_METHODS`
  manifest and every HTTP endpoint in the TypeScript server.

- [ ] Port each remaining domain's existing fixtures and failure tests.
- [ ] Make `rpc_completeness` fail while any method is absent, duplicated, or
      still delegated to Node.
- [ ] Verify stream cleanup and authorization scopes for every handler.
- [ ] Run the complete Rust server test suite with no ignored parity tests.

### Task 14: Run The Rust Server In-Process Inside Tauri

**Files:**

- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Replace: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/tauriDesktopBridge.test.ts`

**Interfaces:**

- Tauri owns one in-process `ServerRuntime`; the headless binary uses the same
  library. The frontend remains on the Tauri asset origin and receives backend
  readiness through a typed bridge event.

- [ ] Write failing Rust lifecycle tests proving one runtime starts, restarts,
      and stops without child processes.
- [ ] Write a failing frontend test proving backend-ready refresh does not
      navigate or recreate the React root.
- [ ] Replace Node supervision with managed Rust server state and explicit
      shutdown joins.
- [ ] Remove production `window.navigate` and invalidate cached bootstrap/auth
      state on restart.
- [ ] Build the headless Rust server for the supported WSL Linux targets and
      launch that binary inside WSL instead of resolving or invoking WSL Node.
- [ ] Replace SSH remote launch scripts with Rust-binary discovery,
      installation/version validation, readiness, and shutdown; remote launch must
      never invoke `node`, `npm`, `npx`, or a JavaScript `t4code` package.
- [ ] Verify desktop startup, settings-driven restart, WSL, SSH, and exit.

### Task 15: Optimize And Harden The React/WebView Boundary

**Files:**

- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/routes/*`
- Modify heavy feature imports under `apps/web/src`

**Interfaces:**

- Retains React behavior while reducing initial parse/heap cost and restricting
  privileged IPC to the minimum commands required by the main window.

- [ ] Add failing tests for CSP, capability least privilege, async command
      execution, and production source-map exclusion.
- [ ] Convert filesystem/process/encryption/dialog bridge commands to async
      work that cannot block Tauri's main thread.
- [ ] Add a restrictive CSP and remove redundant `opener:default`, global API,
      shell, store, and disabled updater exposure.
- [ ] Lazy-load settings routes, terminal, diagnostics, Clerk, diff/editor, and
      other non-shell features; lower the chunk warning budget.
- [ ] Record initial JS/CSS, parse, first-content, and interaction budgets in CI.

### Task 16: Remove Node, TypeScript Server, And Migration Artifacts

**Files:**

- Rename final Rust server package to canonical `apps/server`
- Delete the TypeScript implementation under the former `apps/server`
- Delete: `packages/native-command-runner`
- Delete: `packages/native-process-diagnostics`
- Delete: `packages/effect-acp`
- Delete: `packages/effect-codex-app-server`
- Delete or replace with Rust-owned SSH code: `packages/ssh`
- Delete: `scripts/prepare-tauri-node-runtime.ts`
- Delete: `scripts/prepare-tauri-node-runtime.test.ts`
- Modify all package scripts, workspace config, CI, release, and Tauri resources

**Interfaces:**

- `t4code` resolves to the Rust binary. Desktop links the same Rust library.
- No compatibility sidecar or hidden Node fallback remains.

- [ ] Add a failing repository scan that rejects active Electron, Node runtime,
      server JavaScript bundle, helper executable, or `server-node_modules` paths.
- [ ] Switch backend and desktop runtime build, dev, CI, release, and artifact
      paths to Cargo/Tauri; keep pnpm/Vite only for frontend compilation and tests.
- [ ] Remove Node-only dependencies and regenerate `pnpm-lock.yaml`.
- [ ] Delete obsolete migration adapters, fallbacks, measurements, plans, and
      generated artifacts while retaining intentional historical documentation.
- [ ] Build installers and inspect their contents to prove forbidden artifacts
      are absent.

### Task 17: Documentation And Completion Audit

**Files:**

- Modify every project-owned Markdown file whose architecture, command, path,
  package role, release flow, or troubleshooting content changed
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/desktop-performance-baseline.md`
- Modify this plan with final evidence and status

**Interfaces:**

- Documentation describes only the final Tauri/Rust/React architecture and
  distinguishes current evidence from historical Electron/Node measurements.

- [x] Audit all project-owned Markdown files and validate every local link.
- [x] Run `vp check`, `vp run typecheck`, `vp test`,
      `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
      and `cargo test --workspace` from a clean generated-artifact state.
- [x] Build all release artifacts and scan build logs for warnings.
- [ ] Test browser mode in Chrome and packaged Tauri mode through Windows UI
      Automation; verify core project/thread/provider/terminal/Git/settings flows.
- [ ] Record repeated cold/warm, idle, terminal, large-thread, source-control,
      and provider-stream measurements on Windows, macOS, and Linux.
- [x] Confirm the default process tree has no Node process and compare memory,
      responsiveness, startup, and artifact size against the Phase 0 baseline.
- [ ] Mark this plan complete only when every checkbox has authoritative current
      evidence and no required work remains.

## Final Acceptance Scans

These scans must return no active runtime/build matches. Historical measurement
documents and explicit compatibility fixtures may be allowlisted by exact path.

```powershell
rg -n -i "electron|electron-builder|@clerk/electron|desktop-tauri" package.json pnpm-workspace.yaml .github apps packages scripts
rg -n "resources/node|server-node_modules|prepare-tauri-node-runtime|dist/bin\.mjs" apps/desktop Cargo.toml package.json .github scripts
rg -n '"start": "node dist/bin\.mjs"|node --watch src/bin\.ts|apps/server/src/.+\.ts|effect-acp|effect-codex-app-server|node-pty|ffi-rs|@ff-labs/fff-node' package.json pnpm-workspace.yaml pnpm-lock.yaml .github apps packages scripts
rg -n 'node|npm|npx|t4code@latest' apps/desktop/src-tauri/src/ssh.rs apps/desktop/src-tauri/src/backend.rs packages/ssh 2>$null
```

Installer inspection must also prove there is no `node`, `node.exe`,
`server-node_modules`, `bin.mjs`, `.node` native module, or JavaScript backend
entrypoint in the packaged resources.

## Research References

- [Tauri process model](https://v2.tauri.app/concept/process-model/)
- [Tauri state management](https://v2.tauri.app/develop/state-management/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri CSP](https://v2.tauri.app/security/csp/)
- [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html)
- [Axum router](https://docs.rs/axum/latest/axum/struct.Router.html)
- [Axum WebSocket](https://docs.rs/axum/latest/axum/extract/ws/struct.WebSocketUpgrade.html)
