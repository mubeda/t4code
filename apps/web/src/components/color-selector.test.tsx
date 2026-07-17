// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ColorSelector } from "./color-selector";

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

async function render(size?: "default" | "sm" | "lg", onColorSelect = vi.fn()) {
  await act(async () =>
    root.render(
      <ColorSelector
        colors={["red", "#123456"]}
        defaultValue="red"
        name="accent"
        onColorSelect={onColorSelect}
        className="test-class"
        {...(size === undefined ? {} : { size })}
      />,
    ),
  );
  return onColorSelect;
}

describe("ColorSelector", () => {
  it("renders mapped and custom colors with the default selection", async () => {
    await render();
    const buttons = [...container.querySelectorAll('[role="button"]')] as HTMLDivElement[];

    expect(container.querySelector("input")?.value).toBe("red");
    expect(buttons[0]?.className).toContain("size-5");
    expect(buttons[0]?.style.backgroundColor).toContain("var(--color-red-500)");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.style.backgroundColor).toBe("#123456");
  });

  it("selects by click, Enter, and Space and ignores other keys", async () => {
    const onColorSelect = await render("sm");
    const custom = container.querySelector('[aria-label="Select #123456 color"]') as HTMLDivElement;

    await act(async () => custom.click());
    expect(onColorSelect).toHaveBeenLastCalledWith("#123456");
    expect(container.querySelector("input")?.value).toBe("#123456");
    await act(async () =>
      custom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await act(async () =>
      custom.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    await act(async () =>
      custom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onColorSelect).toHaveBeenCalledTimes(3);
    expect(custom.className).toContain("size-4");
  });

  it("supports large controls without an optional callback or hidden input", async () => {
    await act(async () =>
      root.render(<ColorSelector colors={["blue"]} size="lg" defaultValue="blue" />),
    );
    const button = container.querySelector('[role="button"]') as HTMLDivElement;
    await act(async () => button.click());
    expect(button.className).toContain("size-6");
    expect(container.querySelector("input")).toBeNull();
  });
});
