// @vitest-environment happy-dom

import type { ScopedThreadRef } from "@t4code/contracts";
import { StrictMode, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  clearBrowserPointer: vi.fn(),
  closeTab: vi.fn<(tabId: string) => Promise<void>>(),
  createTab: vi.fn<(tabId: string) => Promise<void>>(),
  events: [] as string[],
  navigate: vi.fn<(tabId: string, url: string) => Promise<void>>(),
  present: vi.fn(),
  releaseSurface: vi.fn(),
  reportStatus: vi.fn(async () => undefined),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    closeTab: h.closeTab,
    createTab: h.createTab,
    navigate: h.navigate,
    onStateChange: () => {
      h.events.push("subscribe");
      return () => h.events.push("unsubscribe");
    },
  },
}));

vi.mock("~/browser/browserPointerStore", () => ({
  useBrowserPointerStore: (selector: (state: { clear: typeof h.clearBrowserPointer }) => unknown) =>
    selector({ clear: h.clearBrowserPointer }),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewDesktopState: vi.fn(),
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { reportStatus: { key: "preview.reportStatus" } },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => h.reportStatus,
}));

vi.mock("./browserSurfaceStore", () => ({
  acquireBrowserSurface: () => ({
    present: h.present,
    release: h.releaseSurface,
  }),
}));

import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const threadRef = {
  environmentId: "environment-1",
  threadId: "thread-1",
} as ScopedThreadRef;

const mountedTrees: MountedTree[] = [];

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function rerender(mounted: MountedTree, element: ReactElement): Promise<void> {
  await act(async () => mounted.root.render(element));
}

async function unmount(mounted: MountedTree): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
  mountedTrees.splice(mountedTrees.indexOf(mounted), 1);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

async function runCloseTimers(): Promise<void> {
  await act(async () => vi.runAllTimersAsync());
}

function surface(initialUrl: string, tabId = "tab-1"): ReactElement {
  return <BrowserSurfaceSlot threadRef={threadRef} tabId={tabId} initialUrl={initialUrl} visible />;
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 1,
    y: 2,
    width: 300,
    height: 200,
    top: 2,
    right: 301,
    bottom: 202,
    left: 1,
    toJSON: () => ({}),
  });
  h.clearBrowserPointer.mockClear();
  h.closeTab.mockReset().mockImplementation(async (tabId) => {
    h.events.push(`close:${tabId}`);
  });
  h.createTab.mockReset().mockImplementation(async (tabId) => {
    h.events.push(`create:${tabId}`);
  });
  h.events.length = 0;
  h.navigate.mockReset().mockImplementation(async (tabId, url) => {
    h.events.push(`navigate:${tabId}:${url}`);
  });
  h.present.mockClear();
  h.releaseSurface.mockClear();
  h.reportStatus.mockClear();
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  await runCloseTimers();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("BrowserSurfaceSlot native lifecycle", () => {
  it("subscribes before creating and waits for creation before the captured initial navigation", async () => {
    const creation = deferred();
    h.createTab.mockImplementationOnce((tabId) => {
      h.events.push(`create:${tabId}`);
      return creation.promise;
    });

    const mounted = await mount(surface("https://initial.test/"));
    await rerender(mounted, surface("https://stale.test/"));

    expect(h.events).toEqual(["subscribe", "create:tab-1"]);
    expect(h.navigate).not.toHaveBeenCalled();

    creation.resolve();
    await flush();

    expect(h.events).toEqual(["subscribe", "create:tab-1", "navigate:tab-1:https://initial.test/"]);
    expect(h.navigate).toHaveBeenCalledOnce();
  });

  it("shares creation across StrictMode reacquisition and closes after the final release", async () => {
    const creation = deferred();
    h.createTab.mockImplementationOnce((tabId) => {
      h.events.push(`create:${tabId}`);
      return creation.promise;
    });

    const mounted = await mount(<StrictMode>{surface("https://strict.test/")}</StrictMode>);

    expect(h.createTab).toHaveBeenCalledOnce();
    expect(h.closeTab).not.toHaveBeenCalled();

    creation.resolve();
    await flush();

    expect(h.navigate).toHaveBeenCalledExactlyOnceWith("tab-1", "https://strict.test/");

    await unmount(mounted);
    expect(h.closeTab).not.toHaveBeenCalled();
    await runCloseTimers();
    expect(h.closeTab).toHaveBeenCalledExactlyOnceWith("tab-1");
  });

  it("recreates a finally released tab without stale or duplicate initial navigation", async () => {
    const first = await mount(surface("https://first.test/"));
    await flush();
    expect(h.navigate.mock.calls).toEqual([["tab-1", "https://first.test/"]]);

    await unmount(first);
    await runCloseTimers();

    const secondCreation = deferred();
    h.createTab.mockImplementationOnce((tabId) => {
      h.events.push(`create:${tabId}`);
      return secondCreation.promise;
    });
    const second = await mount(surface("https://second.test/"));
    expect(h.createTab).toHaveBeenCalledTimes(2);
    expect(h.navigate.mock.calls).toEqual([["tab-1", "https://first.test/"]]);

    secondCreation.resolve();
    await flush();

    expect(h.navigate.mock.calls).toEqual([
      ["tab-1", "https://first.test/"],
      ["tab-1", "https://second.test/"],
    ]);
    await unmount(second);
    await runCloseTimers();
    expect(h.closeTab).toHaveBeenCalledTimes(2);
  });

  it("captures a fresh initial URL when the rendered slot changes tabs", async () => {
    const mounted = await mount(surface("https://first-tab.test/"));
    await flush();

    await rerender(mounted, surface("https://second-tab.test/", "tab-2"));
    await flush();

    expect(h.navigate.mock.calls).toEqual([
      ["tab-1", "https://first-tab.test/"],
      ["tab-2", "https://second-tab.test/"],
    ]);
  });

  it("releases the lifecycle promptly when unmounted during creation", async () => {
    const creation = deferred();
    h.createTab.mockReturnValueOnce(creation.promise);
    const mounted = await mount(surface("https://pending.test/"));

    await unmount(mounted);
    await runCloseTimers();

    expect(h.closeTab).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(h.navigate).not.toHaveBeenCalled();

    creation.resolve();
    await flush();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
