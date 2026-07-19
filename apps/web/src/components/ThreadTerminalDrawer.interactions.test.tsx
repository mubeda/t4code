// @vitest-environment happy-dom

import { scopeThreadRef } from "@t4code/client-runtime/environment";
import {
  createTerminalTranscriptRuntime,
  type TerminalTranscriptRuntime,
} from "@t4code/client-runtime/state/terminal";
import {
  EnvironmentId,
  ThreadId,
  type ResolvedKeybindingsConfig,
  type TerminalAttachStreamEvent,
  type TerminalSessionSnapshot,
} from "@t4code/contracts";
import type { TerminalFontPreference } from "@t4code/contracts/settings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeTerminalInstance {
  readonly options: Record<string, unknown>;
  cols: number;
  rows: number;
  readonly open: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly scrollToBottom: ReturnType<typeof vi.fn>;
  readonly clearTextureAtlas: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly loadAddon: ReturnType<typeof vi.fn>;
  readonly clearSelection: ReturnType<typeof vi.fn>;
  readonly inputDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly selectionDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly linkDisposable: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly bufferLines: Array<FakeTerminalBufferLine | undefined>;
  readonly writes: string[];
  readonly writesAfterDispose: string[];
  displayedText: string;
  resetCount: number;
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

interface FakeWebglContext {
  readonly getExtension: ReturnType<typeof vi.fn>;
}

interface FakeWebglAddonInstance {
  readonly kind: "webgl";
  readonly activateSpy: ReturnType<typeof vi.fn>;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
  readonly listenerDisposeSpy: ReturnType<typeof vi.fn>;
  dispose(): void;
  onContextLoss(listener: () => void): { dispose(): void };
  triggerContextLoss(): void;
}

const xtermState = vi.hoisted(() => ({
  terminals: [] as FakeTerminalInstance[],
  fitAddons: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
  fitShouldThrow: false,
  loadWebglShouldThrow: false,
}));

