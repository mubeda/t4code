import { useAtomValue } from "@effect/atom-react";
import { FitAddon } from "@xterm/addon-fit";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t4code/client-runtime/state/runtime";
import {
  createTerminalInputScheduler,
  createTerminalInputSchedulerRegistry,
  type TerminalInputScheduler,
  type TerminalInputSendResult,
  terminalInputKey,
} from "@t4code/client-runtime/state/terminal";
import {
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type TerminalLaunchCommand,
  type ThreadId,
} from "@t4code/contracts";
import { getTerminalLabel } from "@t4code/shared/terminalLabels";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { useOpenInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readLocalApi } from "~/localApi";
import { useAttachedTerminalSession } from "../state/terminalSessions";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { terminalEnvironment } from "../state/terminal";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { createTerminalOutputSink } from "./terminalOutputSink";
import { loadTerminalWebglAddon } from "./terminalWebgl";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimarySettings } from "../hooks/useSettings";
import { ensureBundledTerminalFontLoaded, resolveTerminalFontFamily } from "../lib/terminalFont";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const terminalInputRegistry = createTerminalInputSchedulerRegistry();
const terminalInputBindings = new Map<string, TerminalInputBinding>();
const TERMINAL_WRITE_INTERRUPTED = Symbol("terminal-write-interrupted");

interface TerminalInputBinding {
  renderer: { readonly owner: object; readonly terminal: Terminal } | null;
  write: ((data: string, fallbackError: string) => Promise<TerminalInputSendResult>) | null;
  readonly pendingFallbacks: Array<{
    remaining: number;
    message: string;
    onWriteError?: ((error: unknown) => void) | undefined;
  }>;
}

type WebglAddonInstance = import("@xterm/addon-webgl").WebglAddon;

interface WebglContextLossDisposable {
  dispose(): void;
}

interface WebglLifecycle {
  readonly terminal: Terminal;
  readonly disposed: boolean;
  setContextLossDisposable(disposable: WebglContextLossDisposable): void;
  dispose(): void;
}

interface WebglLoseContextExtension {
  loseContext(): void;
}

function createWebglLifecycle(addon: WebglAddonInstance, terminal: Terminal): WebglLifecycle {
  let disposed = false;
  let contextLossDisposable: WebglContextLossDisposable | null = null;

  return {
    terminal,
    get disposed() {
      return disposed;
    },
    setContextLossDisposable(disposable) {
      if (disposed) {
        try {
          disposable.dispose();
        } catch {
          // Best-effort listener cleanup must not make the terminal unusable.
        }
        return;
      }
      contextLossDisposable = disposable;
    },
    dispose() {
      if (disposed) return;
      disposed = true;

      let context: WebGL2RenderingContext | undefined;
      try {
        context = (
          addon as unknown as {
            readonly _renderer?: { readonly _gl?: WebGL2RenderingContext };
          }
        )._renderer?._gl;
      } catch {
        // Private renderer details can change between compatible addon releases.
      }

      try {
        contextLossDisposable?.dispose();
      } catch {
        // The addon owns this registration too; continue with renderer cleanup.
      }
      contextLossDisposable = null;

      try {
        addon.dispose();
      } catch {
        // Falling back must remain safe even if a partially activated addon throws.
      }

      try {
        (
          context?.getExtension("WEBGL_lose_context") as WebglLoseContextExtension | null
        )?.loseContext();
      } catch {
        // Context release is best effort because this is an implementation detail.
      }
    },
  };
}

export function releaseTerminalInputScheduler(
  environmentId: string,
  threadId: string,
  terminalId: string,
): void {
  const key = terminalInputKey(environmentId, threadId, terminalId);
  const binding = terminalInputBindings.get(key);
  terminalInputRegistry.release(key);
  if (binding) {
    binding.renderer = null;
    binding.write = null;
    binding.pendingFallbacks.length = 0;
  }
  terminalInputBindings.delete(key);
}

function atomCommandTerminalInputResult(
  result: AtomCommandResult<unknown, unknown>,
  fallbackError: string,
): TerminalInputSendResult {
  if (result._tag === "Success") {
    return { ok: true };
  }
  if (isAtomCommandInterrupted(result)) {
    return { ok: false, error: TERMINAL_WRITE_INTERRUPTED };
  }
  const error = squashAtomCommandFailure(result);
  return {
    ok: false,
    error: error instanceof Error ? error : new Error(fallbackError),
  };
}

