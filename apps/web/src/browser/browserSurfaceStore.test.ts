import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acquireBrowserSurface,
  resolveBrowserSurfacePanelRect,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";

describe("browserSurfaceStore", () => {
  beforeEach(() => {
    useBrowserSurfaceStore.setState({ byTabId: {} });
  });

  it("tracks content dimensions for a browser that has never been visible", () => {
    const tabId = "hidden-browser-surface-content-test";
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: 0,
      y: 0,
      width: 393,
      height: 852,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    });

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: null,
      visible: false,
      content: { width: 393, height: 852 },
    });
  });

  it("uses the live panel rect for a hidden background tab", () => {
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    expect(
      resolveBrowserSurfacePanelRect(
        {
          hidden: { rect: staleRect, visible: false, content: null, updatedAt: 1, owner: null },
          active: { rect: liveRect, visible: true, content: null, updatedAt: 2, owner: null },
        },
        "hidden",
      ),
    ).toEqual(liveRect);
  });

  it("prefers the requested visible rect, then the latest visible rect, then stale rects", () => {
    const oldVisible = { x: 1, y: 2, width: 3, height: 4 };
    const latestVisible = { x: 5, y: 6, width: 7, height: 8 };
    const stale = { x: 9, y: 10, width: 11, height: 12 };
    const presentations = {
      requested: { rect: latestVisible, visible: true, content: null, updatedAt: 1, owner: null },
      old: { rect: oldVisible, visible: true, content: null, updatedAt: 2, owner: null },
      latest: { rect: latestVisible, visible: true, content: null, updatedAt: 3, owner: null },
      hidden: { rect: stale, visible: false, content: null, updatedAt: 4, owner: null },
      empty: { rect: null, visible: true, content: null, updatedAt: 5, owner: null },
    };

    expect(resolveBrowserSurfacePanelRect(presentations, "requested")).toBe(latestVisible);
    expect(resolveBrowserSurfacePanelRect(presentations, "hidden")).toBe(latestVisible);
    expect(
      resolveBrowserSurfacePanelRect(
        { hidden: presentations.hidden, empty: presentations.empty },
        "hidden",
      ),
    ).toBe(stale);
    expect(resolveBrowserSurfacePanelRect({}, "missing")).toBeNull();
  });

  it("keeps claim, presentation, and release operations idempotent", () => {
    const owner = Symbol("owner");
    const staleOwner = Symbol("stale");
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    const store = useBrowserSurfaceStore.getState();

    store.claim("tab", owner);
    const claimed = useBrowserSurfaceStore.getState().byTabId.tab;
    store.claim("tab", owner);
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toBe(claimed);

    store.present("tab", staleOwner, rect, true);
    expect(useBrowserSurfaceStore.getState().byTabId.tab?.visible).toBe(false);
    store.present("tab", owner, rect, true);
    const presented = useBrowserSurfaceStore.getState().byTabId.tab;
    store.present("tab", owner, rect, true);
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toBe(presented);

    store.release("tab", staleOwner);
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toBe(presented);
    store.release("tab", owner);
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      visible: false,
      owner: null,
    });
  });

  it("updates a presented rect when any coordinate or dimension changes", () => {
    const owner = Symbol("owner");
    const store = useBrowserSurfaceStore.getState();
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    store.claim("tab", owner);
    store.present("tab", owner, rect, true);

    for (const next of [
      { ...rect, x: 10 },
      { ...rect, y: 20 },
      { ...rect, width: 30 },
      { ...rect, height: 40 },
    ]) {
      store.present("tab", owner, next, true);
      expect(useBrowserSurfaceStore.getState().byTabId.tab?.rect).toEqual(next);
      store.present("tab", owner, rect, true);
    }
    store.present("tab", owner, rect, false);
    expect(useBrowserSurfaceStore.getState().byTabId.tab?.visible).toBe(false);
  });

  it("preserves prior rect and content when a new owner claims the tab", () => {
    const content = {
      x: 0,
      y: 0,
      width: 393,
      height: 852,
      scale: 1,
      scrollLeft: 0,
      scrollTop: 0,
    };
    const store = useBrowserSurfaceStore.getState();
    store.presentContent("tab", content);
    store.claim("tab", Symbol("owner"));

    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      rect: null,
      content,
    });
  });

  it("skips identical content and updates every changed content field", () => {
    const content = {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      scale: 1,
      scrollLeft: 5,
      scrollTop: 6,
    };
    const store = useBrowserSurfaceStore.getState();
    store.presentContent("tab", content);
    const initial = useBrowserSurfaceStore.getState().byTabId.tab;
    store.presentContent("tab", { ...content });
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toBe(initial);

    for (const next of [
      { ...content, x: 10 },
      { ...content, y: 20 },
      { ...content, width: 30 },
      { ...content, height: 40 },
      { ...content, scale: 2 },
      { ...content, scrollLeft: 50 },
      { ...content, scrollTop: 60 },
    ]) {
      store.presentContent("tab", next);
      expect(useBrowserSurfaceStore.getState().byTabId.tab?.content).toEqual(next);
      store.presentContent("tab", content);
    }
  });

  it("ignores updates and releases from a stale surface lease", () => {
    const tabId = "leased-browser-surface";
    const staleRect = { x: 0, y: 0, width: 500, height: 700 };
    const liveRect = { x: 10, y: 20, width: 900, height: 640 };
    const staleLease = acquireBrowserSurface(tabId);
    staleLease.present(staleRect, true);

    const liveLease = acquireBrowserSurface(tabId);
    liveLease.present(liveRect, true);
    staleLease.present(staleRect, true);
    staleLease.release();

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      rect: liveRect,
      visible: true,
    });
  });

  it("hides a surface when its current lease is released", () => {
    const tabId = "released-browser-surface";
    const lease = acquireBrowserSurface(tabId);
    lease.present({ x: 10, y: 20, width: 900, height: 640 }, true);

    lease.release();
    lease.release();
    lease.present({ x: 0, y: 0, width: 1, height: 1 }, true);

    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      visible: false,
      owner: null,
    });
  });
});
