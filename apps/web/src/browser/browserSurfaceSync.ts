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
      void bridge
        .setBounds(
          tabId,
          { x: next.x, y: next.y, width: next.width, height: next.height },
          next.visible,
        )
        .catch((error: unknown) => {
          console.error("Could not sync browser surface bounds.", { tabId, error });
        });
    }
  };

  push(useBrowserSurfaceStore.getState().byTabId);
  return useBrowserSurfaceStore.subscribe((state) => push(state.byTabId));
}
