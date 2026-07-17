// @vitest-environment happy-dom

import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t4code/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeTerminalInstance {
  readonly options: Record<string, unknown>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly clearSelection: ReturnType<typeof vi.fn>;
  readonly inputDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly selectionDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly linkDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly bufferLines: Array<FakeTerminalBufferLine | undefined>;
  readonly writes: string[];
  dataHandler: ((data: string) => void) | null;
  linkProvider: FakeTerminalLinkProvider | null;
  selectionHandler: (() => void) | null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null;
  hasActiveSelection: boolean;
  selectionText: string;
  selectionPosition: { start: { y: number } } | null;
}

interface FakeTerminalBufferLine {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

interface FakeTerminalLink {
  readonly text: string;
  readonly activate: (event: MouseEvent) => void;
}

interface FakeTerminalLinkProvider {
  provideLinks(
    bufferLineNumber: number,
    callback: (links: ReadonlyArray<FakeTerminalLink> | undefined) => void,
  ): void;
}

const xtermState = vi.hoisted(() => ({
  terminals: [] as FakeTerminalInstance[],
  fitAddons: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
  fitShouldThrow: false,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    readonly fit = vi.fn();
    constructor() {
      if (xtermState.fitShouldThrow) {
        this.fit.mockImplementation(() => {
          throw new Error("container not measurable");
        });
      }
      xtermState.fitAddons.push(this);
    }
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    readonly options: Record<string, unknown>;
    readonly rows = 24;
    readonly cols = 80;
    readonly writes: string[] = [];
    readonly open = vi.fn();
    readonly focus = vi.fn();
    readonly refresh = vi.fn();
    readonly scrollToBottom = vi.fn();
    readonly dispose = vi.fn();
    readonly loadAddon = vi.fn();
    readonly clearSelection = vi.fn();
    readonly inputDisposable = { dispose: vi.fn() };
    readonly selectionDisposable = { dispose: vi.fn() };
    readonly linkDisposable = { dispose: vi.fn() };
    readonly bufferLines: Array<FakeTerminalBufferLine | undefined> = [];
    readonly buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: (index: number) => this.bufferLines[index],
      },
    };
    dataHandler: ((data: string) => void) | null = null;
    linkProvider: FakeTerminalLinkProvider | null = null;
    selectionHandler: (() => void) | null = null;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    hasActiveSelection = false;
    selectionText = "";
    selectionPosition: { start: { y: number } } | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermState.terminals.push(this);
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }

    registerLinkProvider(provider: FakeTerminalLinkProvider) {
      this.linkProvider = provider;
      return this.linkDisposable;
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return this.inputDisposable;
    }

    onSelectionChange(handler: () => void) {
      this.selectionHandler = handler;
      return this.selectionDisposable;
    }

    hasSelection() {
      return this.hasActiveSelection;
    }

    getSelection() {
      return this.selectionText;
    }

    getSelectionPosition() {
      return this.selectionPosition;
    }

    write(value: string) {
      this.writes.push(value);
    }
  },
}));

const testState = vi.hoisted(() => ({
  session: { buffer: "", error: null as string | null, status: "running", version: 0 },
  writeCommand: vi.fn(),
  resizeCommand: vi.fn(),
  previewCommand: vi.fn(),
  openPath: vi.fn(),
  contextMenuShow: vi.fn(),
  shellOpenExternal: vi.fn(),
  localApiAvailable: false,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: ["vscode"] }) }));
vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "server-config" },
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: "preview-open" } }));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { write: "terminal-write", resize: "terminal-resize" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    if (command === "terminal-write") return testState.writeCommand;
    if (command === "terminal-resize") return testState.resizeCommand;
    return testState.previewCommand;
  },
}));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => testState.session,
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => testState.openPath,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () =>
    testState.localApiAvailable
      ? {
          contextMenu: { show: testState.contextMenuShow },
          shell: { openExternal: testState.shellOpenExternal },
        }
      : undefined,
}));
vi.mock("./preview/openTerminalLinkInPreview", () => ({
  openTerminalLinkInPreview: vi.fn(),
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render?: React.ReactNode;
    children?: React.ReactNode;
  }) => <>{render ?? children}</>,
  PopoverPopup: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import ThreadTerminalDrawer, { TerminalViewport } from "./ThreadTerminalDrawer";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";

const ENVIRONMENT_ID = EnvironmentId.make("terminal-interactions");
const THREAD_ID = ThreadId.make("thread-interactions");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, THREAD_ID);
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

