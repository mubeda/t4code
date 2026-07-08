import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Instrumented-hooks render tests for {@link ThreadTerminalRouteScreen}. The
 * screen is a React Native component with heavy native/expo dependencies, so —
 * following the repo pattern (`AddProjectScreen.test.tsx`,
 * `ChatView.hooks.test.tsx`) — it renders under `renderToStaticMarkup` with a
 * partial `vi.mock("react")` that captures effects and lets scenarios seed
 * `useState`. Native modules (expo-router / expo-symbols /
 * react-native-keyboard-controller / react-native) and heavy components are
 * mocked; the pure terminal helper modules stay real.
 *
 * The sibling `ThreadTerminalRouteScreen.test.ts` covers a different module
 * (`terminalRouteBootstrap`) and is intentionally left untouched.
 */

const h = vi.hoisted(() => {
  type Matcher = (initial: unknown) => boolean;
  const state = {
    stateSeeds: [] as Array<{ match: Matcher; value: unknown }>,
    setStateCalls: [] as Array<{ initial: unknown; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
    entries: [] as Array<{ kind: string; props: Record<string, unknown> }>,
    colorScheme: "dark" as "light" | "dark",
    params: {} as Record<string, string | ReadonlyArray<string> | undefined>,
    workspaceState: { isLoadingConnections: false } as { isLoadingConnections: boolean },
    selection: null as unknown,
    threadDetail: null as unknown,
    presentation: null as unknown,
    knownSessions: [] as unknown[],
    terminal: null as unknown,
    keyboardState: { height: 0, isVisible: false } as { height: number; isVisible: boolean },
    commandCalls: [] as Array<{ marker: string | null; value: unknown }>,
    routerReplace: [] as unknown[],
    navigationCalls: [] as Array<{ thread: unknown; terminalId: string }>,
    keyboardListeners: [] as Array<{ event: string; handler: () => void }>,
    keyboardRemoveCalls: [] as string[],
    keyboardDismissCalls: 0,
    savePreferencesCalls: [] as unknown[],
    loadPreferencesImpl: (() => Promise.resolve({ terminalFontSize: 14 })) as () => Promise<{
      terminalFontSize: number;
    }>,
    timers: [] as Array<() => void>,
    record(kind: string, props: unknown) {
      if (props && typeof props === "object") {
        state.entries.push({ kind, props: props as Record<string, unknown> });
      }
    },
    filter(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      return state.entries
        .filter((entry) => entry.kind === kind && (predicate?.(entry.props) ?? true))
        .map((entry) => entry.props);
    },
    find(kind: string, predicate?: (props: Record<string, unknown>) => boolean) {
      const found = state.entries.find(
        (entry) => entry.kind === kind && (predicate?.(entry.props) ?? true),
      )?.props;
      if (!found) throw new Error(`No recorded "${kind}" element matched`);
      return found;
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of Array.from(state.effects)) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
    flushTimers(): void {
      for (const cb of state.timers.splice(0)) cb();
    },
  };
  return state;
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const seedIndex = h.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? h.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ initial: resolved, next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
  };
});

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name?: { ios?: string } | string }) => (
    <i
      data-symbol={typeof props.name === "object" ? (props.name?.ios ?? "") : String(props.name)}
    />
  ),
}));

vi.mock("expo-router", () => {
  const Screen = (props: Record<string, unknown>) => {
    h.record("StackScreen", props);
    return null;
  };
  const Toolbar = (props: { readonly children?: ReactNode }) => (
    <div data-toolbar="true">{props.children}</div>
  );
  Toolbar.Menu = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  Toolbar.Label = (props: { readonly children?: ReactNode }) => <span>{props.children}</span>;
  Toolbar.MenuAction = (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("MenuAction", props);
    return <div>{props.children}</div>;
  };
  return {
    Stack: { Screen, Toolbar },
    useRouter: () => ({
      replace: (target: unknown) => {
        h.routerReplace.push(target);
      },
    }),
    useLocalSearchParams: () => h.params,
  };
});

