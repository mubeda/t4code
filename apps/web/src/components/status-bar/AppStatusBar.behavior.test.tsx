import { EnvironmentId } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primaryEnvironment: null as null | { environmentId: string },
  refSeeds: {} as Record<number, unknown>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  iconOnly: false,
  setIconOnly: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
  queries: [] as Array<{
    data: unknown;
    isPending: boolean;
    refresh: ReturnType<typeof vi.fn>;
  }>,
  queryInputs: [] as unknown[],
  providerUsage: vi.fn((input: unknown) => ({ kind: "usage", input })),
  diagnostics: vi.fn((input: unknown) => ({ kind: "diagnostics", input })),
  history: vi.fn((input: unknown) => ({ kind: "history", input })),
  terminalSessions: [] as unknown[],
  terminalInput: null as unknown,
  refreshProviderUsage: vi.fn(),
  buttons: [] as Array<Record<string, unknown>>,
  providerSegments: [] as Array<Record<string, unknown>>,
  resourceSegments: [] as Array<Record<string, unknown>>,
  resizeCallback: null as ResizeObserverCallback | null,
  observe: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: (initial: unknown) => {
    const index = harness.refIndex++;
    const current = Object.hasOwn(harness.refSeeds, index) ? harness.refSeeds[index] : initial;
    const ref = { current };
    harness.refs[index] = ref;
    return ref;
  },
  useState: () => [harness.iconOnly, harness.setIconOnly],
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => harness.primaryEnvironment,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    const index = harness.queryInputs.length;
    harness.queryInputs.push(input);
    return harness.queries[index];
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerUsage: (input: unknown) => harness.providerUsage(input),
    processDiagnostics: (input: unknown) => harness.diagnostics(input),
    processResourceHistory: (input: unknown) => harness.history(input),
    refreshProviderUsage: { label: "refresh" },
  },
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: (input: unknown) => {
    harness.terminalInput = input;
    return harness.terminalSessions;
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => harness.refreshProviderUsage,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    harness.buttons.push(props);
    return <button type="button">{props.children as React.ReactNode}</button>;
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ProviderUsageSegment", () => ({
  ProviderUsageSegment: (props: Record<string, unknown>) => {
    harness.providerSegments.push(props);
    return <span data-provider-segment />;
  },
}));
vi.mock("./ResourceUsageSegment", () => ({
  ResourceUsageSegment: (props: Record<string, unknown>) => {
    harness.resourceSegments.push(props);
    return <span data-resource-segment />;
  },
}));
vi.mock("./statusBarPresentation", () => ({
  buildProviderUsageViewModel: (provider: Record<string, unknown>) => provider,
}));

import {
  AppStatusBar,
  AppStatusBarView,
  createStatusBarRefreshHandler,
  createStatusBarResourceRefreshHandler,
  startStatusBarUsageAutoRefresh,
} from "./AppStatusBar";

function query(data: unknown = null, isPending = false) {
  return { data, isPending, refresh: vi.fn() };
}

function renderStatusBar(): string {
  harness.refIndex = 0;
  harness.refs.length = 0;
  harness.effects.length = 0;
  harness.queryInputs.length = 0;
  harness.buttons.length = 0;
  harness.providerSegments.length = 0;
  harness.resourceSegments.length = 0;
  return renderToStaticMarkup(<AppStatusBar />);
}

function invokeRef(index: number): void {
  const callback = harness.refs[index]?.current;
  if (typeof callback !== "function") throw new Error(`Missing callback ref ${index}`);
  callback();
}

beforeEach(() => {
  harness.primaryEnvironment = null;
  harness.refSeeds = {};
  harness.iconOnly = false;
  harness.setIconOnly.mockReset();
  harness.queries = [query(), query(), query()];
  harness.providerUsage.mockClear();
  harness.diagnostics.mockClear();
  harness.history.mockClear();
  harness.terminalSessions = [];
  harness.terminalInput = null;
  harness.refreshProviderUsage.mockReset();
  harness.refreshProviderUsage.mockResolvedValue({ _tag: "Success" });
  harness.resizeCallback = null;
  harness.observe.mockReset();
  harness.disconnect.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        harness.resizeCallback = callback;
      }
      observe = harness.observe;
      disconnect = harness.disconnect;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("status bar refresh guards", () => {
  it("skips provider and resource refreshes without an environment", async () => {
    const refreshProviderUsage = vi.fn();
    const refreshUsageQuery = vi.fn();
    const refreshDiagnostics = vi.fn();
    const refreshHistory = vi.fn();
    await createStatusBarRefreshHandler({
      environmentId: null,
      refreshProviderUsage,
      refreshUsageQuery,
      refreshProcessDiagnostics: refreshDiagnostics,
      refreshResourceHistory: refreshHistory,
    })();
    createStatusBarResourceRefreshHandler({
      environmentId: null,
      refreshProcessDiagnostics: refreshDiagnostics,
      refreshResourceHistory: refreshHistory,
    })();
    expect(refreshProviderUsage).not.toHaveBeenCalled();
    expect(refreshDiagnostics).not.toHaveBeenCalled();
  });

  it("absorbs rejected background refreshes", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const cleanup = startStatusBarUsageAutoRefresh({ refresh, intervalMs: 10 });
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });
});

