# Embedded AI Browser — Phase 1: Light Up the Browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Tauri-native preview host so `window.desktopBridge.preview` exists, the grayed-out Browser surface activates, and manual browsing (tabs, URL bar, back/forward, reload, zoom, screenshots, devtools, isolated profile) works in the right panel on macOS, Windows, and Linux.

**Architecture:** A new `preview` module in the Tauri shell (`apps/desktop/src-tauri`) creates one native child webview per browser tab via Tauri's `unstable` multi-webview API, positioned over the right-panel rect that the renderer already measures (`browserSurfaceStore`). Nav state flows back as `preview://state` events shaped as the existing `DesktopPreviewTabState` contract. Per-platform native glue (JS-eval-with-result, title, history, hard reload, clear data, screenshot) lives behind one Rust trait with three implementations. The renderer gains a thin `tauriPreviewBridge.ts` implementing the (slightly updated) `DesktopPreviewBridge` contract, plus a small sync module that forwards `browserSurfaceStore` rects to the host.

**Tech Stack:** Tauri 2.11.5 (`unstable`, `devtools` features), Rust (objc2-web-kit / webview2-com / webkit2gtk per platform), TypeScript + Effect Schema contracts, React 19, zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-embedded-ai-browser-design.md` (Phase 1 scope only. Automation agent, MCP executor rewiring, URL routing, and design mode are Phases 2–4 with their own plans.)

## Global Constraints

- Never use Electron WebContents APIs — Tauri/native only (`docs/architecture/overview.md:96`).
- All three platforms (macOS, Windows, Linux) must compile and work; platform-specific code goes behind `src/preview/platform/` trait impls only.
- Contract-first: any renderer↔host shape lives in `packages/contracts/src/ipc.ts` as Effect Schema.
- Preview webviews use an isolated data profile — never the user's default browser state, never the main app webview's session.
- Command naming: `desktop_preview_<verb>` (mirrors `desktop_bridge_*`); permission file `permissions/preview.toml`, identifier `allow-desktop-preview`, registered in `capabilities/default.json`.
- Test commands: web `pnpm --filter @t4code/web test`, contracts `pnpm --filter @t4code/contracts test`, desktop Rust `pnpm --filter @t4code/desktop test` (runs `cargo test -p t4code-desktop`), typecheck `pnpm --filter @t4code/desktop typecheck` (runs `cargo check`).
- Commit after every green step; message format `feat(preview): …` / `test(preview): …`; end with `Co-Authored-By:` trailer per repo convention.
- Renderer never talks to wry/platform webviews directly; everything crosses `window.desktopBridge.preview`.

---

### Task 1: Contract — host-managed `DesktopPreviewBridge`

The current contract is Electron-shaped. Make it host-managed: add `setBounds`, downgrade the two Electron-era members to optional.

**Files:**
- Modify: `packages/contracts/src/ipc.ts:1056-1116` (`DesktopPreviewBridge`), `:617-639` (near `DesktopPreviewWebviewConfig`)
- Test: `packages/contracts/src/ipc.preview.test.ts` (create)

**Interfaces:**
- Consumes: existing `DesktopPreviewTabState`, `DesktopPreviewScreenshotArtifact` (unchanged).
- Produces: `DesktopPreviewBounds` type + `DesktopPreviewBoundsSchema`; `DesktopPreviewBridge.setBounds(tabId, bounds, visible)`; `registerWebview?` and `getPreviewConfig?` now optional. Tasks 8–9 implement/consume these exact signatures.

- [x] **Step 1: Write the failing test**

```ts
// packages/contracts/src/ipc.preview.test.ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DesktopPreviewBoundsSchema } from "./ipc";

describe("DesktopPreviewBoundsSchema", () => {
  it("round-trips a bounds rect", () => {
    const bounds = { x: 12, y: 34, width: 800, height: 600 };
    const decoded = Schema.decodeUnknownSync(DesktopPreviewBoundsSchema)(bounds);
    expect(decoded).toEqual(bounds);
  });

  it("rejects negative dimensions", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesktopPreviewBoundsSchema)({ x: 0, y: 0, width: -1, height: 10 }),
    ).toThrow();
  });
});
```

Note: match the Schema import/usage style used by the existing tests in `packages/contracts/src` (check a neighbouring `*.test.ts` for whether they import `Schema` from `"effect"` or `"effect/Schema"` and copy that idiom exactly).

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @t4code/contracts test -- ipc.preview`
Expected: FAIL — `DesktopPreviewBoundsSchema` is not exported.

- [x] **Step 3: Add the contract types**

In `packages/contracts/src/ipc.ts`, directly above `export interface DesktopPreviewWebviewConfig` (line ~617), add:

```ts
/**
 * Panel-relative bounds for a native preview webview, in logical (CSS)
 * pixels relative to the main window's client area. The renderer measures
 * these from `browserSurfaceStore` and forwards them verbatim.
 */
export interface DesktopPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DesktopPreviewBoundsSchema: Schema.Codec<DesktopPreviewBounds> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number.check(Schema.nonNegative()),
  height: Schema.Number.check(Schema.nonNegative()),
});
```

(If the file's existing schemas express "non-negative number" differently — e.g. `Schema.NonNegative` or a `.pipe(...)` filter — copy that exact idiom instead.)

In `DesktopPreviewBridge` (line ~1056):

```ts
export interface DesktopPreviewBridge {
  createTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  /**
   * Electron-era API: associate a renderer-mounted `<webview>`. Absent on
   * the Tauri host, which owns webview lifetime natively.
   */
  registerWebview?: (tabId: string, webContentsId: number) => Promise<void>;
  /**
   * Position/show the native webview over the right-panel rect. Bounds are
   * logical pixels relative to the main window's client area. `visible:
   * false` hides the webview without destroying it (tab switched away).
   */
  setBounds: (tabId: string, bounds: DesktopPreviewBounds, visible: boolean) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  // ... keep every other existing member unchanged, EXCEPT:
  getPreviewConfig?: (environmentId: EnvironmentId) => Promise<DesktopPreviewWebviewConfig>;
}
```

(Only three edits inside the interface: `registerWebview` gains `?`, `setBounds` is inserted after it, `getPreviewConfig` gains `?`. Update the `getPreviewConfig` doc comment to note it is Electron-era and absent on Tauri.)

- [x] **Step 4: Fix compile fallout**

Run: `pnpm --filter @t4code/contracts typecheck && pnpm --filter @t4code/web typecheck`
Expected: `previewWebviewConfigState.ts:44` fails — `Pick<DesktopPreviewBridge, "getPreviewConfig">` now yields an optional member. Fix `apps/web/src/browser/previewWebviewConfigState.ts` by guarding:

```ts
type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;
// inside the loader:
    try: () => {
      if (!bridge.getPreviewConfig) {
        return Promise.reject(new Error("preview config not supported on this host"));
      }
      return bridge.getPreviewConfig(environmentId);
    },
```

(Adapt to the actual surrounding code — the intent is: optional member handled, same external behavior when absent as when rejecting. If other call sites of `registerWebview`/`getPreviewConfig` surface in typecheck, guard them the same way.)

- [x] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @t4code/contracts test -- ipc.preview && pnpm --filter @t4code/web typecheck`
Expected: PASS / clean.

- [x] **Step 6: Commit**

```bash
git add -A packages/contracts apps/web/src/browser/previewWebviewConfigState.ts
git commit -m "feat(contracts): host-managed DesktopPreviewBridge with setBounds"
```

---

### Task 2: Rust dependencies & feature flags

**Files:**
- Modify: `Cargo.toml` (workspace root, line ~36), `apps/desktop/src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `tauri` with `unstable` + `devtools` features; per-platform webview crates available to `preview/platform/*` (Task 4–6).

- [ ] **Step 1: Enable Tauri features (workspace root `Cargo.toml:36`)**

```toml
tauri = { version = "2.11.5", features = ["unstable", "devtools", "image-png"] }
```

- [ ] **Step 2: Add per-platform deps to `apps/desktop/src-tauri/Cargo.toml`**

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-app-kit = { version = "0.3", features = ["NSImage", "NSBitmapImageRep", "NSGraphics"] }
objc2-web-kit = { version = "0.3", features = ["WKWebView", "WKWebViewConfiguration", "WKWebsiteDataStore", "WKBackForwardList"] }
block2 = "0.6"

[target.'cfg(target_os = "windows")'.dependencies]
webview2-com = "0.38"
windows = { version = "0.61", features = ["Win32_System_Com", "Win32_System_Com_StructuredStorage", "Win32_System_Memory"] }

[target.'cfg(target_os = "linux")'.dependencies]
webkit2gtk = { version = "2.0", features = ["v2_40"] }
gtk = "0.18"
cairo-rs = { version = "0.18", features = ["png"] }
```

**Version alignment is mandatory:** these crates must resolve to the SAME versions wry already uses, or you get type mismatches when casting `PlatformWebview::inner()`. Verify with:

Run: `cargo tree -p t4code-desktop -i objc2-web-kit 2>/dev/null | head -5` (macOS) — if the version differs from wry's, change the dep spec to match wry's exactly (check `Cargo.lock` for wry's resolved versions of `objc2*`, `webview2-com`, `webkit2gtk`). Same check on each platform's CI later.

- [ ] **Step 3: Compile**

Run: `pnpm --filter @t4code/desktop typecheck`
Expected: clean `cargo check` (features compile; `unstable` and `devtools` are additive).

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(preview): enable tauri unstable+devtools, add platform webview deps"
```

---

### Task 3: Preview module skeleton — registry & pure logic

Everything unit-testable without a live webview: tab registry, webview label derivation, pending-bounds handling, nav-state model.

**Files:**
- Create: `apps/desktop/src-tauri/src/preview/mod.rs`, `apps/desktop/src-tauri/src/preview/registry.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod preview;`)