type ViewportProps = Parameters<typeof TerminalViewport>[0];
type DrawerProps = Parameters<typeof ThreadTerminalDrawer>[0];

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const observerInstances: Array<{
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  callback: MutationCallback;
}> = [];
const componentTimers = new Set<number>();
const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
let beginComponentTimerCapture = () => 0;
let captureComponentTimers = (_startIndex: number) => undefined;
let assertComponentTimerCleanup = () => undefined;
let assertComponentListenerCleanup = () => undefined;

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  const timerCallStart = beginComponentTimerCapture();
  await act(async () => root.render(element));
  captureComponentTimers(timerCallStart);
  return mounted;
}

async function unmount(mounted: MountedTree): Promise<void> {
  const index = mountedTrees.indexOf(mounted);
  if (index >= 0) mountedTrees.splice(index, 1);
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

function viewportProps(overrides: Partial<ViewportProps> = {}): ViewportProps {
  return {
    threadRef: THREAD_REF,
    threadId: THREAD_ID,
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    cwd: "/repo",
    onSessionExited: vi.fn(),
    onAddTerminalContext: vi.fn(),
    focusRequestId: 0,
    autoFocus: false,
    resizeEpoch: 0,
    drawerHeight: 280,
    keybindings: EMPTY_KEYBINDINGS,
    ...overrides,
  };
}

function drawerProps(overrides: Partial<DrawerProps> = {}): DrawerProps {
  return {
    threadRef: THREAD_REF,
    threadId: THREAD_ID,
    cwd: "/repo",
    height: 280,
    terminalIds: ["term-1"],
    activeTerminalId: "term-1",
    terminalGroups: [{ id: "group-1", terminalIds: ["term-1"] }],
    activeTerminalGroupId: "group-1",
    focusRequestId: 0,
    onSplitTerminal: vi.fn(),
    onSplitTerminalVertical: vi.fn(),
    onNewTerminal: vi.fn(),
    onActiveTerminalChange: vi.fn(),
    onCloseTerminal: vi.fn(),
    onHeightChange: vi.fn(),
    onAddTerminalContext: vi.fn(),
    keybindings: EMPTY_KEYBINDINGS,
    ...overrides,
  };
}

function terminalBufferLine(text: string, isWrapped = false): FakeTerminalBufferLine {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.trimEnd() : text),
  };
}

