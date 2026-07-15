// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";

type ToolbarProps = Parameters<typeof BrowserDeviceToolbar>[0];

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(element));
  return container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function toolbarProps(overrides: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    setting: { _tag: "freeform", width: 800, height: 600 },
    width: 640,
    aspectRatio: null,
    onAspectRatioChange: vi.fn(),
    onChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function byLabel<T extends HTMLElement>(label: string): T {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  return element!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

describe("BrowserDeviceToolbar mounted interactions", () => {
  it("commits edited dimensions through the rendered inputs", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);

    const widthInput = byLabel<HTMLInputElement>("Viewport width");
    const heightInput = byLabel<HTMLInputElement>("Viewport height");
    await act(async () => widthInput.focus());
    await changeInput(widthInput, "1024");
    await changeInput(heightInput, "720");
    await act(async () => {
      widthInput.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ _tag: "freeform", width: 1024, height: 720 });
    expect(widthInput.value).toBe("800");
    expect(heightInput.value).toBe("600");
  });

  it("locks, rotates, and closes the viewport with real toolbar buttons", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const onAspectRatioChange = vi.fn();
    await mount(
      <BrowserDeviceToolbar
        {...toolbarProps({ onChange, onAspectRatioChange, aspectRatio: null })}
      />,
    );

    await click(byLabel("Lock viewport aspect ratio"));
    expect(onAspectRatioChange).toHaveBeenCalledWith(800 / 600);

    await click(byLabel("Rotate viewport"));
    expect(onChange).toHaveBeenCalledWith({ _tag: "freeform", width: 600, height: 800 });

    await click(byLabel("Close device toolbar"));
    expect(onChange).toHaveBeenLastCalledWith({ _tag: "fill" });
    expect(onAspectRatioChange).toHaveBeenLastCalledWith(null);
  });

  it("opens the rendered preset control and selects a device", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);

    await click(byLabel("Browser device preset"));
    const preset = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slot='select-item']"),
    ).find((item) => item.textContent?.includes("iPhone 12 Pro"));
    expect(preset).toBeDefined();
    await click(preset!);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "preset", presetId: "iphone-12-pro" }),
    );
  });

  it("keeps an invalid draft visible and does not submit it on blur", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const container = await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);
    const widthInput = byLabel<HTMLInputElement>("Viewport width");

    await act(async () => widthInput.focus());
    await changeInput(widthInput, "1");
    expect(widthInput.getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      widthInput.blur();
      container.dispatchEvent(
        new FocusEvent("blur", { bubbles: true, relatedTarget: document.body }),
      );
    });

    expect(onChange).not.toHaveBeenCalled();
  });
});