export function enqueueTerminalInput<A, E>(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
  readonly fallbackError: string;
  readonly write: (data: string) => Promise<AtomCommandResult<A, E>>;
  readonly onWriteError?: ((error: unknown) => void) | undefined;
}): void {
  if (input.data.length === 0) return;
  const inputKey = terminalInputKey(input.environmentId, input.threadId, input.terminalId);
  const { binding, scheduler } = acquireTerminalInputBinding(inputKey);
  binding.write = async (data, fallbackError) =>
    atomCommandTerminalInputResult(await input.write(data), fallbackError);
  binding.pendingFallbacks.push({
    remaining: input.data.length,
    message: input.fallbackError,
    onWriteError: input.onWriteError,
  });
  scheduler.enqueue(input.data);
}

export function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

export function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function acquireTerminalInputBinding(inputKey: string): {
  readonly binding: TerminalInputBinding;
  readonly scheduler: TerminalInputScheduler;
} {
  let binding = terminalInputBindings.get(inputKey);
  if (!binding) {
    binding = {
      renderer: null,
      write: null,
      pendingFallbacks: [],
    };
    terminalInputBindings.set(inputKey, binding);
  }

  const keyedBinding = binding;
  const scheduler = terminalInputRegistry.acquire(inputKey, () => {
    const rawScheduler = createTerminalInputScheduler({
      send: async (data) => {
        let remaining = data.length;
        let fallbackError = "Terminal write failed";
        let hasFallback = false;
        const consumedFallbacks = new Set<(typeof keyedBinding.pendingFallbacks)[number]>();
        const notifyFallbackFailures = (error: unknown) => {
          if (error === TERMINAL_WRITE_INTERRUPTED) return;
          const affectedFallbacks = new Set([
            ...consumedFallbacks,
            ...keyedBinding.pendingFallbacks,
          ]);
          for (const fallback of affectedFallbacks) {
            try {
              fallback.onWriteError?.(error);
            } catch {
              // Failure observers must not break scheduler cleanup.
            }
          }
        };
        while (remaining > 0 && keyedBinding.pendingFallbacks.length > 0) {
          const pendingFallback = keyedBinding.pendingFallbacks[0]!;
          consumedFallbacks.add(pendingFallback);
          if (!hasFallback) {
            fallbackError = pendingFallback.message;
            hasFallback = true;
          }
          const consumed = Math.min(remaining, pendingFallback.remaining);
          pendingFallback.remaining -= consumed;
          remaining -= consumed;
          if (pendingFallback.remaining === 0) {
            keyedBinding.pendingFallbacks.shift();
          }
        }

        const write = keyedBinding.write;
        if (!write) {
          const error = new Error(fallbackError);
          notifyFallbackFailures(error);
          return { ok: false, error };
        }
        let result: TerminalInputSendResult;
        try {
          result = await write(data, fallbackError);
        } catch (error) {
          notifyFallbackFailures(error);
          throw error;
        }
        if (!result.ok) {
          notifyFallbackFailures(result.error);
        }
        return result;
      },
      onWriteError: (error) => {
        keyedBinding.pendingFallbacks.length = 0;
        if (error === TERMINAL_WRITE_INTERRUPTED) return;
        const active = keyedBinding.renderer?.terminal;
        if (!active) return;
        writeSystemMessage(
          active,
          error instanceof Error ? error.message : "Terminal write failed",
        );
      },
    });

    return {
      enqueue: (data) => rawScheduler.enqueue(data),
      reset: () => {
        keyedBinding.pendingFallbacks.length = 0;
        rawScheduler.reset();
      },
      pendingLength: () => rawScheduler.pendingLength(),
      isDraining: () => rawScheduler.isDraining(),
    };
  });

  return { binding: keyedBinding, scheduler };
}

export function writeTerminalBuffer(terminal: Terminal, buffer: string): void {
  terminal.write("\u001bc");
  if (buffer.length > 0) {
    terminal.write(buffer);
  }
}

export function fitTerminalSafely(fitAddon: FitAddon): boolean {
  try {
    fitAddon.fit();
    return true;
  } catch {
    return false;
  }
}

export function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

