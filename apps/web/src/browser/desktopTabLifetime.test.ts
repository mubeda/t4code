import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { closeTab, createTab } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab },
}));

import { acquireDesktopTab } from "./desktopTabLifetime";

describe("desktopTabLifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    closeTab.mockClear();
    createTab.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares tab creation readiness across concurrent leases", async () => {
    let resolveCreation: (() => void) | undefined;
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
    );

    const first = acquireDesktopTab("tab_readiness");
    const second = acquireDesktopTab("tab_readiness");

    expect(createTab).toHaveBeenCalledOnce();
    expect(first.ready).toBe(second.ready);

    let ready = false;
    void first.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    resolveCreation?.();
    await first.ready;
    expect(ready).toBe(true);
  });

  it("closes a tab only after the last lease releases", async () => {
    const first = acquireDesktopTab("tab_shared");
    const second = acquireDesktopTab("tab_shared");
    await first.ready;

    first.release();
    await vi.runAllTimersAsync();
    expect(closeTab).not.toHaveBeenCalled();

    second.release();
    await vi.runAllTimersAsync();
    expect(closeTab).toHaveBeenCalledWith("tab_shared");

    second.release();
    await vi.runAllTimersAsync();
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("cancels a pending close when the tab is acquired again", async () => {
    const first = acquireDesktopTab("tab_reacquired");
    first.release();
    const second = acquireDesktopTab("tab_reacquired");

    await vi.runAllTimersAsync();
    expect(closeTab).not.toHaveBeenCalled();
    expect(second.ready).toBe(first.ready);

    second.release();
    await vi.runAllTimersAsync();
    expect(closeTab).toHaveBeenCalledWith("tab_reacquired");
  });
});
