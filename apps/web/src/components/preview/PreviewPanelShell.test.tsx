import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  stateValue: undefined as number | undefined,
  nextWidth: null as number | null,
  effects: [] as Array<() => void | (() => void)>,
  resizeOptions: [] as Array<Record<string, unknown>>,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  requestAnimationFrame: vi.fn(),
  cancelAnimationFrame: vi.fn(),
  resizeHandler: null as (() => void) | null,
  frameCallback: null as (() => void) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useState: (initial: number | (() => number)) => [
    harness.stateValue ?? (typeof initial === "function" ? initial() : initial),
    (value: number) => (harness.nextWidth = value),
  ],
}));
vi.mock("~/hooks/useResizableWidth", () => ({
  useResizableWidth: (options: Record<string, unknown>) => {
    harness.resizeOptions.push(options);
    return { width: 620, handlers: { onPointerDown: vi.fn() } };
  },
}));
vi.mock("./RightPanelResizeHandle", () => ({
  RightPanelResizeHandle: () => <div data-resize-handle />,
}));

import { PreviewPanelShell } from "./PreviewPanelShell";

beforeEach(() => {
  harness.stateValue = undefined;
  harness.nextWidth = null;
  harness.effects.length = 0;
  harness.resizeOptions.length = 0;
  harness.addEventListener.mockReset();
  harness.removeEventListener.mockReset();
  harness.requestAnimationFrame.mockReset();
  harness.cancelAnimationFrame.mockReset();
  harness.resizeHandler = null;
  harness.frameCallback = null;
});

function render(mode: "inline" | "sheet" | "sidebar" | "embedded", maximized?: boolean): string {
  return renderToStaticMarkup(
    <PreviewPanelShell mode={mode} {...(maximized === undefined ? {} : { maximized })}>
      preview
    </PreviewPanelShell>,
  );
}

describe("PreviewPanelShell", () => {
  it("uses the server viewport fallback and renders inline width and handle", () => {
    vi.stubGlobal("window", undefined);
    const markup = render("inline");

    expect(markup).toContain("width:620px");
    expect(markup).toContain("data-resize-handle");
    expect(harness.resizeOptions[0]).toMatchObject({ maxWidth: 896, edge: "left" });
    expect(harness.effects[0]?.()).toBeUndefined();
  });

  it("renders maximized and parent-sized modes without inline width", () => {
    expect(render("inline", true)).not.toContain("width:620px");
    expect(render("sheet")).toContain("w-full");
    expect(render("sidebar")).toContain('data-preview-panel-mode="sidebar"');
    expect(render("embedded")).toContain('data-preview-panel-maximized="false"');
  });

  it("coalesces browser resizes and cancels a pending frame on cleanup", () => {
    harness.stateValue = 2000;
    harness.requestAnimationFrame.mockImplementation((callback: () => void) => {
      harness.frameCallback = callback;
      return 9;
    });
    vi.stubGlobal("window", {
      innerWidth: 2000,
      addEventListener: (type: string, handler: () => void) => {
        harness.addEventListener(type, handler);
        harness.resizeHandler = handler;
      },
      removeEventListener: harness.removeEventListener,
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    render("inline");
    const cleanup = harness.effects[0]?.();
    harness.resizeHandler?.();
    harness.resizeHandler?.();
    expect(harness.requestAnimationFrame).toHaveBeenCalledOnce();
    if (typeof cleanup === "function") cleanup();
    expect(harness.cancelAnimationFrame).toHaveBeenCalledWith(9);

    harness.frameCallback?.();
    expect(harness.nextWidth).toBe(2000);
  });
});
