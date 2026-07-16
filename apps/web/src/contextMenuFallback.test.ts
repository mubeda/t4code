import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { showContextMenuFallback } from "./contextMenuFallback";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  className = "";
  disabled = false;
  type = "";
  readonly attributes: Record<string, string> = {};
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    return this.children.some((child) => child.contains(target));
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  createElementNS(_namespace: string, tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("renders headers, icon variants, disabled rows, and hover tones", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "header", label: "Actions", header: true },
      { id: "copy", label: "Copy", icon: "copy" },
      { id: "disabled", label: "Disabled", icon: "missing", disabled: true },
      { id: "remove", label: "Remove", icon: "trash", destructive: true },
    ]);
    const fakeDocument = document as unknown as FakeDocument;
    expect(fakeDocument.querySelectorAll("svg")).toHaveLength(2);
    expect(fakeDocument.body.textContent).toContain("Actions");

    const copy = findButton("Copy")!;
    copy.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(copy.style.background).toBe("var(--accent)");
    copy.dispatchEvent(new FakeDomEvent("mouseleave"));
    expect(copy.style.color).toBe("var(--foreground)");

    const remove = findButton("Remove")!;
    remove.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(remove.style.color).toBe("var(--destructive-foreground)");
    remove.dispatchEvent(new FakeDomEvent("mouseleave"));
    remove.dispatchEvent(new FakeDomEvent("click"));
    remove.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("remove");
  });

  it("dismisses with Escape but ignores other keys", async () => {
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    fakeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }) as FakeDomEvent);
    expect(fakeDocument.body.children).toHaveLength(1);
    const escape = new KeyboardEvent("keydown", { key: "Escape" }) as FakeDomEvent;
    fakeDocument.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("ignores inside pointer events and dismisses outside pointer events", async () => {
    vi.stubGlobal("Node", FakeElement);
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    const button = findButton("Copy")!;
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: button }) as unknown as PointerEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", {
        target: new FakeElement("outside"),
      }) as unknown as PointerEvent,
    );
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("uses fallback parent chains and context-menu cancellation", async () => {
    vi.stubGlobal("Node", undefined);
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    const menu = fakeDocument.body.children[0]!;
    fakeDocument.dispatchEvent(
      new FakeDomEvent("contextmenu", { target: { parent: menu } }) as unknown as MouseEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    const outside = new FakeDomEvent("contextmenu", { target: { parent: null } });
    fakeDocument.dispatchEvent(outside as unknown as MouseEvent);
    expect(outside.defaultPrevented).toBe(true);
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("does not dismiss from pointers before the animation frame", async () => {
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: null }) as unknown as PointerEvent,
    );
    expect(fakeDocument.body.children).toHaveLength(1);
    for (const frame of frames) frame(0);
    fakeDocument.dispatchEvent(
      new FakeDomEvent("pointerdown", { target: null }) as unknown as PointerEvent,
    );
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("clamps nested menus, prevents parent clicks, and closes child levels", async () => {
    vi.stubGlobal("window", { innerWidth: 250, innerHeight: 180 });
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const fakeDocument = document as unknown as FakeDocument;
    const selectionPromise = showContextMenuFallback(
      [
        {
          id: "parent",
          label: "Parent",
          children: [{ id: "child", label: "Child" }],
        },
      ],
      { x: 240, y: 170 },
    );
    for (const frame of frames.splice(0)) frame(0);
    const parent = findButton("Parent")!;
    parent.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(fakeDocument.body.children).toHaveLength(2);
    expect(fakeDocument.body.children[1]?.style.left).toBe("4px");
    const click = new FakeDomEvent("click");
    parent.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    fakeDocument.body.children[0]?.dispatchEvent(new FakeDomEvent("mouseenter"));
    expect(fakeDocument.body.children).toHaveLength(1);
    findButton("Parent")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    findButton("Child")?.dispatchEvent(new FakeDomEvent("mouseenter"));
    findButton("Child")?.dispatchEvent(new FakeDomEvent("click"));
    await expect(selectionPromise).resolves.toBe("child");
  });
});