function provideTerminalLinks(
  terminal: FakeTerminalInstance,
  bufferLineNumber = 1,
): ReadonlyArray<FakeTerminalLink> | undefined {
  let providedLinks: ReadonlyArray<FakeTerminalLink> | undefined;
  terminal.linkProvider?.provideLinks(bufferLineNumber, (links) => {
    providedLinks = links;
  });
  return providedLinks;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useRealTimers();
  xtermState.terminals = [];
  xtermState.fitAddons = [];
  xtermState.fitShouldThrow = false;
  testState.session = { buffer: "", error: null, status: "running", version: 0 };
  testState.writeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.resizeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.previewCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.openPath.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.contextMenuShow.mockReset().mockResolvedValue(undefined);
  testState.shellOpenExternal.mockReset().mockResolvedValue(undefined);
  vi.mocked(openTerminalLinkInPreview).mockReset();
  testState.localApiAvailable = false;
  observerInstances.length = 0;
  componentTimers.clear();
  animationFrames.clear();
  nextAnimationFrame = 1;

  const addWindowListener = vi.spyOn(window, "addEventListener");
  const removeWindowListener = vi.spyOn(window, "removeEventListener");
  const addElementListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const removeElementListener = vi.spyOn(HTMLElement.prototype, "removeEventListener");
  assertComponentListenerCleanup = () => {
    for (const [type, listener] of addWindowListener.mock.calls) {
      if (type === "mouseup") {
        expect(removeWindowListener).toHaveBeenCalledWith(type, listener);
      }
    }
    for (const [index, [type, listener]] of addElementListener.mock.calls.entries()) {
      const target = addElementListener.mock.instances[index];
      if (
        type !== "pointerdown" ||
        !(target instanceof HTMLElement) ||
        !target.classList.contains("overflow-hidden")
      ) {
        continue;
      }
      const matchingRemoval = removeElementListener.mock.calls.some(
        ([removedType, removedListener], removalIndex) =>
          removeElementListener.mock.instances[removalIndex] === target &&
          removedType === type &&
          removedListener === listener,
      );
      expect(matchingRemoval).toBe(true);
    }
  };

  vi.stubGlobal(
    "MutationObserver",
    class MutationObserver {
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      readonly callback: MutationCallback;
      constructor(callback: MutationCallback) {
        this.callback = callback;
        observerInstances.push(this);
      }
    },
  );
  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
  beginComponentTimerCapture = () => setTimeoutSpy.mock.calls.length;
  captureComponentTimers = (startIndex) => {
    for (let index = startIndex; index < setTimeoutSpy.mock.calls.length; index += 1) {
      if (setTimeoutSpy.mock.calls[index]?.[1] !== 30) continue;
      const result = setTimeoutSpy.mock.results[index] as
        | { readonly type: string; readonly value?: unknown }
        | undefined;
      if (result?.type === "return" && typeof result.value === "number") {
        componentTimers.add(result.value);
      }
    }
  };
  assertComponentTimerCleanup = () => {
    const clearedTimers = new Set(clearTimeoutSpy.mock.calls.map(([timerId]) => timerId));
    for (const timerId of componentTimers) {
      if (clearedTimers.has(timerId)) componentTimers.delete(timerId);
    }
    expect(componentTimers.size).toBe(0);
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
});