vi.mock("react-native", () => ({
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.record("Pressable", props);
    return <button type="button">{props.children}</button>;
  },
  Text: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  useColorScheme: () => h.colorScheme,
}));

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: {
    dismiss: () => {
      h.keyboardDismissCalls += 1;
      return Promise.resolve();
    },
  },
  KeyboardEvents: {
    addListener: (event: string, handler: () => void) => {
      h.keyboardListeners.push({ event, handler });
      return {
        remove: () => {
          h.keyboardRemoveCalls.push(event);
        },
      };
    },
  },
  KeyboardStickyView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  useKeyboardState: (selector: (state: { height: number; isVisible: boolean }) => unknown) =>
    selector(h.keyboardState),
}));

vi.mock("../../components/ComposerToolbarTrigger", () => ({
  ComposerToolbarButton: (props: Record<string, unknown>) => {
    h.record("ComposerToolbarButton", props);
    return (
      <button
        type="button"
        data-toolbar-button={String(props["label"] ?? props["accessibilityLabel"] ?? "")}
      />
    );
  },
  ComposerToolbarRow: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  ComposerToolbarScroller: (props: { readonly children?: ReactNode }) => (
    <div>{props.children}</div>
  ),
}));

vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: { readonly title: string; readonly detail?: string }) => (
    <div data-empty-state="true">{props.title}</div>
  ),
}));

vi.mock("../../components/GlassSurface", () => ({
  GlassSurface: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: (props: { readonly message: string }) => (
    <div data-loading="true">{props.message}</div>
  ),
}));

vi.mock("./NativeTerminalSurface", () => ({
  TerminalSurface: (props: Record<string, unknown>) => {
    h.record("TerminalSurface", props);
    return <div data-terminal-surface="true" />;
  },
}));

vi.mock("../connection/EnvironmentConnectionNotice", () => ({
  EnvironmentConnectionNotice: (props: Record<string, unknown>) => {
    h.record("EnvironmentConnectionNotice", props);
    return <div data-connection-notice="true">{String(props["environmentLabel"] ?? "")}</div>;
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { retryNow: { marker: "retry" } },
}));

vi.mock("../../state/terminal", () => ({
  terminalEnvironment: {
    write: { marker: "write" },
    resize: { marker: "resize" },
    clear: { marker: "clear" },
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { marker?: string } | null) => (value: unknown) => {
    h.commandCalls.push({ marker: command?.marker ?? null, value });
    return Promise.resolve();
  },
}));

vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => h.presentation,
}));

vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: h.workspaceState }),
}));

vi.mock("../../state/use-terminal-session", () => ({
  useAttachedTerminalSession: () => h.terminal,
  useKnownTerminalSessions: () => h.knownSessions,
}));

vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => h.selection,
}));

vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetail: () => h.threadDetail,
}));

vi.mock("../../lib/routes", () => ({
  buildThreadTerminalNavigation: (thread: unknown, terminalId: string) => {
    h.navigationCalls.push({ thread, terminalId });
    return { pathname: "/terminal", terminalId };
  },
}));

vi.mock("../../lib/storage", () => ({
  loadPreferences: () => h.loadPreferencesImpl(),
  savePreferencesPatch: (patch: unknown) => {
    h.savePreferencesCalls.push(patch);
    return Promise.resolve();
  },
}));

vi.mock("./terminalDebugLog", () => ({
  terminalDebugLog: () => undefined,
}));

import { ThreadTerminalRouteScreen } from "./ThreadTerminalRouteScreen";
import { stagePendingTerminalLaunch, takePendingTerminalLaunch } from "./terminalLaunchContext";
import { cacheTerminalFontSize, resetTerminalUiStateCaches } from "./terminalUiState";

/** Hook results are read before any early return, so mocks must never be null. */
const NO_THREAD_SELECTION = {
  selectedThread: null,
  selectedThreadProject: null,
  selectedEnvironmentConnection: null,
};

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");

