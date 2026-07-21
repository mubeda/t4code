import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startBrowserSurfaceSync } from "./browserSurfaceSync";
import { acquireBrowserSurface, useBrowserSurfaceStore } from "./browserSurfaceStore";

describe("browserSurfaceSync", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ byTabId: {} });
  });

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

  it("pushes the initial store state and stops forwarding after unsubscribe", () => {
    const lease = acquireBrowserSurface("sync-initial");
    lease.present({ x: 1, y: 2, width: 30, height: 40 }, true);
    const setBounds = vi.fn().mockResolvedValue(undefined);

    const stop = startBrowserSurfaceSync({ setBounds });

    expect(setBounds).toHaveBeenCalledWith(
      "sync-initial",
      { x: 1, y: 2, width: 30, height: 40 },
      true,
    );

    stop();
    lease.present({ x: 5, y: 6, width: 70, height: 80 }, false);
    expect(setBounds).toHaveBeenCalledTimes(1);
  });

  it("dedupes presentations when unrelated store fields update", () => {
    const setBounds = vi.fn().mockResolvedValue(undefined);
    const stop = startBrowserSurfaceSync({ setBounds });
    const lease = acquireBrowserSurface("sync-content");
    lease.present({ x: 10, y: 20, width: 300, height: 400 }, true);

    useBrowserSurfaceStore.getState().presentContent("sync-content", {
      x: 0,
      y: 0,
      width: 300,
      height: 400,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    expect(setBounds).toHaveBeenCalledTimes(1);
    stop();
  });
});