const webglState = vi.hoisted(() => ({
  instances: [] as FakeWebglAddonInstance[],
  importCount: 0,
  importGate: null as Promise<void> | null,
  resolveImport: null as (() => void) | null,
  rejectImport: null as ((reason: unknown) => void) | null,
  constructorShouldThrow: false,
  activateShouldThrow: false,
  listenerShouldThrow: false,
  listenerTriggersSynchronously: false,
  listenerDisposeShouldThrow: false,
  disposeShouldThrow: false,
  contextMode: "present" as
    | "present"
    | "missing-context"
    | "missing-extension"
    | "getter-throws"
    | "extension-throws"
    | "lose-throws",
  loseContextSpy: vi.fn(),
  events: [] as string[],
  WebglAddonConstructor: null as (new () => FakeWebglAddonInstance) | null,
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

vi.mock("@xterm/addon-webgl", () => {
  class WebglAddon implements FakeWebglAddonInstance {
    readonly kind = "webgl" as const;
    readonly activateSpy = vi.fn((_terminal: unknown) => {
      if (webglState.activateShouldThrow) {
        throw new Error("sensitive activation failure");
      }
    });
    readonly disposeSpy = vi.fn(() => {
      webglState.events.push("addon.dispose");
      if (webglState.disposeShouldThrow) {
        throw new Error("sensitive dispose failure");
      }
    });
    readonly listenerDisposeSpy = vi.fn();
    private contextLossListener: (() => void) | null = null;

    constructor() {
      webglState.events.push("addon.construct");
      if (webglState.constructorShouldThrow) {
        throw new Error("sensitive construction failure");
      }
      webglState.instances.push(this);
    }

    activate(terminal: unknown): void {
      this.activateSpy(terminal);
      const context: FakeWebglContext = {
        getExtension: vi.fn((name: string) => {
          expect(name).toBe("WEBGL_lose_context");
          if (webglState.contextMode === "extension-throws") {
            throw new Error("sensitive extension failure");
          }
          if (webglState.contextMode === "missing-extension") {
            return null;
          }
          return {
            loseContext: () => {
              webglState.events.push("context.lose");
              webglState.loseContextSpy();
              if (webglState.contextMode === "lose-throws") {
                throw new Error("sensitive context release failure");
              }
            },
          };
        }),
      };

      if (webglState.contextMode === "getter-throws") {
        Object.defineProperty(this, "_renderer", {
          configurable: true,
          get: () => {
            throw new Error("sensitive context getter failure");
          },
        });
      } else {
        Object.defineProperty(this, "_renderer", {
          configurable: true,
          value: webglState.contextMode === "missing-context" ? undefined : { _gl: context },
        });
      }
    }

    dispose(): void {
      this.disposeSpy();
    }

    onContextLoss(listener: () => void): { dispose(): void } {
      if (webglState.listenerShouldThrow) {
        throw new Error("sensitive listener failure");
      }
      this.contextLossListener = listener;
      const disposable = {
        dispose: () => {
          this.listenerDisposeSpy();
          this.contextLossListener = null;
          if (webglState.listenerDisposeShouldThrow) {
            throw new Error("sensitive listener dispose failure");
          }
        },
      };
      if (webglState.listenerTriggersSynchronously) {
        listener();
      }
      return disposable;
    }

    triggerContextLoss(): void {
      this.contextLossListener?.();
    }
  }
  webglState.WebglAddonConstructor = WebglAddon;
  return { WebglAddon };
});

vi.mock("./terminalWebgl", () => ({
  loadTerminalWebglAddon: async () => {
    webglState.importCount += 1;
    if (webglState.WebglAddonConstructor === null) {
      await import("@xterm/addon-webgl");
    }
    const importGate = webglState.importGate;
    if (importGate !== null) {
      await importGate;
    }
    webglState.events.push("module.resolve");
    return { WebglAddon: webglState.WebglAddonConstructor! };
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    readonly options: Record<string, unknown>;
    rows = 24;
    cols = 80;
    readonly writes: string[] = [];
    readonly writesAfterDispose: string[] = [];
    displayedText = "";
    resetCount = 0;
    private disposed = false;
    readonly open = vi.fn();
    readonly focus = vi.fn();
    readonly refresh = vi.fn();
    readonly scrollToBottom = vi.fn();
    readonly clearTextureAtlas = vi.fn();
    readonly loadedAddons: Array<{ dispose?: () => void }> = [];
    readonly dispose = vi.fn(() => {
      this.disposed = true;
      webglState.events.push("terminal.dispose");
      for (const addon of [...this.loadedAddons].toReversed()) {
        addon.dispose?.();
      }
    });
    readonly loadAddon = vi.fn(
      (addon: { kind?: string; activate?: (terminal: unknown) => void; dispose?: () => void }) => {
        const originalDispose = addon.dispose;
        let disposed = false;
        if (originalDispose !== undefined) {
          addon.dispose = () => {
            if (disposed) return;
            disposed = true;
            originalDispose.call(addon);
            const index = this.loadedAddons.indexOf(addon);
            if (index >= 0) {
              this.loadedAddons.splice(index, 1);
            }
          };
        }
        this.loadedAddons.push(addon);
        if (addon.kind === "webgl" && xtermState.loadWebglShouldThrow) {
          throw new Error("sensitive load failure");
        }
        addon.activate?.(this);
      },
    );
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
      if (this.disposed) {
        this.writesAfterDispose.push(value);
        return;
      }
      this.writes.push(value);
      const resetParts = value.split("\u001bc");
      if (resetParts.length === 1) {
        this.displayedText += value;
        return;
      }

      this.resetCount += resetParts.length - 1;
      this.displayedText = resetParts.at(-1) ?? "";
    }
  },
}));

const testState = vi.hoisted(() => ({
  session: {
    buffer: "",
    error: null as string | null,
    status: "running",
    version: 0,
    generation: 0,
    transcriptRuntime: null as TerminalTranscriptRuntime | null,
  },
  attachedSessionInputs: [] as unknown[],
  writeCommand: vi.fn(),
  resizeCommand: vi.fn(),
  previewCommand: vi.fn(),
  openPath: vi.fn(),
  contextMenuShow: vi.fn(),
  shellOpenExternal: vi.fn(),
  localApiAvailable: false,
  webglEnabled: false,
  terminalFontPreference: { mode: "bundled" } as TerminalFontPreference,
  fontLoad: vi.fn(() => Promise.resolve()),
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
  useAttachedTerminalSession: (input: unknown) => {
    testState.attachedSessionInputs.push(input);
    return testState.session;
  },
}));
vi.mock("../hooks/useSettings", () => ({
  usePrimarySettings: (
    selector: (settings: {
      terminal: { webglEnabled: boolean };
      terminalFontPreference: TerminalFontPreference;
    }) => unknown,
  ) =>
    selector({
      terminal: { webglEnabled: testState.webglEnabled },
      terminalFontPreference: testState.terminalFontPreference,
    }),
}));
vi.mock("../lib/terminalFont", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/terminalFont")>();
  return {
    ...actual,
    ensureBundledTerminalFontLoaded: () => testState.fontLoad(),
  };
});
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

import ThreadTerminalDrawer, {
  enqueueTerminalInput,
  releaseTerminalInputScheduler,
  TerminalViewport,
} from "./ThreadTerminalDrawer";
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
const componentTimers = new Set<unknown>();
const componentTimerCallbacks = new Map<() => void, unknown>();
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
    visible: true,
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

function terminalSnapshot(
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalSessionSnapshot {
  return {
    threadId: THREAD_ID,
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status,
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-07-18T00:00:00.000Z",
    sequence: 1,
  };
}

function snapshotEvent(history: string): TerminalAttachStreamEvent {
  return { type: "snapshot", snapshot: terminalSnapshot(history) };
}

function outputEvent(data: string): TerminalAttachStreamEvent {
  return {
    type: "output",
    threadId: THREAD_ID,
    terminalId: "term-1",
    sequence: 2,
    data,
  };
}

function restartedEvent(history: string): TerminalAttachStreamEvent {
  return {
    type: "restarted",
    threadId: THREAD_ID,
    terminalId: "term-1",
    sequence: 3,
    snapshot: { ...terminalSnapshot(history), sequence: 3 },
  };
}

function clearedEvent(): TerminalAttachStreamEvent {
  return {
    type: "cleared",
    threadId: THREAD_ID,
    terminalId: "term-1",
    sequence: 4,
  };
}

function trackedTranscriptRuntime(initialSnapshot: string): {
  readonly runtime: TerminalTranscriptRuntime;
  readonly detachRendererSpy: ReturnType<typeof vi.fn>;
} {
  const source = createTerminalTranscriptRuntime();
  source.ingest(snapshotEvent(initialSnapshot));
  const detachRendererSpy = vi.fn();
  return {
    runtime: {
      ingest: (event) => source.ingest(event),
      attachRenderer: (sink) => {
        const attachment = source.attachRenderer(sink);
        let detached = false;
        return {
          detach() {
            if (detached) return;
            detached = true;
            detachRendererSpy();
            attachment.detach();
          },
        };
      },
      snapshot: () => source.snapshot(),
      metadata: () => source.metadata(),
      subscribeMetadata: (listener) => source.subscribeMetadata(listener),
    },
    detachRendererSpy,
  };
}

async function flushAnimationFrames(): Promise<void> {
  await act(async () => {
    while (animationFrames.size > 0) {
      const callbacks = Array.from(animationFrames.values());
      animationFrames.clear();
      for (const callback of callbacks) callback(0);
      await Promise.resolve();
    }
  });
}

async function flushComponentFitTimers(): Promise<void> {
  await act(async () => {
    for (const [callback, timerId] of componentTimerCallbacks) {
      componentTimerCallbacks.delete(callback);
      window.clearTimeout(timerId as number);
      callback();
      await Promise.resolve();
    }
  });
}

function deferWebglImport(): void {
  webglState.importGate = new Promise<void>((resolve, reject) => {
    webglState.resolveImport = resolve;
    webglState.rejectImport = reject;
  });
}

async function settleWebgl(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function mountViewport(
  options: {
    readonly visible?: boolean;
    readonly initialSnapshot?: string;
    readonly publishRuntime?: boolean;
    readonly webglEnabled?: boolean;
    readonly deferWebglImport?: boolean;
    readonly webglContextMode?: typeof webglState.contextMode;
    readonly autoFocus?: boolean;
    readonly focusRequestId?: number;
    readonly terminalId?: string;
    readonly terminalFontPreference?: TerminalFontPreference;
  } = {},
) {
  testState.webglEnabled = options.webglEnabled ?? false;
  testState.terminalFontPreference = options.terminalFontPreference ?? { mode: "bundled" };
  webglState.contextMode = options.webglContextMode ?? "present";
  if (options.deferWebglImport === true) {
    deferWebglImport();
  }
  const tracked = trackedTranscriptRuntime(options.initialSnapshot ?? "");
  const onSessionExited = vi.fn();
  let props = viewportProps({
    terminalId: options.terminalId ?? "term-1",
    visible: options.visible ?? true,
    onSessionExited,
    autoFocus: options.autoFocus ?? false,
    focusRequestId: options.focusRequestId ?? 0,
  } as Partial<ViewportProps>);
  testState.session = {
    buffer: options.initialSnapshot ?? "",
    error: null,
    status: "running",
    version: 1,
    generation: tracked.runtime.metadata().generation,
    transcriptRuntime: options.publishRuntime === false ? null : tracked.runtime,
  };
  const mounted = await mount(<TerminalViewport {...props} />);

  const rerender = async () => {
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
  };

  return {
    mounted,
    runtime: tracked.runtime,
    detachRendererSpy: tracked.detachRendererSpy,
    closeSessionSpy: onSessionExited,
    get webglAddon(): FakeWebglAddonInstance | null {
      return webglState.instances.at(-1) ?? null;
    },
    get webglImported(): boolean {
      return webglState.importCount > 0;
    },
    get fakeTerminal(): FakeTerminalInstance | null {
      return (
        xtermState.terminals.findLast(
          (terminal) =>
            terminal.dispose.mock.calls.length === 0 &&
            terminal.open.mock.calls.some(
              ([element]) => element instanceof Node && mounted.container.contains(element),
            ),
        ) ?? null
      );
    },
    async publishRuntime() {
      testState.session = {
        ...testState.session,
        generation: tracked.runtime.metadata().generation,
        transcriptRuntime: tracked.runtime,
      };
      await rerender();
    },
    async setTranscriptRuntime(runtime: TerminalTranscriptRuntime | null) {
      testState.session = {
        ...testState.session,
        ...(runtime === null ? {} : { generation: runtime.metadata().generation }),
        transcriptRuntime: runtime,
      };
      await rerender();
    },
    async replaceRuntime(snapshot = "reconnected") {
      const replacement = trackedTranscriptRuntime(snapshot);
      testState.session = {
        ...testState.session,
        generation: replacement.runtime.metadata().generation,
        transcriptRuntime: replacement.runtime,
      };
      await rerender();
      return replacement;
    },
    async setVisible(visible: boolean) {
      props = { ...props, visible } as ViewportProps;
      await rerender();
    },
    async setWebglEnabled(webglEnabled: boolean) {
      testState.webglEnabled = webglEnabled;
      await rerender();
    },
    async setTerminalFontPreference(terminalFontPreference: TerminalFontPreference) {
      testState.terminalFontPreference = terminalFontPreference;
      await rerender();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async setDocumentVisible(documentVisible: boolean) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: documentVisible ? "visible" : "hidden",
      });
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    },
    async requestFocus(focusRequestId: number) {
      props = { ...props, focusRequestId } as ViewportProps;
      await rerender();
    },
    async setAutoFocus(autoFocus: boolean) {
      props = { ...props, autoFocus } as ViewportProps;
      await rerender();
    },
    async triggerResizeEpoch() {
      props = { ...props, resizeEpoch: props.resizeEpoch + 1 } as ViewportProps;
      await rerender();
    },
    setFitDimensions(cols: number, rows: number) {
      const terminal = this.fakeTerminal;
      expect(terminal).not.toBeNull();
      terminal!.cols = cols;
      terminal!.rows = rows;
    },
    async rerenderUnrelated() {
      props = { ...props, terminalLabel: `${props.terminalLabel} updated` } as ViewportProps;
      await rerender();
    },
    async setSessionMetadata(
      metadata: Partial<Pick<typeof testState.session, "error" | "status">>,
    ) {
      testState.session = { ...testState.session, ...metadata };
      await rerender();
    },
    pointerDownOnSurface() {
      const surface = mounted.container.firstElementChild;
      expect(surface).toBeInstanceOf(HTMLElement);
      surface!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      );
    },
    pointerDownOutsideSurface() {
      mounted.container.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      );
    },
    emitOutput(data: string) {
      tracked.runtime.ingest(outputEvent(data));
    },
    async emitRestart(snapshot: string) {
      tracked.runtime.ingest(restartedEvent(snapshot));
      testState.session = {
        ...testState.session,
        generation: tracked.runtime.metadata().generation,
      };
      await rerender();
    },
    settleWebgl,
    async resolveWebglImport() {
      webglState.resolveImport?.();
      webglState.importGate = null;
      webglState.resolveImport = null;
      webglState.rejectImport = null;
      await settleWebgl();
    },
    async rejectWebglImport() {
      webglState.rejectImport?.(new Error("sensitive import failure"));
      webglState.importGate = null;
      webglState.resolveImport = null;
      webglState.rejectImport = null;
      await settleWebgl();
    },
    flushFrame: flushAnimationFrames,
    flushMountFit: flushComponentFitTimers,
    resizeSpy: testState.resizeCommand,
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
  xtermState.loadWebglShouldThrow = false;
  webglState.instances = [];
  webglState.importCount = 0;
  webglState.importGate = null;
  webglState.resolveImport = null;
  webglState.rejectImport = null;
  webglState.constructorShouldThrow = false;
  webglState.activateShouldThrow = false;
  webglState.listenerShouldThrow = false;
  webglState.listenerTriggersSynchronously = false;
  webglState.listenerDisposeShouldThrow = false;
  webglState.disposeShouldThrow = false;
  webglState.contextMode = "present";
  webglState.loseContextSpy.mockReset();
  webglState.events = [];
  const defaultRuntime = createTerminalTranscriptRuntime();
  defaultRuntime.ingest(snapshotEvent(""));
  testState.session = {
    buffer: "",
    error: null,
    status: "running",
    version: 0,
    generation: defaultRuntime.metadata().generation,
    transcriptRuntime: defaultRuntime,
  };
  testState.attachedSessionInputs.length = 0;
  testState.writeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.resizeCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.previewCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.openPath.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.contextMenuShow.mockReset().mockResolvedValue(undefined);
  testState.shellOpenExternal.mockReset().mockResolvedValue(undefined);
  vi.mocked(openTerminalLinkInPreview).mockReset();
  testState.localApiAvailable = false;
  testState.webglEnabled = false;
  testState.terminalFontPreference = { mode: "bundled" };
  testState.fontLoad.mockReset().mockResolvedValue(undefined);
  observerInstances.length = 0;
  componentTimers.clear();
  componentTimerCallbacks.clear();
  animationFrames.clear();
  nextAnimationFrame = 1;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

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
      if (result?.type === "return") {
        componentTimers.add(result.value);
        const callback = setTimeoutSpy.mock.calls[index]?.[0];
        if (typeof callback === "function") {
          componentTimerCallbacks.set(callback, result.value);
        }
      }
    }
  };
  assertComponentTimerCleanup = () => {
    const clearedTimers = new Set<unknown>(clearTimeoutSpy.mock.calls.map(([timerId]) => timerId));
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
  for (const terminalId of [
    "term-1",
    "term-coalesced",
    "term-gated",
    "term-release",
    "term-release-stale",
    "term-remount",
    "term-split-a",
    "term-split-b",
  ]) {
    releaseTerminalInputScheduler(ENVIRONMENT_ID, THREAD_ID, terminalId);
  }
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
  componentTimerCallbacks.clear();
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
  it.each([false, true])(
    "updates the font without recreating the terminal (WebGL: %s)",
    async (webglEnabled) => {
      const view = await mountViewport({ visible: true, webglEnabled });
      const terminal = view.fakeTerminal!;
      const fitAddon = xtermState.fitAddons[0]!;
      await view.flushFrame();
      await view.flushMountFit();

      testState.resizeCommand.mockClear();
      terminal.refresh.mockClear();
      terminal.scrollToBottom.mockClear();
      terminal.clearTextureAtlas.mockClear();
      fitAddon.fit.mockClear();
      testState.fontLoad.mockClear();
      fitAddon.fit.mockImplementation(() => {
        terminal.cols += 1;
      });

      await view.setTerminalFontPreference({ mode: "custom", family: "Maple Mono" });

      expect(xtermState.terminals).toHaveLength(1);
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(view.detachRendererSpy).not.toHaveBeenCalled();
      expect(terminal.options.fontFamily).toBe('"Maple Mono", monospace');
      expect(testState.fontLoad).toHaveBeenCalledOnce();
      expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce();
      expect(fitAddon.fit).toHaveBeenCalledOnce();
      expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
      expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
      expect(testState.resizeCommand).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, terminalId: "term-1", cols: 81, rows: 24 },
      });
    },
  );

  it("issues one resize for the initial geometry and skips unchanged fits from either path", async () => {
    const view = await mountViewport({ visible: true });

    await view.flushFrame();
    await view.flushMountFit();

    expect(view.resizeSpy).toHaveBeenCalledOnce();
    expect(view.resizeSpy).toHaveBeenLastCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", cols: 80, rows: 24 },
    });

    await view.triggerResizeEpoch();
    await view.flushFrame();

    expect(view.resizeSpy).toHaveBeenCalledOnce();
  });

  it("issues one resize when either exact dimension changes and preserves real transitions", async () => {
    const view = await mountViewport({ visible: true });
    await view.flushFrame();
    await view.flushMountFit();

    view.setFitDimensions(120, 24);
    await view.triggerResizeEpoch();
    await view.flushFrame();
    view.setFitDimensions(120, 40);
    await view.triggerResizeEpoch();
    await view.flushFrame();
    view.setFitDimensions(80, 24);
    await view.triggerResizeEpoch();
    await view.flushFrame();

    expect(view.resizeSpy.mock.calls.map(([request]) => request.input)).toEqual([
      { threadId: THREAD_ID, terminalId: "term-1", cols: 80, rows: 24 },
      { threadId: THREAD_ID, terminalId: "term-1", cols: 120, rows: 24 },
      { threadId: THREAD_ID, terminalId: "term-1", cols: 120, rows: 40 },
      { threadId: THREAD_ID, terminalId: "term-1", cols: 80, rows: 24 },
    ]);
  });

  it("allows the same exact geometry to retry after a known resize failure", async () => {
    testState.resizeCommand
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("resize rejected"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const view = await mountViewport({ visible: true });

    await view.flushFrame();
    await view.triggerResizeEpoch();
    await view.flushFrame();
    await view.flushMountFit();

    expect(view.resizeSpy).toHaveBeenCalledTimes(2);
    expect(view.resizeSpy.mock.calls[0]?.[0].input).toEqual(
      view.resizeSpy.mock.calls[1]?.[0].input,
    );
  });

  it("does not let an older failed resize clear a newer successful geometry", async () => {
    let resolveFirst!: (result: unknown) => void;
    testState.resizeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(AsyncResult.success(undefined));
    const view = await mountViewport({ visible: true });
    await view.flushFrame();

    view.setFitDimensions(120, 40);
    await view.triggerResizeEpoch();
    await view.flushFrame();
    resolveFirst(AsyncResult.failure(Cause.fail(new Error("stale resize rejected"))));
    await act(async () => Promise.resolve());

    await view.triggerResizeEpoch();
    await view.flushFrame();

    expect(view.resizeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not resize while hidden or from document-hidden stale callbacks", async () => {
    const hidden = await mountViewport({ visible: false });
    await hidden.flushFrame();
    await hidden.flushMountFit();
    expect(hidden.resizeSpy).not.toHaveBeenCalled();
    await unmount(hidden.mounted);

    const view = await mountViewport({ visible: true });
    await view.flushFrame();
    expect(view.resizeSpy).toHaveBeenCalledOnce();

    await view.triggerResizeEpoch();
    const staleResizeFrame = Array.from(animationFrames.values())[0]!;
    await view.setDocumentVisible(false);
    staleResizeFrame(0);
    await act(async () => Promise.resolve());
    await view.triggerResizeEpoch();
    await view.flushFrame();

    expect(view.resizeSpy).toHaveBeenCalledOnce();
    expect(view.fakeTerminal).toBeNull();
  });

  it("resets the exact-size guard when teardown mounts a replacement renderer", async () => {
    const view = await mountViewport({ visible: true });
    await view.flushFrame();
    await view.flushMountFit();
    expect(view.resizeSpy).toHaveBeenCalledOnce();

    await view.setVisible(false);
    await view.setVisible(true);
    await view.flushFrame();
    await view.flushMountFit();

    expect(view.resizeSpy).toHaveBeenCalledTimes(2);
    expect(view.resizeSpy.mock.calls[0]?.[0].input).toEqual(
      view.resizeSpy.mock.calls[1]?.[0].input,
    );
  });

  it("generation-guards a failed resize completion from a replaced renderer", async () => {
    let resolveFirst!: (result: unknown) => void;
    testState.resizeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(AsyncResult.success(undefined));
    const view = await mountViewport({ visible: true });
    await view.flushFrame();

    await view.setVisible(false);
    await view.setVisible(true);
    await view.flushFrame();
    resolveFirst(AsyncResult.failure(Cause.fail(new Error("old renderer rejected"))));
    await act(async () => Promise.resolve());
    await view.triggerResizeEpoch();
    await view.flushFrame();

    expect(view.resizeSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps exact-size guards isolated between split terminal viewports", async () => {
    const firstProps = viewportProps({ terminalId: "term-split-a" });
    const secondProps = viewportProps({ terminalId: "term-split-b" });
    const mounted = await mount(
      <>
        <TerminalViewport {...firstProps} />
        <TerminalViewport {...secondProps} />
      </>,
    );
    await flushAnimationFrames();
    await flushComponentFitTimers();

    expect(testState.resizeCommand.mock.calls.map(([request]) => request.input.terminalId)).toEqual(
      ["term-split-a", "term-split-b"],
    );

    xtermState.terminals[0]!.cols = 132;
    await act(async () =>
      mounted.root.render(
        <>
          <TerminalViewport {...firstProps} resizeEpoch={1} />
          <TerminalViewport {...secondProps} resizeEpoch={1} />
        </>,
      ),
    );
    await flushAnimationFrames();

    expect(
      testState.resizeCommand.mock.calls.map(([request]) => [
        request.input.terminalId,
        request.input.cols,
        request.input.rows,
      ]),
    ).toEqual([
      ["term-split-a", 80, 24],
      ["term-split-b", 80, 24],
      ["term-split-a", 132, 24],
    ]);
  });

  it("does not resize for focus, theme, output, metadata, or WebGL changes", async () => {
    const view = await mountViewport({
      visible: true,
      autoFocus: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    await view.flushFrame();
    await view.flushMountFit();
    expect(view.resizeSpy).toHaveBeenCalledOnce();

    await view.requestFocus(1);
    view.emitOutput("background output\n");
    await view.setSessionMetadata({ error: "background diagnostic" });
    const observer = observerInstances.at(-1)!;
    observer.callback([], observer as never);
    await view.resolveWebglImport();
    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.settleWebgl();
    await view.rerenderUnrelated();
    await view.flushFrame();

    expect(view.resizeSpy).toHaveBeenCalledOnce();
  });

  it("focuses the active renderer only after its initial fit frame", async () => {
    const view = await mountViewport({ visible: true, autoFocus: true });
    const terminal = view.fakeTerminal!;

    expect(xtermState.fitAddons[0]?.fit).toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();

    await view.flushFrame();

    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("focuses after a delayed attach runtime mounts the active renderer", async () => {
    const view = await mountViewport({
      visible: true,
      autoFocus: true,
      publishRuntime: false,
    });
    expect(view.fakeTerminal).toBeNull();

    await view.publishRuntime();
    const terminal = view.fakeTerminal!;

    expect(xtermState.fitAddons[0]?.fit).toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();

    await view.flushFrame();
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("does not refocus a fulfilled activation when the transcript runtime reconnects", async () => {
    const view = await mountViewport({
      visible: true,
      autoFocus: true,
      focusRequestId: 7,
    });
    const initialTerminal = view.fakeTerminal!;
    await view.flushFrame();
    expect(initialTerminal.focus).toHaveBeenCalledOnce();
    initialTerminal.focus.mockClear();

    await view.replaceRuntime();
    const replacementTerminal = view.fakeTerminal!;
    expect(replacementTerminal).not.toBe(initialTerminal);
    await view.flushFrame();

    expect(initialTerminal.focus).not.toHaveBeenCalled();
    expect(replacementTerminal.focus).not.toHaveBeenCalled();

    await view.requestFocus(8);
    await view.flushFrame();
    expect(replacementTerminal.focus).toHaveBeenCalledOnce();
  });

  it("focuses pointer-down on the terminal surface without clearing selection", async () => {
    const view = await mountViewport({ visible: true, autoFocus: false });
    const terminal = view.fakeTerminal!;
    terminal.hasActiveSelection = true;
    terminal.clearSelection.mockClear();

    view.pointerDownOutsideSurface();
    expect(terminal.focus).not.toHaveBeenCalled();

    view.pointerDownOnSurface();

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("does not focus an inactive renderer when its activation token changes", async () => {
    const view = await mountViewport({ visible: true, autoFocus: false });
    const terminal = view.fakeTerminal!;

    await view.requestFocus(1);
    await view.flushFrame();

    expect(terminal.focus).not.toHaveBeenCalled();

    await view.setAutoFocus(true);
    expect(terminal.focus).not.toHaveBeenCalled();
    await view.flushFrame();
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("does not steal focus for output, metadata, theme, or unrelated rerenders", async () => {
    const view = await mountViewport({ visible: true, autoFocus: true });
    const terminal = view.fakeTerminal!;
    await view.flushFrame();
    terminal.focus.mockClear();

    view.emitOutput("background output\n");
    await view.flushFrame();
    await view.setSessionMetadata({ error: "background diagnostic" });
    await view.setSessionMetadata({ status: "closed" });
    const observer = observerInstances.at(-1)!;
    observer.callback([], observer as never);
    await view.rerenderUnrelated();
    await view.flushFrame();

    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("does not steal focus when WebGL resolves, toggles, or loses context", async () => {
    const view = await mountViewport({
      visible: true,
      autoFocus: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    const terminal = view.fakeTerminal!;
    await view.flushFrame();
    terminal.focus.mockClear();

    await view.resolveWebglImport();
    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.settleWebgl();
    view.webglAddon!.triggerContextLoss();

    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("generation-guards canceled focus frames across rapid activation tokens", async () => {
    const view = await mountViewport({ visible: true, autoFocus: true });
    const terminal = view.fakeTerminal!;
    await view.flushFrame();
    terminal.focus.mockClear();

    await view.requestFocus(1);
    const staleFocusFrame = Array.from(animationFrames.values())[0]!;
    await view.requestFocus(2);

    staleFocusFrame(0);
    expect(terminal.focus).not.toHaveBeenCalled();

    await view.flushFrame();
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("generation-guards a canceled focus frame across hide and renderer replacement", async () => {
    const view = await mountViewport({ visible: true, autoFocus: true });
    const firstTerminal = view.fakeTerminal!;
    await view.flushFrame();
    firstTerminal.focus.mockClear();

    await view.requestFocus(1);
    const staleFocusFrame = Array.from(animationFrames.values())[0]!;
    await view.setVisible(false);
    await view.setVisible(true);
    const replacementTerminal = view.fakeTerminal!;

    staleFocusFrame(0);
    expect(firstTerminal.focus).not.toHaveBeenCalled();
    expect(replacementTerminal.focus).not.toHaveBeenCalled();

    await view.flushFrame();
    expect(replacementTerminal.focus).toHaveBeenCalledOnce();
  });

  it("generation-guards a canceled focus frame while the document is hidden", async () => {
    const view = await mountViewport({ visible: true, autoFocus: true });
    const terminal = view.fakeTerminal!;
    await view.flushFrame();
    terminal.focus.mockClear();

    await view.requestFocus(1);
    const staleFocusFrame = Array.from(animationFrames.values())[0]!;
    await view.setDocumentVisible(false);

    staleFocusFrame(0);

    expect(terminal.focus).not.toHaveBeenCalled();
    expect(view.fakeTerminal).toBeNull();

    await view.setDocumentVisible(true);
    const replacementTerminal = view.fakeTerminal!;
    expect(replacementTerminal.focus).not.toHaveBeenCalled();
    await view.flushFrame();
    expect(replacementTerminal.focus).toHaveBeenCalledOnce();
  });

  it("keeps cursor blink and a visible cursor theme in light and dark mode", async () => {
    const lightView = await mountViewport({ visible: true });
    const lightTerminal = lightView.fakeTerminal!;
    const lightTheme = lightTerminal.options.theme as { readonly cursor?: unknown };

    expect(lightTerminal.options.cursorBlink).toBe(true);
    expect(lightTheme.cursor).toEqual(expect.stringMatching(/\S/));
    await unmount(lightView.mounted);

    document.documentElement.classList.add("dark");
    try {
      const darkView = await mountViewport({ visible: true });
      const darkTerminal = darkView.fakeTerminal!;
      const darkTheme = darkTerminal.options.theme as { readonly cursor?: unknown };

      expect(darkTerminal.options.cursorBlink).toBe(true);
      expect(darkTheme.cursor).toEqual(expect.stringMatching(/\S/));
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("attaches a deferred import while its generation stays current", async () => {
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    await view.resolveWebglImport();
    expect(webglState.instances).toHaveLength(1);
  });

  it("attaches the replacement generation after a deferred import is disabled and enabled", async () => {
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.resolveWebglImport();
    expect(webglState.importCount).toBe(2);
    expect(webglState.instances).toHaveLength(1);
  });

  it("attaches the replacement generation after a deferred import is hidden and shown", async () => {
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    await view.setVisible(false);
    await view.setVisible(true);
    await view.resolveWebglImport();
    expect(webglState.importCount).toBe(2);
    expect(webglState.instances).toHaveLength(1);
  });

  it("ignores a rejected hidden generation and loads WebGL after the viewport is shown", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    const rejectStaleImport = webglState.rejectImport!;

    await view.setVisible(false);
    webglState.importGate = null;
    webglState.resolveImport = null;
    webglState.rejectImport = null;
    await view.setVisible(true);
    await view.settleWebgl();
    const currentAddon = view.webglAddon!;

    rejectStaleImport(new Error("sensitive stale import failure"));
    await view.settleWebgl();

    expect(webglState.importCount).toBe(2);
    expect(webglState.instances).toHaveLength(1);
    expect(currentAddon.disposeSpy).not.toHaveBeenCalled();
    expect(diagnosticSpy).not.toHaveBeenCalled();

    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.settleWebgl();

    expect(webglState.importCount).toBe(3);
    expect(webglState.instances).toHaveLength(2);
    expect(view.webglAddon).not.toBe(currentAddon);
    expect(diagnosticSpy).not.toHaveBeenCalled();
  });

  it("ignores a rejected disabled generation and loads WebGL after the setting is enabled", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });

    await view.setWebglEnabled(false);
    await view.rejectWebglImport();
    await view.setWebglEnabled(true);
    await view.settleWebgl();

    expect(webglState.importCount).toBe(2);
    expect(webglState.instances).toHaveLength(1);
    expect(view.webglAddon).not.toBeNull();
    expect(diagnosticSpy).not.toHaveBeenCalled();
  });

  it("guards a late import across hide, disable, and rapid remount generations", async () => {
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    const firstTerminal = view.fakeTerminal!;

    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.setVisible(false);
    await view.setVisible(true);
    const staleRemountTerminal = view.fakeTerminal!;
    await view.setVisible(false);
    await view.setVisible(true);
    const currentRemountTerminal = view.fakeTerminal!;

    await view.resolveWebglImport();

    expect(firstTerminal.loadAddon).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "webgl" }),
    );
    expect(staleRemountTerminal.loadAddon).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "webgl" }),
    );
    expect(webglState.importCount).toBe(4);
    expect(webglState.events).toContain("addon.construct");
    expect(webglState.instances).toHaveLength(1);
    expect(currentRemountTerminal.loadAddon).toHaveBeenCalledWith(webglState.instances[0]);
  });

  it("loads the WebGL addon only for a visible terminal when the setting is on", async () => {
    const view = await mountViewport({ visible: true, webglEnabled: true });

    await view.settleWebgl();

    expect(view.webglAddon).not.toBeNull();
    expect(view.fakeTerminal?.loadAddon).toHaveBeenCalledWith(view.webglAddon);
  });

  it("never imports WebGL while the setting is off or the viewport is hidden", async () => {
    const disabled = await mountViewport({ visible: true, webglEnabled: false });
    await disabled.settleWebgl();
    expect(disabled.webglImported).toBe(false);
    await unmount(disabled.mounted);

    const hidden = await mountViewport({ visible: false, webglEnabled: true });
    await hidden.settleWebgl();
    expect(hidden.webglImported).toBe(false);
  });

  it("falls back once on context loss and does not retry in the same viewport lifetime", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await mountViewport({ visible: true, webglEnabled: true });
    await view.settleWebgl();
    const addon = view.webglAddon!;

    addon.triggerContextLoss();
    addon.triggerContextLoss();
    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.settleWebgl();

    expect(addon.disposeSpy).toHaveBeenCalledOnce();
    expect(diagnosticSpy).toHaveBeenCalledOnce();
    expect(diagnosticSpy).toHaveBeenCalledWith(
      "[terminal] WebGL renderer unavailable; using the standard renderer.",
    );
    expect(webglState.instances).toHaveLength(1);
    expect(view.fakeTerminal).not.toBeNull();
  });

  it("contains synchronous context loss even when late listener cleanup throws", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    webglState.listenerTriggersSynchronously = true;
    webglState.listenerDisposeShouldThrow = true;
    const view = await mountViewport({ visible: true, webglEnabled: true });
    const terminal = view.fakeTerminal!;

    await view.settleWebgl();
    const addon = view.webglAddon!;

    expect(addon.disposeSpy).toHaveBeenCalledOnce();
    expect(addon.listenerDisposeSpy).toHaveBeenCalledOnce();
    expect(webglState.loseContextSpy).toHaveBeenCalledOnce();
    expect(diagnosticSpy).toHaveBeenCalledOnce();
    expect(view.fakeTerminal).toBe(terminal);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("releases the real WebGL context before disposing xterm on hide", async () => {
    const view = await mountViewport({ visible: true, webglEnabled: true });
    await view.settleWebgl();
    const addon = view.webglAddon!;

    await view.setVisible(false);

    expect(addon.disposeSpy).toHaveBeenCalledOnce();
    expect(webglState.loseContextSpy).toHaveBeenCalledOnce();
    expect(
      webglState.events.filter((event) =>
        ["addon.dispose", "context.lose", "terminal.dispose"].includes(event),
      ),
    ).toEqual(["addon.dispose", "context.lose", "terminal.dispose"]);
  });

  it("toggles WebGL without recreating xterm, detaching the producer, or losing history", async () => {
    const view = await mountViewport({
      visible: true,
      webglEnabled: false,
      initialSnapshot: "retained history",
    });
    const terminal = view.fakeTerminal!;
    const snapshot = view.runtime.snapshot();

    await view.setWebglEnabled(true);
    await view.settleWebgl();
    const firstAddon = view.webglAddon!;
    await view.setWebglEnabled(false);

    expect(view.fakeTerminal).toBe(terminal);
    expect(firstAddon.disposeSpy).toHaveBeenCalledOnce();
    expect(webglState.loseContextSpy).toHaveBeenCalledOnce();
    expect(view.detachRendererSpy).not.toHaveBeenCalled();
    expect(view.closeSessionSpy).not.toHaveBeenCalled();
    expect(view.runtime.snapshot()).toBe(snapshot);

    await view.setWebglEnabled(true);
    await view.settleWebgl();

    expect(view.fakeTerminal).toBe(terminal);
    expect(xtermState.terminals).toHaveLength(1);
    expect(webglState.instances).toHaveLength(2);
    expect(view.webglAddon).not.toBe(firstAddon);
    expect(view.detachRendererSpy).not.toHaveBeenCalled();
    expect(view.closeSessionSpy).not.toHaveBeenCalled();
    expect(view.runtime.snapshot()).toBe(snapshot);
  });

  it.each([
    [
      "construction",
      () => {
        webglState.constructorShouldThrow = true;
      },
    ],
    [
      "xterm load",
      () => {
        xtermState.loadWebglShouldThrow = true;
      },
    ],
    [
      "activation",
      () => {
        webglState.activateShouldThrow = true;
      },
    ],
    [
      "context-listener registration",
      () => {
        webglState.listenerShouldThrow = true;
      },
    ],
  ])(
    "falls back after a %s failure, diagnoses without raw errors, and does not retry",
    async (_failure, configureFailure) => {
      const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      configureFailure();
      const view = await mountViewport({ visible: true, webglEnabled: true });
      const terminal = view.fakeTerminal!;

      await view.settleWebgl();
      const importCountAfterFailure = webglState.importCount;
      await view.setWebglEnabled(false);
      await view.setWebglEnabled(true);
      await view.settleWebgl();

      expect(view.fakeTerminal).toBe(terminal);
      expect(terminal.dispose).not.toHaveBeenCalled();
      expect(webglState.importCount).toBe(importCountAfterFailure);
      expect(diagnosticSpy).toHaveBeenCalledOnce();
      expect(diagnosticSpy).toHaveBeenCalledWith(
        "[terminal] WebGL renderer unavailable; using the standard renderer.",
      );
      expect(diagnosticSpy.mock.calls.flat().join(" ")).not.toContain("sensitive");
    },
  );

  it("falls back after an import rejection and keeps the diagnostic error-free", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await mountViewport({
      visible: true,
      webglEnabled: true,
      deferWebglImport: true,
    });
    const terminal = view.fakeTerminal!;

    await view.rejectWebglImport();
    await view.setWebglEnabled(false);
    await view.setWebglEnabled(true);
    await view.settleWebgl();

    expect(view.fakeTerminal).toBe(terminal);
    expect(webglState.importCount).toBe(1);
    expect(webglState.instances).toHaveLength(0);
    expect(diagnosticSpy).toHaveBeenCalledOnce();
    expect(diagnosticSpy.mock.calls.flat().join(" ")).not.toContain("sensitive");
  });

  it("allows a fresh viewport component to retry after a prior component failed", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    webglState.constructorShouldThrow = true;
    const failed = await mountViewport({ visible: true, webglEnabled: true });
    await failed.settleWebgl();
    await unmount(failed.mounted);

    webglState.constructorShouldThrow = false;
    const retried = await mountViewport({ visible: true, webglEnabled: true });
    await retried.settleWebgl();

    expect(retried.webglAddon).not.toBeNull();
    expect(webglState.importCount).toBe(2);
    expect(diagnosticSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing-context", 0],
    ["missing-extension", 0],
    ["getter-throws", 0],
    ["extension-throws", 0],
    ["lose-throws", 1],
  ] as const)(
    "keeps xterm usable when WebGL cleanup encounters %s",
    async (webglContextMode, expectedLoseCalls) => {
      const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const view = await mountViewport({
        visible: true,
        webglEnabled: true,
        webglContextMode,
      });
      await view.settleWebgl();
      const terminal = view.fakeTerminal!;
      const addon = view.webglAddon!;

      await expect(view.setVisible(false)).resolves.toBeUndefined();

      expect(addon.disposeSpy).toHaveBeenCalledOnce();
      expect(webglState.loseContextSpy).toHaveBeenCalledTimes(expectedLoseCalls);
      expect(terminal.dispose).toHaveBeenCalledOnce();
      expect(view.closeSessionSpy).not.toHaveBeenCalled();
      expect(diagnosticSpy).not.toHaveBeenCalled();
    },
  );

  it("continues context release and terminal cleanup when addon disposal throws", async () => {
    const diagnosticSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    webglState.disposeShouldThrow = true;
    const view = await mountViewport({ visible: true, webglEnabled: true });
    await view.settleWebgl();
    const terminal = view.fakeTerminal!;
    const addon = view.webglAddon!;

    await expect(view.setVisible(false)).resolves.toBeUndefined();

    expect(addon.disposeSpy).toHaveBeenCalledOnce();
    expect(webglState.loseContextSpy).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(diagnosticSpy).not.toHaveBeenCalled();
  });

  it("does not create xterm while hidden and creates it when shown", async () => {
    const view = await mountViewport({ visible: false });
    expect(view.fakeTerminal).toBeNull();
    expect(observerInstances).toHaveLength(0);
    expect(testState.attachedSessionInputs.at(-1)).toMatchObject({ attach: false });

    await view.setVisible(true);

    expect(view.fakeTerminal).not.toBeNull();
    expect(view.fakeTerminal?.open).toHaveBeenCalled();
    expect(testState.attachedSessionInputs.at(-1)).toMatchObject({ attach: true });
  });

  it("waits for the attach producer to publish its runtime before creating xterm", async () => {
    const view = await mountViewport({ visible: true, publishRuntime: false });
    expect(view.fakeTerminal).toBeNull();

    await view.publishRuntime();

    expect(view.fakeTerminal?.open).toHaveBeenCalled();
  });

  it("renders attach failures even when no transcript runtime was published", async () => {
    const view = await mountViewport({ visible: true, publishRuntime: false });
    testState.session = {
      ...testState.session,
      error: "attach failed",
      status: "error",
      transcriptRuntime: null,
    };

    await view.setTranscriptRuntime(null);

    const alert = view.mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("attach failed");
    expect(view.fakeTerminal).toBeNull();
  });

  it("disposes xterm and the renderer attachment when hidden without closing the session", async () => {
    const view = await mountViewport({ visible: true });
    const terminal = view.fakeTerminal!;
    testState.session = {
      ...testState.session,
      status: "closed",
      transcriptRuntime: null,
    };

    await view.setVisible(false);

    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(view.detachRendererSpy).toHaveBeenCalledOnce();
    expect(view.closeSessionSpy).not.toHaveBeenCalled();
    expect(view.fakeTerminal).toBeNull();
  });

  it("seeds the bounded snapshot and applies live deltas through the imperative sink", async () => {
    const view = await mountViewport({ visible: true, initialSnapshot: "boot\n" });
    const terminal = view.fakeTerminal!;
    expect(terminal.writes).toContain("boot\n");

    view.emitOutput("a");
    expect(terminal.writes).not.toContain("a");
    await view.flushFrame();

    expect(terminal.writes.at(-1)).toBe("a");
  });

  it("drops a queued old-generation delta before an authoritative reset", async () => {
    const view = await mountViewport({ visible: true, initialSnapshot: "old\n" });
    const terminal = view.fakeTerminal!;

    view.emitOutput("stale");
    await view.emitRestart("fresh\n");
    await view.flushFrame();

    const resetIndex = terminal.writes.lastIndexOf("\u001bc");
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(terminal.writes.slice(resetIndex)).toEqual(["\u001bc", "fresh\n"]);
    expect(terminal.writes).not.toContain("stale");
  });

  it("reopening reconstructs the transcript and resumes live output with no gap or duplicate (C1, invariant 3)", async () => {
    const initialSnapshot = "\u001b[36mprompt λ$ \u001b[0m";
    const beforeHideDelta = "printf 'héllo 😀'\r\nhéllo 😀\r\n";
    let serverHistory = initialSnapshot;
    const initialRuntime = createTerminalTranscriptRuntime();
    initialRuntime.ingest(snapshotEvent(initialSnapshot));
    const view = await mountViewport({ visible: true, publishRuntime: false });

    await view.setTranscriptRuntime(initialRuntime);
    const firstRenderer = view.fakeTerminal!;
    serverHistory += beforeHideDelta;
    initialRuntime.ingest(outputEvent(beforeHideDelta));
    await view.flushFrame();
    expect(firstRenderer.displayedText).toBe(serverHistory);

    await view.setVisible(false);
    await view.setTranscriptRuntime(null);
    const disposedWriteCount = firstRenderer.writes.length;
    const hiddenDelta = "\u001b[33mfile-α\r\nfile-β\u001b[0m\r\n";
    serverHistory += hiddenDelta;

    // The hidden client has no runtime producer. Server history advances independently.
    expect(firstRenderer.writes).toHaveLength(disposedWriteCount);
    expect(firstRenderer.writesAfterDispose).toEqual([]);
    expect(view.closeSessionSpy).not.toHaveBeenCalled();

    await view.setVisible(true);
    expect(view.fakeTerminal).toBeNull();

    const replacementRuntime = createTerminalTranscriptRuntime();
    replacementRuntime.ingest(snapshotEvent(serverHistory));
    const beforeRendererRegistration = "boundary-雪\r\n";
    serverHistory += beforeRendererRegistration;
    replacementRuntime.ingest(outputEvent(beforeRendererRegistration));

    await view.setTranscriptRuntime(replacementRuntime);
    const replacementRenderer = view.fakeTerminal!;
    const showSnapshot = serverHistory;

    expect(replacementRenderer.displayedText).toBe(showSnapshot);
    expect(replacementRenderer.resetCount).toBe(1);
    expect(replacementRenderer.writes.filter((value) => value === showSnapshot)).toHaveLength(1);

    const postShowDelta = "done 🚀\u001b[2K\r\n";
    serverHistory += postShowDelta;
    replacementRuntime.ingest(outputEvent(`done ${postShowDelta[5]}`));
    replacementRuntime.ingest(outputEvent(postShowDelta.slice(6)));
    await view.flushFrame();

    expect(replacementRenderer.displayedText).toBe(serverHistory);
    expect(replacementRenderer.writes.filter((value) => value === postShowDelta)).toHaveLength(1);
    expect(new TextEncoder().encode(replacementRenderer.displayedText)).toEqual(
      new TextEncoder().encode(serverHistory),
    );
    expect(firstRenderer.writes).toHaveLength(disposedWriteCount);
    expect(firstRenderer.writesAfterDispose).toEqual([]);
    expect(view.closeSessionSpy).not.toHaveBeenCalled();
  });

  it("releases renderer resources while the document is backgrounded and restores them once", async () => {
    const view = await mountViewport({ visible: true, initialSnapshot: "ready" });
    const first = view.fakeTerminal!;

    await view.setDocumentVisible(false);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(view.fakeTerminal).toBeNull();
    expect(testState.attachedSessionInputs.at(-1)).toMatchObject({ attach: false });

    await view.setDocumentVisible(true);
    expect(view.fakeTerminal).not.toBeNull();
    expect(xtermState.terminals).toHaveLength(2);
    expect(testState.attachedSessionInputs.at(-1)).toMatchObject({ attach: true });
  });

  it("does not accumulate renderer listeners, observers, or disposals across rapid hide/show", async () => {
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const view = await mountViewport({ visible: true });
    const first = view.fakeTerminal!;

    await view.setVisible(false);
    await view.setVisible(true);
    const second = view.fakeTerminal!;
    await view.setVisible(false);
    await view.setVisible(false);

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(view.detachRendererSpy).toHaveBeenCalledTimes(2);
    const mouseupAdds = addWindowListener.mock.calls.filter(([type]) => type === "mouseup");
    const mouseupRemoves = removeWindowListener.mock.calls.filter(([type]) => type === "mouseup");
    expect(mouseupRemoves).toHaveLength(mouseupAdds.length);
    const visibilityAdds = addDocumentListener.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    );
    const visibilityRemoves = removeDocumentListener.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    );
    expect(visibilityRemoves).toHaveLength(visibilityAdds.length);
    expect(observerInstances).toHaveLength(2);
    for (const observer of observerInstances) expect(observer.disconnect).toHaveBeenCalledOnce();
  });

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

  it("routes xterm data and renders live output without a React output rerender", async () => {
    const props = viewportProps({ autoFocus: true });
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;
    const runtime = testState.session.transcriptRuntime!;

    await act(async () => terminal.dataHandler?.("pwd\r"));
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "pwd\r" },
    });

    runtime.ingest(outputEvent("ready"));
    await flushAnimationFrames();
    expect(terminal.writes).toContain("ready");

    await act(async () => mounted.root.render(<TerminalViewport {...props} focusRequestId={1} />));

    await flushAnimationFrames();
    expect(terminal.focus).toHaveBeenCalled();
  });

  it("coalesces rapid xterm data into one write", async () => {
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-coalesced" })} />);
    const terminal = xtermState.terminals[0]!;

    terminal.dataHandler?.("a");
    terminal.dataHandler?.("b");
    terminal.dataHandler?.("c");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledOnce();
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-coalesced", data: "abc" },
    });
  });

  it("keeps terminal writes single-flight and drops dependent input after failure", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    let activeWrites = 0;
    let peakActiveWrites = 0;
    testState.writeCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          activeWrites += 1;
          peakActiveWrites = Math.max(peakActiveWrites, activeWrites);
          resolveFirstWrite = (result) => {
            activeWrites -= 1;
            resolve(result);
          };
        }),
    );
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-gated" })} />);
    const terminal = xtermState.terminals[0]!;

    terminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    terminal.dataHandler?.("b");
    terminal.dataHandler?.("c");
    await act(async () => Promise.resolve());

    expect(testState.writeCommand).toHaveBeenCalledOnce();
    expect(peakActiveWrites).toBe(1);

    resolveFirstWrite(AsyncResult.failure(Cause.fail(new Error("first write failed"))));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledOnce();
    expect(terminal.writes).toContain("\r\n[terminal] first write failed\r\n");
  });

  it("treats an interrupted write as uncertain and drops dependent input quietly", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    testState.writeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstWrite = resolve;
        }),
    );
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-interrupted" })} />);
    const terminal = xtermState.terminals[0]!;

    terminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    terminal.dataHandler?.("b");
    terminal.dataHandler?.("c");

    resolveFirstWrite(AsyncResult.failure(Cause.interrupt(1)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledOnce();
    expect(terminal.writes.some((value) => value.includes("[terminal]"))).toBe(false);
  });

  it("serializes synthesized input behind an in-flight interactive write", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    testState.writeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-programmatic" })} />);
    const terminal = xtermState.terminals[0]!;

    terminal.dataHandler?.("interactive");
    await act(async () => Promise.resolve());
    enqueueTerminalInput({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      terminalId: "term-programmatic",
      data: "exit\n",
      fallbackError: "Terminal exit fallback failed",
      write: (data) =>
        testState.writeCommand({
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, terminalId: "term-programmatic", data },
        }),
    });
    await act(async () => Promise.resolve());

    expect(testState.writeCommand).toHaveBeenCalledOnce();

    resolveFirstWrite(AsyncResult.success(undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledTimes(2);
    expect(testState.writeCommand).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-programmatic", data: "exit\n" },
    });
  });

  it("resets pending input only when the attached runtime generation increments", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    testState.writeCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstWrite = resolve;
        }),
    );
    const props = viewportProps();
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;
    const runtime = testState.session.transcriptRuntime!;

    terminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    terminal.dataHandler?.("b");
    await act(async () => Promise.resolve());
    expect(testState.writeCommand).toHaveBeenCalledOnce();

    runtime.ingest(restartedEvent("fresh"));
    testState.session = {
      ...testState.session,
      generation: runtime.metadata().generation,
    };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    resolveFirstWrite(AsyncResult.success(undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledOnce();
  });

  it("does not reset pending input for a cleared transcript", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    testState.writeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const props = viewportProps();
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;
    const runtime = testState.session.transcriptRuntime!;

    terminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    terminal.dataHandler?.("b");
    await act(async () => Promise.resolve());
    runtime.ingest(clearedEvent());
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    resolveFirstWrite(AsyncResult.success(undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledTimes(2);
    expect(testState.writeCommand).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "b" },
    });
  });

  it("creates a fresh scheduler after the terminal input key is released", async () => {
    const first = await mount(
      <TerminalViewport {...viewportProps({ terminalId: "term-release" })} />,
    );
    await unmount(first);
    releaseTerminalInputScheduler(ENVIRONMENT_ID, THREAD_ID, "term-release");

    testState.writeCommand.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("new scheduler failure"))),
    );
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-release" })} />);
    const terminal = xtermState.terminals[1]!;
    terminal.dataHandler?.("x");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminal.writes).toContain("\r\n[terminal] new scheduler failure\r\n");
  });

  it("isolates a replacement binding from an in-flight result released with the old key", async () => {
    let resolveStaleWrite!: (result: unknown) => void;
    testState.writeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail("no details")));

    const first = await mount(
      <TerminalViewport {...viewportProps({ terminalId: "term-release-stale" })} />,
    );
    const oldTerminal = xtermState.terminals[0]!;
    oldTerminal.dataHandler?.("old");
    await act(async () => Promise.resolve());
    await unmount(first);
    releaseTerminalInputScheduler(ENVIRONMENT_ID, THREAD_ID, "term-release-stale");

    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-release-stale" })} />);
    const newTerminal = xtermState.terminals[1]!;
    const clearEvent = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true,
      cancelable: true,
    });
    expect(newTerminal.keyHandler?.(clearEvent)).toBe(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(newTerminal.writes).toContain("\r\n[terminal] Failed to clear terminal\r\n");

    resolveStaleWrite(AsyncResult.failure(Cause.fail(new Error("stale write failed"))));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(oldTerminal.writes).not.toContain("\r\n[terminal] stale write failed\r\n");
    expect(newTerminal.writes).not.toContain("\r\n[terminal] stale write failed\r\n");
    expect(
      newTerminal.writes.filter((value) => value === "\r\n[terminal] Failed to clear terminal\r\n"),
    ).toHaveLength(1);
  });

  it("retargets the retained scheduler across an unmount and keeps fallback metadata aligned", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    let activeWrites = 0;
    let peakActiveWrites = 0;
    const trackWrite = <T,>(write: () => Promise<T>): Promise<T> => {
      activeWrites += 1;
      peakActiveWrites = Math.max(peakActiveWrites, activeWrites);
      return write().finally(() => {
        activeWrites -= 1;
      });
    };
    testState.writeCommand
      .mockImplementationOnce(() =>
        trackWrite(
          () =>
            new Promise((resolve) => {
              resolveFirstWrite = resolve;
            }),
        ),
      )
      .mockImplementationOnce(() =>
        trackWrite(async () =>
          AsyncResult.failure(Cause.fail(new Error("remounted write failed"))),
        ),
      )
      .mockImplementationOnce(() =>
        trackWrite(async () => AsyncResult.failure(Cause.fail("no details"))),
      )
      .mockImplementationOnce(() =>
        trackWrite(async () => AsyncResult.failure(Cause.fail("no details"))),
      );

    const first = await mount(
      <TerminalViewport {...viewportProps({ terminalId: "term-remount" })} />,
    );
    const oldTerminal = xtermState.terminals[0]!;
    oldTerminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    expect(testState.writeCommand).toHaveBeenCalledOnce();

    await unmount(first);
    await mount(<TerminalViewport {...viewportProps({ terminalId: "term-remount" })} />);
    const newTerminal = xtermState.terminals[1]!;
    newTerminal.dataHandler?.("b");
    newTerminal.dataHandler?.("c");
    await act(async () => Promise.resolve());
    expect(testState.writeCommand).toHaveBeenCalledOnce();

    resolveFirstWrite(AsyncResult.success(undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(peakActiveWrites).toBe(1);
    expect(testState.writeCommand).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-remount", data: "bc" },
    });
    expect(oldTerminal.writes).not.toContain("\r\n[terminal] remounted write failed\r\n");
    expect(
      newTerminal.writes.filter((value) => value === "\r\n[terminal] remounted write failed\r\n"),
    ).toHaveLength(1);

    const clearEvent = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true,
      cancelable: true,
    });
    expect(newTerminal.keyHandler?.(clearEvent)).toBe(false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      newTerminal.writes.filter((value) => value === "\r\n[terminal] Failed to clear terminal\r\n"),
    ).toHaveLength(1);

    newTerminal.dataHandler?.("later");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      newTerminal.writes.filter((value) => value === "\r\n[terminal] Terminal write failed\r\n"),
    ).toHaveLength(1);
  });

  it("keeps queued input draining while hidden and reports later failures to the current renderer", async () => {
    let resolveFirstWrite!: (result: unknown) => void;
    testState.writeCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstWrite = resolve;
          }),
      )
      .mockResolvedValueOnce(AsyncResult.success(undefined))
      .mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new Error("current renderer failure"))),
      );
    const view = await mountViewport({ visible: true });
    const firstTerminal = view.fakeTerminal!;

    firstTerminal.dataHandler?.("a");
    await act(async () => Promise.resolve());
    firstTerminal.dataHandler?.("b");
    await act(async () => Promise.resolve());
    expect(testState.writeCommand).toHaveBeenCalledOnce();

    await view.setVisible(false);
    resolveFirstWrite(AsyncResult.success(undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(testState.writeCommand).toHaveBeenCalledTimes(2);
    expect(testState.writeCommand).toHaveBeenNthCalledWith(2, {
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "b" },
    });
    expect(firstTerminal.writes).not.toContain("\r\n[terminal] Terminal write failed\r\n");

    await view.setVisible(true);
    const currentTerminal = view.fakeTerminal!;
    currentTerminal.dataHandler?.("c");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(currentTerminal.writes).toContain("\r\n[terminal] current renderer failure\r\n");
    expect(firstTerminal.writes).not.toContain("\r\n[terminal] current renderer failure\r\n");
  });

  it("applies authoritative resets and reports metadata errors and closure once", async () => {
    const onSessionExited = vi.fn();
    const props = viewportProps({ onSessionExited });
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;
    const runtime = testState.session.transcriptRuntime!;

    runtime.ingest(outputEvent("abcdef"));
    await flushAnimationFrames();
    runtime.ingest(restartedEvent("xy"));
    testState.session = {
      ...testState.session,
      error: "stream failed",
      status: "closed",
      generation: runtime.metadata().generation,
    };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));

    expect(terminal.writes).toContain("\u001bc");
    expect(terminal.writes).toContain("xy");
    expect(terminal.writes).toContain("\r\n[terminal] stream failed\r\n");
    expect(terminal.writes).toContain("\r\n[terminal] Terminal closed\r\n");
    expect(onSessionExited).toHaveBeenCalledOnce();

    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    expect(onSessionExited).toHaveBeenCalledOnce();
    expect(
      terminal.writes.filter((value) => value === "\r\n[terminal] stream failed\r\n"),
    ).toHaveLength(1);
  });

  it("reports an error that is already present on the first authoritative publication once", async () => {
    const props = viewportProps();
    testState.session = {
      ...testState.session,
      error: "initial stream failure",
      status: "error",
    };
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;

    expect(terminal.writes).toContain("\r\n[terminal] initial stream failure\r\n");
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    expect(
      terminal.writes.filter((value) => value === "\r\n[terminal] initial stream failure\r\n"),
    ).toHaveLength(1);
  });

  it("handles an already-exited first authoritative publication once", async () => {
    const onSessionExited = vi.fn();
    const props = viewportProps({ onSessionExited });
    testState.session = { ...testState.session, status: "exited" };
    const mounted = await mount(<TerminalViewport {...props} />);
    const terminal = xtermState.terminals[0]!;

    expect(terminal.writes).toContain("\r\n[terminal] Process exited\r\n");
    expect(onSessionExited).toHaveBeenCalledOnce();
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
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
    expect(testState.writeCommand).toHaveBeenCalledOnce();
    expect(testState.writeCommand).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, terminalId: "term-1", data: "\u001bb\u0015" },
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

  it("cancels pending selection actions and ignores unavailable selection UI", async () => {
    const mounted = await mount(<TerminalViewport {...viewportProps()} />);
    await flushAnimationFrames();
    const terminal = xtermState.terminals[0]!;
    const mountElement = mounted.container.querySelector<HTMLElement>(".overflow-hidden")!;

    await act(async () => {
      mountElement.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
      );
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 2 }));
      mountElement.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2 }),
      );

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
      await new Promise((resolve) => window.setTimeout(resolve, 2));
      expect(animationFrames.size).toBeGreaterThan(0);
      mountElement.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 3 }),
      );
      expect(animationFrames.size).toBe(0);

      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 1, detail: 1 }));
      terminal.dataHandler?.("");
      terminal.hasActiveSelection = true;
      terminal.selectionHandler?.();
    });

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
      await new Promise((resolve) => window.setTimeout(resolve, 2));
      for (const callback of animationFrames.values()) callback(0);
      animationFrames.clear();
      await Promise.resolve();
    });
    expect(testState.contextMenuShow).not.toHaveBeenCalled();
  });

  it("rejects incomplete or stale native selection actions", async () => {
    testState.localApiAvailable = true;
    let resolveMenu!: (value: string) => void;
    testState.contextMenuShow.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveMenu = resolve;
        }),
    );
    const onAddTerminalContext = vi.fn();
    const mounted = await mount(<TerminalViewport {...viewportProps({ onAddTerminalContext })} />);
    const terminal = xtermState.terminals[0]!;
    const mountElement = mounted.container.querySelector<HTMLElement>(".overflow-hidden")!;

    const requestSelectionAction = async () => {
      await act(async () => {
        mountElement.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
        );
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
        await new Promise((resolve) => window.setTimeout(resolve, 2));
        for (const callback of animationFrames.values()) callback(0);
        animationFrames.clear();
        await Promise.resolve();
      });
    };

    await requestSelectionAction();
    expect(testState.contextMenuShow).not.toHaveBeenCalled();

    terminal.hasActiveSelection = true;
    terminal.selectionText = "selected";
    terminal.selectionPosition = null;
    await requestSelectionAction();
    expect(testState.contextMenuShow).not.toHaveBeenCalled();

    terminal.selectionText = "\r\n";
    terminal.selectionPosition = { start: { y: 0 } };
    await requestSelectionAction();
    expect(testState.contextMenuShow).not.toHaveBeenCalled();

    terminal.selectionText = "selected";
    await requestSelectionAction();
    expect(testState.contextMenuShow).toHaveBeenCalledOnce();

    await requestSelectionAction();
    expect(testState.contextMenuShow).toHaveBeenCalledOnce();
    mountElement.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2 }),
    );
    resolveMenu("add-to-chat");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onAddTerminalContext).not.toHaveBeenCalled();
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
    const runtime = testState.session.transcriptRuntime!;

    testState.session = { ...testState.session, status: "exited" };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    expect(terminal.writes).toContain("\r\n[terminal] Process exited\r\n");
    expect(onSessionExited).toHaveBeenCalledOnce();

    runtime.ingest(restartedEvent("done"));
    testState.session = {
      ...testState.session,
      status: "running",
      generation: runtime.metadata().generation,
    };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
    testState.session = { ...testState.session, status: "exited" };
    await act(async () => mounted.root.render(<TerminalViewport {...props} />));
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
    terminal.writes.length = 0;

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
    terminal.writes.length = 0;

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
    terminal.writes.length = 0;

    await unmount(mounted);

    expect(provideTerminalLinks(terminal)).toBeUndefined();
    link!.activate(new MouseEvent("click", { metaKey: true }));
    expect(terminal.writes).toEqual([]);
  });
});

