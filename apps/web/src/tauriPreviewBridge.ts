import type {
  DesktopPreviewBounds,
  DesktopPreviewBridge,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabState,
} from "@t4code/contracts";

import { TauriDesktopCapabilityUnsupportedError } from "./tauriDesktopBridge";

interface PreviewBridgeDeps {
  readonly invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  readonly listen: <T>(event: string, listener: (payload: T) => void) => () => void;
}

interface PreviewStateEventPayload {
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
}

function unsupported(capability: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new TauriDesktopCapabilityUnsupportedError(
        capability,
        capability,
        `preview capability not supported yet on this host: ${capability}`,
      ),
    );
}

export function createTauriPreviewBridge(deps: PreviewBridgeDeps): DesktopPreviewBridge {
  const { invoke, listen } = deps;
  const zoomByTab = new Map<string, number>();
  const pendingByTab = new Map<string, Promise<void>>();

  const enqueueTabOperation = (tabId: string, operation: () => Promise<void>): Promise<void> => {
    const pending = pendingByTab.get(tabId);
    let result: Promise<void>;
    try {
      result = pending === undefined ? operation() : pending.then(operation);
    } catch (error) {
      result = Promise.reject(error);
    }

    const tail = result.then(
      () => {
        if (pendingByTab.get(tabId) === tail) pendingByTab.delete(tabId);
      },
      () => {
        if (pendingByTab.get(tabId) === tail) pendingByTab.delete(tabId);
      },
    );
    pendingByTab.set(tabId, tail);
    return result;
  };

  const setZoom = (tabId: string, getFactor: (committed: number) => number): Promise<void> =>
    enqueueTabOperation(tabId, async () => {
      const factor = Math.min(3, Math.max(0.25, getFactor(zoomByTab.get(tabId) ?? 1)));
      await invoke("desktop_preview_set_zoom", { tabId, factor });
      zoomByTab.set(tabId, factor);
    });

  return {
    createTab: (tabId) =>
      enqueueTabOperation(tabId, () => invoke("desktop_preview_create_tab", { tabId })),
    closeTab: (tabId) =>
      enqueueTabOperation(tabId, async () => {
        await invoke("desktop_preview_close_tab", { tabId });
        zoomByTab.delete(tabId);
      }),
    setBounds: (tabId, bounds: DesktopPreviewBounds, visible) =>
      invoke("desktop_preview_set_bounds", { tabId, bounds, visible }),
    navigate: (tabId, url) => invoke("desktop_preview_navigate", { tabId, url }),
    goBack: (tabId) => invoke("desktop_preview_go_back", { tabId }),
    goForward: (tabId) => invoke("desktop_preview_go_forward", { tabId }),
    refresh: (tabId) => invoke("desktop_preview_refresh", { tabId }),
    zoomIn: (tabId) => setZoom(tabId, (factor) => factor + 0.1),
    zoomOut: (tabId) => setZoom(tabId, (factor) => factor - 0.1),
    resetZoom: (tabId) => setZoom(tabId, () => 1),
    hardReload: (tabId) => invoke("desktop_preview_hard_reload", { tabId }),
    openDevTools: (tabId) => invoke("desktop_preview_open_devtools", { tabId }),
    clearCookies: () =>
      invoke("desktop_preview_clear_data", { cookies: true, cache: false, storage: true }),
    clearCache: () =>
      invoke("desktop_preview_clear_data", { cookies: false, cache: true, storage: false }),
    setAnnotationTheme: () => Promise.resolve(),
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
      listen<PreviewStateEventPayload>("preview://state", (payload) => {
        zoomByTab.set(payload.tabId, payload.state.zoomFactor);
        listener(payload.tabId, payload.state);
      }),
    onPointerEvent: () => () => {},
  };
}