afterEach(async () => {
  while (mountedTrees.length > 0) await unmount(mountedTrees[0]!);
  assertComponentTimerCleanup();
  expect(animationFrames.size).toBe(0);
  assertComponentListenerCleanup();
  for (const observer of observerInstances) expect(observer.disconnect).toHaveBeenCalledOnce();
  for (const terminal of xtermState.terminals) {
    expect(terminal.inputDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.selectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.linkDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  }
  componentTimers.clear();
  animationFrames.clear();
  observerInstances.length = 0;
  xtermState.terminals = [];
  xtermState.fitAddons = [];
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  beginComponentTimerCapture = () => 0;
  captureComponentTimers = () => undefined;
  assertComponentTimerCleanup = () => undefined;
  assertComponentListenerCleanup = () => undefined;
});

describe("TerminalViewport mounted lifecycle", () => {
  it("opens xterm in the rendered mount and disposes effects and listeners on unmount", async () => {
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const mounted = await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    const observer = observerInstances[0]!;

    expect(terminal.open).toHaveBeenCalledWith(mounted.container.querySelector("div"));
    expect(xtermState.fitAddons[0]?.fit).toHaveBeenCalled();
    expect(observer.observe).toHaveBeenCalledWith(
      document.documentElement,
      expect.objectContaining({ attributes: true }),
    );

    await unmount(mounted);

    expect(terminal.inputDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.selectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.linkDisposable.dispose).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith("mouseup", expect.any(Function));
    expect(animationFrames.size).toBe(0);
  });

  it("routes xterm data and renders session updates through React rerenders", async () => {
    const props = viewportProps({ autoFocus: true });
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;

    await act(async () => terminal.dataHandler?.("pwd\r"));
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "pwd\r" },
    });

    testState.session = { buffer: "ready", error: null, status: "running", version: 1 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} focusRequestId={1} />));
    expect(terminal.writes).toContain("ready");

    await act(async () => {
      for (const callback of animationFrames.values()) callback(0);
      animationFrames.clear();
    });
    expect(terminal.focus).toHaveBeenCalled();
  });

  it("rewrites divergent buffers, reports errors, and closes exited sessions once", async () => {
    const onSessionExited = vi.fn();
    const props = viewportProps({ onSessionExited });
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;

    testState.session = { buffer: "abcdef", error: null, status: "running", version: 1 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    testState.session = { buffer: "xy", error: "stream failed", status: "closed", version: 2 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    expect(terminal.writes).toContain("\u001bc");
    expect(terminal.writes).toContain("xy");
    expect(terminal.writes).toContain("\r\n[terminal] stream failed\r\n");
    expect(terminal.writes).toContain("\r\n[terminal] Terminal closed\r\n");
    expect(onSessionExited).toHaveBeenCalledOnce();

    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(onSessionExited).toHaveBeenCalledOnce();
  });

  it("reports write and keyboard-command failures while allowing ordinary keys", async () => {
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    testState.writeCommand.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("write denied"))),
    );
    await act(async () => terminal.dataHandler?.("blocked"));
    await act(async () => Promise.resolve());
    expect(terminal.writes).toContain("\r\n[terminal] write denied\r\n");

    testState.writeCommand.mockResolvedValueOnce(AsyncResult.failure(Cause.fail("no details")));
    const clearEvent = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, cancelable: true });
    expect(terminal.keyHandler?.(clearEvent)).toBe(false);
    await act(async () => Promise.resolve());
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "\u000c" },
    });
    expect(terminal.writes).toContain("\r\n[terminal] Failed to clear terminal\r\n");
    expect(terminal.keyHandler?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  });

  it("routes macOS navigation and delete shortcuts to terminal input", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;

    const moveWord = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      cancelable: true,
    });
    const deleteLine = new KeyboardEvent("keydown", {
      key: "Backspace",
      metaKey: true,
      cancelable: true,
    });
    expect(terminal.keyHandler?.(moveWord)).toBe(false);
    expect(terminal.keyHandler?.(deleteLine)).toBe(false);
    await act(async () => Promise.resolve());

    expect(moveWord.defaultPrevented).toBe(true);
    expect(deleteLine.defaultPrevented).toBe(true);
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "\u001bb" },
    });
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "\u0015" },
    });
  });

  it("adds a normalized terminal selection through the native context menu", async () => {
    testState.localApiAvailable = true;
    testState.contextMenuShow.mockResolvedValue("add-to-chat");
    const onAddTerminalContext = vi.fn();
    const mounted = await mount(
      <TerminalViewport {...viewportProps({ onAddTerminalContext, terminalLabel: "Build" })} />,
    );
    const terminal = xtermState.terminals[0]!;
    terminal.hasActiveSelection = true;
    terminal.selectionText = "\r\nfirst\r\nsecond\r\n";
    terminal.selectionPosition = { start: { y: 4 } };
    const mountElement = mounted.container.querySelector<HTMLElement>(".overflow-hidden")!;

    await act(async () => {
      mountElement.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      );
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          detail: 1,
          clientX: 30,
          clientY: 40,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 2));
      for (const callback of animationFrames.values()) callback(0);
      animationFrames.clear();
      await Promise.resolve();
    });

    expect(testState.contextMenuShow).toHaveBeenCalledWith(
      [{ id: "add-to-chat", label: "Add to chat" }],
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
    expect(onAddTerminalContext).toHaveBeenCalledWith({
      terminalId: "term-1",
      terminalLabel: "Build",
      lineStart: 5,
      lineEnd: 6,
      text: "first\nsecond",
    });
    expect(terminal.clearSelection).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();

    terminal.hasActiveSelection = false;
    terminal.selectionHandler?.();
  });

  it("refreshes theme and refits when the viewport changes", async () => {
    const props = viewportProps();
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;
    const observer = observerInstances[0]!;
    observer.callback([], observer as never);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);

    await act(async () => mounted.root.render(<TerminalViewport {...props} resizeEpoch={1} />));
    await act(async () => {
      for (const callback of animationFrames.values()) callback(0);
      animationFrames.clear();
    });
    expect(xtermState.fitAddons[0]?.fit).toHaveBeenCalled();
    expect(testState.resizeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", cols: 80, rows: 24 },
    });
  });

  it("tolerates an unmeasurable terminal and applies the dark application theme", async () => {
    xtermState.fitShouldThrow = true;
    document.documentElement.classList.add("dark");
    const mounted = await mount(
      <TerminalViewport
        {...viewportProps({ runtimeEnv: { Z_VAR: "last", "": "ignored", A_VAR: "first" } })}
      />,
    );
    const terminal = xtermState.terminals[0]!;

    expect(xtermState.fitAddons[0]?.fit).toHaveBeenCalled();
    expect(terminal.options.theme).toEqual(
      expect.objectContaining({
        cursor: "rgb(180, 203, 255)",
        brightWhite: "rgb(244, 247, 252)",
      }),
    );

    await act(async () => {
      await mounted.root.render(
        <TerminalViewport {...viewportProps({ runtimeEnv: { A_VAR: "first", Z_VAR: "last" } })} />,
      );
    });
    expect(xtermState.terminals).toHaveLength(1);
    document.documentElement.classList.remove("dark");
  });

  it("renders the exited session message and resets exit handling after a restart", async () => {
    const onSessionExited = vi.fn();
    const props = viewportProps({ onSessionExited });
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;

    testState.session = { buffer: "done", error: null, status: "exited", version: 1 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(terminal.writes).toContain("\r\n[terminal] Process exited\r\n");
    expect(onSessionExited).toHaveBeenCalledOnce();

    testState.session = { buffer: "done", error: null, status: "running", version: 2 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    testState.session = { buffer: "done", error: null, status: "exited", version: 3 };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(onSessionExited).toHaveBeenCalledTimes(2);
  });

  it("provides only terminal links that intersect the requested wrapped buffer row", async () => {
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(
      terminalBufferLine("see https://example.test/docs and "),
      terminalBufferLine("src/main.ts:12", true),
      terminalBufferLine("plain output"),
    );

    expect(provideTerminalLinks(terminal, 1)?.map((link) => link.text)).toEqual([
      "https://example.test/docs",
    ]);
    expect(provideTerminalLinks(terminal, 2)?.map((link) => link.text)).toEqual(["src/main.ts:12"]);
    expect(provideTerminalLinks(terminal, 3)).toBeUndefined();
    expect(provideTerminalLinks(terminal, 99)).toBeUndefined();
  });

  it("requires the platform link modifier and reports unavailable browser links", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(terminalBufferLine("https://example.test/docs"));
    const [link] = provideTerminalLinks(terminal) ?? [];
    expect(link).toBeDefined();

    link!.activate(new MouseEvent("click"));
    expect(terminal.writes).toEqual([]);

    link!.activate(new MouseEvent("click", { metaKey: true }));
    expect(terminal.writes).toContain(
      "\r\n[terminal] Opening links is unavailable in this browser.\r\n",
    );
    expect(openTerminalLinkInPreview).not.toHaveBeenCalled();
  });

  it("opens native URL links through preview with the event position", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    testState.localApiAvailable = true;
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(terminalBufferLine("https://example.test/docs"));
    const [link] = provideTerminalLinks(terminal) ?? [];

    link!.activate(new MouseEvent("click", { metaKey: true, clientX: 24, clientY: 36 }));

    expect(openTerminalLinkInPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test/docs",
        position: { x: 24, y: 36 },
        threadRef: THREAD_REF,
      }),
    );
  });

  it("falls back to the native browser and reports shell launch failures", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    testState.localApiAvailable = true;
    vi.mocked(openTerminalLinkInPreview).mockImplementation(async ({ fallbackToBrowser }) => {
      fallbackToBrowser();
    });
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(terminalBufferLine("https://example.test/docs"));
    const [link] = provideTerminalLinks(terminal) ?? [];

    testState.shellOpenExternal.mockRejectedValueOnce(new Error("browser blocked"));
    link!.activate(new MouseEvent("click", { metaKey: true }));
    await act(async () => Promise.resolve());
    expect(testState.shellOpenExternal).toHaveBeenCalledWith("https://example.test/docs");
    expect(terminal.writes).toContain("\r\n[terminal] browser blocked\r\n");

    testState.shellOpenExternal.mockRejectedValueOnce("unknown");
    link!.activate(new MouseEvent("click", { metaKey: true }));
    await act(async () => Promise.resolve());
    expect(terminal.writes).toContain("\r\n[terminal] Unable to open link\r\n");
  });

  it("opens path links and reports editor failures", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(terminalBufferLine("src/main.ts:12"));
    const [link] = provideTerminalLinks(terminal) ?? [];

    link!.activate(new MouseEvent("click", { metaKey: true }));
    await act(async () => Promise.resolve());
    expect(testState.openPath).toHaveBeenCalledWith("/repo/src/main.ts:12");
    expect(terminal.writes).toEqual([]);

    testState.openPath.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("editor unavailable"))),
    );
    link!.activate(new MouseEvent("click", { metaKey: true }));
    await act(async () => Promise.resolve());
    expect(terminal.writes).toContain("\r\n[terminal] editor unavailable\r\n");

    testState.openPath.mockResolvedValueOnce(AsyncResult.failure(Cause.fail("unknown")));
    link!.activate(new MouseEvent("click", { metaKey: true }));
    await act(async () => Promise.resolve());
    expect(terminal.writes).toContain("\r\n[terminal] Unable to open path\r\n");
  });

  it("ignores link providers and activations after the terminal is disposed", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const mounted = await mount(<TerminalViewport {...viewportProps()} />);
    const terminal = xtermState.terminals[0]!;
    terminal.bufferLines.push(terminalBufferLine("https://example.test/docs"));
    const [link] = provideTerminalLinks(terminal) ?? [];

    await unmount(mounted);

    expect(provideTerminalLinks(terminal)).toBeUndefined();
    link!.activate(new MouseEvent("click", { metaKey: true }));
    expect(terminal.writes).toEqual([]);
  });
});

