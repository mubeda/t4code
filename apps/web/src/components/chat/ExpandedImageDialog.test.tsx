import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  offset: 0,
  nextOffsets: [] as number[],
  effects: [] as Array<() => void | (() => void)>,
  buttons: [] as Array<Record<string, unknown>>,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useState: () => [
    harness.offset,
    (update: (current: number) => number) => harness.nextOffsets.push(update(harness.offset)),
  ],
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return (
      <button aria-label={props["aria-label"] as string}>
        {props.children as React.ReactNode}
      </button>
    );
  },
}));

import { ExpandedImageDialog } from "./ExpandedImageDialog";

const images = [
  { src: "data:image/png;base64,one", name: "one.png" },
  { src: "data:image/png;base64,two", name: "two.png" },
] as ExpandedImagePreview["images"];

beforeEach(() => {
  harness.offset = 0;
  harness.nextOffsets.length = 0;
  harness.effects.length = 0;
  harness.buttons.length = 0;
  harness.addEventListener.mockReset();
  harness.removeEventListener.mockReset();
  vi.stubGlobal("window", {
    addEventListener: harness.addEventListener,
    removeEventListener: harness.removeEventListener,
  });
});

function render(preview: ExpandedImagePreview, onClose = vi.fn()): string {
  return renderToStaticMarkup(<ExpandedImageDialog preview={preview} onClose={onClose} />);
}

function keyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
}

describe("ExpandedImageDialog", () => {
  it("renders nothing when the selected image is missing", () => {
    expect(render({ images: [], index: 0 })).toBe("");
  });

  it("renders a single image without navigation", () => {
    const markup = render({ images: [images[0]!], index: 0 });

    expect(markup).toContain("one.png");
    expect(markup).not.toContain("Previous image");
    expect(markup).not.toContain("(1/1)");
  });

  it("wraps image navigation in both directions", () => {
    const onClose = vi.fn();
    let markup = render({ images, index: 0 }, onClose);
    expect(markup).toContain("one.png (1/2)");
    const previous = harness.buttons.find((button) => button["aria-label"] === "Previous image");
    const next = harness.buttons.find((button) => button["aria-label"] === "Next image");
    if (!previous || !next) throw new Error("Expected navigation buttons");
    (previous.onClick as () => void)();
    (next.onClick as () => void)();
    expect(harness.nextOffsets).toEqual([-1, 1]);

    harness.offset = -1;
    markup = render({ images, index: 0 }, onClose);
    expect(markup).toContain("two.png (2/2)");
  });

  it("handles keyboard navigation, close, ignored keys, and cleanup", () => {
    const onClose = vi.fn();
    render({ images, index: 0 }, onClose);
    const cleanup = harness.effects[0]?.();
    const handler = harness.addEventListener.mock.calls[0]?.[1] as (event: KeyboardEvent) => void;

    handler(keyEvent("Escape"));
    expect(onClose).toHaveBeenCalledOnce();
    handler(keyEvent("ArrowLeft"));
    handler(keyEvent("ArrowRight"));
    handler(keyEvent("Enter"));
    expect(harness.nextOffsets).toEqual([-1, 1]);
    if (typeof cleanup === "function") cleanup();
    expect(harness.removeEventListener).toHaveBeenCalledWith("keydown", handler);
  });

  it("ignores navigation keys for one image", () => {
    render({ images: [images[0]!], index: 0 });
    harness.effects[0]?.();
    const handler = harness.addEventListener.mock.calls[0]?.[1] as (event: KeyboardEvent) => void;
    handler(keyEvent("ArrowLeft"));
    expect(harness.nextOffsets).toEqual([]);
  });
});
