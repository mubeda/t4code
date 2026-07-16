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

async function openPreset(label: string): Promise<void> {
  await click(byLabel("Browser device preset"));
  const item = Array.from(
    document.querySelectorAll<HTMLElement>("[data-slot='select-item']"),
  ).find((candidate) => candidate.textContent?.includes(label));
  expect(item).toBeDefined();
  await click(item!);
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

    await openPreset("iPhone 12 Pro");

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

  it("returns a known preset to responsive mode and preserves a locked preset ratio", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const onAspectRatioChange = vi.fn();
    await mount(
      <BrowserDeviceToolbar
        {...toolbarProps({
          setting: {
            _tag: "preset",
            presetId: "iphone-12-pro",
            width: 390,
            height: 844,
          },
          width: 320,
          aspectRatio: 390 / 844,
          onChange,
          onAspectRatioChange,
        })}
      />,
    );

    expect(document.body.textContent).not.toContain("Dimensions");
    expect(byLabel("Browser device preset").className).toContain("w-24");
    expect(byLabel("Viewport width").closest('[data-slot="input-control"]')?.className).toContain(
      "w-11",
    );

    await openPreset("Responsive");
    expect(onChange).toHaveBeenCalledWith({ _tag: "freeform", width: 390, height: 844 });

    await click(byLabel("Unlock viewport aspect ratio"));
    expect(onAspectRatioChange).toHaveBeenCalledWith(null);
  });

  it("keeps locked dimensions in sync while editing either axis", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const onAspectRatioChange = vi.fn();
    await mount(
      <BrowserDeviceToolbar
        {...toolbarProps({ aspectRatio: 4 / 3, onChange, onAspectRatioChange, width: 500 })}
      />,
    );
    const widthInput = byLabel<HTMLInputElement>("Viewport width");
    const heightInput = byLabel<HTMLInputElement>("Viewport height");

    await act(async () => widthInput.focus());
    await changeInput(widthInput, "1000");
    expect(heightInput.value).toBe("750");
    await changeInput(heightInput, "900");
    expect(widthInput.value).toBe("1200");

    await click(byLabel("Rotate viewport"));
    expect(onChange).toHaveBeenCalledWith({ _tag: "freeform", width: 900, height: 1200 });
    expect(onAspectRatioChange).toHaveBeenCalledWith(3 / 4);
  });

  it("retains a valid custom draft when persistence rejects and clears an unchanged draft", async () => {
    const onChange = vi.fn().mockRejectedValue(new Error("offline"));
    await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);
    const widthInput = byLabel<HTMLInputElement>("Viewport width");

    await act(async () => widthInput.focus());
    await changeInput(widthInput, "1024");
    await act(async () => {
      widthInput.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(widthInput.value).toBe("1024");
    expect(byLabel<HTMLButtonElement>("Rotate viewport").disabled).toBe(false);

    await changeInput(widthInput, "800");
    await act(async () => {
      widthInput.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(widthInput.value).toBe("800");
  });

  it("rejects fractional and oversized dimensions without changing the viewport", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);
    const widthInput = byLabel<HTMLInputElement>("Viewport width");
    const heightInput = byLabel<HTMLInputElement>("Viewport height");

    await changeInput(widthInput, "800.5");
    expect(widthInput.getAttribute("aria-invalid")).toBe("true");
    await changeInput(widthInput, "4097");
    expect(widthInput.getAttribute("aria-invalid")).toBe("true");
    await changeInput(widthInput, "4096");
    await changeInput(heightInput, "4096");
    expect(heightInput.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      heightInput.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit when focus stays within the toolbar or enters the preset popup", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const container = await mount(<BrowserDeviceToolbar {...toolbarProps({ onChange })} />);
    const widthInput = byLabel<HTMLInputElement>("Viewport width");
    const heightInput = byLabel<HTMLInputElement>("Viewport height");
    await changeInput(widthInput, "1024");

    await act(async () => {
      widthInput.dispatchEvent(
        new FocusEvent("blur", { bubbles: true, relatedTarget: heightInput }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();

    const positioner = document.createElement("div");
    positioner.dataset.slot = "select-positioner";
    document.body.append(positioner);
    await act(async () => {
      container.firstElementChild?.dispatchEvent(
        new FocusEvent("blur", { bubbles: true, relatedTarget: positioner }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
