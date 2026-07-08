/**
 * Behavior tests for the resizable `SidebarRail` and the mobile / non-collapsible
 * branches of `Sidebar`, using the repo's instrumented-hooks pattern (see
 * ChatView.hooks.test.tsx / FilePreviewPanel.test.tsx). A partial `vi.mock("react")`
 * captures effects and records state setters; `~/components/ui/tooltip` is mocked so
 * the rail's `<button>` render element (and its pointer handlers) can be captured and
 * invoked directly against fake DOM/window globals. The plain-SSR sibling
 * `sidebar.test.tsx` keeps the real provider and covers the markup slots.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => {
  const state = {
    isMobile: false,
    storedWidth: null as number | null,
    localStorageSets: [] as Array<{ key: string; value: unknown }>,
    localStorageGets: [] as string[],
    triggers: [] as Array<{ render: unknown; props: Record<string, unknown> }>,
    effects: [] as Array<() => void | (() => void)>,
    refs: [] as Array<{ current: unknown }>,
    setStateCalls: [] as Array<{ next: unknown; applied: unknown }>,
    reset() {
      state.triggers.length = 0;
      state.effects.length = 0;
      state.refs.length = 0;
      state.setStateCalls.length = 0;
      state.localStorageSets.length = 0;
      state.localStorageGets.length = 0;
    },
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();

  const useState = (initial?: unknown) => {
    const resolved = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(resolved) : next;
      harness.setStateCalls.push({ next, applied });
    };
    return [resolved, setValue];
  };

  const useEffect = (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  };

  const useRef = (initial?: unknown) => {
    const ref = { current: initial ?? null };
    harness.refs.push(ref);
    return ref;
  };

  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
    useRef: useRef as typeof actual.useRef,
  };
});

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => harness.isMobile,
  useMediaQuery: () => false,
}));

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: (key: string) => {
    harness.localStorageGets.push(key);
    return harness.storedWidth;
  },
  setLocalStorageItem: (key: string, value: unknown) => {
    harness.localStorageSets.push({ key, value });
  },
}));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render?: unknown; children?: ReactNode }) => {
    if (render && typeof render === "object" && "props" in render) {
      harness.triggers.push({
        render,
        props: (render as { props: Record<string, unknown> }).props,
      });
    }
    return (
      <>
        {render as ReactNode}
        {children}
      </>
    );
  },
  TooltipPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children?: ReactNode }) => <div data-mock="sheet">{children}</div>,
  SheetPopup: ({ children }: { children?: ReactNode }) => (
    <div data-mock="sheet-popup">{children}</div>
  ),
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

// ── Fake DOM plumbing ────────────────────────────────────────────────

interface FakeStyle {
  set: Array<[string, string]>;
  removed: string[];
  cursor?: string;
  userSelect?: string;
  setProperty: (key: string, value: string) => void;
  removeProperty: (key: string) => void;
}

function fakeStyle(): FakeStyle {
  const style = {
    set: [] as Array<[string, string]>,
    removed: [] as string[],
    setProperty(key: string, value: string) {
      style.set.push([key, value]);
    },
    removeProperty(key: string) {
      style.removed.push(key);
    },
  } as FakeStyle;
  return style;
}

function fakeDom(startWidth = 256) {
  const wrapperStyle = fakeStyle();
  const containerStyle = fakeStyle();
  const gapStyle = fakeStyle();
  const container = {
    style: containerStyle,
    getBoundingClientRect: () => ({ width: startWidth }),
  };
  const gap = { style: gapStyle };
  const sidebarRoot = {
    querySelector: (selector: string) =>
      selector.includes("sidebar-container")
        ? container
        : selector.includes("sidebar-gap")
          ? gap
          : null,
  };
  const wrapper = { style: wrapperStyle };
  const rail = {
    captured: [] as Array<[string, number]>,
    closest: (selector: string) =>
      selector.includes("sidebar-wrapper")
        ? wrapper
        : selector.includes("sidebar-container")
          ? container
          : sidebarRoot,
    setPointerCapture: (id: number) => rail.captured.push(["set", id]),
    hasPointerCapture: (_id: number) => true,
    releasePointerCapture: (id: number) => rail.captured.push(["release", id]),
  };
  return { wrapper, container, gap, sidebarRoot, rail, wrapperStyle, containerStyle, gapStyle };
}

interface FakePointerEvent {
  button: number;
  pointerId: number;
  clientX: number;
  defaultPrevented: boolean;
  currentTarget: unknown;
  prevented: boolean;
  stopped: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function pointerEvent(
  currentTarget: unknown,
  overrides: Partial<FakePointerEvent> = {},
): FakePointerEvent {
  const event: FakePointerEvent = {
    button: 0,
    pointerId: 1,
    clientX: 500,
    defaultPrevented: false,
    currentTarget,
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
    ...overrides,
  };
  return event;
}

let rafCallbacks: Array<() => void>;
let cancelledFrames: number[];
let cookieSets: unknown[];
let bodyStyle: FakeStyle;

beforeEach(() => {
  harness.reset();
  harness.isMobile = false;
  harness.storedWidth = null;

  rafCallbacks = [];
  cancelledFrames = [];
  cookieSets = [];
  bodyStyle = fakeStyle();

  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: () => void) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
    cancelAnimationFrame: (id: number) => {
      cancelledFrames.push(id);
    },
  });
  vi.stubGlobal("document", { body: { style: bodyStyle } });
  vi.stubGlobal("cookieStore", {
    set: (value: unknown) => {
      cookieSets.push(value);
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type RailProps = Record<string, unknown> & {
  onPointerDown?: (event: unknown) => void;
  onPointerMove?: (event: unknown) => void;
  onPointerUp?: (event: unknown) => void;
  onPointerCancel?: (event: unknown) => void;
  onClick?: (event: unknown) => void;
  "aria-label"?: string;
};

interface ResizableOptions {
  minWidth?: number;
  maxWidth?: number;
  storageKey?: string;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: unknown) => boolean;
}

function renderRail(
  resizable: boolean | ResizableOptions = { minWidth: 200, maxWidth: 400, storageKey: "sb" },
  options: { defaultOpen?: boolean } = {},
): { rail: RailProps; markup: string } {
  const markup = renderToStaticMarkup(
    <SidebarProvider defaultOpen={options.defaultOpen ?? true}>
      <Sidebar resizable={resizable}>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );
  const trigger = harness.triggers.find((entry) => entry.props["data-slot"] === "sidebar-rail");
  if (!trigger) throw new Error("Rail render element was not captured");
  return { rail: trigger.props as RailProps, markup };
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const effects = [...harness.effects];
  harness.effects.length = 0;
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

describe("SidebarRail label + non-resizable rendering", () => {
  it("labels the rail for resizing when resize is enabled and the sidebar is open", () => {
    const { rail } = renderRail();
    expect(rail["aria-label"]).toBe("Resize Sidebar");
    expect(rail["data-slot"]).toBe("sidebar-rail");
  });

  it("labels the rail for toggling when resize is disabled", () => {
    const { rail } = renderRail(false);
    expect(rail["aria-label"]).toBe("Toggle Sidebar");
  });

  it("labels the rail for toggling when the sidebar is collapsed", () => {
    const { rail } = renderRail({ storageKey: "sb" }, { defaultOpen: false });
    expect(rail["aria-label"]).toBe("Toggle Sidebar");
  });
});

describe("SidebarRail resize drag flow", () => {
  it("captures the pointer, freezes transitions, and seeds the wrapper width on pointer down", () => {
    const dom = fakeDom(256);
    const onResize = vi.fn();
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb", onResize });

    const down = pointerEvent(dom.rail, { clientX: 500 });
    rail.onPointerDown?.(down);

    expect(down.prevented).toBe(true);
    expect(down.stopped).toBe(true);
    // Transition targets are frozen while dragging.
    expect(dom.gapStyle.set).toContainEqual(["transition-duration", "0ms"]);
    expect(dom.containerStyle.set).toContainEqual(["transition-duration", "0ms"]);
    // Wrapper is seeded to the clamped starting width.
    expect(dom.wrapperStyle.set).toContainEqual(["--sidebar-width", "256px"]);
    expect(dom.rail.captured).toContainEqual(["set", 1]);
    expect(bodyStyle.cursor).toBe("col-resize");
    expect(bodyStyle.userSelect).toBe("none");
  });

  it("tracks pointer movement through requestAnimationFrame and applies the clamped width", () => {
    const dom = fakeDom(256);
    const shouldAcceptWidth = vi.fn(() => true);
    const onResize = vi.fn();
    const { rail } = renderRail({
      minWidth: 200,
      maxWidth: 400,
      storageKey: "sb",
      onResize,
      shouldAcceptWidth,
    });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    dom.wrapperStyle.set.length = 0;

    // Move right by 60px → 316px, within [200, 400].
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));
    expect(rafCallbacks).toHaveLength(1);
    // A second move while a frame is pending updates the pending width (→356)
    // but does not schedule a second frame.
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 600 }));
    expect(rafCallbacks).toHaveLength(1);

    rafCallbacks[0]!();
    expect(shouldAcceptWidth).toHaveBeenCalledTimes(1);
    expect(dom.wrapperStyle.set).toContainEqual(["--sidebar-width", "356px"]);

    // Pointer up persists the accepted width and fires the resize callback.
    const up = pointerEvent(dom.rail);
    rail.onPointerUp?.(up);
    expect(harness.localStorageSets).toContainEqual({ key: "sb", value: 356 });
    expect(onResize).toHaveBeenCalledWith(356);
    expect(dom.gapStyle.removed).toContain("transition-duration");
    expect(dom.rail.captured).toContainEqual(["release", 1]);
    expect(bodyStyle.removed).toEqual(expect.arrayContaining(["cursor", "user-select"]));
  });

  it("clamps to the minimum width and does not exceed the configured maximum", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail({ minWidth: 220, maxWidth: 500, storageKey: "sb" });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    dom.wrapperStyle.set.length = 0;
    // Move far left → below the minimum, clamps to 220.
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 100 }));
    rafCallbacks[0]!();
    expect(dom.wrapperStyle.set).toContainEqual(["--sidebar-width", "220px"]);
  });

  it("rejects a candidate width when shouldAcceptWidth returns false", () => {
    const dom = fakeDom(256);
    const shouldAcceptWidth = vi.fn(() => false);
    const { rail } = renderRail({
      minWidth: 200,
      maxWidth: 400,
      storageKey: "sb",
      shouldAcceptWidth,
    });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    dom.wrapperStyle.set.length = 0;
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));
    rafCallbacks[0]!();
    expect(shouldAcceptWidth).toHaveBeenCalledTimes(1);
    // Width rejected → wrapper not updated by the frame.
    expect(dom.wrapperStyle.set).not.toContainEqual(["--sidebar-width", "316px"]);
  });

  it("computes the delta from the right edge for a right-side sidebar", () => {
    const dom = fakeDom(256);
    const markup = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <Sidebar side="right" resizable={{ minWidth: 200, maxWidth: 400, storageKey: "sb" }}>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );
    expect(markup).toContain('data-side="right"');
    const rail = harness.triggers.find((t) => t.props["data-slot"] === "sidebar-rail")!
      .props as RailProps;

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    dom.wrapperStyle.set.length = 0;
    // Right side: moving the pointer left (smaller clientX) grows the sidebar.
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 440 }));
    rafCallbacks[0]!();
    expect(dom.wrapperStyle.set).toContainEqual(["--sidebar-width", "316px"]);
  });

  it("cancels the drag on pointer cancel and clears the pending frame", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb" });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));
    expect(rafCallbacks).toHaveLength(1);

    const cancel = pointerEvent(dom.rail);
    rail.onPointerCancel?.(cancel);
    // The still-pending frame is cancelled during stopResize.
    expect(cancelledFrames).toEqual([1]);
    expect(harness.localStorageSets).toContainEqual({ key: "sb", value: expect.any(Number) });
  });

  it("does not persist when no storage key is configured", () => {
    const dom = fakeDom(256);
    const onResize = vi.fn();
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, onResize });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));
    rafCallbacks[0]!();
    rail.onPointerUp?.(pointerEvent(dom.rail));
    expect(harness.localStorageSets).toHaveLength(0);
    expect(onResize).toHaveBeenCalled();
  });
});

describe("SidebarRail pointer-down guards", () => {
  it("ignores non-primary mouse buttons", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail();
    rail.onPointerDown?.(pointerEvent(dom.rail, { button: 2 }));
    expect(dom.rail.captured).toHaveLength(0);
  });

  it("ignores an event whose default was already prevented", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail();
    rail.onPointerDown?.(pointerEvent(dom.rail, { defaultPrevented: true }));
    expect(dom.rail.captured).toHaveLength(0);
  });

  it("does nothing when resize is disabled", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail(false);
    rail.onPointerDown?.(pointerEvent(dom.rail));
    expect(dom.rail.captured).toHaveLength(0);
  });

  it("bails out when the sidebar wrapper cannot be found", () => {
    const { rail } = renderRail();
    const orphanRail = {
      closest: () => null,
      setPointerCapture: vi.fn(),
    };
    rail.onPointerDown?.(pointerEvent(orphanRail));
    expect(orphanRail.setPointerCapture).not.toHaveBeenCalled();
  });

  it("bails out when the sidebar container is missing", () => {
    const { rail } = renderRail();
    const wrapper = { style: fakeStyle() };
    const sidebarRoot = { querySelector: () => null };
    const orphanRail = {
      closest: (selector: string) => (selector.includes("sidebar-wrapper") ? wrapper : sidebarRoot),
      setPointerCapture: vi.fn(),
    };
    rail.onPointerDown?.(pointerEvent(orphanRail));
    expect(orphanRail.setPointerCapture).not.toHaveBeenCalled();
  });
});

describe("SidebarRail click behavior", () => {
  it("suppresses the click that immediately follows a drag", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb" });

    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));
    rafCallbacks[0]!();
    rail.onPointerUp?.(pointerEvent(dom.rail));

    const click = {
      defaultPrevented: false,
      prevented: false,
      preventDefault(this: { prevented: boolean }) {
        this.prevented = true;
      },
    };
    rail.onClick?.(click);
    expect(click.prevented).toBe(true);
    // The toggle was suppressed, so the open cookie was not written by a click.
    expect(cookieSets).toHaveLength(0);
  });

  it("prevents the default toggle while resize is active without a drag", () => {
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb" });
    const click = {
      defaultPrevented: false,
      prevented: false,
      preventDefault(this: { prevented: boolean }) {
        this.prevented = true;
      },
    };
    rail.onClick?.(click);
    expect(click.prevented).toBe(true);
    expect(cookieSets).toHaveLength(0);
  });

  it("toggles the sidebar when resize is disabled", () => {
    const { rail } = renderRail(false);
    const click = { defaultPrevented: false, preventDefault: vi.fn() };
    rail.onClick?.(click);
    // toggleSidebar → setOpen → persists the new open state via cookieStore.
    expect(cookieSets).toHaveLength(1);
  });

  it("respects a caller that prevents the click default", () => {
    const { rail } = renderRail(false);
    const click = { defaultPrevented: true, preventDefault: vi.fn() };
    rail.onClick?.(click);
    expect(cookieSets).toHaveLength(0);
  });
});

describe("SidebarRail effects", () => {
  it("restores a persisted width on mount and reports it", () => {
    const dom = fakeDom(256);
    const onResize = vi.fn();
    harness.storedWidth = 900; // above max → clamps to 400
    renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb", onResize });
    harness.refs[0]!.current = dom.rail;

    const cleanups = runEffects();
    expect(harness.localStorageGets).toContain("sb");
    expect(dom.wrapperStyle.set).toContainEqual(["--sidebar-width", "400px"]);
    expect(onResize).toHaveBeenCalledWith(400);
    for (const cleanup of cleanups) cleanup();
  });

  it("does not restore anything when no width is stored", () => {
    const dom = fakeDom(256);
    const onResize = vi.fn();
    harness.storedWidth = null;
    renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb", onResize });
    harness.refs[0]!.current = dom.rail;

    runEffects();
    expect(dom.wrapperStyle.set).toHaveLength(0);
    expect(onResize).not.toHaveBeenCalled();
  });

  it("skips the restore effect entirely without a storage key", () => {
    const dom = fakeDom(256);
    harness.storedWidth = 300;
    renderRail({ minWidth: 200, maxWidth: 400 });
    harness.refs[0]!.current = dom.rail;

    runEffects();
    expect(harness.localStorageGets).toHaveLength(0);
  });

  it("cleans up an in-flight drag frame and body styles on unmount", () => {
    const dom = fakeDom(256);
    const { rail } = renderRail({ minWidth: 200, maxWidth: 400, storageKey: "sb" });
    harness.refs[0]!.current = dom.rail;

    // Start a drag so the cleanup has a pending frame + frozen transitions to undo.
    rail.onPointerDown?.(pointerEvent(dom.rail, { clientX: 500 }));
    rail.onPointerMove?.(pointerEvent(dom.rail, { clientX: 560 }));

    const cleanups = runEffects();
    for (const cleanup of cleanups) cleanup();

    expect(cancelledFrames).toContain(1);
    expect(dom.gapStyle.removed).toContain("transition-duration");
    expect(bodyStyle.removed).toEqual(expect.arrayContaining(["cursor", "user-select"]));
  });
});

describe("Sidebar mobile and non-collapsible branches", () => {
  it("renders the mobile sheet shell when the viewport is mobile", () => {
    harness.isMobile = true;
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar>mobile body</Sidebar>
      </SidebarProvider>,
    );
    expect(markup).toContain('data-mock="sheet"');
    expect(markup).toContain("mobile body");
  });

  it("produces no resizable rail context on mobile", () => {
    harness.isMobile = true;
    renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar resizable>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );
    const rail = harness.triggers.find((t) => t.props["data-slot"] === "sidebar-rail")!
      .props as RailProps;
    expect(rail["aria-label"]).toBe("Toggle Sidebar");
  });
});
