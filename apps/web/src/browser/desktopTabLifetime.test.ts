import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { closeTab, createTab, previewNavigate } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
  previewNavigate: vi.fn(async () => undefined),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab, navigate: previewNavigate },
}));

import * as desktopTabLifetime from "./desktopTabLifetime";

const { acquireDesktopTab } = desktopTabLifetime;

describe("desktopTabLifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    closeTab.mockClear();
    createTab.mockClear();
    previewNavigate.mockClear();
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

  it("waits for shared creation readiness before interactive navigation", async () => {
    let resolveCreation: (() => void) | undefined;
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
    );
    const owner = acquireDesktopTab("tab_interactive");
    const navigateDesktopTab = Reflect.get(desktopTabLifetime, "navigateDesktopTab") as
      | ((tabId: string, url: string) => Promise<void>)
      | undefined;

    expect(navigateDesktopTab).toEqual(expect.any(Function));
    const navigation = navigateDesktopTab!("tab_interactive", "https://interactive.test/");
    await Promise.resolve();
    expect(previewNavigate).not.toHaveBeenCalled();

    resolveCreation?.();
    await navigation;
    expect(previewNavigate).toHaveBeenCalledExactlyOnceWith(
      "tab_interactive",
      "https://interactive.test/",
    );

    owner.release();
    await vi.runAllTimersAsync();
  });

  it("treats each acquired lease release as idempotent", async () => {
    const first = acquireDesktopTab("tab_idempotent");
    const second = acquireDesktopTab("tab_idempotent");
    await first.ready;

    first.release();
    first.release();
    await vi.runAllTimersAsync();
    expect(closeTab).not.toHaveBeenCalled();

    second.release();
    await vi.runAllTimersAsync();
    expect(closeTab).toHaveBeenCalledExactlyOnceWith("tab_idempotent");
  });

  it("retries a rejected creation generation instead of poisoning later navigation", async () => {
    createTab.mockRejectedValueOnce(new Error("create boom")).mockResolvedValueOnce(undefined);
    const owner = acquireDesktopTab("tab_create_retry");
    await expect(owner.ready).rejects.toThrow("create boom");
    const navigateDesktopTab = Reflect.get(desktopTabLifetime, "navigateDesktopTab") as (
      tabId: string,
      url: string,
    ) => Promise<void>;

    await navigateDesktopTab("tab_create_retry", "https://recovered.test/");

    expect(createTab).toHaveBeenCalledTimes(2);
    expect(previewNavigate).toHaveBeenCalledExactlyOnceWith(
      "tab_create_retry",
      "https://recovered.test/",
    );
    owner.release();
    await vi.runAllTimersAsync();
  });

  it("releases its temporary lease when navigation rejects", async () => {
    previewNavigate.mockRejectedValueOnce(new Error("navigate boom"));
    const navigateDesktopTab = Reflect.get(desktopTabLifetime, "navigateDesktopTab") as (
      tabId: string,
      url: string,
    ) => Promise<void>;

    await expect(
      navigateDesktopTab("tab_navigation_failure", "https://failure.test/"),
    ).rejects.toThrow("navigate boom");
    await vi.runAllTimersAsync();

    expect(closeTab).toHaveBeenCalledExactlyOnceWith("tab_navigation_failure");
  });
});