describe("AppStatusBar", () => {
  it("uses null queries and tears down refreshers without an environment", () => {
    const usageCleanup = vi.fn();
    const resourceCleanup = vi.fn();
    harness.refSeeds = { 3: usageCleanup, 4: "old", 5: resourceCleanup, 6: "old" };
    renderStatusBar();
    expect(harness.queryInputs).toEqual([null, null, null]);
    expect(harness.terminalInput).toEqual({ environmentId: null, threadId: null });
    harness.effects[0]?.();
    harness.effects[1]?.();
    harness.effects[3]?.();
    harness.effects[4]?.();
    expect(usageCleanup).toHaveBeenCalledOnce();
    expect(resourceCleanup).toHaveBeenCalledOnce();
    expect(harness.refs[3]?.current).toBeNull();
    expect(harness.refs[6]?.current).toBeNull();
    expect(harness.effects[5]?.()).toBeUndefined();

    harness.refs[3]!.current = usageCleanup;
    harness.refs[4]!.current = "old";
    harness.refs[5]!.current = resourceCleanup;
    harness.refs[6]!.current = "old";
    const unmount = harness.effects[2]?.();
    if (typeof unmount === "function") unmount();
    expect(usageCleanup).toHaveBeenCalledTimes(2);
    expect(resourceCleanup).toHaveBeenCalledTimes(2);
  });

  it("builds scoped queries and avoids duplicate or premature usage intervals", () => {
    const environmentId = EnvironmentId.make("environment-1");
    harness.primaryEnvironment = { environmentId };
    harness.queries = [query(null), query(), query()];
    harness.refSeeds = { 4: environmentId, 6: environmentId };
    renderStatusBar();
    expect(harness.queryInputs).toHaveLength(3);
    expect(harness.providerUsage).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(harness.history).toHaveBeenCalledWith({
      environmentId,
      input: { windowMs: 900_000, bucketMs: 60_000 },
    });
    harness.effects[3]?.();
    harness.effects[4]?.();
    expect(harness.refs[3]?.current).toBeNull();
    expect(harness.refs[5]?.current).toBeNull();
  });

  it("replaces refresh intervals when the environment changes", async () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("environment-2");
    const oldUsageCleanup = vi.fn();
    const oldResourceCleanup = vi.fn();
    harness.primaryEnvironment = { environmentId };
    harness.queries = [
      query({ providers: [] }),
      query({ diagnostics: true }),
      query({ history: true }),
    ];
    harness.terminalSessions = [{ id: 1 }, { id: 2 }];
    harness.iconOnly = true;
    harness.refSeeds = {
      3: oldUsageCleanup,
      4: EnvironmentId.make("environment-old"),
      5: oldResourceCleanup,
      6: EnvironmentId.make("environment-old"),
    };
    const markup = renderStatusBar();
    expect(markup).toContain("data-resource-segment");
    expect(harness.resourceSegments[0]).toMatchObject({ terminalCount: 2, iconOnly: true });
    harness.effects[0]?.();
    harness.effects[1]?.();
    harness.effects[3]?.();
    harness.effects[4]?.();
    await Promise.resolve();
    expect(oldUsageCleanup).toHaveBeenCalledOnce();
    expect(oldResourceCleanup).toHaveBeenCalledOnce();
    expect(harness.refreshProviderUsage).toHaveBeenCalledOnce();
    expect(harness.queries[1]?.refresh).toHaveBeenCalledTimes(2);
    expect(harness.queries[2]?.refresh).toHaveBeenCalledTimes(2);
    expect(typeof harness.refs[3]?.current).toBe("function");
    expect(typeof harness.refs[5]?.current).toBe("function");
    invokeRef(3);
    invokeRef(5);
  });

  it("keeps safe no-op refreshers until command handlers are installed", () => {
    vi.useFakeTimers();
    const environmentId = EnvironmentId.make("environment-initializing");
    harness.primaryEnvironment = { environmentId };
    harness.queries = [query({ providers: [] }), query(), query()];
    renderStatusBar();
    harness.effects[3]?.();
    harness.effects[4]?.();
    expect(typeof harness.refs[3]?.current).toBe("function");
    expect(typeof harness.refs[5]?.current).toBe("function");
    invokeRef(3);
    invokeRef(5);
  });

  it("switches to icon-only mode from observer and fallback widths", () => {
    const element = { clientWidth: 480 };
    harness.refSeeds = { 0: element };
    renderStatusBar();
    const cleanup = harness.effects[5]?.();
    expect(harness.observe).toHaveBeenCalledWith(element);
    harness.resizeCallback?.(
      [{ contentRect: { width: 600 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(harness.setIconOnly).toHaveBeenCalledWith(false);
    harness.resizeCallback?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    expect(harness.setIconOnly).toHaveBeenCalledWith(true);
    if (typeof cleanup === "function") cleanup();
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });
});

describe("AppStatusBarView defaults", () => {
  it("renders no providers and exposes refresh state", () => {
    renderToStaticMarkup(
      <AppStatusBarView
        usage={null}
        diagnostics={null}
        resourceHistory={null}
        terminalCount={0}
        isRefreshing
        iconOnly
        onRefresh={vi.fn()}
      />,
    );
    expect(harness.providerSegments).toHaveLength(0);
    expect(String(harness.buttons[0]?.children)).toContain("object");
  });
});
