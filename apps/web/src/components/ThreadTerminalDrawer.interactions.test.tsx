// @vitest-environment happy-dom

import { scopeThreadRef } from "@t4code/client-runtime/environment";
import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t4code/contracts";
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
  readonly inputDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly selectionDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly linkDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly writes: string[];
  dataHandler: ((data: string) => void) | null;
}

const xtermState = vi.hoisted(() => ({
  terminals: [] as FakeTerminalInstance[],
  fitAddons: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    readonly fit = vi.fn();
    constructor() {
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
    readonly buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: () => undefined,
      },
    };
    dataHandler: ((data: string) => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermState.terminals.push(this);
    }

    attachCustomKeyEventHandler() {}

    registerLinkProvider() {
      return this.linkDisposable;
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return this.inputDisposable;
    }

    onSelectionChange() {
      return this.selectionDisposable;
    }

    hasSelection() {
      return false;
    }

    getSelection() {
      return "";
    }

    getSelectionPosition() {
      return null;
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
vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useRealTimers();
  xtermState.terminals = [];
  xtermState.fitAddons = [];
  testState.session = { buffer: "", error: null, status: "running", version: 0 };
  testState.writeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.resizeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.previewCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.openPath.mockReset().mockResolvedValue(AsyncResult.success(undefined));
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
      constructor() {
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
});