interface KnownSessionInput {
  readonly terminalId: string;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly cwd?: string | null;
}

function makeKnownSession(input: KnownSessionInput): unknown {
  return {
    target: { terminalId: input.terminalId },
    state: {
      status: input.status,
      summary: input.cwd === undefined ? { cwd: "/repo" } : input.cwd ? { cwd: input.cwd } : null,
      hasRunningSubprocess: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function makeTerminal(overrides: Record<string, unknown> = {}): unknown {
  return {
    buffer: "",
    status: "running",
    version: 1,
    error: null,
    summary: { cwd: "/repo" },
    hasRunningSubprocess: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSelection(
  overrides: {
    readonly environmentLabel?: string | null;
    readonly workspaceRoot?: string | null;
    readonly worktreePath?: string | null;
    readonly title?: string | null;
  } = {},
): unknown {
  return {
    selectedThread: {
      environmentId: ENV,
      id: THREAD,
      worktreePath: overrides.worktreePath ?? null,
    },
    selectedThreadProject:
      overrides.workspaceRoot === null
        ? { workspaceRoot: null, title: overrides.title ?? "Repo" }
        : { workspaceRoot: overrides.workspaceRoot ?? "/repo", title: overrides.title ?? "Repo" },
    selectedEnvironmentConnection: {
      environmentLabel:
        overrides.environmentLabel === undefined ? "MacBook Pro" : overrides.environmentLabel,
    },
  };
}

function makePresentation(
  overrides: { readonly phase?: string; readonly isReady?: boolean } = {},
): unknown {
  return {
    presentation: {
      connection: { phase: overrides.phase ?? "connected", error: null, traceId: null },
      entry: { target: { label: "MacBook Pro" } },
    },
    isReady: overrides.isReady ?? true,
  };
}

/** Wire up the standard "connected, running terminal" happy-path scene. */
function connectedScene(
  overrides: {
    readonly selection?: Parameters<typeof makeSelection>[0];
    readonly presentation?: Parameters<typeof makePresentation>[0];
    readonly terminal?: Record<string, unknown>;
    readonly knownSessions?: unknown[];
    readonly keyboardVisible?: boolean;
  } = {},
): void {
  h.selection = makeSelection(overrides.selection ?? {});
  h.presentation = makePresentation(overrides.presentation ?? {});
  h.terminal = makeTerminal(overrides.terminal ?? {});
  h.knownSessions = overrides.knownSessions ?? [];
  h.keyboardState = {
    height: overrides.keyboardVisible ? 300 : 0,
    isVisible: !!overrides.keyboardVisible,
  };
}

function render(): string {
  h.entries.length = 0;
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  return renderToStaticMarkup(<ThreadTerminalRouteScreen />);
}

function seedPendingModifier(value: "ctrl" | "meta"): void {
  h.stateSeeds.push({
    match: (initial) =>
      typeof initial === "object" &&
      initial !== null &&
      !Array.isArray(initial) &&
      "terminalId" in (initial as object) &&
      "value" in (initial as object),
    value: { terminalId: DEFAULT_TERMINAL_ID, value },
  });
}

function commandsFor(marker: string): unknown[] {
  return h.commandCalls.filter((call) => call.marker === marker).map((call) => call.value);
}

beforeEach(() => {
  h.stateSeeds.length = 0;
  h.setStateCalls.length = 0;
  h.effects.length = 0;
  h.entries.length = 0;
  h.colorScheme = "dark";
  h.params = { environmentId: "env-1", threadId: "thread-1" };
  h.workspaceState = { isLoadingConnections: false };
  h.selection = { ...NO_THREAD_SELECTION };
  h.threadDetail = null;
  h.presentation = { presentation: null, isReady: false };
  h.knownSessions = [];
  h.terminal = makeTerminal();
  h.keyboardState = { height: 0, isVisible: false };
  h.commandCalls.length = 0;
  h.routerReplace.length = 0;
  h.navigationCalls.length = 0;
  h.keyboardListeners.length = 0;
  h.keyboardRemoveCalls.length = 0;
  h.keyboardDismissCalls = 0;
  h.savePreferencesCalls.length = 0;
  h.loadPreferencesImpl = () => Promise.resolve({ terminalFontSize: 14 });
  h.timers.length = 0;
  resetTerminalUiStateCaches();

  vi.stubGlobal("setTimeout", ((callback: () => void) => {
    h.timers.push(callback);
    return h.timers.length;
  }) as unknown as typeof setTimeout);
  vi.stubGlobal("clearTimeout", (() => undefined) as unknown as typeof clearTimeout);

  // Drain any launch staged by a previous test's render.
  takePendingTerminalLaunch({
    environmentId: ENV,
    threadId: THREAD,
    terminalId: DEFAULT_TERMINAL_ID,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThreadTerminalRouteScreen early states", () => {
  it("shows a loading screen while connections are still loading and no thread is selected", () => {
    h.workspaceState = { isLoadingConnections: true };
    const markup = render();
    expect(markup).toContain("Opening terminal");
    expect(markup).toContain("data-loading");
  });

  it("shows the thread-unavailable empty state when no thread is selected", () => {
    h.workspaceState = { isLoadingConnections: false };
    const markup = render();
    expect(markup).toContain("Thread unavailable");
  });

  it("shows the terminal-unavailable empty state when the thread has no workspace root", () => {
    h.selection = makeSelection({ workspaceRoot: null });
    const markup = render();
    expect(markup).toContain("Terminal unavailable");
  });

  it("shows a loading screen when the environment is not ready and has no presentation", () => {
    h.selection = makeSelection({});
    h.presentation = { presentation: null, isReady: false };
    const markup = render();
    expect(markup).toContain("data-loading");
  });
});

describe("ThreadTerminalRouteScreen connected rendering", () => {
  it("renders the terminal surface, toolbar menu, and header for a connected environment", () => {
    connectedScene();
    const markup = render();

    expect(markup).toContain("data-terminal-surface");
    expect(markup).toContain("data-toolbar");
    // Current session appears in the terminal menu, plus an "Open new terminal" action.
    const openNew = h.find("MenuAction", (props) => props["icon"] === "plus");
    expect(String(openNew["subtitle"])).toContain("Start another shell");

    // The header title render function executes the header JSX closure.
    const screen = h.find("StackScreen");
    const options = screen["options"] as { headerTitle: () => unknown };
    expect(options.headerTitle()).toBeTruthy();
  });

  it("renders the connection notice and retries the environment when not connected", () => {
    connectedScene({ presentation: { phase: "connecting", isReady: false } });
    const markup = render();

    expect(markup).toContain("data-connection-notice");
    expect(markup).not.toContain("data-terminal-surface");

    const notice = h.find("EnvironmentConnectionNotice");
    (notice["onRetry"] as () => void)();
    expect(commandsFor("retry")).toHaveLength(1);
  });

  it("falls back to a default connection notice payload when presentation is missing", () => {
    // isReady=true keeps us past the loading gate while presentation stays null.
    h.selection = makeSelection({});
    h.presentation = { presentation: null, isReady: true };
    const markup = render();
    expect(markup).toContain("data-connection-notice");
    const notice = h.find("EnvironmentConnectionNotice");
    expect((notice["connection"] as { phase: string }).phase).toBe("available");
  });
});

describe("ThreadTerminalRouteScreen host-platform toolbar", () => {
  function toolbarLabels(): string[] {
    return h
      .filter("ComposerToolbarButton", (props) => typeof props["label"] === "string")
      .map((props) => String(props["label"]));
  }

  it("offers cmd + ctrl modifiers for a macOS host", () => {
    connectedScene({ selection: { environmentLabel: "MacBook Pro" }, keyboardVisible: true });
    render();
    expect(toolbarLabels()).toEqual(expect.arrayContaining(["cmd", "ctrl"]));
  });

  it("offers ctrl + alt modifiers for a Linux host", () => {
    connectedScene({ selection: { environmentLabel: "Ubuntu server" }, keyboardVisible: true });
    render();
    expect(toolbarLabels()).toEqual(expect.arrayContaining(["ctrl", "alt"]));
  });

  it("treats a Windows host as non-mac", () => {
    connectedScene({ selection: { environmentLabel: "Windows box" }, keyboardVisible: true });
    render();
    expect(toolbarLabels()).toEqual(expect.arrayContaining(["ctrl", "alt"]));
  });

  it("treats an unknown host label as non-mac", () => {
    connectedScene({ selection: { environmentLabel: null }, keyboardVisible: true });
    render();
    expect(toolbarLabels()).toEqual(expect.arrayContaining(["ctrl", "alt"]));
  });
});

describe("ThreadTerminalRouteScreen terminal input", () => {
  it("writes plain input from the terminal surface while running", () => {
    connectedScene();
    render();
    const surface = h.find("TerminalSurface");
    (surface["onInput"] as (data: string) => void)("ls\n");
    expect(commandsFor("write")).toHaveLength(1);
    const write = commandsFor("write")[0] as { input: { data: string } };
    expect(write.input.data).toBe("ls\n");
  });

  it("ignores empty input and input while the session is not running", () => {
    connectedScene({ terminal: { status: "exited" } });
    render();
    const surface = h.find("TerminalSurface");
    (surface["onInput"] as (data: string) => void)("");
    (surface["onInput"] as (data: string) => void)("x");
    expect(commandsFor("write")).toHaveLength(0);
  });

  it("applies the ctrl modifier across the control-character table", () => {
    seedPendingModifier("ctrl");
    connectedScene();
    render();
    const onInput = h.find("TerminalSurface")["onInput"] as (data: string) => void;
    for (const char of ["a", "@", "[", "\\", "]", "^", "_", "?", "1"]) {
      onInput(char);
    }
    const writes = commandsFor("write").map(
      (value) => (value as { input: { data: string } }).input.data,
    );
    expect(writes[0]).toBe(""); // ctrl-a
    expect(writes[1]).toBe(" "); // ctrl-@
    expect(writes[2]).toBe(""); // ctrl-[
    expect(writes[8]).toBe("1"); // non-mappable char passes through
  });

  it("applies the meta modifier by prefixing an escape", () => {
    seedPendingModifier("meta");
    connectedScene();
    render();
    const onInput = h.find("TerminalSurface")["onInput"] as (data: string) => void;
    onInput("b");
    const write = commandsFor("write")[0] as { input: { data: string } };
    expect(write.input.data).toBe("b");
  });
});

describe("ThreadTerminalRouteScreen resize", () => {
  it("caches the grid, schedules a replay, and resizes the running session", () => {
    connectedScene();
    render();
    const surface = h.find("TerminalSurface");
    (surface["onResize"] as (size: { cols: number; rows: number }) => void)({
      cols: 120,
      rows: 40,
    });
    h.flushTimers();

    const resize = commandsFor("resize")[0] as { input: { cols: number; rows: number } };
    expect(resize.input.cols).toBe(120);
    expect(resize.input.rows).toBe(40);
    // Buffer-replay readiness was scheduled and fired via the captured timer.
    expect(h.setStateCalls.some((call) => typeof call.applied === "string")).toBe(true);
  });

  it("does not resize when the reported grid size is unchanged", () => {
    connectedScene();
    render();
    const surface = h.find("TerminalSurface");
    (surface["onResize"] as (size: { cols: number; rows: number }) => void)({ cols: 80, rows: 24 });
    expect(commandsFor("resize")).toHaveLength(0);
  });
});

describe("ThreadTerminalRouteScreen toolbar actions", () => {
  function accessoryButton(label: string): Record<string, unknown> {
    return h.find("ComposerToolbarButton", (props) => props["label"] === label);
  }

  it("sends escape data from an accessory send action", () => {
    connectedScene({ keyboardVisible: true });
    render();
    (accessoryButton("esc")["onPress"] as () => void)();
    const write = commandsFor("write")[0] as { input: { data: string } };
    expect(write.input.data).toBe("");
  });

  it("clears the terminal from the accessory clear action", () => {
    connectedScene({ keyboardVisible: true });
    render();
    (accessoryButton("clear")["onPress"] as () => void)();
    expect(commandsFor("clear")).toHaveLength(1);
  });

  it("toggles a pending modifier from a modifier action", () => {
    connectedScene({ keyboardVisible: true });
    render();
    (accessoryButton("ctrl")["onPress"] as () => void)();
    const modifierUpdate = h.setStateCalls.find(
      (call) => (call.applied as { value?: string })?.value === "ctrl",
    );
    expect(modifierUpdate).toBeDefined();
  });

  it("applies a pending ctrl modifier to a send action", () => {
    seedPendingModifier("ctrl");
    connectedScene({ keyboardVisible: true });
    render();
    (accessoryButton("tab")["onPress"] as () => void)();
    const write = commandsFor("write")[0] as { input: { data: string } };
    expect(write.input.data).toBe("\t"); // ctrl-tab is non-mappable, passes through
  });

  it("applies a pending meta modifier to a send action", () => {
    seedPendingModifier("meta");
    connectedScene({ keyboardVisible: true });
    render();
    (accessoryButton("esc")["onPress"] as () => void)();
    const write = commandsFor("write")[0] as { input: { data: string } };
    expect(write.input.data).toBe("");
  });

  it("dismisses the keyboard from the accessory dismiss button", () => {
    connectedScene({ keyboardVisible: true });
    render();
    const dismiss = h.find(
      "ComposerToolbarButton",
      (props) => props["accessibilityLabel"] === "Dismiss keyboard",
    );
    (dismiss["onPress"] as () => void)();
    expect(h.keyboardDismissCalls).toBe(1);
  });

  it("requests the keyboard from the floating show-keyboard button", () => {
    connectedScene({ keyboardVisible: false });
    render();
    const showKeyboard = h.find(
      "Pressable",
      (props) => props["accessibilityLabel"] === "Show keyboard",
    );
    (showKeyboard["onPress"] as () => void)();
    const focusUpdate = h.setStateCalls.find((call) => call.applied === 1);
    expect(focusUpdate).toBeDefined();
  });
});

describe("ThreadTerminalRouteScreen terminal menu actions", () => {
  it("navigates when selecting a different terminal", () => {
    connectedScene({
      knownSessions: [makeKnownSession({ terminalId: "term-2", status: "running" })],
    });
    render();
    const selectAction = h.find(
      "MenuAction",
      (props) => typeof props["onPress"] === "function" && props["icon"] === "terminal",
    );
    (selectAction["onPress"] as () => void)();
    expect(h.routerReplace).toHaveLength(1);
    expect(h.navigationCalls.at(-1)?.terminalId).toBe("term-2");
  });

  it("opens a new terminal from the open-new action", () => {
    connectedScene();
    render();
    const openNew = h.find("MenuAction", (props) => props["icon"] === "plus");
    (openNew["onPress"] as () => void)();
    expect(h.routerReplace).toHaveLength(1);
    expect(h.navigationCalls.at(-1)?.terminalId).toBe("term-2");
  });

  it("adjusts the font size from the text-size actions", () => {
    connectedScene();
    render();
    const decrease = h.find(
      "MenuAction",
      (props) => props["discoverabilityLabel"] === "Decrease terminal text size",
    );
    (decrease["onPress"] as () => void)();
    const increase = h.find(
      "MenuAction",
      (props) => props["discoverabilityLabel"] === "Increase terminal text size",
    );
    (increase["onPress"] as () => void)();
    h.flushTimers();
    const fontUpdates = h.setStateCalls.filter((call) => typeof call.applied === "number");
    expect(fontUpdates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ThreadTerminalRouteScreen effects", () => {
  it("registers keyboard listeners and toggles accessory dismissal", () => {
    connectedScene();
    render();
    const cleanups = h.runEffects();

    const showListener = h.keyboardListeners.find((entry) => entry.event === "keyboardWillShow");
    const hideListener = h.keyboardListeners.find((entry) => entry.event === "keyboardWillHide");
    expect(showListener).toBeDefined();
    expect(hideListener).toBeDefined();
    showListener!.handler();
    hideListener!.handler();
    const dismissUpdates = h.setStateCalls.filter(
      (call) => call.applied === false || call.applied === true,
    );
    expect(dismissUpdates.length).toBeGreaterThanOrEqual(2);

    for (const cleanup of cleanups) cleanup();
    expect(h.keyboardRemoveCalls).toEqual(
      expect.arrayContaining(["keyboardWillShow", "keyboardWillHide"]),
    );
  });

  it("resolves the persisted font preference and persists subsequent changes", async () => {
    // Seeding the cache makes hasResolvedFontPreference true at render time so the
    // persist effect (which early-returns until the preference is resolved) runs.
    cacheTerminalFontSize(16);
    h.loadPreferencesImpl = () => Promise.resolve({ terminalFontSize: 18 });
    connectedScene();
    render();
    h.runEffects();
    await Promise.resolve();
    await Promise.resolve();

    // loadPreferences resolved and cached the persisted size.
    const fontResolved = h.setStateCalls.some((call) => call.applied === true);
    expect(fontResolved).toBe(true);
    // The font-persist effect wrote back through savePreferencesPatch.
    expect(h.savePreferencesCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to resolved state when loading the font preference fails", async () => {
    h.loadPreferencesImpl = () => Promise.reject(new Error("no storage"));
    connectedScene();
    render();
    h.runEffects();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.setStateCalls.some((call) => call.applied === true)).toBe(true);
  });

  it("logs the first non-empty buffer and sends a staged initial input", () => {
    stagePendingTerminalLaunch({
      target: { environmentId: ENV, threadId: THREAD, terminalId: DEFAULT_TERMINAL_ID },
      launch: { cwd: "/repo", worktreePath: null, initialInput: "echo hi\n" },
    });
    connectedScene({ terminal: { buffer: "welcome", version: 2 } });
    render();
    h.runEffects();

    // The staged initial input was written once the session had a version.
    const writes = commandsFor("write") as Array<{ input: { data: string } }>;
    expect(writes.some((write) => write.input.data === "echo hi\n")).toBe(true);
  });

  it("redirects a bare terminal route to the already-running terminal", () => {
    h.params = { environmentId: "env-1", threadId: "thread-1" };
    connectedScene({
      knownSessions: [makeKnownSession({ terminalId: "term-2", status: "running" })],
    });
    render();
    h.runEffects();
    expect(h.routerReplace).toHaveLength(1);
    expect(h.navigationCalls.at(-1)?.terminalId).toBe("term-2");
  });

  it("runs the buffer-replay and status logging effects without error", () => {
    connectedScene({ terminal: { buffer: "output", version: 3, error: "boom" } });
    render();
    const captured = h.effects.length;
    const cleanups = h.runEffects();
    for (const cleanup of cleanups) cleanup();
    expect(captured).toBeGreaterThan(0);
  });
});

describe("ThreadTerminalRouteScreen route params", () => {
  it("reads array-form route params and honours an explicit terminal id", () => {
    h.params = { environmentId: ["env-1"], threadId: ["thread-1"], terminalId: ["term-9"] };
    connectedScene({
      knownSessions: [makeKnownSession({ terminalId: "term-2", status: "running" })],
    });
    render();
    h.runEffects();
    // An explicit terminalId suppresses the bare-route redirect.
    expect(h.routerReplace).toHaveLength(0);
    const surface = h.find("TerminalSurface");
    expect(String(surface["terminalKey"])).toContain("term-9");
  });
});
