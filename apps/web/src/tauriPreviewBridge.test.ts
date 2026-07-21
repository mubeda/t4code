import { describe, expect, it, vi } from "vite-plus/test";

import { createTauriPreviewBridge } from "./tauriPreviewBridge";

function makeBridge() {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const listeners = new Map<string, (payload: unknown) => void>();
  const listen = <T>(event: string, cb: (payload: T) => void) => {
    listeners.set(event, cb as (payload: unknown) => void);
    return () => {
      listeners.delete(event);
    };
  };
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
