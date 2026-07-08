import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { computeLabelPosition } from "./PickLabelPosition.ts";

const ipcState = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: Array<unknown>) => void>>();
  return {
    handlers,
    send: vi.fn(),
    on: (channel: string, listener: (...args: Array<unknown>) => void): void => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), listener]);
    },
    off: (channel: string, listener: (...args: Array<unknown>) => void): void => {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((existing) => existing !== listener),
      );
    },
  };
});

const grabState = vi.hoisted(() => ({
  getElementContext: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: ipcState.on,
    off: ipcState.off,
    send: ipcState.send,
  },
}));

vi.mock("react-grab/primitives", () => ({
  getElementContext: grabState.getElementContext,
}));

const OVERLAY_ATTRIBUTE = "data-t3code-annotation-ui";
const TOOL_ATTRIBUTE = "data-t3code-annotation-tool";

interface FakeRect {
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const makeRect = (x: number, y: number, width: number, height: number): FakeRect => ({
  x,
  y,
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
});

class FakeStyleDeclaration {
  cssText = "";
  display = "";
  transform = "";
  width = "";
  height = "";
  left = "";
  top = "";
  right = "";
  bottom = "";
  cursor = "";
  overflowY = "";
  colorScheme = "";
  accentColor = "";
  paddingRight = "";
  zIndex = "";
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string, _priority?: string): void {
    this.properties.set(name, value);
  }

  removeProperty(name: string): void {
    this.properties.delete(name);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

class FakeClassList {
  private readonly owner: FakeElement;

  constructor(owner: FakeElement) {
    this.owner = owner;
  }

  private classes(): Array<string> {
    return this.owner.className.split(/\s+/).filter(Boolean);
  }

  toggle(name: string, force?: boolean): boolean {
    const classes = this.classes();
    const has = classes.includes(name);
    const next = force ?? !has;
    if (next && !has) classes.push(name);
    if (!next && has) classes.splice(classes.indexOf(name), 1);
    this.owner.className = classes.join(" ");
    return next;
  }

  contains(name: string): boolean {
    return this.classes().includes(name);
  }
}

class FakeElement {
  readonly tagName: string;
  id = "";
  className = "";
  title = "";
  textContent = "";
  innerHTML = "";
  isConnected = true;
  rect: FakeRect = makeRect(0, 0, 0, 0);
  readonly style = new FakeStyleDeclaration();
  readonly classList: FakeClassList;
  readonly dataset: Record<string, string | undefined> = {};
  parentElement: FakeElement | null = null;
  readonly childNodes: Array<FakeElement> = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList(this);
  }

  get children(): Array<FakeElement> {
    return this.childNodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.remove();
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes: Array<FakeElement>): void {
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: unknown, _options?: unknown): void {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener as (event: never) => void,
    ]);
  }

  removeEventListener(type: string, listener: unknown, _options?: unknown): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((existing) => existing !== listener),
    );
  }

  dispatch(type: string, event: object = {}): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      (listener as (value: unknown) => void)(event);
    }
  }

  click(): void {
    this.dispatch("click");
  }

  focus(_options?: unknown): void {}

  blur(): void {}

  select(): void {}

  setPointerCapture(_pointerId: number): void {}

  releasePointerCapture(_pointerId: number): void {}

  hasPointerCapture(_pointerId: number): boolean {
    return true;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  closest(_selector: string): FakeElement | null {
    if (this.hasAttribute(OVERLAY_ATTRIBUTE)) return this;
    let current: FakeElement | null = this.parentElement;
    while (current) {
      if (current.hasAttribute(OVERLAY_ATTRIBUTE)) return current;
      current = current.parentElement;
    }
    return null;
  }

  descendants(): Array<FakeElement> {
    const all: Array<FakeElement> = [];
    for (const child of this.childNodes) {
      all.push(child, ...child.descendants());
    }
    return all;
  }

  querySelector(selector: string): FakeElement | null {
    const match = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
    if (!match) return null;
    const name = match[1] ?? "";
    const value = match[2] ?? "";
    return this.descendants().find((element) => element.getAttribute(name) === value) ?? null;
  }

  attachShadow(_init: { mode: string }): FakeElement {
    const shadowRoot = new FakeElement("#shadow-root");
    this.appendChild(shadowRoot);
    return shadowRoot;
  }
}

class FakeHTMLElement extends FakeElement {}
class FakeSVGElement extends FakeElement {}
class FakeHTMLDivElement extends FakeHTMLElement {}
class FakeHTMLAnchorElement extends FakeHTMLElement {}

class FakeHTMLButtonElement extends FakeHTMLElement {
  type = "";
  disabled = false;
}

class FakeHTMLInputElement extends FakeHTMLElement {
  type = "text";
  value = "";
  placeholder = "";
  min = "";
  max = "";
  step = "";
}

class FakeHTMLTextAreaElement extends FakeHTMLElement {
  value = "";
  placeholder = "";
  rows = 0;
  scrollHeight = 20;
}

class FakeHTMLOptionElement extends FakeHTMLElement {
  value = "";
}

class FakeHTMLSelectElement extends FakeHTMLElement {
  value = "";

  get options(): Array<FakeHTMLOptionElement> {
    return this.childNodes.filter(
      (child): child is FakeHTMLOptionElement => child instanceof FakeHTMLOptionElement,
    );
  }
}

const createElement = (tagName: string): FakeElement => {
  switch (tagName) {
    case "div":
      return new FakeHTMLDivElement(tagName);
    case "button":
      return new FakeHTMLButtonElement(tagName);
    case "input":
      return new FakeHTMLInputElement(tagName);
    case "textarea":
      return new FakeHTMLTextAreaElement(tagName);
    case "select":
      return new FakeHTMLSelectElement(tagName);
    case "option":
      return new FakeHTMLOptionElement(tagName);
    case "a":
      return new FakeHTMLAnchorElement(tagName);
    default:
      return new FakeHTMLElement(tagName);
  }
};

