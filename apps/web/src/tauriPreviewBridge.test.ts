import type { DesktopPreviewBridge, DesktopPreviewTabState } from "@t4code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { TauriDesktopCapabilityUnsupportedError } from "./tauriDesktopBridge";
import { createTauriPreviewBridge } from "./tauriPreviewBridge";
import { supportsPreviewRuntimeCapability } from "./previewRuntimeCapabilities";

const screenshotArtifact = {
  id: "shot-1",
  tabId: "t1",
  path: "/tmp/shot-1.png",
  mimeType: "image/png" as const,
  sizeBytes: 42,
  createdAt: "2026-07-20T00:00:00.000Z",
};

function makeBridge() {
  const invoke = vi
    .fn()
    .mockImplementation((command: string) =>
      Promise.resolve(
        command === "desktop_preview_capture_screenshot" ? screenshotArtifact : undefined,
      ),
    );
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const listen = <T>(event: string, cb: (payload: T) => void) => {
    const eventListeners = listeners.get(event) ?? new Set<(payload: unknown) => void>();
    const listener = cb as (payload: unknown) => void;
    eventListeners.add(listener);
    listeners.set(event, eventListeners);
    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) listeners.delete(event);
    };
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  return {
    bridge: createTauriPreviewBridge({ invoke, listen }),
    emit,
    invoke,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

function statePayload(tabId: string, zoomFactor = 1, url = "https://example.com/") {
  const state: DesktopPreviewTabState = {
    tabId,
    webContentsId: null,
    navStatus: { kind: "Success", url, title: "Example" },
    canGoBack: false,
    canGoForward: false,
    zoomFactor,
    controller: "human",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  return { tabId, state };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface CommandCase {
  readonly name: string;
  readonly run: (bridge: DesktopPreviewBridge) => Promise<unknown>;
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly result?: unknown;
}

const commandCases: readonly CommandCase[] = [
  {
    name: "createTab",
    run: (bridge) => bridge.createTab("t1"),
    command: "desktop_preview_create_tab",
    args: { tabId: "t1" },
  },
  {
    name: "closeTab",
    run: (bridge) => bridge.closeTab("t1"),
    command: "desktop_preview_close_tab",
    args: { tabId: "t1" },
  },
  {
    name: "setBounds",
    run: (bridge) => bridge.setBounds("t1", { x: 1, y: 2, width: 3, height: 4 }, true),
    command: "desktop_preview_set_bounds",
    args: { tabId: "t1", bounds: { x: 1, y: 2, width: 3, height: 4 }, visible: true },
  },
  {
    name: "navigate",
    run: (bridge) => bridge.navigate("t1", "https://example.com"),
    command: "desktop_preview_navigate",
    args: { tabId: "t1", url: "https://example.com" },
  },
  {
    name: "goBack",
    run: (bridge) => bridge.goBack("t1"),
    command: "desktop_preview_go_back",
    args: { tabId: "t1" },
  },
  {
    name: "goForward",
    run: (bridge) => bridge.goForward("t1"),
    command: "desktop_preview_go_forward",
    args: { tabId: "t1" },
  },
  {
    name: "refresh",
    run: (bridge) => bridge.refresh("t1"),
    command: "desktop_preview_refresh",
    args: { tabId: "t1" },
  },
  {
    name: "hardReload",
    run: (bridge) => bridge.hardReload("t1"),
    command: "desktop_preview_hard_reload",
    args: { tabId: "t1" },
  },
  {
    name: "zoomIn",
    run: (bridge) => bridge.zoomIn("t1"),
    command: "desktop_preview_set_zoom",
    args: { tabId: "t1", factor: 1.1 },
  },
  {
    name: "zoomOut",
    run: (bridge) => bridge.zoomOut("t1"),
    command: "desktop_preview_set_zoom",
    args: { tabId: "t1", factor: 0.9 },
  },
  {
    name: "resetZoom",
    run: (bridge) => bridge.resetZoom("t1"),
    command: "desktop_preview_set_zoom",
    args: { tabId: "t1", factor: 1 },
  },
  {
    name: "openDevTools",
    run: (bridge) => bridge.openDevTools("t1"),
    command: "desktop_preview_open_devtools",
    args: { tabId: "t1" },
  },
  {
    name: "clearCookies",
    run: (bridge) => bridge.clearCookies(),
    command: "desktop_preview_clear_data",
    args: { cookies: true, cache: false, storage: true },
  },
  {
    name: "clearCache",
    run: (bridge) => bridge.clearCache(),
    command: "desktop_preview_clear_data",
    args: { cookies: false, cache: true, storage: false },
  },
  {
    name: "captureScreenshot",
    run: (bridge) => bridge.captureScreenshot("t1"),
    command: "desktop_preview_capture_screenshot",
    args: { tabId: "t1" },
    result: screenshotArtifact,
  },
  {
    name: "revealArtifact",
    run: (bridge) => bridge.revealArtifact("/tmp/shot-1.png"),
    command: "desktop_preview_reveal_artifact",
    args: { path: "/tmp/shot-1.png" },
  },
];

describe("tauriPreviewBridge", () => {
  it("reports image clipboard unsupported while retaining its rejecting stub", async () => {
    const { bridge } = makeBridge();

    await expect(bridge.copyArtifactToClipboard("/tmp/shot-1.png")).rejects.toMatchObject({
      code: "tauri_capability_unsupported",
    });
    expect(supportsPreviewRuntimeCapability(bridge, "imageClipboard")).toBe(false);
  });

  it("reports deferred picker, recording, and automation capabilities as unsupported", () => {
    const { bridge } = makeBridge();

    expect(supportsPreviewRuntimeCapability(bridge, "picker")).toBe(false);
    expect(supportsPreviewRuntimeCapability(bridge, "recording")).toBe(false);
    expect(supportsPreviewRuntimeCapability(bridge, "automation")).toBe(false);
  });

  it.each(commandCases)(
    "maps $name to its exact desktop_preview command and payload",
    async (entry) => {
      const { bridge, invoke } = makeBridge();
      const result = await entry.run(bridge);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(entry.command, entry.args);
      if ("result" in entry) expect(result).toEqual(entry.result);
    },
  );

  it("clamps zoom factors to the host bounds", async () => {
    const lower = makeBridge();
    for (let index = 0; index < 20; index += 1) await lower.bridge.zoomOut("t1");
    expect(lower.invoke).toHaveBeenLastCalledWith("desktop_preview_set_zoom", {
      tabId: "t1",
      factor: 0.25,
    });

    const upper = makeBridge();
    for (let index = 0; index < 30; index += 1) await upper.bridge.zoomIn("t1");
    expect(upper.invoke).toHaveBeenLastCalledWith("desktop_preview_set_zoom", {
      tabId: "t1",
      factor: 3,
    });
  });

  it("fans state events out through one native listener and honors each unsubscribe", () => {
    const { bridge, emit, listenerCount } = makeBridge();
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = bridge.onStateChange((tabId) => first.push(tabId));
    const unsubscribeSecond = bridge.onStateChange((tabId) => second.push(tabId));

    expect(listenerCount("preview://state")).toBe(1);
    emit("preview://state", statePayload("t1"));
    unsubscribeFirst();
    emit("preview://state", statePayload("t2"));

    expect(first).toEqual(["t1"]);
    expect(second).toEqual(["t1", "t2"]);
    expect(listenerCount("preview://state")).toBe(1);

    unsubscribeSecond();
    expect(listenerCount("preview://state")).toBe(0);
  });

  it("serializes rapid zoom operations per tab", async () => {
    const { bridge, invoke } = makeBridge();
    const firstInvoke = deferred<void>();
    invoke.mockImplementationOnce(() => firstInvoke.promise).mockResolvedValueOnce(undefined);

    const firstZoom = bridge.zoomIn("t1");
    const secondZoom = bridge.zoomIn("t1");

    expect(invoke).toHaveBeenCalledTimes(1);
    firstInvoke.resolve(undefined);
    await firstZoom;
    await secondZoom;

    expect(invoke.mock.calls[1]?.[0]).toBe("desktop_preview_set_zoom");
    const secondArgs = invoke.mock.calls[1]?.[1] as { factor: number; tabId: string } | undefined;
    expect(secondArgs).toMatchObject({ tabId: "t1" });
    expect(secondArgs?.factor).toBeCloseTo(1.2);
  });

  it("orders deferred zoom, close, and recreate on the same tab queue", async () => {
    const { bridge, invoke } = makeBridge();
    const zoomInvoke = deferred<void>();
    const closeInvoke = deferred<void>();
    invoke
      .mockImplementationOnce(() => zoomInvoke.promise)
      .mockImplementationOnce(() => closeInvoke.promise)
      .mockResolvedValueOnce(undefined);

    const zoom = bridge.zoomIn("t1");
    const close = bridge.closeTab("t1");
    const recreate = bridge.createTab("t1");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["desktop_preview_set_zoom"]);

    zoomInvoke.resolve(undefined);
    await zoom;
    await Promise.resolve();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "desktop_preview_set_zoom",
      "desktop_preview_close_tab",
    ]);

    closeInvoke.resolve(undefined);
    await close;
    await recreate;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "desktop_preview_set_zoom",
      "desktop_preview_close_tab",
      "desktop_preview_create_tab",
    ]);
  });

  it("waits for an unresolved close before recreating the same tab", async () => {
    const { bridge, invoke } = makeBridge();
    const closeInvoke = deferred<void>();
    invoke.mockImplementationOnce(() => closeInvoke.promise).mockResolvedValueOnce(undefined);

    const close = bridge.closeTab("t1");
    const recreate = bridge.createTab("t1");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["desktop_preview_close_tab"]);

    closeInvoke.resolve(undefined);
    await close;
    await recreate;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "desktop_preview_close_tab",
      "desktop_preview_create_tab",
    ]);
  });

  it("invokes create immediately when the tab has no pending operation", async () => {
    const { bridge, invoke } = makeBridge();

    const create = bridge.createTab("t1");

    expect(invoke).toHaveBeenCalledWith("desktop_preview_create_tab", { tabId: "t1" });
    await create;
  });

  it("continues to recreate after close fails without clearing committed zoom", async () => {
    const { bridge, invoke } = makeBridge();
    const closeInvoke = deferred<void>();
    const error = new Error("close failed");
    await bridge.zoomIn("t1");
    invoke
      .mockImplementationOnce(() => closeInvoke.promise)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const close = bridge.closeTab("t1");
    const closeResult = close.then(
      () => undefined,
      (closeError: unknown) => closeError,
    );
    const recreate = bridge.createTab("t1");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "desktop_preview_set_zoom",
      "desktop_preview_close_tab",
    ]);

    closeInvoke.reject(error);
    expect(await closeResult).toBe(error);
    await recreate;
    await bridge.zoomIn("t1");

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "desktop_preview_set_zoom",
      "desktop_preview_close_tab",
      "desktop_preview_create_tab",
      "desktop_preview_set_zoom",
    ]);
    const lastArgs = invoke.mock.lastCall?.[1] as { factor: number; tabId: string } | undefined;
    expect(lastArgs?.factor).toBeCloseTo(1.2);
  });

  it("recovers from a rejected zoom using the last successfully committed factor", async () => {
    const { bridge, invoke } = makeBridge();
    const error = new Error("set zoom failed");
    invoke.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

    const failedZoom = bridge.zoomIn("t1");
    const recoveredZoom = bridge.zoomOut("t1");

    await expect(failedZoom).rejects.toBe(error);
    await recoveredZoom;
    expect(invoke).toHaveBeenNthCalledWith(2, "desktop_preview_set_zoom", {
      tabId: "t1",
      factor: 0.9,
    });
  });

  it("uses host state events as the committed factor for subsequent zooms", async () => {
    const { bridge, emit, invoke } = makeBridge();
    bridge.onStateChange(() => {});
    emit("preview://state", statePayload("t1", 1.5));

    await bridge.zoomIn("t1");

    expect(invoke).toHaveBeenCalledWith("desktop_preview_set_zoom", {
      tabId: "t1",
      factor: 1.6,
    });
  });

  it("clears committed zoom after close succeeds so a recreated tab starts at one", async () => {
    const { bridge, invoke } = makeBridge();
    await bridge.zoomIn("t1");
    await bridge.closeTab("t1");
    await bridge.createTab("t1");
    await bridge.zoomIn("t1");

    const zoomCalls = invoke.mock.calls.filter(
      ([command]) => command === "desktop_preview_set_zoom",
    );
    expect(zoomCalls).toEqual([
      ["desktop_preview_set_zoom", { tabId: "t1", factor: 1.1 }],
      ["desktop_preview_set_zoom", { tabId: "t1", factor: 1.1 }],
    ]);
  });

  it("preserves committed zoom when close fails", async () => {
    const { bridge, invoke } = makeBridge();
    const error = new Error("close failed");
    await bridge.zoomIn("t1");
    invoke.mockRejectedValueOnce(error);

    await expect(bridge.closeTab("t1")).rejects.toBe(error);
    await bridge.zoomIn("t1");

    const lastCall = invoke.mock.lastCall;
    expect(lastCall?.[0]).toBe("desktop_preview_set_zoom");
    const lastArgs = lastCall?.[1] as { factor: number; tabId: string } | undefined;
    expect(lastArgs).toMatchObject({ tabId: "t1" });
    expect(lastArgs?.factor).toBeCloseTo(1.2);
  });

  it("rejects every unsupported Promise surface with the stable Tauri capability error", async () => {
    const { bridge } = makeBridge();
    const unsupportedCalls: ReadonlyArray<() => Promise<unknown>> = [
      () => bridge.pickElement("t1"),
      () => bridge.copyArtifactToClipboard("/tmp/shot-1.png"),
      () => bridge.recording.startScreencast("t1"),
      () => bridge.recording.stopScreencast("t1"),
      () => bridge.recording.save("t1", "video/webm", new Uint8Array()),
      () => bridge.automation.status("t1"),
      () => bridge.automation.snapshot("t1"),
      () => bridge.automation.click("t1", undefined as never),
      () => bridge.automation.type("t1", undefined as never),
      () => bridge.automation.press("t1", undefined as never),
      () => bridge.automation.scroll("t1", undefined as never),
      () => bridge.automation.evaluate("t1", undefined as never),
      () => bridge.automation.waitFor("t1", undefined as never),
    ];

    for (const call of unsupportedCalls) {
      try {
        await call();
        expect.unreachable("unsupported preview surface resolved");
      } catch (error) {
        expect(error).toBeInstanceOf(TauriDesktopCapabilityUnsupportedError);
        expect((error as TauriDesktopCapabilityUnsupportedError).code).toBe(
          "tauri_capability_unsupported",
        );
      }
    }
  });

  it("keeps allowed Phase-2/4 no-op surfaces harmless", async () => {
    const { bridge } = makeBridge();

    await expect(bridge.setAnnotationTheme(undefined as never)).resolves.toBeUndefined();
    await expect(bridge.cancelPickElement("t1")).resolves.toBeUndefined();

    const unsubscribeFrame = bridge.recording.onFrame(() => {});
    const unsubscribePointer = bridge.onPointerEvent(() => {});
    expect(unsubscribeFrame).toBeTypeOf("function");
    expect(unsubscribePointer).toBeTypeOf("function");
    expect(() => unsubscribeFrame()).not.toThrow();
    expect(() => unsubscribePointer()).not.toThrow();
  });
});