export function resolveTerminalDocumentVisibility(
  visibilityState: DocumentVisibilityState,
  desktopUiAutomation: boolean,
): boolean {
  return desktopUiAutomation || visibilityState === "visible";
}

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" ||
    resolveTerminalDocumentVisibility(
      document.visibilityState,
      import.meta.env.VITE_T4CODE_DESKTOP_E2E === "1",
    )
  );
}

export function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

// The terminal's resolved background/foreground/cursor as "r,g,b" triplets,
// keyed by the same `.dark` signal terminalThemeFromApp resolves against. These
// match terminalThemeFromApp's fallback colors so what the PTY reports for an
// OSC color query is consistent with what xterm paints.
const TERMINAL_OSC_COLORS = {
  dark: { background: "14,18,24", foreground: "237,241,247", cursor: "180,203,255" },
  light: { background: "255,255,255", foreground: "28,33,41", cursor: "38,56,78" },
} as const;

// Reserved launch env keys the server consumes to answer OSC 10/11/12 color
// queries at the PTY layer, then strips before spawning the child. This lets
// providers like OpenCode detect a light vs. dark terminal reliably, without
// depending on xterm's slower round-trip reply. See apps/server terminal::osc.
function terminalOscColorEnv(): Record<string, string> {
  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const colors = isDark ? TERMINAL_OSC_COLORS.dark : TERMINAL_OSC_COLORS.light;
  return {
    T4CODE_OSC_BACKGROUND: colors.background,
    T4CODE_OSC_FOREGROUND: colors.foreground,
    T4CODE_OSC_CURSOR: colors.cursor,
  };
}

function terminalThemesEqual(left: ITheme, right: ITheme): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof ITheme>);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