**Interfaces:**
- Produces (consumed by Tasks 4–7):

```rust
pub struct PreviewHostState(pub Mutex<PreviewRegistry>);                 // tauri managed state
pub struct PreviewRegistry { tabs: HashMap<String, TabEntry> }
pub struct TabEntry {
    pub label: String,                       // tauri webview label
    pub bounds: Option<PendingBounds>,       // last bounds seen (applied on create if early)
    pub visible: bool,
    pub zoom: f64,                           // tracked, tauri has set-only zoom
    pub last_url: String,
    pub created: bool,                       // webview exists (vs. pending)
}
pub struct PendingBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
pub fn webview_label_for_tab(tab_id: &str) -> String;                    // "preview-" + sanitized
impl PreviewRegistry {
    pub fn new() -> Self;
    pub fn upsert_pending(&mut self, tab_id: &str) -> &mut TabEntry;     // insert if absent
    pub fn get(&self, tab_id: &str) -> Option<&TabEntry>;
    pub fn get_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry>;
    pub fn remove(&mut self, tab_id: &str) -> Option<TabEntry>;
    pub fn tab_id_for_label(&self, label: &str) -> Option<String>;
}
```

- [ ] **Step 1: Write failing tests in `registry.rs`**

```rust
// apps/desktop/src-tauri/src/preview/registry.rs  (tests at bottom of same file)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_deterministic_and_sanitized() {
        assert_eq!(webview_label_for_tab("tab-1"), "preview-tab-1");
        // tauri labels must be alphanumeric plus `-`/`_`/`:`; everything else maps to `_`
        assert_eq!(webview_label_for_tab("a b/c"), "preview-a_b_c");
    }

    #[test]
    fn upsert_then_get_roundtrip() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1").bounds = Some(PendingBounds { x: 1.0, y: 2.0, width: 3.0, height: 4.0 });
        assert!(!reg.get("t1").unwrap().created);
        assert_eq!(reg.get("t1").unwrap().bounds.as_ref().unwrap().width, 3.0);
    }

    #[test]
    fn reverse_label_lookup() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1");
        let label = reg.get("t1").unwrap().label.clone();
        assert_eq!(reg.tab_id_for_label(&label).as_deref(), Some("t1"));
    }

    #[test]
    fn remove_clears_entry() {
        let mut reg = PreviewRegistry::new();
        reg.upsert_pending("t1");
        assert!(reg.remove("t1").is_some());
        assert!(reg.get("t1").is_none());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @t4code/desktop test`
Expected: FAIL to compile — types not defined.

- [ ] **Step 3: Implement**

```rust
// apps/desktop/src-tauri/src/preview/registry.rs
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PendingBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct TabEntry {
    pub label: String,
    pub bounds: Option<PendingBounds>,
    pub visible: bool,
    pub zoom: f64,
    pub last_url: String,
    pub created: bool,
}

pub fn webview_label_for_tab(tab_id: &str) -> String {
    let sanitized: String = tab_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' { c } else { '_' })
        .collect();
    format!("preview-{sanitized}")
}

#[derive(Debug, Default)]
pub struct PreviewRegistry {
    tabs: HashMap<String, TabEntry>,
}

impl PreviewRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_pending(&mut self, tab_id: &str) -> &mut TabEntry {
        self.tabs.entry(tab_id.to_string()).or_insert_with(|| TabEntry {
            label: webview_label_for_tab(tab_id),
            bounds: None,
            visible: false,
            zoom: 1.0,
            last_url: String::new(),
            created: false,
        })
    }

    pub fn get(&self, tab_id: &str) -> Option<&TabEntry> {
        self.tabs.get(tab_id)
    }

    pub fn get_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry> {
        self.tabs.get_mut(tab_id)
    }

    pub fn remove(&mut self, tab_id: &str) -> Option<TabEntry> {
        self.tabs.remove(tab_id)
    }

    pub fn tab_id_for_label(&self, label: &str) -> Option<String> {
        self.tabs
            .iter()
            .find(|(_, entry)| entry.label == label)
            .map(|(tab_id, _)| tab_id.clone())
    }
}
```

```rust
// apps/desktop/src-tauri/src/preview/mod.rs
use std::sync::Mutex;

pub mod registry;

pub use registry::{PendingBounds, PreviewRegistry, TabEntry, webview_label_for_tab};

pub struct PreviewHostState(pub Mutex<PreviewRegistry>);

impl PreviewHostState {
    pub fn new() -> Self {
        Self(Mutex::new(PreviewRegistry::new()))
    }
}
```

In `apps/desktop/src-tauri/src/lib.rs` add `mod preview;` to the module list (line ~139) and register the state in the builder chain (line ~62):

