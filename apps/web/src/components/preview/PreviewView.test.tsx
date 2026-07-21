/**
 * Behaviour tests for PreviewView.
 *
 * Rendered once per scenario with `renderToStaticMarkup`; the stateful React
 * hooks are instrumented (useState/useEffect replaced) so effects can be run
 * manually and setState calls recorded. Heavy children (chrome row, empty
 * state, more menu, overlays) are capture-mocked so their recorded handler
 * props (onSubmit / onCapture / onPickElement / onToggleDeviceToolbar …) can be
 * invoked directly to exercise the component's callback bodies without a DOM.
 * The toast + clipboard flows inside handleCapture are driven through the
 * recorded toast objects (stackedThreadToast returns its argument).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import { EnvironmentId, ThreadId } from "@t4code/contracts";

const h = vi.hoisted(() => {
  const state = {
    // react instrumentation
    stateCalls: [] as Array<{ initial: unknown }>,
    setStateCalls: [] as Array<{ next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    // captured child props
    captures: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    // data
    previewState: {} as Record<string, unknown>,
    environment: null as unknown,
    httpBaseUrl: null as string | null,
    displayUrl: "display.local" as string | null,
    loadProgress: 0 as number,
    activeRecordingTabId: null as string | null,
    showEmptyState: false,
    panelRect: null as unknown,
    resolvedUrl: "http://resolved.local/" as string,
    responsiveSize: { width: 800, height: 600 },
    // command results
    commandCalls: [] as Array<{ label: string; input: unknown }>,
    resizeResult: { _tag: "Success", value: { viewport: { _tag: "fill" } } } as Record<
      string,
      unknown
    >,
    // preview bridge
    previewBridge: null as unknown,
    bridgeCalls: [] as Array<{ method: string; args: unknown[] }>,
    pickAnnotation: null as unknown,
    screenshotArtifact: { path: "/shot.png" } as unknown,
    screenshotRejects: false,
    copyArtifactRejects: false,
    // module collaborators
    desktopNavigateCalls: [] as Array<[string, string]>,
    desktopNavigateRejects: false,
    openPreviewSessionCalls: [] as unknown[],
    rememberPreviewUrlCalls: [] as unknown[],
    updateSnapshotCalls: [] as unknown[],
    commitViewportCalls: [] as unknown[],
    startRecordingCalls: [] as string[],
    startRecordingRejects: false,
    stopRecordingResult: { path: "/rec.webm" } as unknown,
    stopRecordingRejects: false,
    addPreviewAnnotationCalls: [] as unknown[],
    addImageCalls: [] as unknown[],
    screenshotFile: null as unknown,
    // bus subscriptions
    previewActionSubscribers: [] as Array<(action: string) => void>,
    viewportChangeSubscriptions: [] as Array<{ tabId: string; cb: (v: unknown) => Promise<void> }>,
    // toasts + clipboard
    toasts: [] as Array<{ id: number; toast: Record<string, unknown> }>,
    toastUpdates: [] as Array<{ id: number; toast: Record<string, unknown> }>,
    nextToastId: 1,
    clipboardAvailable: true,
    clipboardWriteRejects: false,
    clipboardWriteCalls: [] as string[],
    localApi: null as unknown,
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    h.stateCalls.push({ initial: resolved });
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(resolved) : next;
      h.setStateCalls.push({ next, applied });
    };
    return [resolved, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
  };
});

const capture = (kind: string, props: Record<string, unknown>) => {
  h.captures.push({ kind, props });
};

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error?: unknown }) =>
    result.error ?? new Error("squashed failure"),
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      addPreviewAnnotation: (...args: unknown[]) => h.addPreviewAnnotationCalls.push(args),
      addImage: (...args: unknown[]) => h.addImageCalls.push(args),
    }),
}));

vi.mock("~/lib/previewAnnotation", () => ({
  previewAnnotationScreenshotFile: () => Promise.resolve(h.screenshotFile),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => h.localApi,
}));

vi.mock("~/previewStateStore", () => ({
  rememberPreviewUrl: (...args: unknown[]) => h.rememberPreviewUrlCalls.push(args),
  updatePreviewServerSnapshot: (...args: unknown[]) => h.updateSnapshotCalls.push(args),
  useThreadPreviewState: () => h.previewState,
}));

vi.mock("~/browser/browserTargetResolver", () => ({
  resolveDiscoveredServerUrl: () => h.resolvedUrl,
}));

vi.mock("~/browser/desktopTabLifetime", () => ({
  navigateDesktopTab: (tabId: string, url: string) => {
    h.desktopNavigateCalls.push([tabId, url]);
    return h.desktopNavigateRejects
      ? Promise.reject(new Error("nav boom"))
      : Promise.resolve(undefined);
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => h.environment,
  useEnvironmentHttpBaseUrl: () => h.httpBaseUrl,
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    open: { label: "open" },
    resize: { label: "resize" },
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string } | null | undefined) => {
    const label = command && typeof command.label === "string" ? command.label : "unknown";
    return (input: unknown) => {
      h.commandCalls.push({ label, input });
      if (label === "resize") return Promise.resolve(h.resizeResult);
      return Promise.resolve({ _tag: "Success", value: undefined });
    };
  },
}));

vi.mock("./previewBridge", () => ({
  get previewBridge() {
    return h.previewBridge;
  },
}));

vi.mock("./previewActionBus", () => ({
  subscribePreviewAction: (cb: (action: string) => void) => {
    h.previewActionSubscribers.push(cb);
    return () => {
      const idx = h.previewActionSubscribers.indexOf(cb);
      if (idx >= 0) h.previewActionSubscribers.splice(idx, 1);
    };
  },
}));

vi.mock("./openPreviewSession", () => ({
  openPreviewSession: (input: unknown) => {
    h.openPreviewSessionCalls.push(input);
    return Promise.resolve();
  },
}));

vi.mock("./PreviewChromeRow", () => ({
  PreviewChromeRow: (props: Record<string, unknown>) => {
    capture("chromeRow", props);
    return <div data-mock="chrome-row" />;
  },
}));

vi.mock("./previewUrlPresentation", () => ({
  formatPreviewUrl: () => h.displayUrl,
}));

vi.mock("./PreviewEmptyState", () => ({
  PreviewEmptyState: (props: Record<string, unknown>) => {
    capture("emptyState", props);
    return <div data-mock="empty-state" />;
  },
}));

vi.mock("./PreviewMoreMenu", () => ({
  PreviewMoreMenu: (props: Record<string, unknown>) => {
    capture("moreMenu", props);
    return <div data-mock="more-menu" />;
  },
}));

vi.mock("~/browser/browserViewportActions", () => ({
  commitBrowserViewportChange: (...args: unknown[]) => {
    h.commitViewportCalls.push(args);
    return Promise.resolve();
  },
  subscribeBrowserViewportChange: (tabId: string, cb: (v: unknown) => Promise<void>) => {
    h.viewportChangeSubscriptions.push({ tabId, cb });
    return () => undefined;
  },
}));

vi.mock("~/browser/browserViewportLayout", () => ({
  resolveResponsiveBrowserViewportSize: () => h.responsiveSize,
}));

vi.mock("./PreviewUnreachable", () => ({
  PreviewUnreachable: (props: Record<string, unknown>) => {
    capture("unreachable", props);
    return <div data-mock="unreachable" />;
  },
}));

vi.mock("./fileExplorerLabel", () => ({
  revealInFileExplorerLabel: () => "Reveal in Finder",
}));

vi.mock("./previewEmptyStateLogic", () => ({
  shouldShowPreviewEmptyState: () => h.showEmptyState,
}));

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: (props: Record<string, unknown>) => {
    capture("surfaceSlot", props);
    return <div data-mock="surface-slot" />;
  },
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ byTabId: h.panelRect === null ? {} : { "tab-1": { rect: h.panelRect } } }),
}));

vi.mock("./useLoadingProgress", () => ({
  useLoadingProgress: () => h.loadProgress,
}));

vi.mock("./usePreviewSession", () => ({
  usePreviewSession: () => undefined,
}));

vi.mock("./ZoomIndicator", () => ({
  ZoomIndicator: (props: Record<string, unknown>) => {
    capture("zoomIndicator", props);
    return <div data-mock="zoom-indicator" />;
  },
}));

vi.mock("./AgentBrowserCursor", () => ({
  AgentBrowserCursor: (props: Record<string, unknown>) => {
    capture("agentCursor", props);
    return <div data-mock="agent-cursor" />;
  },
}));

vi.mock("~/browser/browserRecording", () => ({
  startBrowserRecording: (tabId: string) => {
    h.startRecordingCalls.push(tabId);
    return h.startRecordingRejects
      ? Promise.reject(new Error("start boom"))
      : Promise.resolve("started");
  },
  stopBrowserRecording: () =>
    h.stopRecordingRejects
      ? Promise.reject(new Error("stop boom"))
      : Promise.resolve(h.stopRecordingResult),
  useActiveBrowserRecordingTabId: () => h.activeRecordingTabId,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: (toast: Record<string, unknown>) => {
      const id = h.nextToastId++;
      h.toasts.push({ id, toast });
      return id;
    },
    update: (id: number, toast: Record<string, unknown>) => {
      h.toastUpdates.push({ id, toast });
    },
  },
  stackedThreadToast: (toast: Record<string, unknown>) => toast,
}));

import { PreviewView } from "./PreviewView";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadRef = { environmentId, threadId };

type ViewProps = Parameters<typeof PreviewView>[0];

function baseProps(overrides: Partial<ViewProps> = {}): ViewProps {
  // Omit optional keys so exactOptionalPropertyTypes stays happy; callers add
  // them through `overrides` when a scenario needs them.
  return {
    threadRef,
    visible: true,
    ...overrides,
  };
}

function renderView(props: ViewProps = baseProps()): string {
  h.captures.length = 0;
  h.stateCalls.length = 0;
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  h.previewActionSubscribers.length = 0;
  h.viewportChangeSubscriptions.length = 0;
  return renderToStaticMarkup(<PreviewView {...props} />);
}

function captured<T = Record<string, unknown>>(kind: string): T {
  const entry = [...h.captures].toReversed().find((c) => c.kind === kind);
  expect(entry, `expected captured props for ${kind}`).toBeDefined();
  return entry!.props as T;
}

function hasCapture(kind: string): boolean {
  return h.captures.some((c) => c.kind === kind);
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const effect of Array.from(h.effects)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Populate a live session + desktop overlay for `tab-1`. */
function seedSession(
  options: {
    navStatus?: Record<string, unknown>;
    viewport?: Record<string, unknown>;
    overlay?: Record<string, unknown> | null;
    controller?: string;
  } = {},
): void {
  const navStatus = options.navStatus ?? {
    _tag: "Success",
    url: "http://app.local/",
    title: "App",
  };
  const snapshot = {
    tabId: "tab-1",
    navStatus,
    canGoBack: true,
    canGoForward: false,
    viewport: options.viewport ?? { _tag: "fill" },
  };
  const overlay =
    options.overlay === null
      ? null
      : (options.overlay ?? {
          loading: false,
          canGoBack: true,
          canGoForward: true,
          controller: options.controller ?? "none",
          zoomFactor: 1,
        });
  h.previewState = {
    activeTabId: "tab-1",
    sessions: { "tab-1": snapshot },
    desktopByTabId: overlay ? { "tab-1": overlay } : {},
    recentlySeenUrls: ["http://recent.local/"],
  };
}