const documentElement = new FakeElement("html");
const body = new FakeElement("body");
documentElement.appendChild(body);

const elementsFromPoint = vi.fn((_x: number, _y: number): Array<FakeElement> => []);
const querySelectorAll = vi.fn((_selector: string): Array<FakeElement> => []);

const fakeDocument = {
  documentElement,
  body,
  title: "Preview Page",
  createElement,
  createElementNS: (_namespace: string, tagName: string): FakeElement =>
    new FakeSVGElement(tagName),
  elementsFromPoint,
  querySelectorAll,
};

const windowListeners = new Map<string, Array<(event: never) => void>>();
const frameCallbacks = new Map<number, () => void>();
let frameSequence = 0;

const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (type: string, listener: unknown, _options?: unknown): void => {
    windowListeners.set(type, [
      ...(windowListeners.get(type) ?? []),
      listener as (event: never) => void,
    ]);
  },
  removeEventListener: (type: string, listener: unknown, _options?: unknown): void => {
    windowListeners.set(
      type,
      (windowListeners.get(type) ?? []).filter((existing) => existing !== listener),
    );
  },
  setTimeout: (callback: () => void, _delay?: number): number => {
    callback();
    return 0;
  },
  requestAnimationFrame: (callback: (time: number) => void): number => {
    frameSequence += 1;
    frameCallbacks.set(frameSequence, () => callback(0));
    return frameSequence;
  },
  cancelAnimationFrame: (handle: number): void => {
    frameCallbacks.delete(handle);
  },
};

const flushAnimationFrames = (): void => {
  while (frameCallbacks.size > 0) {
    const next = frameCallbacks.entries().next().value as [number, () => void];
    frameCallbacks.delete(next[0]);
    next[1]();
  }
};

const computedStyle = {
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "24px",
  fontFamily: "monospace",
  color: "rgb(10, 20, 30)",
  backgroundColor: "rgb(240, 240, 240)",
  borderColor: "rgb(1, 2, 3)",
  opacity: "0.8",
  borderRadius: "6px",
  borderWidth: "2px",
  padding: "4px",
  margin: "8px",
  gap: "normal",
  getPropertyValue: (_name: string): string => "",
};

Object.defineProperties(globalThis, {
  window: { value: fakeWindow, configurable: true, writable: true },
  document: { value: fakeDocument, configurable: true, writable: true },
  location: { value: { href: "https://preview.test/page" }, configurable: true, writable: true },
  getComputedStyle: {
    value: (_element: unknown) => computedStyle,
    configurable: true,
    writable: true,
  },
  Element: { value: FakeElement, configurable: true, writable: true },
  HTMLElement: { value: FakeHTMLElement, configurable: true, writable: true },
  SVGElement: { value: FakeSVGElement, configurable: true, writable: true },
  HTMLInputElement: { value: FakeHTMLInputElement, configurable: true, writable: true },
  HTMLButtonElement: { value: FakeHTMLButtonElement, configurable: true, writable: true },
  HTMLAnchorElement: { value: FakeHTMLAnchorElement, configurable: true, writable: true },
  HTMLTextAreaElement: { value: FakeHTMLTextAreaElement, configurable: true, writable: true },
});

const fireWindow = (type: string, event: object): void => {
  for (const listener of Array.from(windowListeners.get(type) ?? [])) {
    (listener as (value: unknown) => void)(event);
  }
};

const fireChannel = (channel: string, ...args: Array<unknown>): void => {
  for (const listener of Array.from(ipcState.handlers.get(channel) ?? [])) {
    listener(...args);
  }
};

const sendsTo = (channel: string): Array<Array<unknown>> =>
  ipcState.send.mock.calls
    .filter(([sent]) => sent === channel)
    .map((call) => call.slice(1) as Array<unknown>);

const pointerEvent = (overrides: Record<string, unknown> = {}): object => ({
  isTrusted: false,
  clientX: 0,
  clientY: 0,
  button: 0,
  shiftKey: false,
  pointerId: 1,
  target: body,
  relatedTarget: body,
  metaKey: false,
  ctrlKey: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
});

const keyEvent = (key: string, overrides: Record<string, unknown> = {}): object => ({
  isTrusted: false,
  key,
  code: `Key${key.toUpperCase()}`,
  target: body,
  metaKey: false,
  ctrlKey: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
});

const makeTheme = (primary: string): DesktopPreviewAnnotationTheme => ({
  colorScheme: "dark",
  radius: "0.5rem",
  background: "black",
  foreground: "white",
  popover: "black",
  popoverForeground: "white",
  primary,
  primaryForeground: "black",
  muted: "gray",
  mutedForeground: "silver",
  accent: "gray",
  accentForeground: "white",
  border: "gray",
  input: "gray",
  ring: primary,
  fontSans: "sans-serif",
  fontMono: "monospace",
});

interface SessionHandles {
  host: FakeElement;
  root: FakeElement;
  svg: FakeElement;
  hoverOutline: FakeElement;
  marqueeBox: FakeElement;
  toolbar: FakeElement;
  editor: FakeElement;
  stylePanel: FakeElement;
  adjust: FakeHTMLButtonElement;
  comment: FakeHTMLTextAreaElement;
  dragHandle: FakeHTMLButtonElement;
  submit: FakeHTMLButtonElement;
}