```rust
        .manage(preview::PreviewHostState::new())
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4code/desktop test`
Expected: 4 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat(preview): tab registry and host state skeleton"
```

---

### Task 4: Platform ops trait + macOS (WKWebView) implementation

The per-platform primitive layer. One trait, everything else in the module is cross-platform.

**Files:**
- Create: `apps/desktop/src-tauri/src/preview/platform/mod.rs`, `apps/desktop/src-tauri/src/preview/platform/macos.rs`

**Interfaces:**
- Produces (consumed by Tasks 5–7 and by Phase 2's automation executor):

```rust
/// Everything Tauri's cross-platform Webview API cannot do. All functions
/// take the tauri Webview and run their platform work via `with_webview`
/// (executes on the platform's main/UI thread).
pub trait PlatformWebviewOps {
    /// Evaluate JS, return the result serialized as a JSON string.
    /// The JS expression is wrapped so the result is ALWAYS valid JSON:
    /// `{"ok": <value>}` or `{"err": "<message>"}`.
    fn eval_json(webview: &tauri::Webview, js: &str, timeout: Duration) -> Result<String, PreviewPlatformError>;
    fn title(webview: &tauri::Webview) -> Result<String, PreviewPlatformError>;
    fn can_go_back(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn can_go_forward(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn go_back(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn go_forward(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn hard_reload(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn screenshot_png(webview: &tauri::Webview, timeout: Duration) -> Result<Vec<u8>, PreviewPlatformError>;
    fn clear_data(webview: &tauri::Webview, kinds: ClearDataKinds) -> Result<(), PreviewPlatformError>;
}
pub struct ClearDataKinds { pub cookies: bool, pub cache: bool, pub storage: bool }
pub enum PreviewPlatformError { Unavailable(String), Timeout, Js(String) }
pub type Platform = /* cfg-selected concrete type */;
```

`platform/mod.rs` selects the impl:

```rust
// apps/desktop/src-tauri/src/preview/platform/mod.rs
use std::time::Duration;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacosWebviewOps as Platform;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::WindowsWebviewOps as Platform;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::LinuxWebviewOps as Platform;

#[derive(Debug, Clone, Copy)]
pub struct ClearDataKinds {
    pub cookies: bool,
    pub cache: bool,
    pub storage: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewPlatformError {
    #[error("preview platform unavailable: {0}")]
    Unavailable(String),
    #[error("preview platform call timed out")]
    Timeout,
    #[error("preview javascript error: {0}")]
    Js(String),
}

pub trait PlatformWebviewOps {
    fn eval_json(webview: &tauri::Webview, js: &str, timeout: Duration) -> Result<String, PreviewPlatformError>;
    fn title(webview: &tauri::Webview) -> Result<String, PreviewPlatformError>;
    fn can_go_back(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn can_go_forward(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError>;
    fn go_back(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn go_forward(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn hard_reload(webview: &tauri::Webview) -> Result<(), PreviewPlatformError>;
    fn screenshot_png(webview: &tauri::Webview, timeout: Duration) -> Result<Vec<u8>, PreviewPlatformError>;
    fn clear_data(webview: &tauri::Webview, kinds: ClearDataKinds) -> Result<(), PreviewPlatformError>;
}

/// Wrap arbitrary JS so the completion value is always a JSON envelope.
pub fn json_envelope(js: &str) -> String {
    format!(
        "(function(){{ try {{ return JSON.stringify({{ ok: (function(){{ return ({js}); }})() }}) ?? '{{\"ok\":null}}'; }} catch (e) {{ return JSON.stringify({{ err: String((e && e.message) || e) }}); }} }})()"
    )
}

#[cfg(test)]
mod tests {
    use super::json_envelope;

    #[test]
    fn envelope_wraps_expression() {
        let js = json_envelope("1 + 1");
        assert!(js.contains("1 + 1"));
        assert!(js.contains("JSON.stringify"));
    }
}
```

(Add `thiserror = "2"` to `apps/desktop/src-tauri/Cargo.toml` `[dependencies]` if not already present — check first; the codebase may already depend on it or use plain enums with `Display` impls. Follow whichever error idiom `bridge.rs` uses.)

- [ ] **Step 1: Write `platform/mod.rs` exactly as above; run `pnpm --filter @t4code/desktop test`** — the `envelope_wraps_expression` test passes; macOS module missing so `cargo check` fails on mac. Proceed to Step 2 immediately.

- [ ] **Step 2: Implement macOS ops**

```rust
// apps/desktop/src-tauri/src/preview/platform/macos.rs
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKWebView;

use super::{json_envelope, ClearDataKinds, PlatformWebviewOps, PreviewPlatformError};

pub struct MacosWebviewOps;

/// Run `f` with the WKWebView on the main thread and post the result back.
fn with_wk<T: Send + 'static>(
    webview: &tauri::Webview,
    f: impl FnOnce(&WKWebView) -> T + Send + 'static,
) -> Result<T, PreviewPlatformError> {
    let (tx, rx) = mpsc::channel::<T>();
    webview
        .with_webview(move |platform| {
            // SAFETY: on macOS `PlatformWebview::inner()` is the WKWebView pointer.
            let wk: &WKWebView = unsafe { &*platform.inner().cast() };
            let _ = tx.send(f(wk));
        })
        .map_err(|e| PreviewPlatformError::Unavailable(e.to_string()))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| PreviewPlatformError::Timeout)
}

impl PlatformWebviewOps for MacosWebviewOps {
    fn eval_json(
        webview: &tauri::Webview,
        js: &str,
        timeout: Duration,
    ) -> Result<String, PreviewPlatformError> {
        let script = json_envelope(js);
        let (tx, rx) = mpsc::channel::<Result<String, PreviewPlatformError>>();
        webview
            .with_webview(move |platform| {
                let wk: &WKWebView = unsafe { &*platform.inner().cast() };
                let ns_script = NSString::from_str(&script);
                let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                    let outcome = if !error.is_null() {
                        Err(PreviewPlatformError::Js(unsafe {
                            (*error).localizedDescription().to_string()
                        }))
                    } else if result.is_null() {
                        Ok("{\"ok\":null}".to_string())
                    } else {
                        // The envelope always returns a JS string, so `result`
                        // is an NSString.
                        let ns: &NSString = unsafe { &*result.cast() };
                        Ok(ns.to_string())
                    };
                    let _ = tx.send(outcome);
                });
                unsafe { wk.evaluateJavaScript_completionHandler(&ns_script, Some(&handler)) };
            })
            .map_err(|e| PreviewPlatformError::Unavailable(e.to_string()))?;
        rx.recv_timeout(timeout).map_err(|_| PreviewPlatformError::Timeout)?
    }

    fn title(webview: &tauri::Webview) -> Result<String, PreviewPlatformError> {
        with_wk(webview, |wk| unsafe { wk.title().map(|t| t.to_string()).unwrap_or_default() })
    }

    fn can_go_back(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError> {
        with_wk(webview, |wk| unsafe { wk.canGoBack() })
    }

    fn can_go_forward(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError> {
        with_wk(webview, |wk| unsafe { wk.canGoForward() })
    }

    fn go_back(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_wk(webview, |wk| {
            let _ = unsafe { wk.goBack() };
        })
    }

    fn go_forward(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_wk(webview, |wk| {
            let _ = unsafe { wk.goForward() };
        })
    }

    fn hard_reload(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_wk(webview, |wk| {
            let _ = unsafe { wk.reloadFromOrigin() };
        })
    }

    fn screenshot_png(
        webview: &tauri::Webview,
        timeout: Duration,
    ) -> Result<Vec<u8>, PreviewPlatformError> {
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
        use objc2_web_kit::WKSnapshotConfiguration;

        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, PreviewPlatformError>>();
        webview
            .with_webview(move |platform| {
                let wk: &WKWebView = unsafe { &*platform.inner().cast() };
                let config = unsafe { WKSnapshotConfiguration::new() };
                let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let outcome = if !error.is_null() {
                        Err(PreviewPlatformError::Js(unsafe {
                            (*error).localizedDescription().to_string()
                        }))
                    } else if image.is_null() {
                        Err(PreviewPlatformError::Unavailable("snapshot returned nil".into()))
                    } else {
                        // NSImage -> TIFF -> NSBitmapImageRep -> PNG bytes
                        let image: &NSImage = unsafe { &*image };
                        unsafe {
                            image
                                .TIFFRepresentation()
                                .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                                .and_then(|rep| {
                                    rep.representationUsingType_properties(
                                        NSBitmapImageFileType::PNG,
                                        &objc2_foundation::NSDictionary::new(),
                                    )
                                })
                                .map(|png| png.to_vec())
                                .ok_or_else(|| {
                                    PreviewPlatformError::Unavailable("png encode failed".into())
                                })
                        }
                    };
                    let _ = tx.send(outcome);
                });
                unsafe {
                    wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler)
                };
            })
            .map_err(|e| PreviewPlatformError::Unavailable(e.to_string()))?;
        rx.recv_timeout(timeout).map_err(|_| PreviewPlatformError::Timeout)?
    }

    fn clear_data(
        webview: &tauri::Webview,
        kinds: ClearDataKinds,
    ) -> Result<(), PreviewPlatformError> {
        use objc2_foundation::NSDate;
        use objc2_web_kit::WKWebsiteDataStore;

        with_wk(webview, move |wk| unsafe {
            let store = wk.configuration().websiteDataStore();
            let mut types: Vec<&'static str> = Vec::new();
            if kinds.cookies {
                types.push("WKWebsiteDataTypeCookies");
            }
            if kinds.cache {
                types.extend(["WKWebsiteDataTypeDiskCache", "WKWebsiteDataTypeMemoryCache"]);
            }
            if kinds.storage {
                types.extend([
                    "WKWebsiteDataTypeLocalStorage",
                    "WKWebsiteDataTypeSessionStorage",
                    "WKWebsiteDataTypeIndexedDBDatabases",
                ]);
            }
            let ns_types = objc2_foundation::NSSet::from_retained_slice(
                &types
                    .iter()
                    .map(|t| NSString::from_str(t))
                    .collect::<Vec<Retained<NSString>>>(),
            );
            let done = RcBlock::new(move || {});
            store.removeDataOfTypes_modifiedSince_completionHandler(
                &ns_types,
                &NSDate::distantPast(),
                &done,
            );
        })
    }
}
```

**Expect to iterate on exact objc2 signatures.** The objc2-web-kit method names above follow its `selectorName_argName` convention but the generated signatures (Option vs non-Option pointers, `Retained` wrappers, feature flags per class) vary between crate versions. The verification loop for this task IS the compiler:

- [ ] **Step 3: Compile until clean**

Run: `pnpm --filter @t4code/desktop typecheck`
Expected: iterate on signature mismatches using `cargo doc -p objc2-web-kit --no-deps --open` (or docs.rs for the resolved version) until `cargo check` is clean. Do not change the trait — only the macOS internals.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(preview): platform ops trait with macOS WKWebView implementation"
```

---

### Task 5: Windows (WebView2) platform ops

**Files:**
- Create: `apps/desktop/src-tauri/src/preview/platform/windows.rs`

**Interfaces:**
- Consumes: `PlatformWebviewOps`, `json_envelope`, `ClearDataKinds`, `PreviewPlatformError` from Task 4.
- Produces: `WindowsWebviewOps` (selected as `Platform` on Windows).

- [ ] **Step 1: Implement**

On Windows, `platform.controller()` returns the `ICoreWebView2Controller`; get `ICoreWebView2` via `.CoreWebView2()`. Key mappings (all inside `webview.with_webview(...)` with the same mpsc/timeout pattern as macOS — copy `with_wk` into a `with_wv2` helper):

```rust
// apps/desktop/src-tauri/src/preview/platform/windows.rs — core mappings
// eval_json: webview2-com ExecuteScriptCompletedHandler; WebView2 already
//   returns the script result as a JSON string, so pass json_envelope(js)
//   and forward the callback's result string verbatim after unwrapping the
//   outer JSON string quoting (ExecuteScript wraps string results in quotes:
//   serde_json::from_str::<String>(&raw) to unquote).
//   core.ExecuteScript(PCWSTR(script_utf16.as_ptr()), &handler)
// title:        core.DocumentTitle(&mut pwstr) -> String
// can_go_back:  core.CanGoBack(&mut BOOL)
// can_go_forward: core.CanGoForward(&mut BOOL)
// go_back / go_forward: core.GoBack() / core.GoForward()
// hard_reload:  no cache-bypass API on ICoreWebView2 -> call
//   eval_json(webview, "location.reload()", …) after clearing cache via
//   profile (see clear_data), or plain core.Reload(); v1: core.Reload().
// screenshot_png: core.CapturePreview(
//     COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
//   with stream = CreateStreamOnHGlobal(HGLOBAL::default(), true); on
//   completion, read the IStream back to Vec<u8> (GetHGlobalFromStream +
//   GlobalLock/GlobalSize/GlobalUnlock).
// clear_data:   cast core to ICoreWebView2_13 -> Profile() ->
//   ICoreWebView2Profile2::ClearBrowsingData(kinds-mapped
//   COREWEBVIEW2_BROWSING_DATA_KINDS bitflags, &handler).
```

Write the full impl following those mappings; each method mirrors the macOS structure (channel + `with_webview` + completion handler). webview2-com provides typed callback handler builders (`ExecuteScriptCompletedHandler::create(Box::new(...))` etc.) — use them rather than hand-rolling COM vtables.

- [ ] **Step 2: Cross-check compile**

This machine is macOS, so `cargo check` skips the file locally. Verify: `cargo check -p t4code-desktop` still clean locally (module is cfg-gated), and rely on Windows CI — or run `cargo check --target x86_64-pc-windows-msvc` if the toolchain target is installed (it likely is, given `scripts/run-msvc-x64.mjs`; if `rustup target list --installed` lacks it, note it in the PR for Windows CI validation instead of blocking).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/preview/platform/windows.rs
git commit -m "feat(preview): WebView2 platform ops"
```

---

### Task 6: Linux (WebKitGTK) platform ops

**Files:**
- Create: `apps/desktop/src-tauri/src/preview/platform/linux.rs`

**Interfaces:**
- Consumes/Produces: same trait; `LinuxWebviewOps`.

- [ ] **Step 1: Implement**

On Linux `platform.inner()` is the `webkit2gtk::WebView`. Mappings (same channel pattern; GTK calls must run on the GTK main thread, which `with_webview` guarantees):

```rust
// apps/desktop/src-tauri/src/preview/platform/linux.rs — core mappings
// eval_json:    webview.evaluate_javascript(&json_envelope(js), None, None,
//               None::<&gio::Cancellable>, callback) -> jsc Value; use
//               value.to_str() (envelope always yields a string).
// title:        webview.title() -> Option<GString>
// can_go_back / can_go_forward: webview.can_go_back() / can_go_forward()
// go_back / go_forward:         webview.go_back() / go_forward()
// hard_reload:  webview.reload_bypass_cache()
// screenshot_png: webview.snapshot(
//     webkit2gtk::SnapshotRegion::Visible,
//     webkit2gtk::SnapshotOptions::NONE, None::<&gio::Cancellable>, callback)
//   -> cairo::Surface; cast to ImageSurface and surface.write_to_png(&mut Vec<u8>).
// clear_data:   webview.website_data_manager() -> WebsiteDataManager::clear(
//     WebsiteDataTypes bitflags mapped from kinds, glib timespan 0, …, callback).
```

Write the full impl. Add `gio` / `glib` to the Linux dependency block if the compiler asks for them explicitly (they're re-exported through webkit2gtk in most versions).

- [ ] **Step 2: Compile check** — cfg-gated; local `cargo check` stays clean. Flag for Linux CI validation in the PR.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/preview/platform/linux.rs
git commit -m "feat(preview): WebKitGTK platform ops"
```

---

### Task 7: Host — child webview lifecycle, nav events, commands, permissions

The heart of Phase 1: create/position/navigate native child webviews and emit `DesktopPreviewTabState`.

**Files:**
- Create: `apps/desktop/src-tauri/src/preview/host.rs`, `apps/desktop/src-tauri/src/preview/commands.rs`, `apps/desktop/src-tauri/permissions/preview.toml`
- Modify: `apps/desktop/src-tauri/src/preview/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `PreviewHostState`/registry (Task 3), `Platform` ops (Tasks 4–6).
- Produces: Tauri commands invoked by Task 8's TS bridge, exact names:
  `desktop_preview_create_tab { tabId }`, `desktop_preview_close_tab { tabId }`,
  `desktop_preview_set_bounds { tabId, bounds: {x,y,width,height}, visible }`,
  `desktop_preview_navigate { tabId, url }`, `desktop_preview_go_back { tabId }`,
  `desktop_preview_go_forward { tabId }`, `desktop_preview_refresh { tabId }`,
  `desktop_preview_hard_reload { tabId }`, `desktop_preview_set_zoom { tabId, factor }`,
  `desktop_preview_open_devtools { tabId }`, `desktop_preview_clear_data { cookies, cache, storage }`,
  `desktop_preview_capture_screenshot { tabId } -> DesktopPreviewScreenshotArtifact`,
  `desktop_preview_reveal_artifact { path }`.
  Event `preview://state` with payload `{ tabId: string, state: DesktopPreviewTabState }` (camelCase serde).

- [ ] **Step 1: Write `host.rs`**

```rust
// apps/desktop/src-tauri/src/preview/host.rs
use std::time::Duration;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use super::platform::{ClearDataKinds, Platform, PlatformWebviewOps, PreviewPlatformError};
use super::{PendingBounds, PreviewHostState};

pub const STATE_EVENT: &str = "preview://state";
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")] // variant names serialize verbatim: "Idle" | "Loading" | "Success" | "LoadFailed"
pub enum NavStatus {
    Idle,
    Loading { url: String, title: String },
    Success { url: String, title: String },
    LoadFailed { url: String, title: String, code: i32, description: String },
}

/// Wire shape of `DesktopPreviewTabState` (packages/contracts/src/ipc.ts:544).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabStatePayload {
    pub tab_id: String,
    pub web_contents_id: Option<i64>, // always None on Tauri
    pub nav_status: NavStatus,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub zoom_factor: f64,
    pub controller: &'static str, // "human" | "agent" | "none" — Phase 1 always "human"
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateEvent {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub state: TabStatePayload,
}

fn now_iso() -> String {
    // chrono is not a dep; std-only RFC3339-ish stamp is fine for updatedAt.
    humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string()
}

pub fn emit_state(app: &AppHandle, tab_id: &str, nav_status: NavStatus) {
    let state = app.state::<PreviewHostState>();
    let (label, zoom) = {
        let registry = state.0.lock().expect("preview registry poisoned");
        match registry.get(tab_id) {
            Some(entry) => (entry.label.clone(), entry.zoom),
            None => return,
        }
    };
    let webview = app.webviews().get(&label).cloned();
    let (can_go_back, can_go_forward) = webview
        .as_ref()
        .map(|wv| {
            (
                Platform::can_go_back(wv).unwrap_or(false),
                Platform::can_go_forward(wv).unwrap_or(false),
            )
        })
        .unwrap_or((false, false));
    let payload = StateEvent {
        tab_id: tab_id.to_string(),
        state: TabStatePayload {
            tab_id: tab_id.to_string(),
            web_contents_id: None,
            nav_status,
            can_go_back,
            can_go_forward,
            zoom_factor: zoom,
            controller: "human",
            updated_at: now_iso(),
        },
    };
    if let Err(error) = app.emit(STATE_EVENT, payload) {
        tracing::warn!("failed to emit preview state: {error}");
    }
}

/// Resolve current title via platform ops, tolerating failures.
fn current_title(app: &AppHandle, label: &str) -> String {
    app.webviews()
        .get(label)
        .and_then(|wv| Platform::title(wv).ok())
        .unwrap_or_default()
}

pub fn create_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    let (label, bounds, already_created) = {
        let mut registry = state.0.lock().map_err(|e| e.to_string())?;
        let entry = registry.upsert_pending(tab_id);
        (entry.label.clone(), entry.bounds, entry.created)
    };
    if already_created {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .or_else(|| app.get_webview_window("main").map(|w| w.as_ref().window().clone()))
        .ok_or_else(|| "main window not found".to_string())?;

    let app_for_events = app.clone();
    let tab_for_events = tab_id.to_string();
    let label_for_events = label.clone();
    let mut builder = tauri::webview::WebviewBuilder::new(
        &label,
        WebviewUrl::External(Url::parse("about:blank").map_err(|e| e.to_string())?),
    )
    .on_page_load(move |_webview, payload| {
        let url = payload.url().to_string();
        let title = current_title(&app_for_events, &label_for_events);
        let nav = match payload.event() {
            PageLoadEvent::Started => NavStatus::Loading { url, title },
            PageLoadEvent::Finished => NavStatus::Success { url, title },
        };
        emit_state(&app_for_events, &tab_for_events, nav);
    });

    // Isolated persistent profile, never the app/session default.
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(*b"t4codepreview001");
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            builder = builder.data_directory(dir.join("preview-profile"));
        }
    }

    let pending = bounds.unwrap_or(PendingBounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(pending.x, pending.y),
            LogicalSize::new(pending.width, pending.height),
        )
        .map_err(|e| e.to_string())?;
    // Hidden until the renderer presents a visible rect.
    let _ = webview.hide();

    let mut registry = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = registry.get_mut(tab_id) {
        entry.created = true;
    }
    Ok(())
}

pub fn with_tab_webview<T>(
    app: &AppHandle,
    tab_id: &str,
    f: impl FnOnce(&tauri::Webview) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<PreviewHostState>();
    let label = {
        let registry = state.0.lock().map_err(|e| e.to_string())?;
        registry
            .get(tab_id)
            .filter(|entry| entry.created)
            .map(|entry| entry.label.clone())
            .ok_or_else(|| format!("preview tab {tab_id} does not exist"))?
    };
    let webviews = app.webviews();
    let webview = webviews
        .get(&label)
        .ok_or_else(|| format!("preview webview {label} not found"))?;
    f(webview)
}

pub fn platform_err(error: PreviewPlatformError) -> String {
    error.to_string()
}

pub fn set_bounds(
    app: &AppHandle,
    tab_id: &str,
    bounds: PendingBounds,
    visible: bool,
) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    let (label, created) = {
        let mut registry = state.0.lock().map_err(|e| e.to_string())?;
        let entry = registry.upsert_pending(tab_id);
        entry.bounds = Some(bounds);
        entry.visible = visible;
        (entry.label.clone(), entry.created)
    };
    if !created {
        return Ok(()); // applied at creation
    }
    let webviews = app.webviews();
    let webview = webviews
        .get(&label)
        .ok_or_else(|| format!("preview webview {label} not found"))?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|e| e.to_string())?;
    if visible { webview.show().map_err(|e| e.to_string())? } else { webview.hide().map_err(|e| e.to_string())? }
    Ok(())
}

pub fn close_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    let entry = {
        let mut registry = state.0.lock().map_err(|e| e.to_string())?;
        registry.remove(tab_id)
    };
    if let Some(entry) = entry {
        if entry.created {
            if let Some(webview) = app.webviews().get(&entry.label) {
                let _ = webview.close();
            }
        }
    }
    Ok(())
}
```

Notes for the implementer:
- `humantime` — add `humantime = "2"` to desktop `[dependencies]` (or use the crate the codebase already stamps timestamps with — grep `updated_at`/`created_at` in `apps/desktop/src-tauri/src` first and reuse that; if nothing exists, `humantime` is the lightest).
- If `app.get_window("main")` compiles on 2.11.5 (it does with `unstable`), drop the `get_webview_window` fallback line.
- `data_store_identifier` takes `[u8; 16]` — the literal above is exactly 16 bytes (`t4codepreview001`).

- [ ] **Step 2: Write `commands.rs`**

```rust
// apps/desktop/src-tauri/src/preview/commands.rs
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

use super::host;
use super::platform::{ClearDataKinds, Platform, PlatformWebviewOps};
use super::{PendingBounds, PreviewHostState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotArtifact {
    pub id: String,
    pub tab_id: String,
    pub path: String,
    pub mime_type: &'static str,
    pub size_bytes: u64,
    pub created_at: String,
}

#[tauri::command]
pub fn desktop_preview_create_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::create_tab(&app, &tab_id)
}

#[tauri::command]
pub fn desktop_preview_close_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::close_tab(&app, &tab_id)
}

#[tauri::command]
pub fn desktop_preview_set_bounds(
    app: AppHandle,
    tab_id: String,
    bounds: BoundsInput,
    visible: bool,
) -> Result<(), String> {
    host::set_bounds(
        &app,
        &tab_id,
        PendingBounds { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        visible,
    )
}

#[tauri::command]
pub fn desktop_preview_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http(s) urls can be previewed".to_string());
    }
    host::with_tab_webview(&app, &tab_id, |webview| {
        webview.navigate(parsed).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn desktop_preview_go_back(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::with_tab_webview(&app, &tab_id, |wv| Platform::go_back(wv).map_err(host::platform_err))
}

#[tauri::command]
pub fn desktop_preview_go_forward(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::with_tab_webview(&app, &tab_id, |wv| Platform::go_forward(wv).map_err(host::platform_err))
}

#[tauri::command]
pub fn desktop_preview_refresh(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::with_tab_webview(&app, &tab_id, |wv| wv.reload().map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn desktop_preview_hard_reload(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::with_tab_webview(&app, &tab_id, |wv| Platform::hard_reload(wv).map_err(host::platform_err))
}

#[tauri::command]
pub fn desktop_preview_set_zoom(app: AppHandle, tab_id: String, factor: f64) -> Result<(), String> {
    let state = app.state::<PreviewHostState>();
    {
        let mut registry = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = registry.get_mut(&tab_id) {
            entry.zoom = factor;
        }
    }
    host::with_tab_webview(&app, &tab_id, |wv| wv.set_zoom(factor).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn desktop_preview_open_devtools(app: AppHandle, tab_id: String) -> Result<(), String> {
    host::with_tab_webview(&app, &tab_id, |wv| {
        wv.open_devtools();
        Ok(())
    })
}

#[tauri::command]
pub fn desktop_preview_clear_data(
    app: AppHandle,
    cookies: bool,
    cache: bool,
    storage: bool,
) -> Result<(), String> {
    // All preview tabs share one profile, so clearing through any live
    // preview webview clears for all of them.
    for (label, webview) in app.webviews() {
        if label.starts_with("preview-") {
            return Platform::clear_data(&webview, ClearDataKinds { cookies, cache, storage })
                .map_err(host::platform_err);
        }
    }
    Err("no live preview webview to clear data through".to_string())
}

#[tauri::command]
pub fn desktop_preview_capture_screenshot(
    app: AppHandle,
    tab_id: String,
) -> Result<ScreenshotArtifact, String> {
    let png = host::with_tab_webview(&app, &tab_id, |wv| {
        Platform::screenshot_png(wv, Duration::from_secs(15)).map_err(host::platform_err)
    })?;
    let id = format!("shot-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis());
    let dir = crate::config::state_dir(&app)
        .map_err(|e| e.to_string())?
        .join("preview-artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.png"));
    std::fs::write(&path, &png).map_err(|e| e.to_string())?;
    Ok(ScreenshotArtifact {
        id,
        tab_id,
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png",
        size_bytes: png.len() as u64,
        created_at: humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string(),
    })
}

#[tauri::command]
pub fn desktop_preview_reveal_artifact(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}
```

Check `crate::config::state_dir`'s exact signature in `config.rs` and match it (it may take `&AppHandle` or an `App`; adjust the call).

- [ ] **Step 3: Register commands + permissions**

`preview/mod.rs`: add `pub mod commands; pub mod host; pub mod platform;`.

`lib.rs`: mirror the existing macro pattern — add below `desktop_bridge_commands!`:

```rust
macro_rules! desktop_preview_commands {
    ($with_commands:ident) => {
        $with_commands![
            desktop_preview_create_tab,
            desktop_preview_close_tab,
            desktop_preview_set_bounds,
            desktop_preview_navigate,
            desktop_preview_go_back,
            desktop_preview_go_forward,
            desktop_preview_refresh,
            desktop_preview_hard_reload,
            desktop_preview_set_zoom,
            desktop_preview_open_devtools,
            desktop_preview_clear_data,
            desktop_preview_capture_screenshot,
            desktop_preview_reveal_artifact,
        ]
    };
}
```

The `invoke_handler` accepts exactly one `generate_handler!` call, so both command lists must land in a single invocation. Do it explicitly — replace `.invoke_handler(desktop_bridge_commands!(bridge_invoke_handler))` with one `generate_handler!` listing every existing `bridge::desktop_bridge_*` command (copy them from the `desktop_bridge_commands!` list, prefixed `bridge::`) followed by the new preview commands:

```rust
.invoke_handler(tauri::generate_handler![
    // every existing bridge::desktop_bridge_* command, unchanged, then:
    preview::commands::desktop_preview_create_tab,
    preview::commands::desktop_preview_close_tab,
    preview::commands::desktop_preview_set_bounds,
    preview::commands::desktop_preview_navigate,
    preview::commands::desktop_preview_go_back,
    preview::commands::desktop_preview_go_forward,
    preview::commands::desktop_preview_refresh,
    preview::commands::desktop_preview_hard_reload,
    preview::commands::desktop_preview_set_zoom,
    preview::commands::desktop_preview_open_devtools,
    preview::commands::desktop_preview_clear_data,
    preview::commands::desktop_preview_capture_screenshot,
    preview::commands::desktop_preview_reveal_artifact,
])
```

Keep the `desktop_bridge_commands!`/`bridge_command_names!` test macros working — add a parallel `DESKTOP_PREVIEW_COMMAND_NAMES` list for the permission test.

`permissions/preview.toml`:

```toml
[[permission]]
identifier = "allow-desktop-preview"
description = "Allows the renderer to drive native preview webviews."
commands.allow = [
    "desktop_preview_create_tab",
    "desktop_preview_close_tab",
    "desktop_preview_set_bounds",
    "desktop_preview_navigate",
    "desktop_preview_go_back",
    "desktop_preview_go_forward",
    "desktop_preview_refresh",
    "desktop_preview_hard_reload",
    "desktop_preview_set_zoom",
    "desktop_preview_open_devtools",
    "desktop_preview_clear_data",
    "desktop_preview_capture_screenshot",
    "desktop_preview_reveal_artifact",
]
```

(Match `desktop-bridge.toml`'s exact TOML style — check whether it uses `[[permission]]` array-of-tables and `commands.allow`; copy that structure.)

`capabilities/default.json`: `"permissions": ["allow-desktop-bridge", "allow-desktop-preview", "core:default"]`.

- [ ] **Step 4: Write the permission consistency test**

In `lib.rs` `mod tests`, clone the existing `desktop_bridge_permission_allows_registered_commands` test as `desktop_preview_permission_allows_registered_commands`, pointing at `include_str!("../permissions/preview.toml")`, identifier `allow-desktop-preview`, and `DESKTOP_PREVIEW_COMMAND_NAMES`.

- [ ] **Step 5: Compile + test**

Run: `pnpm --filter @t4code/desktop typecheck && pnpm --filter @t4code/desktop test`
Expected: clean check; registry tests + both permission tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(preview): native child-webview host with nav events and commands"
```

---

### Task 8: Renderer — `tauriPreviewBridge.ts`

**Files:**
- Create: `apps/web/src/tauriPreviewBridge.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts` (add `preview` to the object returned by `createTauriDesktopBridge()`)
- Test: `apps/web/src/tauriPreviewBridge.test.ts`

**Interfaces:**
- Consumes: Task 7 command names/payloads; Task 1 contract (`DesktopPreviewBridge`, `DesktopPreviewBounds`).
- Produces: `createTauriPreviewBridge(deps: { invoke, listen }): DesktopPreviewBridge` — dependency-injected so tests pass fakes; `tauriDesktopBridge.ts` wires the real `tauriInvoke`/`tauriListen`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/tauriPreviewBridge.test.ts
import { describe, expect, it, vi } from "vitest";

import { createTauriPreviewBridge } from "./tauriPreviewBridge";

function makeBridge() {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, (payload: unknown) => void>();
  const listen = vi.fn((event: string, cb: (payload: unknown) => void) => {
    listeners.set(event, cb);
    return () => listeners.delete(event);
  });
  return { bridge: createTauriPreviewBridge({ invoke, listen }), invoke, listeners };
}

describe("tauriPreviewBridge", () => {
  it("maps createTab/navigate/setBounds to desktop_preview commands", async () => {
    const { bridge, invoke } = makeBridge();
    await bridge.createTab("t1");
    await bridge.navigate("t1", "https://example.com");
    await bridge.setBounds("t1", { x: 1, y: 2, width: 3, height: 4 }, true);
    expect(invoke).toHaveBeenCalledWith("desktop_preview_create_tab", { tabId: "t1" });
    expect(invoke).toHaveBeenCalledWith("desktop_preview_navigate", {
      tabId: "t1",
      url: "https://example.com",
    });
    expect(invoke).toHaveBeenCalledWith("desktop_preview_set_bounds", {
      tabId: "t1",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      visible: true,
    });
  });

  it("fans preview://state events out to onStateChange listeners", () => {
    const { bridge, listeners } = makeBridge();
    const seen: Array<{ tabId: string; url: string }> = [];
    bridge.onStateChange((tabId, state) => {
      if (state.navStatus.kind !== "Idle") seen.push({ tabId, url: state.navStatus.url });
    });
    listeners.get("preview://state")?.({
      tabId: "t1",
      state: {
        tabId: "t1",
        webContentsId: null,
        navStatus: { kind: "Success", url: "https://example.com/", title: "Example" },
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        controller: "human",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    expect(seen).toEqual([{ tabId: "t1", url: "https://example.com/" }]);
  });

  it("rejects Phase-2 surfaces with capability-unsupported errors", async () => {
    const { bridge } = makeBridge();
    await expect(bridge.automation.snapshot("t1")).rejects.toThrow(/not.*supported|capability/i);
    await expect(bridge.pickElement("t1")).rejects.toThrow(/not.*supported|capability/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @t4code/web test -- tauriPreviewBridge`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/tauriPreviewBridge.ts
import type {
  DesktopPreviewBounds,
  DesktopPreviewBridge,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabState,
} from "@t4code/contracts";

interface PreviewBridgeDeps {
  readonly invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  readonly listen: <T>(event: string, listener: (payload: T) => void) => () => void;
}

interface PreviewStateEventPayload {
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
}

class PreviewCapabilityUnsupportedError extends Error {
  readonly code = "tauri_capability_unsupported";
  constructor(capability: string) {
    super(`preview capability not supported yet on this host: ${capability}`);
  }
}

const unsupported = (capability: string) => () =>
  Promise.reject(new PreviewCapabilityUnsupportedError(capability));

export function createTauriPreviewBridge(deps: PreviewBridgeDeps): DesktopPreviewBridge {
  const { invoke, listen } = deps;
  return {
    createTab: (tabId) => invoke("desktop_preview_create_tab", { tabId }),
    closeTab: (tabId) => invoke("desktop_preview_close_tab", { tabId }),
    setBounds: (tabId, bounds: DesktopPreviewBounds, visible) =>
      invoke("desktop_preview_set_bounds", { tabId, bounds, visible }),
    navigate: (tabId, url) => invoke("desktop_preview_navigate", { tabId, url }),
    goBack: (tabId) => invoke("desktop_preview_go_back", { tabId }),
    goForward: (tabId) => invoke("desktop_preview_go_forward", { tabId }),
    refresh: (tabId) => invoke("desktop_preview_refresh", { tabId }),
    hardReload: (tabId) => invoke("desktop_preview_hard_reload", { tabId }),
    zoomIn: (tabId) => adjustZoom(invoke, tabId, +0.1),
    zoomOut: (tabId) => adjustZoom(invoke, tabId, -0.1),
    resetZoom: (tabId) => setZoom(invoke, tabId, 1),
    openDevTools: (tabId) => invoke("desktop_preview_open_devtools", { tabId }),
    clearCookies: () =>
      invoke("desktop_preview_clear_data", { cookies: true, cache: false, storage: true }),
    clearCache: () =>
      invoke("desktop_preview_clear_data", { cookies: false, cache: true, storage: false }),
    setAnnotationTheme: () => Promise.resolve(), // Phase 4
    pickElement: unsupported("preview.pickElement"),
    cancelPickElement: () => Promise.resolve(),
    captureScreenshot: (tabId) =>
      invoke<DesktopPreviewScreenshotArtifact>("desktop_preview_capture_screenshot", { tabId }),
    revealArtifact: (path) => invoke("desktop_preview_reveal_artifact", { path }),
    copyArtifactToClipboard: unsupported("preview.copyArtifactToClipboard"),
    recording: {
      startScreencast: unsupported("preview.recording"),
      stopScreencast: unsupported("preview.recording"),
      save: unsupported("preview.recording"),
      onFrame: () => () => {},
    },
    automation: {
      status: unsupported("preview.automation"),
      snapshot: unsupported("preview.automation"),
      click: unsupported("preview.automation"),
      type: unsupported("preview.automation"),
      press: unsupported("preview.automation"),
      scroll: unsupported("preview.automation"),
      evaluate: unsupported("preview.automation"),
      waitFor: unsupported("preview.automation"),
    },
    onStateChange: (listener) =>
      listen<PreviewStateEventPayload>("preview://state", (payload) =>
        listener(payload.tabId, payload.state),
      ),
    onPointerEvent: () => () => {}, // Phase 2 (agent cursor)
  };
}

// Zoom factor lives host-side; renderer tracks per-tab factor for the +/- affordances.
const zoomByTab = new Map<string, number>();

function setZoom(
  invoke: PreviewBridgeDeps["invoke"],
  tabId: string,
  factor: number,
): Promise<void> {
  const clamped = Math.min(3, Math.max(0.25, factor));
  zoomByTab.set(tabId, clamped);
  return invoke("desktop_preview_set_zoom", { tabId, factor: clamped });
}

function adjustZoom(
  invoke: PreviewBridgeDeps["invoke"],
  tabId: string,
  delta: number,
): Promise<void> {
  return setZoom(invoke, tabId, (zoomByTab.get(tabId) ?? 1) + delta);
}
```

Check the exact member list of `DesktopPreviewBridge` against `ipc.ts` after Task 1 — every non-optional member must be present here (TypeScript enforces it; the compiler is the checklist). If `TauriDesktopCapabilityUnsupportedError` from `tauriDesktopBridge.ts` is exported, reuse it instead of the local `PreviewCapabilityUnsupportedError` class.

In `apps/web/src/tauriDesktopBridge.ts`, inside `createTauriDesktopBridge()`'s returned object, add:

```ts
    preview: createTauriPreviewBridge({
      invoke: tauriInvoke,
      listen: tauriListen,
    }),
```

with the import at the top: `import { createTauriPreviewBridge } from "./tauriPreviewBridge";`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4code/web test -- tauriPreviewBridge && pnpm --filter @t4code/web typecheck`
Expected: 3 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/tauriPreviewBridge.ts apps/web/src/tauriPreviewBridge.test.ts apps/web/src/tauriDesktopBridge.ts
git commit -m "feat(web): tauri preview bridge lights up isPreviewSupportedInRuntime"
```

---

### Task 9: Renderer — surface-rect sync to the host

`BrowserSurfaceSlot` already measures panel rects into `browserSurfaceStore`; forward them to `setBounds`.

**Files:**
- Create: `apps/web/src/browser/browserSurfaceSync.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts` (start sync after bridge install, line ~504)
- Test: `apps/web/src/browser/browserSurfaceSync.test.ts`

**Interfaces:**
- Consumes: `useBrowserSurfaceStore` (zustand, `apps/web/src/browser/browserSurfaceStore.ts:73`), `DesktopPreviewBridge.setBounds` (Task 1/8).
- Produces: `startBrowserSurfaceSync(bridge: Pick<DesktopPreviewBridge, "setBounds">): () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/browser/browserSurfaceSync.test.ts
import { describe, expect, it, vi } from "vitest";

import { startBrowserSurfaceSync } from "./browserSurfaceSync";
import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

describe("browserSurfaceSync", () => {
  it("forwards presented rects to setBounds and dedupes identical updates", () => {
    const setBounds = vi.fn().mockResolvedValue(undefined);
    const stop = startBrowserSurfaceSync({ setBounds });

    const lease = acquireBrowserSurface("sync-t1");
    lease.present({ x: 10, y: 20, width: 300, height: 400 }, true);
    lease.present({ x: 10, y: 20, width: 300, height: 400 }, true); // no-op (store dedupes)
    lease.present({ x: 10, y: 20, width: 300, height: 401 }, true);
    lease.release(); // visible -> false

    expect(setBounds.mock.calls).toEqual([
      ["sync-t1", { x: 10, y: 20, width: 300, height: 400 }, true],
      ["sync-t1", { x: 10, y: 20, width: 300, height: 401 }, true],
      ["sync-t1", { x: 10, y: 20, width: 300, height: 401 }, false],
    ]);
    stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @t4code/web test -- browserSurfaceSync`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/browser/browserSurfaceSync.ts
import type { DesktopPreviewBridge } from "@t4code/contracts";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";

interface SyncedPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

/**
 * Streams `browserSurfaceStore` rects to the native preview host so each
 * tab's child webview tracks the right-panel slot. Started once when the
 * Tauri preview bridge installs; safe to call `stop()` in tests.
 */
export function startBrowserSurfaceSync(
  bridge: Pick<DesktopPreviewBridge, "setBounds">,
): () => void {
  const synced = new Map<string, SyncedPresentation>();

  const push = (byTabId: ReturnType<typeof useBrowserSurfaceStore.getState>["byTabId"]) => {
    for (const [tabId, presentation] of Object.entries(byTabId)) {
      if (!presentation.rect) continue;
      const next: SyncedPresentation = {
        x: presentation.rect.x,
        y: presentation.rect.y,
        width: presentation.rect.width,
        height: presentation.rect.height,
        visible: presentation.visible,
      };
      const previous = synced.get(tabId);
      if (
        previous &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height &&
        previous.visible === next.visible
      ) {
        continue;
      }
      synced.set(tabId, next);
      void bridge.setBounds(
        tabId,
        { x: next.x, y: next.y, width: next.width, height: next.height },
        next.visible,
      );
    }
  };

  push(useBrowserSurfaceStore.getState().byTabId);
  return useBrowserSurfaceStore.subscribe((state) => push(state.byTabId));
}
```

In `tauriDesktopBridge.ts`, after `window.desktopBridge = createTauriDesktopBridge();` (line ~505):

```ts
if (isTauriDesktopRuntime && window.desktopBridge === undefined) {
  window.desktopBridge = createTauriDesktopBridge();
  const preview = window.desktopBridge.preview;
  if (preview) startBrowserSurfaceSync(preview);
}
```

(import `startBrowserSurfaceSync` from `./browser/browserSurfaceSync` — verify the relative path from `apps/web/src/tauriDesktopBridge.ts` is `./browser/browserSurfaceSync`.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @t4code/web test -- browserSurfaceSync && pnpm --filter @t4code/web typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/browser/browserSurfaceSync.ts apps/web/src/browser/browserSurfaceSync.test.ts apps/web/src/tauriDesktopBridge.ts
git commit -m "feat(web): sync browser surface rects to native preview host"
```

---

### Task 10: Full-suite verification + live manual test

**Files:** none new — verification only.

- [ ] **Step 1: Run every affected suite**

Run:
```bash
pnpm --filter @t4code/contracts test && \
pnpm --filter @t4code/web test && \
pnpm --filter @t4code/desktop test && \
pnpm --filter @t4code/web typecheck && \
pnpm --filter @t4code/desktop typecheck
```
Expected: all PASS/clean. Fix anything that broke (notably `PreviewView.test.tsx` / `RightPanelTabs` tests that assert the Browser card is disabled — those assertions run in jsdom where `window.desktopBridge` is undefined, so they should still pass; if any test mocks the bridge WITH `preview`, update its expectations to enabled).

- [ ] **Step 2: Manual smoke test on macOS (the checklist)**

Run: `pnpm dev:desktop`

1. Open a project thread → right panel → "Open a surface": **Browser card is enabled** (not grayed).
2. Open Browser; type `example.com` in the URL bar → page renders inside the panel.
3. Navigate to a second page → Back enables and works; Forward works.
4. Zoom in/out/reset from the chrome row; hard reload; refresh.
5. Take screenshot → PNG artifact lands under the app state dir `preview-artifacts/`; reveal works.
6. Switch right-panel tab to Terminal and back → webview hides/shows and stays aligned; resize the panel → webview tracks the rect (no lag > one frame, no overlap over chat).
7. Log into any site in the preview, then check your system browser: session is NOT shared (isolated profile). Restart the app: preview cookies persisted.
8. DevTools button opens the platform inspector.
9. Open two browser tabs in the right panel; both keep independent nav state.

Record any failures as fix-up commits within this task.

- [ ] **Step 3: Update dormant-feature docs**

Edit `docs/architecture/overview.md` preview section: note the preview host is now implemented natively on Tauri (child webviews + `desktop_preview_*` commands), and `window.desktopBridge.preview` is present on desktop builds. Keep it to a short paragraph in the existing style.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(preview): phase 1 verification fixes and architecture doc update"
```

---

## Deviations & risks the implementer must know

- **`preview://tab-crashed` is not emitted in Phase 1.** wry exposes no cross-platform render-process-death event. The spec's tab error state ships with Phase 2's watchdog (a failed `eval_json` heartbeat against a live tab is the crash signal). Documented gap, same rationale as `LoadFailed` below.
- **`LoadFailed` is not emitted in Phase 1.** wry's page-load hooks expose Started/Finished only; provisional navigation failures (DNS fail, refused connection) show the platform error page without a Finished event. The chrome row's unreachable state still works when the server reports failures. A watchdog/probe lands in Phase 2 alongside the injected agent (which can detect error pages). This is a deliberate, documented gap — do not block Phase 1 on it.
- **objc2/webview2-com/webkit2gtk API surfaces move.** The trait is the stable boundary; platform internals are expected to need signature adjustments against the resolved crate versions. Compile-driven iteration there is normal, not scope creep.
- **Coordinate space assumption:** child-webview logical coordinates are relative to the window's client area, which the full-window main webview's `getBoundingClientRect` matches 1:1. If the manual test shows a constant Y offset on some platform (title-bar inset), apply the correction in `browserSurfaceSync.ts` (subtract `window.outerHeight - window.innerHeight` style probe) — renderer-side, one place.
- **`registerWebview`/`getPreviewConfig` stay in the contract as optional** so the dormant Electron-era renderer paths keep typechecking; they are never called when `setBounds` drives a native host.
- **Recording, automation, element pick remain stubbed** (capability-unsupported rejections). UI affordances that call them exist behind flows that Phase 1 doesn't enable; if the manual test surfaces a visible button that hard-fails (e.g. record), hide it behind `Boolean(previewBridge?.recording)`-style guards as a fix-up in Task 10.

## Phase boundary

Done means: Browser surface enabled, manual browsing on macOS verified (Windows/Linux compile + CI), isolated profile, screenshots, all suites green. Phase 2 (automation agent + MCP executor rewiring), Phase 3 (URL routing), and Phase 4 (design mode) get their own plans once this lands.
