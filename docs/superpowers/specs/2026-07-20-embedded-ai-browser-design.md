# Embedded AI-Controlled Browser (Right Panel) — Design

**Date:** 2026-07-20
**Status:** Approved (brainstorming complete, pending implementation plan)

## Summary

Bring the right-panel Browser surface to life on Tauri and integrate it with the AI
chat panel and all AI providers, Cursor-style: the user browses in the panel; agents
drive the same browser through the existing `preview_*` MCP tools; all in-app URL
opens (chat links, AI-generated HTML artifacts, terminal links) route to the internal
browser; and a design mode lets the user select/annotate page elements and send them
to chat as context chips.

## Background — what exists today

T4Code (Tauri 2.11.5 + React 19 renderer + Rust Axum server) already contains ~90%
of this feature, dormant:

- Right-panel Browser surface, tabs, and picker (`apps/web/src/components/RightPanelTabs.tsx`,
  `apps/web/src/rightPanelStore.ts` — surface kind `preview`).
- Full preview UI: chrome row, device/viewport toolbar with Chrome DevTools presets,
  screen recording, agent-cursor overlay (`apps/web/src/components/preview/*`,
  `apps/web/src/browser/*`).
- Server: preview RPC service (`apps/server/src/production/workspace_preview.rs`),
  localhost dev-server discovery (`local_servers.rs`), and an MCP endpoint at `/mcp`
  (`connect_mcp.rs`) that exposes a complete browser tool family — `preview_status`,
  `preview_open`, `preview_navigate`, `preview_resize`, `preview_snapshot`,
  `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
  `preview_evaluate`, `preview_wait_for`, `preview_recording_start/stop` — injected
  into every provider CLI (Claude, Codex, Cursor, Grok, OpenCode) with a per-thread
  credential.
- Contracts: `packages/contracts/src/preview.ts`, `previewAutomation.ts` (tool
  schemas incl. snapshot with screenshot + a11y tree + console + network), and the
  `DesktopPreviewBridge` interface (`ipc.ts:1056-1116`).
- Automation pipeline: server `PreviewAutomationBroker`
  (`apps/server/src/mcp/preview_automation.rs`) → renderer executor
  (`apps/web/src/components/preview/PreviewAutomationHosts.tsx`) over the
  `previewAutomation.connect` RPC stream.

**The gap:** the native "preview host" that renders pages was built on Electron
`<webview>` and was not re-implemented in the Tauri 2 migration. Nothing installs
`window.desktopBridge.preview`, so `isPreviewSupportedInRuntime()`
(`apps/web/src/previewStateStore.ts:410`) is false on every build and the Browser
card is disabled. The renderer executor also depends on Electron-only
`webview.executeJavaScript()`.

`docs/architecture/overview.md:96` mandates: preview and preview automation are
capability-driven and use the Tauri/native implementation, never Electron
WebContents APIs.

### Research inputs

- **Cursor** (closed source; docs/changelogs): embeds its own Chromium, agent tools
  are MCP-style (navigate/click/type/scroll/screenshot/console/network), agent
  perception is screenshot-first with structured DOM capture on element select;
  element→source mapping is heuristic (agent searches the codebase). Design Mode:
  `⌘⇧D`, click/Shift+drag multi-select, `⌘L` to chat, context chips.
- **Orca** (source at `/Users/admin/projects/orca`): Electron `<webview>` guests
  driven over CDP (`webContents.debugger`); accessibility snapshot with `@e1` refs,
  stale-ref recovery by role+name+nth; per-tab command queue; agents use a CLI over
  a local JSON-RPC socket. Its `snapshot-engine.ts` + `cdp-bridge.ts` are the
  reference design for our snapshot/ref engine (reimplemented as injected JS since
  Tauri has no CDP on WKWebView).
- **VS Code Copilot browser**: Playwright-based; agent-opened tabs get isolated
  fresh sessions — the isolation model we mirror.

## Decisions (from brainstorming)

1. **Scope:** all three pillars designed together — browser surface, agent control,
   URL/artifact routing — implemented in phases.
2. **Design mode is in scope** (element selection/annotation → chat context).
3. **Consumers:** chat-panel providers and terminal CLI agents both drive the
   browser. Both are served by the one existing mechanism: the per-thread `t4code`
   MCP server injected into every provider CLI.
4. **Security posture:** AI browsing is unrestricted; preview webviews use an
   isolated data profile, never the user's personal browser state.
5. **Routing:** all in-app URL opens go to the internal browser by default, with
   escape hatches (pop-out button, right-click "Open in system browser", settings
   toggle).
6. **Platforms:** macOS, Windows, Linux from day one. This drove the architecture
   choice: maximize shared code, minimize per-platform native surface.
7. **Architecture:** Approach A — Tauri child-webview host + injected JS automation
   agent — designed so per-platform CDP upgrades (e.g. WebView2's
   `CallDevToolsProtocolMethod` on Windows) can slot in behind the same interface
   later.

Rejected: sidecar Chromium over CDP (cannot embed in the panel; heavy), staying
Electron-shaped (app deliberately migrated to Tauri).

## Architecture

```
AI agents (chat panel providers + terminal CLIs)
    │  MCP: preview_open / navigate / snapshot / click / type / …   [EXISTS]
    ▼