const currentSession = (): SessionHandles => {
  const host = [...documentElement.childNodes]
    .toReversed()
    .find((child) => child.tagName === "DIV" && child.hasAttribute(OVERLAY_ATTRIBUTE));
  if (!host) throw new Error("no active annotation session host");
  const shadowRoot = host.childNodes.find((child) => child.tagName === "#SHADOW-ROOT");
  const root = shadowRoot?.childNodes.find((child) => child.tagName === "DIV");
  if (!root) throw new Error("annotation session root missing");
  const [hoverOutline, marqueeBox, svg, toolbar, editor] = root.childNodes;
  const composer = editor?.childNodes[0];
  const [adjust, comment, dragHandle, submit] = composer?.childNodes ?? [];
  const stylePanel = editor?.childNodes[1];
  if (!hoverOutline || !marqueeBox || !svg || !toolbar || !editor) {
    throw new Error("annotation overlay chrome missing");
  }
  if (
    !(adjust instanceof FakeHTMLButtonElement) ||
    !(comment instanceof FakeHTMLTextAreaElement) ||
    !(dragHandle instanceof FakeHTMLButtonElement) ||
    !(submit instanceof FakeHTMLButtonElement) ||
    !stylePanel
  ) {
    throw new Error("annotation editor chrome missing");
  }
  return {
    host,
    root,
    svg,
    hoverOutline,
    marqueeBox,
    toolbar,
    editor,
    stylePanel,
    adjust,
    comment,
    dragHandle,
    submit,
  };
};

const startSession = (theme?: DesktopPreviewAnnotationTheme): SessionHandles => {
  fireChannel(START_PICK_CHANNEL, {}, theme);
  return currentSession();
};

const toolButton = (session: SessionHandles, label: string): FakeHTMLButtonElement => {
  const button = session.toolbar.childNodes.find((child) => child.textContent === label);
  if (!(button instanceof FakeHTMLButtonElement)) throw new Error(`missing tool button ${label}`);
  return button;
};

const fieldControls = (panel: FakeElement, labelText: string): Array<FakeElement> => {
  const field = panel
    .descendants()
    .find(
      (element) => element.tagName === "LABEL" && element.childNodes[0]?.textContent === labelText,
    );
  if (!field) throw new Error(`missing style field: ${labelText}`);
  return field
    .descendants()
    .filter((element) => element.tagName === "INPUT" || element.tagName === "SELECT");
};

const inputField = (panel: FakeElement, labelText: string): FakeHTMLInputElement => {
  const control = fieldControls(panel, labelText)[0];
  if (!(control instanceof FakeHTMLInputElement)) {
    throw new Error(`style field is not an input: ${labelText}`);
  }
  return control;
};

const selectField = (panel: FakeElement, labelText: string): FakeHTMLSelectElement => {
  const control = fieldControls(panel, labelText)[0];
  if (!(control instanceof FakeHTMLSelectElement)) {
    throw new Error(`style field is not a select: ${labelText}`);
  }
  return control;
};

const colorRow = (
  panel: FakeElement,
  labelText: string,
): { color: FakeHTMLInputElement; text: FakeHTMLInputElement } => {
  const controls = fieldControls(panel, labelText);
  const color = controls.find(
    (control): control is FakeHTMLInputElement =>
      control instanceof FakeHTMLInputElement && control.type === "color",
  );
  const text = controls.find(
    (control): control is FakeHTMLInputElement =>
      control instanceof FakeHTMLInputElement && control.type === "text",
  );
  if (!color || !text) throw new Error(`missing color row: ${labelText}`);
  return { color, text };
};

const regionBoxes = (session: SessionHandles): Array<FakeElement> =>
  session.root.descendants().filter((element) => element.hasAttribute("data-region-id"));

const settle = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const defaultElementContext = {
  selector: "#hero",
  htmlPreview: '<div id="hero"></div>',
  componentName: "Hero",
  styles: ".hero{}",
  stack: [{ functionName: "Hero", fileName: "Hero.tsx", lineNumber: 3, columnNumber: 7 }],
};

