# Scripts

Run workspace commands through Vite+ (`vp`).

- `vp install`: install workspace dependencies.
- `vp run dev`: start the server and React development graph.
- `vp run dev:server`: start only the WebSocket/HTTP server.
- `vp run dev:web`: start only the Vite frontend.
- `vp run dev:desktop`: start the Tauri 2 desktop app with frontend HMR.
- `cargo run -p t4code-server -- serve`: run the native headless server from
  this checkout.
- `vp run build`: build all application and package outputs.
- `vp run build:desktop`: build the React assets, Rust backend, and Tauri
  application.
- `vp check`: run formatting and lint checks.
- `vp run typecheck`: run TypeScript and Rust checks across the workspace.
- `vp test`: run the built-in Vite+ unit test suite.
- `vp run test`: run every package `test` script, including Rust packages.
- `vp run test:desktop`: run the Tauri Rust test suite.
- `vp run release:smoke`: exercise release versioning and lockfile generation.
- `vp run measure:desktop-runtime -- ...`: capture startup and process-tree
  memory measurements.

## Desktop Artifacts

- `vp run dist:desktop:dmg`: macOS DMG for the host architecture.
- `vp run dist:desktop:dmg:arm64`: macOS arm64 DMG.
- `vp run dist:desktop:dmg:x64`: macOS Intel DMG.
- `vp run dist:desktop:linux`: Linux x64 AppImage.
- `vp run dist:desktop:win`: Windows NSIS installer for the host architecture.
- `vp run dist:desktop:win:x64`: Windows x64 NSIS installer.

The artifact wrapper is `scripts/build-desktop-artifact.ts`. It rejects
cross-platform builds by default, invokes the canonical `@t4code/desktop`
Tauri package, and copies bundle output under `release/desktop` unless an output
directory is supplied.

The desktop artifact contains the Tauri host, in-process Rust server, and built
web assets. It does not stage Node.js, a TypeScript server, or helper sidecars.

## Multiple Development Instances

Set `T4CODE_DEV_INSTANCE` to shift the server and web development ports
deterministically, or set `T4CODE_PORT_OFFSET` to an explicit numeric offset.
The default server/web ports are `13773` and `5733`.