Server — MCP endpoint + PreviewAutomationBroker                      [EXISTS]
    │  previewAutomation.connect stream (WS RPC)                     [EXISTS]
    ▼
Renderer — PreviewAutomationHosts executor, browser UI, tabs         [EXISTS, rewire executor]
    │  window.desktopBridge.preview                                  [NEW bridge]
    ▼
Tauri host — PreviewHost plugin: child webviews, nav, screenshots    [NEW]
    │  eval in / Tauri IPC postMessage out
    ▼
Page — injected automation agent (snapshot, input, capture, picker)  [NEW]
```

An automation round-trip (`preview_click`): provider CLI → server MCP endpoint →
broker → renderer executor (existing stream) → `desktopBridge.preview.automation` →
Tauri command → `eval` into the page agent → result via IPC → back up the chain.
Only the last three hops are new.

## Components

### 1. `PreviewHost` Tauri plugin — `apps/desktop/src-tauri/src/preview/` (new)

- Enable `tauri = { features = ["unstable"] }` (multi-webview). Each browser tab is
  a child webview attached to the main window, positioned over the right-panel rect.
- State: `TabId → PreviewTab` (webview handle, profile, nav state).
- Commands: `create_tab`, `destroy_tab`, `set_bounds`, `set_visible`, `navigate`,
  `go_back`, `go_forward`, `reload(hard?)`, `set_zoom`, `screenshot`, `eval`,
  `open_devtools`, `clear_data(cookies|cache|storage)`.
- Events to renderer: `preview://nav-state` (url, title, loading, canGoBack/Forward),
  `preview://agent-message`, `preview://tab-crashed`.
- Screenshots behind `trait PreviewSnapshot`, three impls: WKWebView `takeSnapshot`
  (objc2), WebView2 `CapturePreview`, `webkit_web_view_get_snapshot`. PNG → base64,
  matching the existing screenshot artifact contract.
- One shared, isolated data profile for all preview webviews (successor of the old
  `persist:t4code-preview` partition): cookies/storage persist across tabs and
  restarts but never touch the user's personal browser state. Finer-grained
  profiles are a possible later addition.
- The automation agent bundle is embedded via `include_str!` and registered as an
  initialization script on every preview webview.

### 2. Automation agent — `packages/preview-agent` (new, TS → single IIFE bundle)

- `snapshot.ts`: AX-style indented text tree with `@e1` refs (interactive elements,
  headings, landmarks, text; duplicate role+name disambiguation; stale-ref recovery
  by role+name+nth). Modeled on Orca's `snapshot-engine.ts`, computed from the DOM.
- `input.ts`: click (scrollIntoView + full pointer/mouse event sequence), type/fill
  (focus + native value setters so React-controlled inputs update + input/change
  events), press, scroll, hover, drag.
- `capture.ts`: `console.*` wrapper + `fetch`/XHR wrapper feeding ring buffers; the
  existing `SnapshotResult` contract already has console/network fields.
- `picker.ts`: design-mode element picker + annotation overlay (in-page DOM/canvas).
- `channel.ts`: commands in via `eval("__t4b.dispatch(...)")`; results out via
  Tauri's IPC message handler (native script-message channel — page CSP cannot
  block it). Per-tab command queue serializes operations.
- One namespaced global (`__t4b`); pristine references to `console`/`fetch`/etc.
  captured in a closure at install time so hostile pages can't blind the agent.
- Built and unit-tested with the same vite-plus/vitest toolchain as `apps/web`.

### 3. Bridge — `apps/web/src/tauriDesktopBridge.ts` implements `preview`

Thin mapping of the updated `DesktopPreviewBridge` contract onto `invoke()`/
`listen()`. Its presence flips `isPreviewSupportedInRuntime()` → the Browser card,
tabs, chrome row, and device toolbar activate with no further UI work.

### 4. Renderer rewiring (surgical)

- `PreviewView.tsx`: mounts a placeholder div; ResizeObserver streams its rect to
  `set_bounds` so the child webview floats exactly over the panel.
- `PreviewAutomationHosts.tsx`: replace the Electron internals
  (`querySelector("webview[data-preview-tab]")` + `executeJavaScript`) with
  `desktopBridge.preview.automation.*` calls. The broker protocol above is untouched.

### 5. Server — no logic changes for v1

The `preview_*` MCP tools, broker, per-thread credentials, and dev-server discovery
work as-is. The only change in this area is text: sharpened LLM-facing tool
descriptions (notably `preview_open`) in `packages/contracts/src/previewAutomation.ts`.
Optional hardening later: enforce the per-capability credential scoping the contract
already defines (`PreviewAutomationUnavailableError`).