function makeBridge(): Record<string, unknown> {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      h.bridgeCalls.push({ method, args });
      return Promise.resolve();
    };
  return {
    navigate: record("navigate"),
    refresh: record("refresh"),
    zoomIn: record("zoomIn"),
    zoomOut: record("zoomOut"),
    resetZoom: record("resetZoom"),
    goBack: record("goBack"),
    goForward: record("goForward"),
    cancelPickElement: record("cancelPickElement"),
    pickElement: () => {
      h.bridgeCalls.push({ method: "pickElement", args: [] });
      return Promise.resolve(h.pickAnnotation);
    },
    captureScreenshot: () => {
      h.bridgeCalls.push({ method: "captureScreenshot", args: [] });
      return h.screenshotRejects
        ? Promise.reject(new Error("shot boom"))
        : Promise.resolve(h.screenshotArtifact);
    },
    copyArtifactToClipboard: () => {
      h.bridgeCalls.push({ method: "copyArtifactToClipboard", args: [] });
      return h.copyArtifactRejects ? Promise.reject(new Error("copy boom")) : Promise.resolve();
    },
    revealArtifact: record("revealArtifact"),
  };
}

function bridgeMethodCalls(method: string): Array<{ method: string; args: unknown[] }> {
  return h.bridgeCalls.filter((c) => c.method === method);
}