export function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  command?: TerminalLaunchCommand;
  visible: boolean;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Record<string, string>;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  command,
  visible,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const environmentId = threadRef.environmentId;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  });
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  });
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const selectionActionFrameRef = useRef<number | null>(null);
  const keybindingsRef = useRef(keybindings);
  const inputSchedulerRef = useRef<TerminalInputScheduler | null>(null);
  const focusGenerationRef = useRef(0);
  const fulfilledFocusRequestIdRef = useRef<number | null>(null);
  const resizeRendererGenerationRef = useRef(0);
  const lastRequestedSizeRef = useRef<{
    readonly generation: number;
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const webglGenerationRef = useRef(0);
  const webglLifecycleRef = useRef<WebglLifecycle | null>(null);
  const webglFailedRef = useRef(false);
  const webglDiagnosticRecordedRef = useRef(false);
  // Bumped whenever the main renderer effect creates a new Terminal, so the
  // webgl effect re-runs for the replacement instance instead of leaving it on
  // the DOM renderer. The ref lets stale renders be skipped until the state
  // update commits.
  const webglTerminalEpochRef = useRef(0);
  const [webglTerminalEpoch, setWebglTerminalEpoch] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(isDocumentVisible);
  const shouldRender = visible && isDocumentVisible() && documentVisible;
  const webglEnabled = usePrimarySettings((settings) => settings.terminal.webglEnabled);
  const terminalFontPreference = usePrimarySettings((settings) => settings.terminalFontPreference);
  const terminalFontFamily = useMemo(
    () => resolveTerminalFontFamily(terminalFontPreference),
    [terminalFontPreference],
  );
  const readTerminalFontFamily = useEffectEvent(() => terminalFontFamily);
  const runtimeEnvKey = useMemo(() => runtimeEnvSignature(runtimeEnv), [runtimeEnv]);
  const recordWebglDiagnosticOnce = useCallback(() => {
    if (webglDiagnosticRecordedRef.current) return;
    webglDiagnosticRecordedRef.current = true;
    console.warn("[terminal] WebGL renderer unavailable; using the standard renderer.");
  }, []);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  // Launch-command env supplies provider defaults; the reserved OSC color keys
  // carry the resolved theme for the PTY-layer query responder; the thread's
  // runtime env is user configuration and wins on conflicts. Captured at spawn,
  // which is when providers read their terminal background.
  const spawnEnv = useMemo(() => {
    const merged = { ...command?.env, ...terminalOscColorEnv(), ...runtimeEnv };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [command, runtimeEnv]);
  const terminalSession = useAttachedTerminalSession({
    environmentId,
    terminal: {
      threadId,
      terminalId,
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(spawnEnv ? { env: spawnEnv } : {}),
      ...(command ? { command } : {}),
    },
    attach: shouldRender,
  });
  const resizeTerminal = useEffectEvent((cols: number, rows: number) =>
    runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows },
    }),
  );
  const requestTerminalResize = useEffectEvent(
    (rendererGeneration: number, cols: number, rows: number) => {
      if (resizeRendererGenerationRef.current !== rendererGeneration) return;
      const current = lastRequestedSizeRef.current;
      if (
        current?.generation === rendererGeneration &&
        current.cols === cols &&
        current.rows === rows
      ) {
        return;
      }

      const request = {
        generation: rendererGeneration,
        cols,
        rows,
      };
      lastRequestedSizeRef.current = request;
      void resizeTerminal(cols, rows).then((result) => {
        if (
          result._tag === "Failure" &&
          resizeRendererGenerationRef.current === rendererGeneration &&
          lastRequestedSizeRef.current === request
        ) {
          lastRequestedSizeRef.current = null;
        }
      });
    },
  );
  const terminalError = terminalSession.error;
  const terminalStatus = terminalSession.status;
  const terminalGeneration = terminalSession.generation;
  const transcriptRuntime = terminalSession.transcriptRuntime;
  const hasAuthoritativeTerminalState = transcriptRuntime !== null;
  const previousMetadataRef = useRef({
    error: null as string | null,
    status: "closed" as typeof terminalStatus,
  });
  const previousRuntimeGenerationRef = useRef({
    runtime: transcriptRuntime,
    generation: terminalGeneration,
  });

  useEffect(() => {
    if (!visible) return;

    const updateDocumentVisibility = () => {
      setDocumentVisible(isDocumentVisible());
    };
    updateDocumentVisibility();
    document.addEventListener("visibilitychange", updateDocumentVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateDocumentVisibility);
    };
  }, [visible]);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !shouldRender || transcriptRuntime === null) return;

    const localApi = readLocalApi();

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: readTerminalFontFamily(),
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitTerminalSafely(fitAddon);

    const resizeRendererGeneration = resizeRendererGenerationRef.current + 1;
    resizeRendererGenerationRef.current = resizeRendererGeneration;
    lastRequestedSizeRef.current = null;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    webglTerminalEpochRef.current += 1;
    setWebglTerminalEpoch(webglTerminalEpochRef.current);
    const inputKey = terminalInputKey(environmentId, threadId, terminalId);
    const rendererOwner = {};
    const { binding: inputBinding, scheduler: inputScheduler } =
      acquireTerminalInputBinding(inputKey);
    inputSchedulerRef.current = inputScheduler;
    inputBinding.renderer = { owner: rendererOwner, terminal };
    inputBinding.write = async (data, fallbackError) => {
      const result = await runTerminalWrite({
        environmentId,
        input: { threadId, terminalId, data },
      });
      return atomCommandTerminalInputResult(result, fallbackError);
    };
    const createOutputSink = () =>
      createTerminalOutputSink({
        write: (data) => terminal.write(data),
      });
    let outputSink = createOutputSink();
    const rendererAttachment = transcriptRuntime.attachRenderer((signal) => {
      if (signal.type === "delta") {
        outputSink.push(signal.data);
        return;
      }

      // Reset is authoritative. Drop any old-generation delta still queued for
      // a frame before replacing xterm's display with the bounded snapshot.
      outputSink.dispose();
      outputSink = createOutputSink();
      writeTerminalBuffer(terminal, signal.snapshot);
      terminal.clearSelection();
    });

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
      if (selectionActionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionActionFrameRef.current);
        selectionActionFrameRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (!localApi) {
        clearSelectionAction();
        return;
      }
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await localApi.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        handleAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = (data: string, fallbackError: string) => {
      if (inputBinding.renderer?.owner !== rendererOwner || data.length === 0) return;
      inputBinding.pendingFallbacks.push({ remaining: data.length, message: fallbackError });
      inputScheduler.enqueue(data);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalSplitVerticalShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                if (!localApi) {
                  writeSystemMessage(
                    latestTerminal,
                    "Opening links is unavailable in this browser.",
                  );
                  return;
                }
                const fallbackToBrowser = () => {
                  void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : "Unable to open link",
                    );
                  });
                };
                void openTerminalLinkInPreview({
                  url: match.text,
                  position: { x: event.clientX, y: event.clientY },
                  threadRef,
                  openPreview,
                  localApi,
                  fallbackToBrowser,
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void (async () => {
                const result = await openTerminalPath(target);
                if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
                  return;
                }
                const error = squashAtomCommandFailure(result);
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              })();
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      sendTerminalInput(data, "Terminal write failed");
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        selectionActionFrameRef.current = window.requestAnimationFrame(() => {
          selectionActionFrameRef.current = null;
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
      terminal.focus();
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      // <html> class/style churn (tooltips, scroll locks) fires this observer
      // far more often than the theme changes; a repaint rebuilds the glyph
      // atlas, so skip it unless the resolved theme actually differs.
      const nextTheme = terminalThemeFromApp(containerRef.current);
      const currentTheme = activeTerminal.options.theme;
      if (currentTheme && terminalThemesEqual(currentTheme, nextTheme)) return;
      activeTerminal.options.theme = nextTheme;
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      fitTerminalSafely(activeFitAddon);
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      requestTerminalResize(resizeRendererGeneration, activeTerminal.cols, activeTerminal.rows);
    }, 30);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;

      resizeRendererGenerationRef.current += 1;
      lastRequestedSizeRef.current = null;
      window.clearTimeout(fitTimer);
      outputSink.dispose();
      rendererAttachment.detach();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      clearSelectionAction();
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      if (inputBinding.renderer?.owner === rendererOwner) {
        inputBinding.renderer = null;
      }
      if (inputSchedulerRef.current === inputScheduler) {
        inputSchedulerRef.current = null;
      }
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      if (fitAddonRef.current === fitAddon) {
        fitAddonRef.current = null;
      }
      webglGenerationRef.current += 1;
      const activeWebglLifecycle = webglLifecycleRef.current;
      if (activeWebglLifecycle?.terminal === terminal) {
        activeWebglLifecycle.dispose();
        if (webglLifecycleRef.current === activeWebglLifecycle) {
          webglLifecycleRef.current = null;
        }
      }
      terminal.dispose();
    };
    // Focus is handled by a separate activation effect so it never tears down this renderer.
  }, [
    command,
    cwd,
    environmentId,
    runtimeEnvKey,
    shouldRender,
    terminalId,
    threadId,
    transcriptRuntime,
    worktreePath,
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!shouldRender || terminal === null || fitAddon === null) return;

    terminal.options.fontFamily = terminalFontFamily;
    const rendererGeneration = resizeRendererGenerationRef.current;
    let cancelled = false;

    void ensureBundledTerminalFontLoaded().then(() => {
      if (
        cancelled ||
        resizeRendererGenerationRef.current !== rendererGeneration ||
        terminalRef.current !== terminal ||
        fitAddonRef.current !== fitAddon
      ) {
        return;
      }

      const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      terminal.clearTextureAtlas();
      fitTerminalSafely(fitAddon);
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      terminal.refresh(0, terminal.rows - 1);
      requestTerminalResize(rendererGeneration, terminal.cols, terminal.rows);
    });

    return () => {
      cancelled = true;
    };
  }, [shouldRender, terminalFontFamily]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (
      !shouldRender ||
      !webglEnabled ||
      transcriptRuntime === null ||
      terminal === null ||
      webglFailedRef.current
    ) {
      return;
    }
    // A stale render's epoch means a fresh terminal was just created and this
    // effect will re-run once the epoch state commits — attaching now would
    // create a second context for the same terminal.
    if (webglTerminalEpoch !== webglTerminalEpochRef.current) {
      return;
    }

    const generation = webglGenerationRef.current + 1;
    webglGenerationRef.current = generation;
    let cleanedUp = false;
    let lifecycle: WebglLifecycle | null = null;
    const isCurrent = () =>
      !cleanedUp && webglGenerationRef.current === generation && terminalRef.current === terminal;

    void (async () => {
      try {
        const { WebglAddon } = await loadTerminalWebglAddon();
        if (!isCurrent()) return;

        const addon = new WebglAddon();
        lifecycle = createWebglLifecycle(addon, terminal);
        terminal.loadAddon(addon);
        if (!isCurrent()) {
          lifecycle.dispose();
          return;
        }

        const contextLossDisposable = addon.onContextLoss(() => {
          const activeLifecycle = lifecycle;
          if (activeLifecycle === null || activeLifecycle.disposed) return;
          webglFailedRef.current = true;
          activeLifecycle.dispose();
          if (webglLifecycleRef.current === activeLifecycle) {
            webglLifecycleRef.current = null;
          }
          recordWebglDiagnosticOnce();
        });
        lifecycle.setContextLossDisposable(contextLossDisposable);
        if (!isCurrent() || lifecycle.disposed) {
          lifecycle.dispose();
          return;
        }

        webglLifecycleRef.current = lifecycle;
      } catch {
        lifecycle?.dispose();
        if (!isCurrent()) return;

        webglFailedRef.current = true;
        if (webglLifecycleRef.current === lifecycle) {
          webglLifecycleRef.current = null;
        }
        recordWebglDiagnosticOnce();
      }
    })();

    return () => {
      cleanedUp = true;
      if (webglGenerationRef.current === generation) {
        webglGenerationRef.current += 1;
      }
      lifecycle?.dispose();
      if (webglLifecycleRef.current === lifecycle) {
        webglLifecycleRef.current = null;
      }
    };
  }, [
    recordWebglDiagnosticOnce,
    shouldRender,
    transcriptRuntime,
    webglEnabled,
    webglTerminalEpoch,
  ]);

  useEffect(() => {
    if (!shouldRender || !hasAuthoritativeTerminalState) return;

    const previous = previousMetadataRef.current;
    previousMetadataRef.current = {
      error: terminalError,
      status: terminalStatus,
    };
    const terminal = terminalRef.current;

    if (terminal !== null && terminalError !== null && terminalError !== previous.error) {
      writeSystemMessage(terminal, terminalError);
    }

    if (terminalStatus === "running") {
      hasHandledExitRef.current = false;
    } else if (
      (terminalStatus === "closed" || terminalStatus === "exited") &&
      terminalStatus !== previous.status &&
      !hasHandledExitRef.current
    ) {
      hasHandledExitRef.current = true;
      if (terminal !== null) {
        writeSystemMessage(
          terminal,
          terminalStatus === "closed" ? "Terminal closed" : "Process exited",
        );
      }
      handleSessionExited();
    }
  }, [hasAuthoritativeTerminalState, shouldRender, terminalError, terminalStatus]);

  useEffect(() => {
    const previous = previousRuntimeGenerationRef.current;
    previousRuntimeGenerationRef.current = {
      runtime: transcriptRuntime,
      generation: terminalGeneration,
    };
    if (
      !shouldRender ||
      transcriptRuntime === null ||
      previous.runtime !== transcriptRuntime ||
      terminalGeneration <= previous.generation
    ) {
      return;
    }
    inputSchedulerRef.current?.reset();
  }, [shouldRender, terminalGeneration, transcriptRuntime]);

  useEffect(() => {
    const generation = focusGenerationRef.current + 1;
    focusGenerationRef.current = generation;
    if (!autoFocus || !shouldRender || fulfilledFocusRequestIdRef.current === focusRequestId) {
      return;
    }
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    const frame = window.requestAnimationFrame(() => {
      if (
        focusGenerationRef.current !== generation ||
        terminalRef.current !== terminal ||
        fitAddonRef.current !== fitAddon
      ) {
        return;
      }
      terminal.focus();
      fulfilledFocusRequestIdRef.current = focusRequestId;
    });
    return () => {
      focusGenerationRef.current += 1;
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId, shouldRender, transcriptRuntime]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!shouldRender || !terminal || !fitAddon) return;
    const resizeRendererGeneration = resizeRendererGenerationRef.current;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitTerminalSafely(fitAddon);
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      requestTerminalResize(resizeRendererGeneration, terminal.cols, terminal.rows);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, environmentId, resizeEpoch, shouldRender, terminalId, threadId]);
  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-[4px] bg-background"
    >
      {shouldRender && transcriptRuntime === null && terminalError !== null ? (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-destructive"
        >
          {terminalError}
        </div>
      ) : null}
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  mode?: "drawer" | "panel";
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal?: (() => void) | undefined;
  onSplitTerminalVertical?: (() => void) | undefined;
  onNewTerminal?: (() => void) | undefined;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  /** Prefer server-provided tab titles when present (e.g. active subprocess name). */
  terminalLabelsById?: ReadonlyMap<string, string>;
  /** Structured launch commands for provider terminals that have not started yet. */
  terminalCommandsById?: ReadonlyMap<string, TerminalLaunchCommand>;
  /** Prefer per-session launch locations when the server already knows a terminal. */
  terminalLaunchLocationsById?: ReadonlyMap<string, TerminalLaunchLocation>;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  mode = "drawer",
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
  terminalLabelsById,
  terminalCommandsById,
  terminalLaunchLocationsById,
}: ThreadTerminalDrawerProps) {
  const isPanel = mode === "panel";
  const controlledDrawerHeight = clampDrawerHeight(height);
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    threadId,
    height: controlledDrawerHeight,
  }));
  const drawerHeight =
    drawerHeightState.threadId === threadId ? drawerHeightState.height : controlledDrawerHeight;
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) => {
      setDrawerHeightState((current) => {
        const currentHeight =
          current.threadId === threadId ? current.height : controlledDrawerHeight;
        const nextHeight = typeof update === "function" ? update(currentHeight) : update;
        return nextHeight === currentHeight && current.threadId === threadId
          ? current
          : { threadId, height: nextHeight };
      });
    },
    [controlledDrawerHeight, threadId],
  );
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) => {
    setDrawerHeight(nextHeight);
  });
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(controlledDrawerHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const normalizedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of terminalIds) {
      const trimmedId = id.trim();
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
      seen.add(trimmedId);
      normalizedIds.push(trimmedId);
    }
    return normalizedIds;
  }, [terminalIds]);

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ""
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? "");

  const resolvedTerminalGroups = useMemo(() => {
    if (normalizedTerminalIds.length === 0) {
      return [];
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds: string[] = [];
      const seenGroupTerminalIds = new Set<string>();
      for (const id of terminalGroup.terminalIds) {
        const terminalId = id.trim();
        if (terminalId.length === 0) continue;
        if (seenGroupTerminalIds.has(terminalId)) continue;
        seenGroupTerminalIds.add(terminalId);
        if (!validTerminalIdSet.has(terminalId)) continue;
        if (assignedTerminalIds.has(terminalId)) continue;
        nextTerminalIds.push(terminalId);
      }
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ""}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    );
    nextGroups.sort((left, right) => {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY));
      return rank(left.terminalIds) - rank(right.terminalIds);
    });

    return nextGroups;
  }, [normalizedTerminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : []);
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ?? "horizontal";
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(() => {
    const next = new Map<string, string>();
    for (const terminalId of normalizedTerminalIds) {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId));
    }
    return next;
  }, [normalizedTerminalIds, terminalLabelsById]);
  const resolveTerminalLaunchLocation = useCallback(
    (terminalId: string): TerminalLaunchLocation => {
      return (
        terminalLaunchLocationsById?.get(terminalId) ?? {
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(runtimeEnv ? { runtimeEnv } : {}),
        }
      );
    },
    [cwd, runtimeEnv, terminalLaunchLocationsById, worktreePath],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : "Split Terminal Horizontally";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : "Split Terminal Vertically";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit || !onSplitTerminal) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalVerticalAction = useCallback(() => {
    if (hasReachedSplitLimit || !onSplitTerminalVertical) return;
    onSplitTerminalVertical();
  }, [hasReachedSplitLimit, onSplitTerminalVertical]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal?.();
  }, [onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    lastSyncedHeightRef.current = controlledDrawerHeight;
  }, [controlledDrawerHeight, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [setDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeightFromWindowResize(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  if (normalizedTerminalIds.length === 0) {
    return (
      <aside
        data-terminal-owner={isPanel ? "right-panel" : "drawer"}
        className={cn(
          "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
          isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
        )}
        style={isPanel ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          {onNewTerminal ? (
            <button
              type="button"
              className="rounded-md border border-border/80 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
            >
              {newTerminalActionLabel}
            </button>
          ) : null}
        </div>
      </aside>
    );
  }

  const activeTerminalLaunchLocation = resolveTerminalLaunchLocation(resolvedActiveTerminalId);

  return (
    <aside
      data-terminal-owner={isPanel ? "right-panel" : "drawer"}
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
        isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
      )}
      style={isPanel ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            {onSplitTerminal ? (
              <>
                <TerminalActionButton
                  className={`p-1 text-foreground/90 transition-colors ${
                    hasReachedSplitLimit
                      ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                      : "hover:bg-accent"
                  }`}
                  onClick={onSplitTerminalAction}
                  label={splitTerminalActionLabel}
                >
                  <SquareSplitHorizontal className="size-3.25" />
                </TerminalActionButton>
                <div className="h-4 w-px bg-border/80" />
              </>
            ) : null}
            {onSplitTerminalVertical ? (
              <>
                <TerminalActionButton
                  className={`p-1 text-foreground/90 transition-colors ${
                    hasReachedSplitLimit
                      ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                      : "hover:bg-accent"
                  }`}
                  onClick={onSplitTerminalVerticalAction}
                  label={splitTerminalVerticalActionLabel}
                >
                  <SquareSplitVertical className="size-3.25" />
                </TerminalActionButton>
                <div className="h-4 w-px bg-border/80" />
              </>
            ) : null}
            {onNewTerminal ? (
              <>
                <TerminalActionButton
                  className="p-1 text-foreground/90 transition-colors hover:bg-accent"
                  onClick={onNewTerminalAction}
                  label={newTerminalActionLabel}
                >
                  <Plus className="size-3.25" />
                </TerminalActionButton>
                <div className="h-4 w-px bg-border/80" />
              </>
            ) : null}
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === "vertical"
                    ? {
                        gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => {
                  const terminalLaunchLocation = resolveTerminalLaunchLocation(terminalId);
                  return (
                    <div
                      key={terminalId}
                      className={`min-h-0 min-w-0 ${
                        splitDirection === "vertical"
                          ? "border-t first:border-t-0"
                          : "border-l first:border-l-0"
                      } ${
                        terminalId === resolvedActiveTerminalId
                          ? "border-border"
                          : "border-border/70"
                      }`}
                      onMouseDown={() => {
                        if (terminalId !== resolvedActiveTerminalId) {
                          onActiveTerminalChange(terminalId);
                        }
                      }}
                    >
                      <div className="h-full p-1">
                        <TerminalViewport
                          threadRef={threadRef}
                          threadId={threadId}
                          terminalId={terminalId}
                          terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                          cwd={terminalLaunchLocation.cwd}
                          {...(terminalLaunchLocation.worktreePath !== undefined
                            ? { worktreePath: terminalLaunchLocation.worktreePath }
                            : {})}
                          {...(terminalLaunchLocation.runtimeEnv
                            ? { runtimeEnv: terminalLaunchLocation.runtimeEnv }
                            : {})}
                          {...(terminalCommandsById?.get(terminalId)
                            ? { command: terminalCommandsById.get(terminalId)! }
                            : {})}
                          visible={visible}
                          onSessionExited={() => onCloseTerminal(terminalId)}
                          onAddTerminalContext={onAddTerminalContext}
                          focusRequestId={focusRequestId}
                          autoFocus={terminalId === resolvedActiveTerminalId}
                          resizeEpoch={resizeEpoch}
                          drawerHeight={drawerHeight}
                          keybindings={keybindings}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadRef={threadRef}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={activeTerminalLaunchLocation.cwd}
                  {...(activeTerminalLaunchLocation.worktreePath !== undefined
                    ? { worktreePath: activeTerminalLaunchLocation.worktreePath }
                    : {})}
                  {...(activeTerminalLaunchLocation.runtimeEnv
                    ? { runtimeEnv: activeTerminalLaunchLocation.runtimeEnv }
                    : {})}
                  {...(terminalCommandsById?.get(resolvedActiveTerminalId)
                    ? { command: terminalCommandsById.get(resolvedActiveTerminalId)! }
                    : {})}
                  visible={visible}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  keybindings={keybindings}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  {onSplitTerminal ? (
                    <TerminalActionButton
                      className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                        hasReachedSplitLimit
                          ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                          : "hover:bg-accent/70"
                      }`}
                      onClick={onSplitTerminalAction}
                      label={splitTerminalActionLabel}
                    >
                      <SquareSplitHorizontal className="size-3.25" />
                    </TerminalActionButton>
                  ) : null}
                  {onSplitTerminalVertical ? (
                    <TerminalActionButton
                      className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                        hasReachedSplitLimit
                          ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                          : "hover:bg-accent/70"
                      }`}
                      onClick={onSplitTerminalVerticalAction}
                      label={splitTerminalVerticalActionLabel}
                    >
                      <SquareSplitVertical className="size-3.25" />
                    </TerminalActionButton>
                  ) : null}
                  {onNewTerminal ? (
                    <TerminalActionButton
                      className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={onNewTerminalAction}
                      label={newTerminalActionLabel}
                    >
                      <Plus className="size-3.25" />
                    </TerminalActionButton>
                  ) : null}
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          Group {groupIndex + 1}
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