### Contract change

`DesktopPreviewBridge` (`packages/contracts/src/ipc.ts:1056-1116`) moves from
Electron-shaped (`registerWebview(tabId, webContentsId)`) to host-managed:
`createTab` returns a host-side tab handle; the renderer supplies/updates bounds.
Navigate/zoom/screenshot/recording/automation sub-APIs keep their shape.

## Design mode (element-to-chat)

- Toggle: "Design" button in the chrome row + `⌘⇧D`.
- Picking: hover outline + chip label; click selects; `Shift+drag` box-selects
  multiple; pen tool for freehand annotation. Overlays are injected into the page's
  DOM (the native child webview sits above the app UI), so annotations appear in
  screenshots for free.
- Captured per element: trimmed `outerHTML`, layout-relevant computed CSS, stable
  CSS selector, bounding box, page URL, screenshot crop. Multi-select adds layout
  relationships between selections.
- To chat: agent → IPC → renderer → context chips on the chat composer (reviving
  the element-pick attachment plumbing from commit `17fb0e4a9a`). A floating
  "Describe the change…" mini-input appears over the page when something is
  selected; `⌘L` jumps to the main composer with chips attached. Screenshot crops
  ride along as image attachments for vision models.
- Element→source is heuristic (agent searches the codebase from selector/HTML),
  matching Cursor. Future hook: dev-mode source data attributes.

## URL & artifact routing

- Single funnel: every in-app open goes through `openUrlInPreview` when the preview
  host is available. Wire points: chat markdown link clicks (`ChatMarkdown.tsx`),
  `localApi.shell.openExternal` call sites (http/https only; `mailto:` etc. stay
  external), terminal link clicks (`openTerminalLinkInPreview.ts`), discovered
  dev-server cards, and the agent's `preview_open` tool.
- Escape hatches: right-click "Open in system browser" on links; pop-out button in
  the browser chrome; Settings toggle "Open links in internal browser" (default on,
  desktop only). Web builds keep current behavior.
- Inside preview pages: `window.open`/`target=_blank` intercepted by the injected
  agent → new internal tab via IPC.
- AI-generated HTML artifacts: the AI writes the file to the workspace; the existing
  workspace-file asset endpoint serves it over localhost (`.html` is a previewable
  asset type); it opens as an internal browser tab — via agent `preview_open` or by
  clicking the file chip in chat. Sharpen `preview_open`'s tool description so
  providers show web content this way rather than shelling out to `open`.

## Error handling

- Webview crash/unresponsive → `preview://tab-crashed` → tab error state with
  reload; automation against a dead tab returns a structured `no_tab` error
  (extending the broker's `PreviewAutomationNoAvailableHostError` pattern to tab
  granularity).
- Stale `@e` refs → structured `stale_ref` error telling the agent to re-snapshot;
  refs self-heal by role+name+nth when possible.
- Broker timeout stays at 15s; per-tab command queue prevents interleaved gestures.
- Hostile pages: init script runs before page code; pristine globals captured in
  closures; anti-bot walls and frame-busting degrade to structured tool errors.
- Cross-origin iframes are opaque in snapshots — documented v1 limitation; the
  Approach-C CDP upgrade path (WebView2 first) addresses it later.
- `preview_open` with the panel closed auto-opens the Browser surface; other tools
  with no live tab return the structured error.

## Testing

- **preview-agent** (vitest, fixture DOMs): snapshot shape, ref stability/staleness,
  synthesized input on React-controlled inputs, console/network capture.
- **Rust host**: unit tests for tab registry + bounds math; screenshot trait mocked.
- **End-to-end** (`tauri-plugin-wdio`, already a dev dep): launch app → open Browser
  surface → load local fixture page → call `preview_snapshot`/`preview_click`
  through the real server `/mcp` endpoint and assert round-trips.
- **Contracts**: Effect Schema round-trip tests for the updated bridge contract.
- Manual per-platform checklist (macOS/Windows/Linux): screenshots, zoom, devtools.

## Phasing (each independently shippable)

1. **Light up the browser** — Rust host + bridge + renderer rewiring; manual
   browsing works; Browser card enables.
2. **Agent control** — preview-agent + executor rewiring; all `preview_*` tools
   live for chat and terminal agents; agent cursor + recording work.
3. **Routing** — `openUrlInPreview` funnel, `window.open` interception, pop-out,
   settings toggle, HTML-artifact flow.
4. **Design mode** — picker, multi-select, annotations, context chips, floating
   input, `⌘L`.

## Known limitations (v1)

- Synthesized JS events are not trusted input (`isTrusted: false`); a few sites can
  detect this. Upgrade path: per-platform CDP input (WebView2 first).
- Injected agent cannot reach cross-origin iframes.
- No anti-bot stealth; heavy bot-walled sites may block automation.
- Rendering engine differs per OS (WebKit/Chromium/WebKitGTK) — previews are the
  platform's system webview, not Chrome pixel-parity.