beforeEach(() => {
  h.stateCalls.length = 0;
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  h.captures.length = 0;
  h.previewState = {
    activeTabId: null,
    sessions: {},
    desktopByTabId: {},
    recentlySeenUrls: [],
  };
  h.environment = { label: "Local" };
  h.httpBaseUrl = "http://127.0.0.1:4100";
  h.displayUrl = "display.local";
  h.loadProgress = 0;
  h.activeRecordingTabId = null;
  h.showEmptyState = false;
  h.panelRect = null;
  h.resolvedUrl = "http://resolved.local/";
  h.responsiveSize = { width: 800, height: 600 };
  h.commandCalls.length = 0;
  h.resizeResult = { _tag: "Success", value: { viewport: { _tag: "fill" } } };
  h.previewBridge = null;
  h.bridgeCalls.length = 0;
  h.pickAnnotation = null;
  h.screenshotArtifact = { path: "/shot.png" };
  h.screenshotRejects = false;
  h.copyArtifactRejects = false;
  h.desktopNavigateCalls.length = 0;
  h.desktopNavigateRejects = false;
  h.openPreviewSessionCalls.length = 0;
  h.rememberPreviewUrlCalls.length = 0;
  h.updateSnapshotCalls.length = 0;
  h.commitViewportCalls.length = 0;
  h.startRecordingCalls.length = 0;
  h.startRecordingRejects = false;
  h.stopRecordingResult = { path: "/rec.webm" };
  h.stopRecordingRejects = false;
  h.addPreviewAnnotationCalls.length = 0;
  h.addImageCalls.length = 0;
  h.screenshotFile = null;
  h.previewActionSubscribers.length = 0;
  h.viewportChangeSubscriptions.length = 0;
  h.toasts.length = 0;
  h.toastUpdates.length = 0;
  h.nextToastId = 1;
  h.clipboardAvailable = true;
  h.clipboardWriteRejects = false;
  h.clipboardWriteCalls.length = 0;
  h.localApi = null;

  const windowStub = {
    setTimeout: (cb: () => void) => {
      cb();
      return 0;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", {
    activeElement: null,
    querySelector: () => null,
  });
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    clipboard: h.clipboardAvailable
      ? {
          writeText: (text: string) => {
            h.clipboardWriteCalls.push(text);
            return h.clipboardWriteRejects
              ? Promise.reject(new Error("clipboard boom"))
              : Promise.resolve();
          },
        }
      : undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────
// Rendering / derived state
// ─────────────────────────────────────────────────────────────────────

describe("PreviewView rendering", () => {
  it("renders the empty state when there is no session", () => {
    h.showEmptyState = true;
    const markup = renderView();
    expect(markup).toContain('data-mock="empty-state"');
    const empty = captured("emptyState");
    expect(empty.environmentId).toBe(environmentId);
    expect(empty.recentlySeenUrls).toEqual([]);
    // Chrome row still renders; no tab means no open-in-browser / capture.
    const chrome = captured("chromeRow");
    expect(chrome.onOpenInBrowser).toBeUndefined();
    expect(chrome.onCapture).toBeUndefined();
    expect(chrome.pickDisabled).toBe(true);
  });

  it("wires derived chrome-row state from a live session and overlay", () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.loadProgress = 42;
    const markup = renderView();

    const chrome = captured("chromeRow");
    expect(chrome.url).toBe("http://app.local/");
    expect(chrome.displayUrl).toBe("display.local");
    expect(chrome.loadProgress).toBe(42);
    expect(chrome.canGoBack).toBe(true);
    expect(chrome.canGoForward).toBe(true);
    expect(chrome.refreshDisabled).toBe(false);
    expect(typeof chrome.onCapture).toBe("function");
    expect(typeof chrome.onPickElement).toBe("function");
    expect(chrome.pickDisabled).toBe(false);

    // The browser surface slot renders for a live, reachable session.
    expect(hasCapture("surfaceSlot")).toBe(true);
    expect(markup).toContain('data-mock="surface-slot"');
    // Zoom indicator + agent cursor render when a desktop overlay exists.
    expect(hasCapture("zoomIndicator")).toBe(true);
    expect(hasCapture("agentCursor")).toBe(true);
  });

  it("renders the unreachable overlay and controller banner for a failed load", () => {
    seedSession({
      navStatus: {
        _tag: "LoadFailed",
        url: "http://broken.local/",
        title: "Broken",
        code: -105,
        description: "NAME_NOT_RESOLVED",
      },
      controller: "agent",
    });
    h.previewBridge = makeBridge();
    const markup = renderView();

    const chrome = captured("chromeRow");
    expect(chrome.refreshDisabled).toBe(false);
    expect(chrome.captureDisabled).toBe(true);
    expect(chrome.pickDisabled).toBe(true);
    expect(chrome.pickDisabledReason).toContain("Page didn't load");

    const unreachable = captured("unreachable");
    expect(unreachable.url).toBe("http://broken.local/");
    expect(unreachable.code).toBe(-105);
    expect(unreachable.description).toBe("NAME_NOT_RESOLVED");
    expect(markup).toContain("Agent controlling browser");
  });

  it("shows the human-control banner when a human drives the browser", () => {
    seedSession({ controller: "human" });
    h.previewBridge = makeBridge();
    const markup = renderView();
    expect(markup).toContain("Human control");
  });

  it("renders the more-menu inside the chrome trailing slot when the bridge exists", () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    const chrome = captured("chromeRow");
    const trailing = chrome.trailingActions as ReactElement;
    expect(trailing).toBeTruthy();
    expect((trailing.props as { hasWebContents: boolean }).hasWebContents).toBe(true);
  });

  it("omits the trailing more-menu when there is no preview bridge", () => {
    seedSession({ overlay: null });
    h.previewBridge = null;
    renderView();
    const chrome = captured("chromeRow");
    expect(chrome.trailingActions).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// URL submit + navigation handlers
// ─────────────────────────────────────────────────────────────────────

describe("navigation handlers", () => {
  it("navigates through desktop tab readiness and remembers the url when a tab exists", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    const chrome = captured("chromeRow");

    (chrome.onSubmit as (next: string) => void)("example.com");
    await flush();

    expect(h.desktopNavigateCalls).toEqual([["tab-1", "http://resolved.local/"]]);
    expect(bridgeMethodCalls("navigate")).toHaveLength(0);
    expect(h.rememberPreviewUrlCalls).toHaveLength(1);
    expect(h.openPreviewSessionCalls).toHaveLength(0);
  });

  it("opens a fresh preview session when no tab is active", async () => {
    h.showEmptyState = true;
    renderView();
    const empty = captured("emptyState");

    (empty.onOpenUrl as (next: string) => void)("example.com");
    await flush();

    expect(h.openPreviewSessionCalls).toHaveLength(1);
    expect(h.desktopNavigateCalls).toHaveLength(0);
    expect(bridgeMethodCalls("navigate")).toHaveLength(0);
  });

  it("swallows navigation errors (the failed event drives the unreachable view)", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.desktopNavigateRejects = true;
    renderView();
    const chrome = captured("chromeRow");

    (chrome.onSubmit as (next: string) => void)("example.com");
    await flush();
    // No throw escaped; remember was not reached.
    expect(h.rememberPreviewUrlCalls).toHaveLength(0);
  });

  it("drives back / forward / refresh through the bridge", () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    const chrome = captured("chromeRow");

    (chrome.onBack as () => void)();
    (chrome.onForward as () => void)();
    (chrome.onRefresh as () => void)();

    expect(bridgeMethodCalls("goBack")).toHaveLength(1);
    expect(bridgeMethodCalls("goForward")).toHaveLength(1);
    expect(bridgeMethodCalls("refresh")).toHaveLength(1);
  });

  it("invokes open-in-browser without throwing (local api unavailable under node)", () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    const chrome = captured("chromeRow");
    // onOpenInBrowser is provided because a tab exists; body early-returns
    // because module-level localApi resolves to null under node.
    expect(() => (chrome.onOpenInBrowser as () => void)()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Viewport handlers
// ─────────────────────────────────────────────────────────────────────

describe("viewport handlers", () => {
  it("resizes the viewport and updates the server snapshot on success", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    runEffects();
    const subscription = h.viewportChangeSubscriptions.at(-1);
    expect(subscription).toBeDefined();

    await subscription!.cb({ _tag: "fill" });
    expect(h.commandCalls.some((c) => c.label === "resize")).toBe(true);
    expect(h.updateSnapshotCalls).toHaveLength(1);
  });

  it("surfaces a resize failure as a toast and rethrows", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.resizeResult = { _tag: "Failure", error: new Error("resize boom") };
    renderView();
    runEffects();
    const subscription = h.viewportChangeSubscriptions.at(-1)!;

    const error = await subscription.cb({ _tag: "fill" }).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(h.toasts.some((t) => t.toast.title === "Unable to resize browser viewport")).toBe(true);
    expect(h.updateSnapshotCalls).toHaveLength(0);
  });

  it("toggles the device toolbar to a responsive freeform size from fill", () => {
    seedSession({ viewport: { _tag: "fill" } });
    h.previewBridge = makeBridge();
    h.panelRect = { width: 1024, height: 768 };
    renderView();
    const chrome = captured("chromeRow");
    const toggle = (chrome.trailingActions as ReactElement).props as {
      onToggleDeviceToolbar: () => void;
    };
    toggle.onToggleDeviceToolbar();
    expect(h.commitViewportCalls).toHaveLength(1);
    const [, setting] = h.commitViewportCalls[0] as [string, Record<string, unknown>];
    expect(setting._tag).toBe("freeform");
    expect(setting.width).toBe(800);
  });

  it("falls back to a default freeform size when no panel rect is known", () => {
    seedSession({ viewport: { _tag: "fill" } });
    h.previewBridge = makeBridge();
    h.panelRect = null;
    renderView();
    const toggle = (captured("chromeRow").trailingActions as ReactElement).props as {
      onToggleDeviceToolbar: () => void;
    };
    toggle.onToggleDeviceToolbar();
    const [, setting] = h.commitViewportCalls[0] as [string, Record<string, unknown>];
    expect(setting).toMatchObject({ _tag: "freeform", width: 1024, height: 768 });
  });

  it("returns to fill mode when the device toolbar is already active", () => {
    seedSession({ viewport: { _tag: "freeform", width: 800, height: 600 } });
    h.previewBridge = makeBridge();
    renderView();
    const toggle = (captured("chromeRow").trailingActions as ReactElement).props as {
      onToggleDeviceToolbar: () => void;
    };
    toggle.onToggleDeviceToolbar();
    const [, setting] = h.commitViewportCalls[0] as [string, Record<string, unknown>];
    expect(setting).toEqual({ _tag: "fill" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Capture: screenshots + recording
// ─────────────────────────────────────────────────────────────────────

describe("handleCapture: screenshots", () => {
  function setup() {
    seedSession();
    h.previewBridge = makeBridge();
    renderView();
    return captured("chromeRow").onCapture as (record: boolean) => void;
  }

  it("captures a screenshot and wires copy-image / copy-path / reveal actions", async () => {
    const onCapture = setup();
    onCapture(false);
    await flush();

    expect(bridgeMethodCalls("captureScreenshot")).toHaveLength(1);
    const saved = h.toasts.find((t) => t.toast.title === "Screenshot saved");
    expect(saved).toBeDefined();
    const toast = saved!.toast;

    // Copy image → bridge clipboard copy, then reset after the timeout.
    (toast.actionProps as { onClick: () => void }).onClick();
    await flush();
    expect(bridgeMethodCalls("copyArtifactToClipboard")).toHaveLength(1);

    // Copy path (first additional action) → clipboard writeText.
    const additional = (
      toast.data as { additionalActions: Array<{ props: { onClick: () => void } }> }
    ).additionalActions;
    additional[0]!.props.onClick();
    await flush();
    expect(h.clipboardWriteCalls).toContain("/shot.png");

    // Reveal in file explorer (secondary action).
    (
      toast.data as { secondaryActionProps: { onClick: () => void } }
    ).secondaryActionProps.onClick();
    expect(bridgeMethodCalls("revealArtifact")).toHaveLength(1);
  });

  it("reports a clipboard-copy-image failure through a toast update", async () => {
    const onCapture = setup();
    h.copyArtifactRejects = true;
    onCapture(false);
    await flush();
    const toast = h.toasts.find((t) => t.toast.title === "Screenshot saved")!.toast;
    (toast.actionProps as { onClick: () => void }).onClick();
    await flush();
    expect(h.toastUpdates.some((u) => u.toast.title === "Unable to copy screenshot")).toBe(true);
  });

  it("reports a copy-path failure when the clipboard API is unavailable", async () => {
    const onCapture = setup();
    // Remove clipboard support.
    vi.stubGlobal("navigator", { platform: "MacIntel", clipboard: undefined });
    onCapture(false);
    await flush();
    const toast = h.toasts.find((t) => t.toast.title === "Screenshot saved")!.toast;
    const additional = (
      toast.data as { additionalActions: Array<{ props: { onClick: () => void } }> }
    ).additionalActions;
    additional[0]!.props.onClick();
    expect(h.toastUpdates.some((u) => u.toast.title === "Unable to copy screenshot path")).toBe(
      true,
    );
  });

  it("reports a screenshot capture failure", async () => {
    const onCapture = setup();
    h.screenshotRejects = true;
    onCapture(false);
    await flush();
    expect(h.toasts.some((t) => t.toast.title === "Unable to capture screenshot")).toBe(true);
  });
});

describe("handleCapture: recording", () => {
  it("starts a recording when record is requested and nothing else records", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.activeRecordingTabId = null;
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;
    onCapture(true);
    await flush();
    expect(h.startRecordingCalls).toEqual(["tab-1"]);
  });

  it("warns when another preview is already recording", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.activeRecordingTabId = "other-tab";
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;
    onCapture(true);
    await flush();
    expect(h.startRecordingCalls).toHaveLength(0);
    expect(h.toasts.some((t) => t.toast.title === "Another preview is recording")).toBe(true);
  });

  it("reports a failure to start recording", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.startRecordingRejects = true;
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;
    onCapture(true);
    await flush();
    expect(h.toasts.some((t) => t.toast.title === "Unable to start recording")).toBe(true);
  });

  it("stops the active recording and wires the saved-recording toast actions", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.activeRecordingTabId = "tab-1";
    h.stopRecordingResult = { path: "/rec.webm" };
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;

    onCapture(true); // recordingThisTab → stops
    await flush();
    const saved = h.toasts.find((t) => t.toast.title === "Recording saved");
    expect(saved).toBeDefined();
    const toast = saved!.toast;

    // Copy path from the secondary action.
    (
      toast.data as { secondaryActionProps: { onClick: () => void } }
    ).secondaryActionProps.onClick();
    await flush();
    expect(h.clipboardWriteCalls).toContain("/rec.webm");

    // Reveal action.
    (toast.actionProps as { onClick: () => void }).onClick();
    expect(bridgeMethodCalls("revealArtifact")).toHaveLength(1);
  });

  it("ignores a stop that yields no artifact", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.activeRecordingTabId = "tab-1";
    h.stopRecordingResult = null;
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;
    onCapture(true);
    await flush();
    expect(h.toasts.some((t) => t.toast.title === "Recording saved")).toBe(false);
  });

  it("reports a failure to stop recording", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.activeRecordingTabId = "tab-1";
    h.stopRecordingRejects = true;
    renderView();
    const onCapture = captured("chromeRow").onCapture as (record: boolean) => void;
    onCapture(true);
    await flush();
    expect(h.toasts.some((t) => t.toast.title === "Unable to stop recording")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pick element
// ─────────────────────────────────────────────────────────────────────

describe("handlePickElement", () => {
  it("runs a pick, records the annotation, and attaches the screenshot image", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.pickAnnotation = {
      id: "ann-1",
      screenshot: { dataUrl: "data:image/png;base64,AAA" },
    };
    h.screenshotFile = { name: "shot.png", type: "image/png", size: 10 };
    renderView();
    const chrome = captured("chromeRow");

    (chrome.onPickElement as () => void)();
    await flush();

    expect(bridgeMethodCalls("pickElement")).toHaveLength(1);
    expect(h.addPreviewAnnotationCalls).toHaveLength(1);
    expect(h.addImageCalls).toHaveLength(1);
    // pickActive was toggled on then off.
    expect(h.setStateCalls.some((c) => c.applied === true)).toBe(true);
    expect(h.setStateCalls.some((c) => c.applied === false)).toBe(true);
  });

  it("cancels an in-flight pick when invoked while active", () => {
    seedSession();
    h.previewBridge = makeBridge();
    // Never resolve pickElement so the pick stays active.
    (h.previewBridge as Record<string, unknown>).pickElement = () => new Promise(() => undefined);
    renderView();
    const chrome = captured("chromeRow");

    (chrome.onPickElement as () => void)(); // starts pick (pickActiveRef=true)
    (chrome.onPickElement as () => void)(); // second call cancels

    expect(bridgeMethodCalls("cancelPickElement")).toHaveLength(1);
  });

  it("restores focus to the previously focused element after a pick resolves", async () => {
    seedSession();
    h.previewBridge = makeBridge();
    h.pickAnnotation = null; // annotation missing → early return in the async body
    const focus = vi.fn();
    vi.stubGlobal("document", {
      activeElement: { isConnected: true, focus },
      querySelector: () => null,
    });
    renderView();
    (captured("chromeRow").onPickElement as () => void)();
    await flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("swallows a pick rejection as a silent cancel", async () => {
    seedSession();
    const bridge = makeBridge();
    bridge.pickElement = () => Promise.reject(new Error("pick boom"));
    h.previewBridge = bridge;
    renderView();
    const chrome = captured("chromeRow");
    (chrome.onPickElement as () => void)();
    await flush();
    // No annotation recorded; pickActive reset without throwing.
    expect(h.addPreviewAnnotationCalls).toHaveLength(0);
    expect(h.setStateCalls.some((c) => c.applied === false)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Effects + preview action bus
// ─────────────────────────────────────────────────────────────────────

describe("effects and the preview action bus", () => {
  it("relays bus actions to refresh / focus-url / zoom handlers while visible", () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView(baseProps({ visible: true }));
    runEffects();

    expect(h.previewActionSubscribers.length).toBeGreaterThanOrEqual(1);
    const notify = (action: string) => {
      for (const sub of Array.from(h.previewActionSubscribers)) sub(action);
    };

    notify("refresh");
    expect(bridgeMethodCalls("refresh").length).toBeGreaterThanOrEqual(1);
    notify("zoom-in");
    expect(bridgeMethodCalls("zoomIn")).toHaveLength(1);
    notify("zoom-out");
    expect(bridgeMethodCalls("zoomOut")).toHaveLength(1);
    notify("reset-zoom");
    expect(bridgeMethodCalls("resetZoom")).toHaveLength(1);
    notify("focus-url");
    expect(h.setStateCalls.some((c) => c.applied === 1)).toBe(true);
    // toggle-panel is a no-op here (owned elsewhere).
    expect(() => notify("toggle-panel")).not.toThrow();
  });

  it("does not subscribe to the action bus when the panel is not visible", () => {
    seedSession();
    h.previewBridge = makeBridge();
    renderView(baseProps({ visible: false }));
    runEffects();
    expect(h.previewActionSubscribers).toHaveLength(0);
  });

  it("cancels an in-flight pick when the tab changes (cleanup effect)", () => {
    seedSession();
    h.previewBridge = makeBridge();
    (h.previewBridge as Record<string, unknown>).pickElement = () => new Promise(() => undefined);
    renderView();
    // Start a pick so pickActiveRef is set before cleanup runs.
    (captured("chromeRow").onPickElement as () => void)();
    const cleanups = runEffects();
    for (const cleanup of cleanups) cleanup();
    expect(bridgeMethodCalls("cancelPickElement").length).toBeGreaterThanOrEqual(1);
  });

  it("subscribes to viewport changes only when a tab is present", () => {
    // No active tab → the effect returns early without subscribing.
    renderView();
    runEffects();
    expect(h.viewportChangeSubscriptions).toHaveLength(0);
  });
});
