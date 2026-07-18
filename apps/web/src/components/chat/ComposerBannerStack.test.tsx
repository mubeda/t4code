// @vitest-environment happy-dom

import { act, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("lucide-react", () => ({
  XIcon: () => <span data-icon="close" />,
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: ReadonlyArray<unknown>) => values.filter(Boolean).join(" "),
}));

vi.mock("../ui/alert", () => ({
  Alert: ({ children, variant }: { children?: ReactNode; variant?: string }) => (
    <section data-alert data-variant={variant}>
      {children}
    </section>
  ),
  AlertAction: ({ children, ...props }: ComponentPropsWithoutRef<"div">) => (
    <div data-alert-action {...props}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: { children?: ReactNode }) => (
    <p data-alert-description>{children}</p>
  ),
  AlertTitle: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentPropsWithoutRef<"button"> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
}));

import { type ComposerBannerStackItem, ComposerBannerStack } from "./ComposerBannerStack";

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];

function item(
  id: string,
  overrides: Partial<ComposerBannerStackItem> = {},
): ComposerBannerStackItem {
  return {
    id,
    variant: "warning",
    icon: <span data-banner-icon={id} />,
    title: `Title ${id}`,
    description: `Description ${id}`,
    ...overrides,
  };
}

function renderStack(
  items: ReadonlyArray<ComposerBannerStackItem>,
  className?: string,
): ReactElement {
  return <ComposerBannerStack items={items} {...(className ? { className } : {})} />;
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  act(() => root.render(element));
  return mounted;
}

async function click(element: HTMLElement): Promise<void> {
  act(() => element.click());
}

function dismissButton(container: HTMLElement, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (result === null) throw new Error(`Missing dismiss button ${label}.`);
  return result;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ComposerBannerStack", () => {
  it("renders nothing for an empty stack", async () => {
    const mounted = await mount(renderStack([]));

    expect(mounted.container.innerHTML).toBe("");
  });

  it("renders the front banner, optional content, and custom class", async () => {
    const mounted = await mount(
      renderStack(
        [
          item("front", {
            variant: "error",
            actions: <button data-custom-action>Retry</button>,
          }),
        ],
        "custom-stack",
      ),
    );

    expect(mounted.container.firstElementChild?.className).toContain("custom-stack");
    expect(mounted.container.querySelector("[data-alert]")?.getAttribute("data-variant")).toBe(
      "error",
    );
    expect(mounted.container.textContent).toContain("Description front");
    expect(mounted.container.querySelector("[data-custom-action]")?.textContent).toBe("Retry");
  });

  it("renders collapsed and expanded stack layers", async () => {
    const mounted = await mount(renderStack([item("front"), item("second"), item("third")]));

    expect(mounted.container.querySelectorAll("[data-alert]")).toHaveLength(3);
    expect(mounted.container.querySelector("[aria-hidden=true]")).not.toBeNull();
    expect(mounted.container.textContent).toContain("Title second");
    expect(mounted.container.textContent).toContain("Title third");
  });

  it("dismisses the front banner once after its exit transition", async () => {
    const onDismiss = vi.fn();
    const mounted = await mount(
      renderStack([item("front", { onDismiss, dismissLabel: "Dismiss front" }), item("second")]),
    );
    const button = dismissButton(mounted.container, "Dismiss front");

    await click(button);
    await click(button);

    expect(button.disabled).toBe(true);
    expect(mounted.container.querySelector("[aria-hidden=true]")).toBeNull();
    expect(button.closest("[style]")?.getAttribute("style")).toContain("translate3d(0, 4rem, 0)");
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(220));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses the stacked exit motion for a background banner", async () => {
    const onDismiss = vi.fn();
    const mounted = await mount(
      renderStack([item("front"), item("second", { onDismiss, dismissLabel: "Dismiss second" })]),
    );
    const button = dismissButton(mounted.container, "Dismiss second");

    await click(button);

    expect(button.closest("[style]")?.getAttribute("style")).toContain("translate3d(0, 7rem, 0)");
    act(() => vi.advanceTimersByTime(220));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("guards concurrent dismissal and replaces a pending removed-item timeout", async () => {
    const dismissFront = vi.fn();
    const dismissSecond = vi.fn();
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const second = item("second", {
      onDismiss: dismissSecond,
      dismissLabel: "Dismiss second",
    });
    const mounted = await mount(renderStack([item("front", { onDismiss: dismissFront }), second]));

    await click(dismissButton(mounted.container, "Dismiss warning"));
    await click(dismissButton(mounted.container, "Dismiss second"));
    expect(dismissFront).not.toHaveBeenCalled();
    expect(dismissSecond).not.toHaveBeenCalled();

    act(() => mounted.root.render(renderStack([second])));
    await click(dismissButton(mounted.container, "Dismiss second"));
    expect(clearTimeout).toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(220));
    expect(dismissFront).not.toHaveBeenCalled();
    expect(dismissSecond).toHaveBeenCalledOnce();
  });

  it("clears pending dismissal on unmount", async () => {
    const onDismiss = vi.fn();
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
    const mounted = await mount(
      renderStack([item("front", { onDismiss, dismissLabel: "Dismiss front" })]),
    );
    await click(dismissButton(mounted.container, "Dismiss front"));

    act(() => mounted.root.unmount());
    mountedTrees.splice(mountedTrees.indexOf(mounted), 1);
    act(() => vi.advanceTimersByTime(220));

    expect(clearTimeout).toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("omits action chrome when a banner has no actions or dismissal", async () => {
    const mounted = await mount(renderStack([item("front", { description: undefined })]));

    expect(mounted.container.querySelector("[data-alert-description]")).toBeNull();
    expect(mounted.container.querySelector("[data-alert-action]")).toBeNull();
    expect(mounted.container.querySelector("button")).toBeNull();
  });
});