describe("ThreadTerminalDrawer mounted controls", () => {
  it("forwards provider launch commands to terminal attachment", async () => {
    await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          threadRef: scopeThreadRef(EnvironmentId.make("environment-1"), THREAD_ID),
          terminalCommandsById: new Map([
            [
              "term-1",
              {
                executable: "/opt/codex",
                args: ["--dangerously-bypass-approvals-and-sandbox"],
                label: "Codex Terminal",
              },
            ],
          ]),
        })}
      />,
    );

    expect(testState.attachedSessionInputs).toContainEqual({
      environmentId: "environment-1",
      terminal: expect.objectContaining({
        terminalId: "term-1",
        command: {
          executable: "/opt/codex",
          args: ["--dangerously-bypass-approvals-and-sandbox"],
          label: "Codex Terminal",
        },
      }),
      attach: true,
    });
  });

  it("passes visibility to every active split pane without retaining hidden xterms", async () => {
    const props = drawerProps({
      visible: false,
      terminalIds: ["term-1", "term-2"],
      terminalGroups: [{ id: "group-1", terminalIds: ["term-1", "term-2"] }],
    });
    const mounted = await mount(<ThreadTerminalDrawer {...props} />);
    expect(xtermState.terminals).toHaveLength(0);

    await act(async () => mounted.root.render(<ThreadTerminalDrawer {...props} visible />));
    expect(xtermState.terminals).toHaveLength(2);

    await act(async () => mounted.root.render(<ThreadTerminalDrawer {...props} visible={false} />));
    for (const terminal of xtermState.terminals) {
      expect(terminal.dispose).toHaveBeenCalledOnce();
    }
  });

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

  it("renders an empty panel without drawer resize or create controls", async () => {
    const mounted = await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          mode: "panel",
          height: Number.NaN,
          terminalIds: [],
          terminalGroups: [],
          onNewTerminal: undefined,
        })}
      />,
    );

    const aside = mounted.container.querySelector("aside");
    expect(aside?.getAttribute("data-terminal-owner")).toBe("right-panel");
    expect(aside?.getAttribute("style")).toBeNull();
    expect(mounted.container.querySelector(".cursor-row-resize")).toBeNull();
    expect(mounted.container.querySelector("button")).toBeNull();
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

  it("normalizes malformed groups and enforces the split limit for a vertical group", async () => {
    const onSplitTerminal = vi.fn();
    const onSplitTerminalVertical = vi.fn();
    const onNewTerminal = vi.fn();
    const onCloseTerminal = vi.fn();
    const onActiveTerminalChange = vi.fn();
    const mounted = await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          mode: "panel",
          worktreePath: "/worktree",
          runtimeEnv: { ROOT_TERMINAL: "1" },
          terminalIds: [" term-1 ", "term-1", "", "term-2", "term-3", "term-4", "orphan"],
          activeTerminalId: "missing",
          activeTerminalGroupId: "missing",
          terminalGroups: [
            {
              id: "",
              terminalIds: ["", "missing", "term-1", "term-1", "term-2", "term-3", "term-4"],
              splitDirection: "vertical",
            },
            { id: "group-term-1", terminalIds: ["term-1"] },
            { id: "group-term-1", terminalIds: ["orphan"] },
          ],
          onSplitTerminal,
          onSplitTerminalVertical,
          onNewTerminal,
          onCloseTerminal,
          onActiveTerminalChange,
          splitShortcutLabel: "Ctrl+H",
          splitVerticalShortcutLabel: "Ctrl+V",
          newShortcutLabel: "Ctrl+N",
          closeShortcutLabel: "Ctrl+W",
          terminalLabelsById: new Map([["term-1", "Primary"]]),
          terminalLaunchLocationsById: new Map([
            [
              "term-2",
              {
                cwd: "/alternate",
                worktreePath: null,
                runtimeEnv: { TERMINAL_VARIANT: "secondary" },
              },
            ],
          ]),
        })}
      />,
    );

    expect(xtermState.terminals).toHaveLength(4);
    expect(mounted.container.textContent).toContain("Primary");
    expect(mounted.container.querySelector<HTMLElement>(".grid")?.style.gridTemplateRows).toContain(
      "repeat(4",
    );
    expect(testState.attachedSessionInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          terminal: expect.objectContaining({
            terminalId: "term-2",
            cwd: "/alternate",
            worktreePath: null,
            env: { TERMINAL_VARIANT: "secondary" },
          }),
        }),
      ]),
    );

    await click(buttonByLabel("Split Terminal Horizontally (max 4 per group)"));
    await click(buttonByLabel("Split Terminal Vertically (max 4 per group)"));
    expect(onSplitTerminal).not.toHaveBeenCalled();
    expect(onSplitTerminalVertical).not.toHaveBeenCalled();

    await click(buttonByLabel("New Terminal (Ctrl+N)"));
    await click(buttonByLabel("Close Terminal (Ctrl+W)"));
    expect(onNewTerminal).toHaveBeenCalledOnce();
    expect(onCloseTerminal).toHaveBeenCalledWith("term-1");

    const splitPanes = Array.from(
      mounted.container.querySelector<HTMLElement>(".grid")?.children ?? [],
    ) as HTMLElement[];
    expect(splitPanes).toHaveLength(4);
    splitPanes[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onActiveTerminalChange).not.toHaveBeenCalled();
    splitPanes[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onActiveTerminalChange).toHaveBeenCalledWith("term-2");
  });

  it("shows shortcut labels for an under-limit horizontal split", async () => {
    const onSplitTerminal = vi.fn();
    const onSplitTerminalVertical = vi.fn();
    await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1", "term-2"],
          activeTerminalId: "term-2",
          terminalGroups: [{ id: "group-1", terminalIds: ["term-1", "term-2"] }],
          onSplitTerminal,
          onSplitTerminalVertical,
          splitShortcutLabel: "Ctrl+H",
          splitVerticalShortcutLabel: "Ctrl+V",
        })}
      />,
    );

    await click(buttonByLabel("Split Terminal Horizontally (Ctrl+H)"));
    await click(buttonByLabel("Split Terminal Vertically (Ctrl+V)"));
    expect(onSplitTerminal).toHaveBeenCalledOnce();
    expect(onSplitTerminalVertical).toHaveBeenCalledOnce();
  });

  it("derives a default group and omits unavailable terminal actions", async () => {
    const onCloseTerminal = vi.fn();
    await mount(
      <ThreadTerminalDrawer
        {...drawerProps({
          terminalIds: ["term-1"],
          activeTerminalId: "missing",
          activeTerminalGroupId: "missing",
          terminalGroups: [],
          onSplitTerminal: undefined,
          onSplitTerminalVertical: undefined,
          onNewTerminal: undefined,
          onCloseTerminal,
        })}
      />,
    );

    expect(document.querySelectorAll('button[aria-label^="Split Terminal"]')).toHaveLength(0);
    expect(document.querySelector('button[aria-label^="New Terminal"]')).toBeNull();
    await click(buttonByLabel("Close Terminal"));
    expect(onCloseTerminal).toHaveBeenCalledWith("term-1");
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

  it("ignores unrelated resize gestures and clamps a window resize", async () => {
    vi.stubGlobal("innerHeight", 800);
    const onHeightChange = vi.fn();
    const props = drawerProps({
      onHeightChange,
      terminalIds: [],
      terminalGroups: [],
      onNewTerminal: undefined,
    });
    const mounted = await mount(<ThreadTerminalDrawer {...props} />);
    const handle = mounted.container.querySelector<HTMLElement>(".cursor-row-resize")!;
    Object.defineProperties(handle, {
      setPointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
      hasPointerCapture: {
        configurable: true,
        value: () => false,
      },
      releasePointerCapture: {
        configurable: true,
        value: vi.fn(),
      },
    });

    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 1, pointerId: 1, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 250 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientY: 250 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientY: 300 }),
      );
      handle.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientY: 300 }),
      );
    });
    expect(onHeightChange).not.toHaveBeenCalled();

    vi.stubGlobal("innerHeight", 240);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(mounted.container.querySelector("aside")?.getAttribute("style")).toContain("180px");
    expect(onHeightChange).toHaveBeenCalledWith(180);

    const nextThreadId = ThreadId.make("thread-resized");
    await act(async () =>
      mounted.root.render(
        <ThreadTerminalDrawer {...props} threadId={nextThreadId} height={360} visible={false} />,
      ),
    );
    expect(mounted.container.querySelector("aside")?.getAttribute("style")).toContain("180px");
  });
});