describe("PickPreload", () => {
  beforeAll(async () => {
    await import("./PickPreload.ts");
  });

  beforeEach(() => {
    fireChannel(CANCEL_PICK_CHANNEL);
    frameCallbacks.clear();
    ipcState.send.mockClear();
    elementsFromPoint.mockReset();
    elementsFromPoint.mockReturnValue([]);
    querySelectorAll.mockReset();
    querySelectorAll.mockReturnValue([]);
    grabState.getElementContext.mockReset();
    grabState.getElementContext.mockResolvedValue(defaultElementContext);
    fakeDocument.title = "Preview Page";
    body.childNodes.splice(0);
  });

  it("reports only trusted human input to the host process", () => {
    fireWindow("pointerdown", pointerEvent({ isTrusted: true, clientX: 5, clientY: 6, button: 1 }));
    expect(sendsTo(HUMAN_INPUT_CHANNEL)).toEqual([[{ kind: "pointer", x: 5, y: 6, button: 1 }]]);

    fireWindow("pointerdown", pointerEvent({ isTrusted: false, clientX: 9, clientY: 9 }));
    expect(sendsTo(HUMAN_INPUT_CHANNEL)).toHaveLength(1);

    fireWindow("keydown", keyEvent("a", { isTrusted: true, code: "KeyA" }));
    expect(sendsTo(HUMAN_INPUT_CHANNEL)).toEqual([
      [{ kind: "pointer", x: 5, y: 6, button: 1 }],
      [{ kind: "key", key: "a", code: "KeyA" }],
    ]);

    fireWindow("keydown", keyEvent("b", { isTrusted: false }));
    expect(sendsTo(HUMAN_INPUT_CHANNEL)).toHaveLength(2);
  });

  it("starts a select session, replaces prior sessions, and cancels on Escape", () => {
    const session = startSession();
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("select");
    expect(session.editor.style.display).toBe("none");
    expect(session.submit.disabled).toBe(true);
    expect(session.adjust.disabled).toBe(true);

    const replacement = startSession();
    expect(replacement.host).not.toBe(session.host);
    expect(
      documentElement.childNodes.filter(
        (child) => child.tagName === "DIV" && child.hasAttribute(OVERLAY_ATTRIBUTE),
      ),
    ).toHaveLength(1);

    fireWindow("keydown", keyEvent("Escape", { key: "Escape" }));
    expect(sendsTo(ELEMENT_PICKED_CHANNEL)).toEqual([[null]]);
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBeNull();
    expect(replacement.host.parentElement).toBeNull();
  });

  it("switches tools with shortcuts and toolbar buttons", () => {
    const session = startSession();
    fireWindow("keydown", keyEvent("r"));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("marquee");
    fireWindow("keydown", keyEvent("d"));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("draw");
    fireWindow("keydown", keyEvent("e"));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("erase");
    fireWindow("keydown", keyEvent("v"));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("select");
    fireWindow("keydown", keyEvent("z"));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("select");

    const draw = toolButton(session, "Draw");
    draw.dispatch("click");
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("draw");
    expect(draw.classList.contains("text-primary")).toBe(true);
    expect(toolButton(session, "Select").classList.contains("text-foreground")).toBe(true);

    fireChannel(CANCEL_PICK_CHANNEL);
    expect(session.host.parentElement).toBeNull();
    expect(sendsTo(ELEMENT_PICKED_CHANNEL)).toHaveLength(0);
  });

  it("highlights hovered pickable elements and clears the outline elsewhere", () => {
    const session = startSession();
    const target = new FakeHTMLDivElement("div");
    target.rect = makeRect(100, 100, 200, 50);
    body.appendChild(target);

    elementsFromPoint.mockReturnValue([session.host, documentElement, body, target]);
    fireWindow("pointermove", pointerEvent({ clientX: 150, clientY: 120 }));
    expect(session.hoverOutline.style.display).toBe("block");
    expect(session.hoverOutline.style.transform).toBe("translate(100px, 100px)");
    expect(session.hoverOutline.style.width).toBe("200px");
    expect(session.hoverOutline.style.height).toBe("50px");

    elementsFromPoint.mockReturnValue([documentElement, body]);
    fireWindow("pointermove", pointerEvent({ clientX: 20, clientY: 20 }));
    expect(session.hoverOutline.style.display).toBe("none");

    elementsFromPoint.mockReturnValue([target]);
    fireWindow("pointermove", pointerEvent({ clientX: 150, clientY: 120 }));
    expect(session.hoverOutline.style.display).toBe("block");
    fireWindow("pointermove", pointerEvent({ target: session.hoverOutline }));
    expect(session.hoverOutline.style.display).toBe("none");

    fireWindow("pointermove", pointerEvent({ clientX: 150, clientY: 120 }));
    fireWindow("pointerout", pointerEvent({ relatedTarget: null }));
    expect(session.hoverOutline.style.display).toBe("none");

    fireWindow("pointermove", pointerEvent({ clientX: 150, clientY: 120 }));
    fireWindow("blur", {});
    expect(session.hoverOutline.style.display).toBe("none");

    const swallow = pointerEvent({ target });
    fireWindow("click", swallow);
    expect(
      (swallow as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).toHaveBeenCalledOnce();
    const ignored = pointerEvent({ target: session.hoverOutline });
    fireWindow("click", ignored);
    expect(
      (ignored as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).not.toHaveBeenCalled();
  });

  it("selects elements, toggles them, and submits the annotation", async () => {
    const theme = makeTheme("#123456");
    const session = startSession(theme);
    expect(session.host.style.getPropertyValue("--t3-primary")).toBe("#123456");
    expect(session.host.style.colorScheme).toBe("dark");

    const hero = new FakeHTMLDivElement("div");
    hero.id = "hero";
    hero.className = "card primary extra";
    hero.rect = makeRect(100, 100, 200, 50);
    body.appendChild(hero);
    const sidebar = new FakeHTMLDivElement("div");
    sidebar.rect = makeRect(400, 100, 100, 40);
    body.appendChild(sidebar);
    const banner = new FakeHTMLDivElement("div");
    banner.rect = makeRect(700, 100, 50, 50);
    body.appendChild(banner);
    elementsFromPoint.mockImplementation((x: number) =>
      x < 300 ? [session.host, hero] : x < 600 ? [sidebar] : [banner],
    );

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    expect(session.editor.style.display).toBe("flex");
    expect(session.submit.disabled).toBe(false);
    const label = session.root.childNodes.find(
      (child) => child.textContent === "div#hero.card.primary",
    );
    expect(label).toBeDefined();
    expect(label?.style.transform).toBe("translate(100px, 78px)");

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    expect(session.editor.style.display).toBe("none");

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    fireWindow("pointerdown", pointerEvent({ clientX: 420, clientY: 120, shiftKey: true }));
    fireWindow("pointerdown", pointerEvent({ clientX: 700, clientY: 120 }));

    session.comment.value = "Make it pop";
    session.comment.dispatch("input");
    session.comment.dispatch("keydown", {
      key: "Enter",
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    });
    expect(sendsTo(ELEMENT_PICKED_CHANNEL)).toHaveLength(0);
    session.comment.dispatch("keydown", {
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    });
    expect(session.submit.textContent).toBe("Capturing…");
    session.submit.dispatch("click");
    await settle();

    const sends = sendsTo(ELEMENT_PICKED_CHANNEL);
    expect(sends).toHaveLength(1);
    const [annotation, screenshotRect] = sends[0] as [Record<string, unknown>, unknown];
    expect(annotation).toMatchObject({
      pageUrl: "https://preview.test/page",
      pageTitle: "Preview Page",
      comment: "Make it pop",
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
    });
    expect(annotation["id"]).toMatch(/^annotation_/);
    const elements = annotation["elements"] as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      rect: { x: 700, y: 100, width: 50, height: 50 },
      element: {
        selector: "#hero",
        componentName: "Hero",
        tagName: "div",
        pageUrl: "https://preview.test/page",
        pageTitle: "Preview Page",
        source: { functionName: "Hero", fileName: "Hero.tsx", lineNumber: 3, columnNumber: 7 },
      },
    });
    expect(screenshotRect).toEqual({ x: 680, y: 80, width: 90, height: 90 });
    expect(session.editor.style.display).toBe("none");
    expect(session.toolbar.style.display).toBe("none");

    fireChannel(ANNOTATION_CAPTURED_CHANNEL);
    expect(session.host.parentElement).toBeNull();
  });

  it("expands the style editor and applies edits to selected elements", () => {
    const session = startSession(makeTheme("#123456"));
    const hero = new FakeHTMLDivElement("div");
    hero.rect = makeRect(100, 100, 200, 50);
    hero.style.setProperty("font-size", "12px");
    body.appendChild(hero);
    const sidebar = new FakeHTMLDivElement("div");
    sidebar.rect = makeRect(500, 100, 100, 40);
    body.appendChild(sidebar);
    elementsFromPoint.mockImplementation((x: number) => (x < 400 ? [hero] : [sidebar]));

    session.adjust.dispatch("click");
    expect(session.stylePanel.style.display).toBe("none");

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    session.adjust.dispatch("click");
    expect(session.stylePanel.style.display).toBe("grid");
    expect(session.dragHandle.style.display).toBe("block");
    expect(session.adjust.getAttribute("aria-expanded")).toBe("true");

    const panel = session.stylePanel;
    const fontFamily = selectField(panel, "Font");
    const fontSize = inputField(panel, "Font size");
    const fontWeight = selectField(panel, "Font weight");
    const lineHeight = inputField(panel, "Line height");
    const textColor = colorRow(panel, "Text color");
    const opacity = inputField(panel, "Opacity");
    const radius = inputField(panel, "Radius");
    const borderWidth = inputField(panel, "Border width");
    const padding = inputField(panel, "Padding");
    const margin = inputField(panel, "Margin");
    const gap = inputField(panel, "Gap");
    const dimensionInputs = panel
      .descendants()
      .filter(
        (element): element is FakeHTMLInputElement =>
          element instanceof FakeHTMLInputElement && element.placeholder === "auto",
      );
    const widthInput = dimensionInputs[0];
    const heightInput = dimensionInputs[1];
    const aspectLock = panel
      .descendants()
      .find(
        (element): element is FakeHTMLButtonElement =>
          element instanceof FakeHTMLButtonElement && element.title === "Lock aspect ratio",
      );
    if (!widthInput || !heightInput || !aspectLock) throw new Error("missing sizing controls");

    expect(widthInput.value).toBe("200");
    expect(heightInput.value).toBe("50");
    expect(fontSize.value).toBe("16");
    expect(fontFamily.value).toBe("monospace");
    expect(fontWeight.value).toBe("400");
    expect(textColor.text.value).toBe("rgb(10, 20, 30)");
    expect(opacity.value).toBe("0.8");
    expect(radius.value).toBe("6");
    expect(borderWidth.value).toBe("2");
    expect(padding.value).toBe("4px");
    expect(margin.value).toBe("8px");
    expect(gap.value).toBe("0px");

    fontSize.value = "18";
    fontSize.dispatch("input");
    fontSize.value = "20";
    fontSize.dispatch("input");
    expect(hero.style.getPropertyValue("font-size")).toBe("20px");
    fontSize.value = "";
    fontSize.dispatch("input");
    expect(hero.style.getPropertyValue("font-size")).toBe("20px");

    fontFamily.value = "serif";
    fontFamily.dispatch("change");
    expect(hero.style.getPropertyValue("font-family")).toBe("serif");
    fontWeight.value = "700";
    fontWeight.dispatch("change");
    expect(hero.style.getPropertyValue("font-weight")).toBe("700");
    lineHeight.value = " 1.6 ";
    lineHeight.dispatch("change");
    expect(hero.style.getPropertyValue("line-height")).toBe("1.6");
    lineHeight.value = "  ";
    lineHeight.dispatch("change");
    expect(hero.style.getPropertyValue("line-height")).toBe("1.6");

    textColor.color.value = "#ff0000";
    textColor.color.dispatch("input");
    expect(textColor.text.value).toBe("#ff0000");
    expect(hero.style.getPropertyValue("color")).toBe("#ff0000");
    textColor.text.value = "#00ff00";
    textColor.text.dispatch("change");
    expect(hero.style.getPropertyValue("color")).toBe("#00ff00");
    expect(textColor.color.value).toBe("#00ff00");
    textColor.text.value = "tomato";
    textColor.text.dispatch("change");
    expect(hero.style.getPropertyValue("color")).toBe("tomato");
    expect(textColor.color.value).toBe("#00ff00");
    textColor.text.value = "   ";
    textColor.text.dispatch("change");
    expect(hero.style.getPropertyValue("color")).toBe("tomato");

    opacity.value = "0.5";
    opacity.dispatch("input");
    expect(hero.style.getPropertyValue("opacity")).toBe("0.5");
    radius.value = "8";
    radius.dispatch("input");
    expect(hero.style.getPropertyValue("border-radius")).toBe("8px");
    borderWidth.value = "3";
    borderWidth.dispatch("input");
    expect(hero.style.getPropertyValue("border-style")).toBe("solid");
    expect(hero.style.getPropertyValue("border-width")).toBe("3px");

    widthInput.value = "100";
    widthInput.dispatch("input");
    expect(hero.style.getPropertyValue("width")).toBe("100px");
    expect(hero.style.getPropertyValue("height")).toBe("25px");
    expect(heightInput.value).toBe("25");
    heightInput.value = "50";
    heightInput.dispatch("input");
    expect(hero.style.getPropertyValue("height")).toBe("50px");
    expect(widthInput.value).toBe("200");

    aspectLock.dispatch("click");
    expect(aspectLock.getAttribute("aria-pressed")).toBe("false");
    widthInput.value = "80";
    widthInput.dispatch("input");
    expect(hero.style.getPropertyValue("width")).toBe("80px");
    expect(heightInput.value).toBe("50");
    widthInput.value = "0";
    widthInput.dispatch("input");
    expect(hero.style.getPropertyValue("width")).toBe("80px");
    heightInput.value = "0";
    heightInput.dispatch("input");
    expect(hero.style.getPropertyValue("height")).toBe("50px");

    padding.value = "10px";
    padding.dispatch("change");
    expect(hero.style.getPropertyValue("padding")).toBe("10px");
    margin.value = "12px";
    margin.dispatch("change");
    expect(hero.style.getPropertyValue("margin")).toBe("12px");
    gap.value = "4px";
    gap.dispatch("change");
    expect(hero.style.getPropertyValue("gap")).toBe("4px");
    gap.value = "";
    gap.dispatch("change");
    expect(hero.style.getPropertyValue("gap")).toBe("4px");

    fireWindow("pointerdown", pointerEvent({ clientX: 520, clientY: 120, shiftKey: true }));
    expect(session.stylePanel.style.display).toBe("grid");

    session.adjust.dispatch("click");
    expect(session.stylePanel.style.display).toBe("none");
    expect(session.dragHandle.style.display).toBe("none");
    expect(session.adjust.getAttribute("aria-expanded")).toBe("false");

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    expect(hero.style.getPropertyValue("font-size")).toBe("12px");
    expect(hero.style.getPropertyValue("font-weight")).toBe("");
    expect(hero.style.getPropertyValue("color")).toBe("");
  });

  it("drags the expanded editor and clamps it to the viewport", () => {
    const session = startSession();
    const hero = new FakeHTMLDivElement("div");
    hero.rect = makeRect(100, 100, 200, 50);
    body.appendChild(hero);
    elementsFromPoint.mockReturnValue([hero]);

    const ignoredWhileCollapsed = pointerEvent({ button: 0, pointerId: 3 });
    session.dragHandle.dispatch("pointerdown", ignoredWhileCollapsed);
    expect(session.dragHandle.style.cursor).toBe("");

    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));
    session.editor.rect = makeRect(500, 300, 360, 120);
    session.adjust.dispatch("click");

    session.dragHandle.dispatch(
      "pointerdown",
      pointerEvent({ button: 2, pointerId: 6, clientX: 510, clientY: 310 }),
    );
    expect(session.dragHandle.style.cursor).toBe("");

    session.dragHandle.dispatch(
      "pointerdown",
      pointerEvent({ button: 0, pointerId: 7, clientX: 520, clientY: 310 }),
    );
    expect(session.dragHandle.style.cursor).toBe("grabbing");

    session.dragHandle.dispatch(
      "pointermove",
      pointerEvent({ pointerId: 9, clientX: 0, clientY: 0 }),
    );
    session.dragHandle.dispatch(
      "pointermove",
      pointerEvent({ pointerId: 7, clientX: 900, clientY: 700 }),
    );
    expect(session.editor.style.left).toBe("880px");
    expect(session.editor.style.top).toBe("672px");
    expect(session.editor.style.right).toBe("auto");

    session.dragHandle.dispatch("pointerup", pointerEvent({ pointerId: 9 }));
    expect(session.dragHandle.style.cursor).toBe("grabbing");
    session.dragHandle.dispatch("pointerup", pointerEvent({ pointerId: 7 }));
    expect(session.dragHandle.style.cursor).toBe("grab");
    session.dragHandle.dispatch("pointercancel", pointerEvent({ pointerId: 7 }));

    flushAnimationFrames();
    expect(session.editor.style.left).toBe("880px");
  });

  it("marquee-selects contained elements or captures a region, and erases targets", async () => {
    const session = startSession();
    const leaf = new FakeHTMLDivElement("div");
    leaf.rect = makeRect(120, 120, 40, 20);
    const buttonWithChild = new FakeHTMLButtonElement("button");
    buttonWithChild.rect = makeRect(170, 150, 60, 20);
    buttonWithChild.appendChild(new FakeHTMLElement("span"));
    const anchorWithChild = new FakeHTMLAnchorElement("a");
    anchorWithChild.rect = makeRect(120, 160, 40, 16);
    anchorWithChild.appendChild(new FakeHTMLElement("span"));
    const roleButton = new FakeHTMLDivElement("div");
    roleButton.setAttribute("role", "button");
    roleButton.rect = makeRect(200, 200, 30, 20);
    roleButton.appendChild(new FakeHTMLElement("span"));
    const container = new FakeHTMLDivElement("div");
    container.rect = makeRect(110, 110, 150, 130);
    container.appendChild(new FakeHTMLElement("p"));
    const tiny = new FakeHTMLDivElement("div");
    tiny.rect = makeRect(130, 130, 1, 1);
    const outside = new FakeHTMLDivElement("div");
    outside.rect = makeRect(600, 600, 50, 50);
    const centerOutside = new FakeHTMLDivElement("div");
    centerOutside.rect = makeRect(60, 90, 50, 40);
    body.append(leaf, buttonWithChild, anchorWithChild, roleButton, container, tiny, outside);
    querySelectorAll.mockReturnValue([
      leaf,
      buttonWithChild,
      anchorWithChild,
      roleButton,
      container,
      tiny,
      outside,
      centerOutside,
      session.hoverOutline,
    ]);

    fireWindow("keydown", keyEvent("r"));
    fireWindow("pointerdown", pointerEvent({ clientX: 100, clientY: 100 }));
    fireWindow("pointermove", pointerEvent({ clientX: 300, clientY: 260 }));
    expect(session.marqueeBox.style.display).toBe("block");
    expect(session.marqueeBox.style.transform).toBe("translate(100px, 100px)");
    expect(session.marqueeBox.style.width).toBe("200px");
    expect(session.marqueeBox.style.height).toBe("160px");
    fireWindow("pointerup", pointerEvent({ clientX: 300, clientY: 260 }));
    expect(session.marqueeBox.style.display).toBe("none");
    expect(session.editor.style.display).toBe("flex");
    expect(regionBoxes(session)).toHaveLength(0);

    querySelectorAll.mockReturnValue([]);
    fireWindow("pointerdown", pointerEvent({ clientX: 500, clientY: 400 }));
    fireWindow("pointerup", pointerEvent({ clientX: 600, clientY: 470 }));
    expect(regionBoxes(session)).toHaveLength(1);
    expect(regionBoxes(session)[0]?.style.transform).toBe("translate(500px, 400px)");

    fireWindow("pointerdown", pointerEvent({ clientX: 700, clientY: 700 }));
    fireWindow("pointerup", pointerEvent({ clientX: 701, clientY: 701 }));
    expect(regionBoxes(session)).toHaveLength(1);

    fireWindow("keydown", keyEvent("e"));
    fireWindow("pointerdown", pointerEvent({ clientX: 140, clientY: 130 }));
    fireWindow("pointerdown", pointerEvent({ clientX: 550, clientY: 430 }));
    expect(regionBoxes(session)).toHaveLength(0);
    fireWindow("pointerdown", pointerEvent({ clientX: 1000, clientY: 50 }));

    fireWindow("pointerdown", pointerEvent({ clientX: 1000, clientY: 50, button: 2 }));
    fireWindow("pointerup", pointerEvent({ clientX: 1000, clientY: 50 }));

    session.submit.dispatch("click");
    await settle();
    const sends = sendsTo(ELEMENT_PICKED_CHANNEL);
    expect(sends).toHaveLength(1);
    const [annotation] = sends[0] as [Record<string, unknown>];
    expect(annotation["elements"]).toHaveLength(3);
    expect(annotation["regions"]).toEqual([]);
  });

  it("draws freehand strokes, discards single-point strokes, and erases strokes", async () => {
    const session = startSession(makeTheme("#ff8800"));
    fireWindow("keydown", keyEvent("d"));

    fireWindow("pointerdown", pointerEvent({ clientX: 10, clientY: 10 }));
    expect(session.svg.childNodes).toHaveLength(1);
    const path = session.svg.childNodes[0];
    expect(path?.getAttribute("stroke")).toBe("#ff8800");
    expect(path?.getAttribute("data-stroke-id")).toMatch(/^stroke_/);
    fireWindow("pointermove", pointerEvent({ clientX: 20, clientY: 20 }));
    expect(path?.getAttribute("d")).toBe("M 10 10 L 20 20");
    fireWindow("pointermove", pointerEvent({ clientX: 30, clientY: 26 }));
    expect(path?.getAttribute("d")).toBe("M 10 10 Q 20 20 25 23 L 30 26");
    fireWindow("pointerup", pointerEvent({ clientX: 30, clientY: 26 }));
    expect(session.svg.childNodes).toHaveLength(1);
    expect(session.editor.style.display).toBe("flex");

    fireWindow("pointerdown", pointerEvent({ clientX: 50, clientY: 50 }));
    expect(session.svg.childNodes).toHaveLength(2);
    fireWindow("pointerup", pointerEvent({ clientX: 50, clientY: 50 }));
    expect(session.svg.childNodes).toHaveLength(1);

    fireWindow("pointerdown", pointerEvent({ clientX: 100, clientY: 100 }));
    fireWindow("pointermove", pointerEvent({ clientX: 130, clientY: 120 }));
    fireWindow("pointerup", pointerEvent({ clientX: 130, clientY: 120 }));
    expect(session.svg.childNodes).toHaveLength(2);

    fireWindow("keydown", keyEvent("e"));
    fireWindow("pointerdown", pointerEvent({ clientX: 110, clientY: 110 }));
    expect(session.svg.childNodes).toHaveLength(1);

    session.submit.dispatch("click");
    await settle();
    const sends = sendsTo(ELEMENT_PICKED_CHANNEL);
    expect(sends).toHaveLength(1);
    const [annotation, screenshotRect] = sends[0] as [Record<string, unknown>, unknown];
    const strokes = annotation["strokes"] as Array<Record<string, unknown>>;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({
      color: "#ff8800",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 26 },
      ],
    });
    expect(annotation["elements"]).toEqual([]);
    expect(screenshotRect).not.toBeNull();
  });

  it("hides visuals for disconnected elements on repaint", () => {
    const session = startSession();
    const hero = new FakeHTMLDivElement("div");
    hero.rect = makeRect(100, 100, 200, 50);
    body.appendChild(hero);
    elementsFromPoint.mockReturnValue([hero]);
    fireWindow("pointerdown", pointerEvent({ clientX: 150, clientY: 120 }));

    const outlines = session.root.childNodes.filter(
      (child) => child.style.transform === "translate(100px, 100px)",
    );
    expect(outlines.length).toBeGreaterThan(0);

    hero.isConnected = false;
    fireWindow("scroll", {});
    const hidden = session.root.childNodes.filter(
      (child, index) => index >= 5 && child.style.display === "none",
    );
    expect(hidden.length).toBeGreaterThanOrEqual(2);

    hero.isConnected = true;
    fireWindow("resize", {});
    flushAnimationFrames();
    expect(session.editor.style.left.endsWith("px")).toBe(true);
  });

  it("applies live theme updates to the active session only", () => {
    const session = startSession();
    fireChannel(ANNOTATION_THEME_CHANNEL, {}, makeTheme("#00ff00"));
    expect(session.host.style.getPropertyValue("--t3-primary")).toBe("#00ff00");

    fireChannel(CANCEL_PICK_CHANNEL);
    fireChannel(ANNOTATION_THEME_CHANNEL, {}, makeTheme("#0000ff"));
    expect(session.host.style.getPropertyValue("--t3-primary")).toBe("#00ff00");
  });

  it("tolerates partial element context and capture failures", async () => {
    const session = startSession();
    fakeDocument.title = "  ";
    const first = new FakeHTMLDivElement("div");
    first.rect = makeRect(100, 100, 50, 50);
    body.appendChild(first);
    const second = new FakeHTMLDivElement("div");
    second.rect = makeRect(400, 100, 50, 50);
    body.appendChild(second);
    elementsFromPoint.mockImplementation((x: number) => (x < 300 ? [first] : [second]));

    grabState.getElementContext.mockReset();
    grabState.getElementContext
      .mockResolvedValueOnce({ selector: null, componentName: null })
      .mockRejectedValueOnce(new Error("context unavailable"));

    fireWindow("pointerdown", pointerEvent({ clientX: 120, clientY: 120 }));
    fireWindow("pointerdown", pointerEvent({ clientX: 420, clientY: 120, shiftKey: true }));
    session.submit.dispatch("click");
    await settle();

    const sends = sendsTo(ELEMENT_PICKED_CHANNEL);
    expect(sends).toHaveLength(1);
    const [annotation] = sends[0] as [Record<string, unknown>];
    expect(annotation["pageTitle"]).toBeNull();
    const elements = annotation["elements"] as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0]?.["element"]).toMatchObject({
      selector: null,
      componentName: null,
      htmlPreview: "",
      styles: "",
      stack: [],
      source: null,
      pageTitle: null,
    });
  });

  it("sends a null capture rect when every element capture fails", async () => {
    const session = startSession();
    const hero = new FakeHTMLDivElement("div");
    hero.rect = makeRect(100, 100, 50, 50);
    body.appendChild(hero);
    elementsFromPoint.mockReturnValue([hero]);
    grabState.getElementContext.mockReset();
    grabState.getElementContext.mockRejectedValue(new Error("nope"));

    fireWindow("pointerdown", pointerEvent({ clientX: 120, clientY: 120 }));
    session.submit.dispatch("click");
    await settle();

    const sends = sendsTo(ELEMENT_PICKED_CHANNEL);
    expect(sends).toHaveLength(1);
    const [annotation, screenshotRect] = sends[0] as [Record<string, unknown>, unknown];
    expect(annotation["elements"]).toEqual([]);
    expect(screenshotRect).toBeNull();
  });

  it("ignores keyboard shortcuts targeted at the annotation UI", () => {
    const session = startSession();
    fireWindow("keydown", keyEvent("r", { target: session.comment }));
    expect(documentElement.getAttribute(TOOL_ATTRIBUTE)).toBe("select");
    fireWindow("keydown", keyEvent("Escape", { key: "Escape", target: session.comment }));
    expect(session.host.parentElement).toBeNull();
  });
});

