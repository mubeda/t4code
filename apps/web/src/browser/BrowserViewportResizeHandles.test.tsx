// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import type { BrowserViewportLayout } from "./browserViewportLayout";

const layout = {
  viewportX: 20,
  viewportY: 30,
  viewportWidth: 400,
  viewportHeight: 300,
} as BrowserViewportLayout;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("BrowserViewportResizeHandles", () => {
  it("renders every edge and forwards pointer and keyboard events", async () => {
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    await act(async () =>
      root.render(
        <BrowserViewportResizeHandles
          layout={layout}
          activeDirection="southwest"
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        />,
      ),
    );

    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(5);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("left edge"),
      expect.stringContaining("right edge"),
      expect.stringContaining("bottom edge"),
      expect.stringContaining("bottom-left corner"),
      expect.stringContaining("bottom-right corner"),
    ]);
    expect(buttons[3]?.innerHTML).toContain("-scale-x-100");

    buttons[0]?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    buttons[4]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onPointerDown).toHaveBeenCalledWith("west", expect.anything());
    expect(onKeyDown).toHaveBeenCalledWith("southeast", expect.anything());
  });
});