describe("ThreadTerminalDrawer mounted controls", () => {
  it("creates the first terminal from the rendered empty state", async () => {
    const onNewTerminal = vi.fn();
    await mount(
      <ThreadTerminalDrawer
        {...drawerProps({ terminalIds: [], terminalGroups: [], onNewTerminal })}
      />,
    );

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "New Terminal",
    );
    expect(button).toBeDefined();
    await click(button!);
    expect(onNewTerminal).toHaveBeenCalledOnce();
  });

  it("runs split, new, close, and terminal activation from rendered controls", async () => {
    const onSplitTerminal = vi.fn();
    const onSplitTerminalVertical = vi.fn();
    const onNewTerminal = vi.fn();
    const onCloseTerminal = vi.fn();
    const onActiveTerminalChange = vi.fn();
    await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          terminalGroups: [
            { id: "group-1", terminalIds: ["term-1"] },
            { id: "group-2", terminalIds: ["term-2"] },
          ],
          onSplitTerminal,
          onSplitTerminalVertical,
          onNewTerminal,
          onCloseTerminal,
          onActiveTerminalChange,
        })}
      />,
    );

    await click(buttonByLabel("Split Terminal Horizontally"));
    await click(buttonByLabel("Split Terminal Vertically"));
    await click(buttonByLabel("New Terminal"));
    await click(buttonByLabel("Close Terminal"));
    expect(onSplitTerminal).toHaveBeenCalledOnce();
    expect(onSplitTerminalVertical).toHaveBeenCalledOnce();
    expect(onNewTerminal).toHaveBeenCalledOnce();
    expect(onCloseTerminal).toHaveBeenCalledWith("term-1");

    const terminalTwo = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Terminal 2"),
    );
    expect(terminalTwo).toBeDefined();
    await click(terminalTwo!);
    expect(onActiveTerminalChange).toHaveBeenCalledWith("term-2");
  });

  it("resizes the drawer by pointer and syncs the clamped height", async () => {
    const onHeightChange = vi.fn();
    const mounted = await mount(
      <ThreadTerminalDrawer
        {...drawerProps({ onHeightChange, terminalIds: [], terminalGroups: [] })}
      />,
    );
    const handle = mounted.container.querySelector<HTMLElement>(".cursor-row-resize")!;
    const captured = new Set<number>();
    Object.defineProperties(handle, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => captured.add(pointerId),
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => captured.has(pointerId),
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => captured.delete(pointerId),
      },
    });

    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 7, clientY: 250 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientY: 250 }),
      );
    });

    expect(mounted.container.querySelector("aside")?.getAttribute("style")).toContain("330px");
    expect(onHeightChange).toHaveBeenCalledWith(330);
  });
});