const VIEWPORT = { viewportWidth: 1280, viewportHeight: 800 };

describe("computeLabelPosition", () => {
  it("anchors to the element's top-left when there's room above and to the right", () => {
    const { x, y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 120,
      labelHeight: 18,
    });
    expect(x).toBe(200);
    // 200 (top) - 18 (height) - 4 (gap)
    expect(y).toBe(200 - 18 - 4);
  });

  it("clamps left edge so the label stays inside the viewport", () => {
    const { x } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: -50,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 120,
      labelHeight: 18,
    });
    expect(x).toBe(4);
  });

  it("clamps right edge when the label would overflow the viewport (the bug we shipped)", () => {
    const { x } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 1240,
      targetTop: 200,
      targetBottom: 240,
      labelWidth: 200,
      labelHeight: 18,
    });
    // viewportWidth (1280) - labelWidth (200) - margin (4) = 1076
    expect(x).toBe(1076);
  });

  it("flips the label below the element when there's no room above", () => {
    const { y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 4,
      targetBottom: 44,
      labelWidth: 120,
      labelHeight: 18,
    });
    // labelY = 4 - 18 - 4 = -18 → flip → 44 + 4 = 48
    expect(y).toBe(48);
  });

  it("pins to the bottom margin when the element fills the viewport (no room above OR below)", () => {
    const { y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: 200,
      targetTop: 0,
      targetBottom: 800,
      labelWidth: 120,
      labelHeight: 18,
    });
    // Above overflows top → flip below = 800 + 4 = 804 → also overflows
    // bottom → pin to viewportHeight - labelHeight - margin = 778.
    expect(y).toBe(800 - 18 - 4);
  });

  it("never returns a negative coordinate", () => {
    const { x, y } = computeLabelPosition({
      ...VIEWPORT,
      targetLeft: -1000,
      targetTop: -1000,
      targetBottom: -900,
      labelWidth: 5000,
      labelHeight: 5000,
    });
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
