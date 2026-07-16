/**
 * Behavior tests for DiagnosticsSettingsPanel.
 *
 * Only `DiagnosticsSettingsPanel` is exported, so the pure formatters and the
 * many sub-components are exercised through `renderToStaticMarkup`. Following the
 * ConnectionsSettings.test.tsx pattern, `react` is partially mocked so functional
 * state updaters run and setter calls are recorded, `../ui/tooltip` is mocked so
 * the native INT/KILL/copy `<button>` render elements (and their onClick handlers)
 * are captured, and `../ui/button` records its props so the refresh / open-logs
 * handlers can be invoked directly. All state/query/atom seams are swapped for
 * controllable test doubles.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t4code/contracts";
import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryResult,
  ServerProcessResourceHistorySummary,
  ServerTraceDiagnosticsResult,
} from "@t4code/contracts";

type AnyProps = Record<string, unknown>;

const h = vi.hoisted(() => {
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node !== null && typeof node === "object" && "props" in node) {
      return textOf((node as { props: { children?: unknown } }).props.children);
    }
    return "";
  };

  return {
    textOf,
    // ── react instrumentation ──
    stateSeeds: [] as Array<{ match: (initial: unknown) => boolean; value: unknown }>,
    setStateCalls: [] as Array<{ next: unknown; applied: unknown }>,
    // ── captured render elements / controls ──
    triggers: [] as Array<{ props: Record<string, unknown> }>,
    buttons: [] as Array<{ props: Record<string, unknown> }>,
    // ── seams ──
    observability: null as { logsDirectoryPath?: string | null } | null,
    availableEditors: [] as ReadonlyArray<unknown>,
    primaryEnvironment: null as {
      environmentId: EnvironmentId;
      serverConfig?: { environment: { platform: { os: string } } };
    } | null,
    preferredEditor: "vscode" as string | null,
    isCopied: false,
    copies: [] as Array<{ value: string }>,
    confirmResult: true,
    relative: { value: "5m", suffix: "ago" as string | null },
    toasts: [] as Array<unknown>,
    // queries
    traceQuery: emptyQuery(),
    processQuery: emptyQuery(),
    resourceQuery: emptyQuery(),
    // commands
    signalCalls: [] as Array<unknown>,
    // Real Option values are wired up in reset() (runs at test time); the hoisted
    // factory cannot reference the `effect/Option` import.
    signalResult: { _tag: "Success" } as {
      _tag: string;
      value?: { signaled: boolean; message: Option.Option<string> };
      error?: unknown;
    },
    openInEditorCalls: [] as Array<unknown>,
    openInEditorResult: { _tag: "Success" } as { _tag: string; error?: unknown },
    frontendLogSnapshot: "captured frontend warning\n",
    downloadCalls: [] as Array<string>,
    downloadError: null as unknown,
    reset() {
      h.stateSeeds.length = 0;
      h.setStateCalls.length = 0;
      h.triggers.length = 0;
      h.buttons.length = 0;
      h.observability = { logsDirectoryPath: "/logs" };
      h.availableEditors = ["vscode"];
      h.primaryEnvironment = { environmentId: EnvironmentId.make("environment-1") };
      h.preferredEditor = "vscode";
      h.isCopied = false;
      h.copies.length = 0;
      h.confirmResult = true;
      h.relative = { value: "5m", suffix: "ago" };
      h.toasts.length = 0;
      h.traceQuery = emptyQuery();
      h.processQuery = emptyQuery();
      h.resourceQuery = emptyQuery();
      h.signalCalls.length = 0;
      h.signalResult = { _tag: "Success", value: { signaled: true, message: Option.none() } };
      h.openInEditorCalls.length = 0;
      h.openInEditorResult = { _tag: "Success" };
      h.frontendLogSnapshot = "captured frontend warning\n";
      h.downloadCalls.length = 0;
      h.downloadError = null;
    },
  };

  function emptyQuery() {
    return {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    };
  }
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial?: unknown) => {
    const resolved = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const seedIndex = h.stateSeeds.findIndex((seed) => seed.match(resolved));
    const value = seedIndex >= 0 ? h.stateSeeds.splice(seedIndex, 1)[0]!.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ next, applied });
    };
    return [value, setValue];
  };
  return { ...actual, useState: useState as typeof actual.useState };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { __atom?: string } | null | undefined) => {
    if (atom?.__atom === "observability") return h.observability;
    if (atom?.__atom === "editors") return h.availableEditors;
    return undefined;
  },
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { _tag?: string; interrupted?: boolean }) =>
    result._tag === "Interrupted" || result.interrupted === true,
  squashAtomCommandFailure: (result: { error?: unknown }) => result.error,
}));

vi.mock("../../editorPreferences", () => ({
  resolveAndPersistPreferredEditor: () => h.preferredEditor,
}));

vi.mock("../../timestampFormat", () => ({
  formatRelativeTime: () => h.relative,
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    isCopied: h.isCopied,
    copyToClipboard: (value: string) => h.copies.push({ value }),
  }),
}));

vi.mock("../../diagnostics/frontendLogCapture", () => ({
  readFrontendLogSnapshot: () => h.frontendLogSnapshot,
}));

vi.mock("../../diagnostics/downloadDiagnosticLogs", () => ({
  downloadDiagnosticLogs: async (frontendLog: string) => {
    h.downloadCalls.push(frontendLog);
    if (h.downloadError !== null) throw h.downloadError;
    return "t4code-diagnostics-test.zip";
  },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    signalProcess: { __cmd: "signalProcess" },
    traceDiagnostics: (args: unknown) => ({ __q: "trace", args }),
    processDiagnostics: (args: unknown) => ({ __q: "process", args }),
    processResourceHistory: (args: unknown) => ({ __q: "resource", args }),
  },
  primaryServerAvailableEditorsAtom: { __atom: "editors" },
  primaryServerObservabilityAtom: { __atom: "observability" },
}));

vi.mock("../../state/shell", () => ({
  shellEnvironment: {
    openInEditor: { __cmd: "openInEditor" },
  },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => h.primaryEnvironment,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { __q?: string } | null) => {
    if (atom === null) {
      return { data: null, error: null, isPending: false, refresh: vi.fn() };
    }
    if (atom.__q === "trace") return h.traceQuery;
    if (atom.__q === "process") return h.processQuery;
    if (atom.__q === "resource") return h.resourceQuery;
    return { data: null, error: null, isPending: false, refresh: vi.fn() };
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: { __cmd?: string } | null | undefined) => {
    if (atom?.__cmd === "signalProcess") {
      return (input: unknown) => {
        h.signalCalls.push(input);
        return Promise.resolve(h.signalResult);
      };
    }
    if (atom?.__cmd === "openInEditor") {
      return (input: unknown) => {
        h.openInEditorCalls.push(input);
        return Promise.resolve(h.openInEditorResult);
      };
    }
    return () => Promise.resolve({ _tag: "Success" });
  },
}));

vi.mock("./settingsLayout", () => ({
  useRelativeTimeTick: () => Date.now(),
  SettingsPageContainer: (props: AnyProps) => (
    <div data-testid="settings-page" className={props.className as string | undefined}>
      {props.children as ReactNode}
    </div>
  ),
  SettingsSection: (props: AnyProps) => (
    <section data-section-title={typeof props.title === "string" ? props.title : "custom"}>
      {props.headerAction as ReactNode}
      {props.children as ReactNode}
    </section>
  ),
  SettingsRow: (props: AnyProps) => (
    <div data-settings-row>
      {props.title as ReactNode}
      {props.description as ReactNode}
      {props.control as ReactNode}
      {props.children as ReactNode}
    </div>
  ),
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: (props: AnyProps) => <div data-scroll-area>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: unknown) => h.toasts.push(toast) },
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => {
    const render = props.render;
    if (render && typeof render === "object" && "props" in render) {
      h.triggers.push({ props: (render as { props: Record<string, unknown> }).props });
    }
    return (
      <>
        {render as ReactNode}
        {props.children as ReactNode}
      </>
    );
  },
  TooltipPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/button", () => ({
  Button: (props: AnyProps) => {
    h.buttons.push({ props });
    return (
      <button
        type="button"
        aria-label={props["aria-label"] as string | undefined}
        disabled={Boolean(props.disabled)}
      >
        {props.children as ReactNode}
      </button>
    );
  },
}));

import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";

// ── fixtures ─────────────────────────────────────────────────────────

const T0 = DateTime.makeUnsafe("2026-03-29T00:00:00.000Z");
const T1 = DateTime.makeUnsafe("2026-03-29T00:01:00.000Z");

const LONG_TRACE_ID = "trace-0123456789abcdefghijklmnopqrstuvwxyz-9876";
const LONG_CAUSE =
  "boom failed with a very long multi-line cause\n" +
  "that definitely exceeds one hundred and eighty characters so the expandable text control offers a show-more affordance to the reader here and keeps going for a while longer.";

function entry(
  overrides: Partial<ServerProcessDiagnosticsEntry> = {},
): ServerProcessDiagnosticsEntry {
  return {
    pid: 100,
    ppid: 1,
    pgid: Option.none(),
    status: "running",
    cpuPercent: 3.2,
    rssBytes: 1_048_576,
    elapsed: "01:00",
    command: "/usr/bin/codex run",
    depth: 0,
    childPids: [],
    ...overrides,
  } as ServerProcessDiagnosticsEntry;
}

function processData(
  overrides: Partial<ServerProcessDiagnosticsResult> = {},
): ServerProcessDiagnosticsResult {
  return {
    serverPid: 4242,
    readAt: T0,
    processCount: 3,
    totalRssBytes: 5_000_000,
    totalCpuPercent: 12.5,
    processes: [
      entry({ pid: 100, depth: 0, childPids: [101], command: "/usr/bin/codex run" }),
      entry({ pid: 101, depth: 1, childPids: [], command: "node worker.js", rssBytes: 500 }),
      entry({
        pid: 102,
        depth: 0,
        childPids: [],
        command: "'C:\\Program Files\\tool.exe' --flag",
        cpuPercent: 0,
        rssBytes: 2048,
      }),
    ],
    error: Option.none(),
    ...overrides,
  } as ServerProcessDiagnosticsResult;
}

function summary(
  overrides: Partial<ServerProcessResourceHistorySummary> = {},
): ServerProcessResourceHistorySummary {
  return {
    processKey: "k",
    pid: 100,
    ppid: 1,
    command: "t4 server",
    depth: 0,
    isServerRoot: true,
    firstSeenAt: T0,
    lastSeenAt: T0,
    currentCpuPercent: 2,
    avgCpuPercent: 1.5,
    maxCpuPercent: 8,
    cpuSecondsApprox: 65,
    currentRssBytes: 1000,
    maxRssBytes: 2000,
    sampleCount: 10,
    ...overrides,
  } as ServerProcessResourceHistorySummary;
}

function resourceData(
  overrides: Partial<ServerProcessResourceHistoryResult> = {},
): ServerProcessResourceHistoryResult {
  return {
    readAt: T0,
    windowMs: 900_000,
    bucketMs: 60_000,
    sampleIntervalMs: 2_000,
    retainedSampleCount: 120,
    totalCpuSecondsApprox: 75,
    buckets: [
      {
        startedAt: T0,
        endedAt: T1,
        avgCpuPercent: 10,
        maxCpuPercent: 40,
        maxRssBytes: 1000,
        maxProcessCount: 2,
      },
      {
        startedAt: T1,
        endedAt: T1,
        avgCpuPercent: 5,
        maxCpuPercent: 20,
        maxRssBytes: 800,
        maxProcessCount: 1,
      },
    ],
    topProcesses: [
      summary({ processKey: "root", pid: 100, isServerRoot: true, depth: 0, cpuSecondsApprox: 65 }),
      summary({
        processKey: "child",
        pid: 101,
        isServerRoot: false,
        depth: 2,
        command: "node child.js",
        cpuSecondsApprox: 0.5,
      }),
      summary({
        processKey: "hours",
        pid: 102,
        isServerRoot: false,
        depth: 2,
        command: "this-is-a-really-long-process-name-that-clearly-exceeds-forty-two-characters",
        cpuSecondsApprox: 7_200,
      }),
    ],
    error: Option.none(),
    ...overrides,
  } as ServerProcessResourceHistoryResult;
}

function traceData(
  overrides: Partial<ServerTraceDiagnosticsResult> = {},
): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: "/logs/trace.jsonl",
    scannedFilePaths: ["/logs/trace.jsonl"],
    readAt: T0,
    recordCount: 1234,
    parseErrorCount: 2,
    firstSpanAt: Option.some(T0),
    lastSpanAt: Option.some(T0),
    failureCount: 3,
    interruptionCount: 0,
    slowSpanThresholdMs: 500,
    slowSpanCount: 4,
    logLevelCounts: {},
    topSpansByCount: [
      {
        name: "span.a",
        count: 10,
        failureCount: 1,
        totalDurationMs: 1000,
        averageDurationMs: 100,
        maxDurationMs: 1200,
      },
    ],
    slowestSpans: [
      {
        name: "span.slow",
        durationMs: 12_000,
        endedAt: T0,
        traceId: LONG_TRACE_ID,
        spanId: "span-1",
      },
    ],
    commonFailures: [
      {
        name: "span.err",
        cause: "short cause",
        count: 5,
        lastSeenAt: T0,
        traceId: "t",
        spanId: "s",
      },
    ],
    latestFailures: [
      {
        name: "span.fail",
        cause: LONG_CAUSE,
        durationMs: 9000,
        endedAt: T0,
        traceId: "t",
        spanId: "s",
      },
    ],
    latestWarningAndErrorLogs: [
      {
        spanName: "span.log",
        level: "warn",
        message: "a warning message",
        seenAt: T0,
        traceId: LONG_TRACE_ID,
        spanId: "s",
      },
    ],
    partialFailure: Option.none(),
    error: Option.none(),
    ...overrides,
  } as ServerTraceDiagnosticsResult;
}

function render(): string {
  h.triggers.length = 0;
  h.buttons.length = 0;
  h.setStateCalls.length = 0;
  return renderToStaticMarkup(<DiagnosticsSettingsPanel />);
}

function seedAll() {
  h.traceQuery = { data: traceData(), error: null, isPending: false, refresh: vi.fn() };
  h.processQuery = { data: processData(), error: null, isPending: false, refresh: vi.fn() };
  h.resourceQuery = { data: resourceData(), error: null, isPending: false, refresh: vi.fn() };
}

function findTrigger(predicate: (props: Record<string, unknown>) => boolean) {
  const found = h.triggers.find((entry) => predicate(entry.props));
  if (!found) throw new Error("No matching tooltip trigger element was captured");
  return found.props;
}

function findButton(label: string) {
  const found = h.buttons.find((entry) => entry.props["aria-label"] === label);
  if (!found) throw new Error(`No button with aria-label "${label}" was captured`);
  return found.props;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  h.reset();
  vi.stubGlobal("window", { confirm: () => h.confirmResult });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────

describe("DiagnosticsSettingsPanel rendering", () => {
  it("renders formatted diagnostics for fully populated data", () => {
    seedAll();
    const markup = render();

    // Live process stats + formatters.
    expect(markup).toContain("12.5%");
    expect(markup).toContain("MB");
    expect(markup).toContain("4242"); // server pid rendered verbatim
    // Process name/type formatting.
    expect(markup).toContain(">codex</span>");
    expect(markup).toContain("Agent");
    expect(markup).toContain("Subprocess");
    expect(markup).toContain("Process");
    expect(markup).toContain("node worker.js");
    // Trace id shortening (ellipsis) for long ids.
    expect(markup).toContain("...");
    // Resource history CPU-time formatting: 0.5s, 1.08m (65s), 2.00h (7200s).
    expect(markup).toContain("0.50s");
    expect(markup).toContain("1.08m");
    expect(markup).toContain("2.00h");
    // Latest / common failure tables render their span names.
    expect(markup).toContain("span.fail");
    expect(markup).toContain("span.slow");
    expect(markup).toContain("span.a");
    expect(markup).toContain("span.log");
    // Expandable long cause offers the show-more affordance.
    expect(markup).toContain("Show full error");
  });

  it("renders loading and empty placeholders when queries are pending", () => {
    h.traceQuery = { data: null, error: null, isPending: true, refresh: vi.fn() };
    h.processQuery = { data: null, error: null, isPending: true, refresh: vi.fn() };
    h.resourceQuery = { data: null, error: null, isPending: true, refresh: vi.fn() };
    const markup = render();

    expect(markup).toContain("...");
    expect(markup).toContain("Loading live processes...");
    expect(markup).toContain("Collecting process resource samples...");
    expect(markup).toContain("Loading failures...");
    expect(markup).toContain("Loading failure groups...");
    expect(markup).toContain("Loading slow spans...");
    expect(markup).toContain("Loading recent logs...");
    expect(markup).toContain("Loading span names...");
  });

  it("renders settled empty states when there is no data and nothing pending", () => {
    h.traceQuery = {
      data: traceData({
        latestFailures: [],
        commonFailures: [],
        slowestSpans: [],
        topSpansByCount: [],
        latestWarningAndErrorLogs: [],
      }),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    h.processQuery = {
      data: processData({ processes: [] }),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    h.resourceQuery = {
      data: resourceData({ topProcesses: [] }),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    const markup = render();

    expect(markup).toContain("No live descendant processes found.");
    expect(markup).toContain("No process resource samples found for this window.");
    expect(markup).toContain("No failed spans found.");
    expect(markup).toContain("No repeated failures found.");
    expect(markup).toContain("No spans found.");
    expect(markup).toContain("No warnings or errors found.");
  });

  it("renders the copied trace-id affordance when the clipboard reports success", () => {
    h.isCopied = true;
    seedAll();
    const markup = render();
    expect(markup).toContain("Copied trace ID");
    expect(markup).toContain("Copied");
  });

  it("hides a collapsed process subtree when its pid is in the collapsed set", () => {
    seedAll();
    // Seed ProcessDiagnosticsTable's collapsedPids with the codex parent (pid 100).
    h.stateSeeds.push({
      match: (initial) => initial instanceof Set,
      value: new Set<number>([100]),
    });
    const markup = render();
    // The child worker under the collapsed parent is filtered out of the table.
    expect(markup).not.toContain("node worker.js");
    // The sibling root process is still visible.
    expect(markup).toContain("Process");
  });
});

describe("DiagnosticsSettingsPanel error banners", () => {
  it("shows connection and structured error messages across sections", () => {
    h.processQuery = {
      data: processData({ error: Option.some({ message: "disk unreadable" }) }),
      error: "process transport down",
      isPending: false,
      refresh: vi.fn(),
    };
    h.resourceQuery = {
      data: resourceData({
        error: Option.some({
          failureTag: "ProcessDiagnosticsQueryFailedError",
          message: "sampler stalled",
        }),
      }),
      error: "resource transport down",
      isPending: false,
      refresh: vi.fn(),
    };
    h.traceQuery = {
      data: traceData({
        partialFailure: Option.some(true),
        error: Option.some({ kind: "trace-file-read-failed", message: "trace unreadable" }),
      }),
      error: "trace transport down",
      isPending: false,
      refresh: vi.fn(),
    };
    const markup = render();

    expect(markup).toContain("disk unreadable");
    expect(markup).toContain("process transport down");
    expect(markup).toContain("sampler stalled");
    expect(markup).toContain("resource transport down");
    expect(markup).toContain("trace transport down");
    // Partial-failure trace error uses the amber wording and the message.
    expect(markup).toContain("Some trace files could not be read");
    expect(markup).toContain("trace unreadable");
  });

  it("renders a non-partial trace error with the plain message only", () => {
    h.traceQuery = {
      data: traceData({
        partialFailure: Option.some(false),
        error: Option.some({ kind: "trace-file-not-found", message: "no trace file" }),
      }),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
    const markup = render();
    expect(markup).toContain("no trace file");
    expect(markup).not.toContain("Some trace files could not be read");
  });
});

describe("DiagnosticsSettingsPanel refresh actions", () => {
  it("wires each refresh button to its query refresh callback", () => {
    seedAll();
    render();

    (findButton("Refresh process diagnostics").onClick as () => void)();
    (findButton("Refresh resource history").onClick as () => void)();
    (findButton("Refresh trace diagnostics").onClick as () => void)();

    expect(h.processQuery.refresh).toHaveBeenCalledTimes(1);
    expect(h.resourceQuery.refresh).toHaveBeenCalledTimes(1);
    expect(h.traceQuery.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("DiagnosticsSettingsPanel trace-id copy", () => {
  it("copies the full trace id when the copy control is clicked", () => {
    seedAll();
    render();
    const copyButton = findTrigger(
      (props) => (props["aria-label"] as string | undefined) === "Copy trace ID",
    );
    (copyButton.onClick as () => void)();
    expect(h.copies).toContainEqual({ value: LONG_TRACE_ID });
  });
});

describe("DiagnosticsSettingsPanel process signals", () => {
  function clickSignal(kind: "INT" | "KILL") {
    seedAll();
    render();
    const button = findTrigger(
      (props) => props.children === kind && typeof props.onClick === "function",
    );
    (button.onClick as () => void)();
  }

  it("sends SIGINT and refreshes on a successful signal", async () => {
    clickSignal("INT");
    await flush();
    expect(h.signalCalls).toHaveLength(1);
    expect(h.signalCalls[0]).toMatchObject({ input: { signal: "SIGINT" } });
    expect(h.processQuery.refresh).toHaveBeenCalled();
    expect(h.toasts).toHaveLength(0);
  });

  it("does not offer SIGINT for Windows environments", () => {
    h.primaryEnvironment = {
      environmentId: EnvironmentId.make("environment-1"),
      serverConfig: { environment: { platform: { os: "windows" } } },
    };
    seedAll();
    render();

    expect(h.triggers.some(({ props }) => props.children === "INT")).toBe(false);
    expect(h.triggers.some(({ props }) => props.children === "KILL")).toBe(true);
  });

  it("surfaces an info toast when the process already exited (stale descendant)", async () => {
    h.signalResult = {
      _tag: "Success",
      value: { signaled: false, message: Option.some("pid is not a live descendant") },
    };
    clickSignal("INT");
    await flush();
    expect(h.toasts).toContainEqual(
      expect.objectContaining({ type: "info", title: "Process already exited" }),
    );
  });

  it("surfaces an error toast when the signal reports an unhandled failure message", async () => {
    h.signalResult = {
      _tag: "Success",
      value: { signaled: false, message: Option.some("permission denied") },
    };
    clickSignal("INT");
    await flush();
    expect(h.toasts).toContainEqual(
      expect.objectContaining({ type: "error", description: "permission denied" }),
    );
  });

  it("surfaces an error toast when the command fails and is not interrupted", async () => {
    h.signalResult = { _tag: "Failure", error: new Error("spawn refused") };
    clickSignal("INT");
    await flush();
    expect(h.toasts).toContainEqual(
      expect.objectContaining({ type: "error", title: "Could not send SIGINT" }),
    );
  });

  it("stays silent when the command is interrupted", async () => {
    h.signalResult = { _tag: "Interrupted" };
    clickSignal("INT");
    await flush();
    expect(h.toasts).toHaveLength(0);
  });

  it("asks for confirmation before sending SIGKILL and proceeds when confirmed", async () => {
    h.confirmResult = true;
    clickSignal("KILL");
    await flush();
    expect(h.signalCalls).toHaveLength(1);
    expect(h.signalCalls[0]).toMatchObject({ input: { signal: "SIGKILL" } });
  });

  it("aborts SIGKILL when the confirmation is dismissed", async () => {
    h.confirmResult = false;
    clickSignal("KILL");
    await flush();
    expect(h.signalCalls).toHaveLength(0);
  });
});

describe("DiagnosticsSettingsPanel open logs directory", () => {
  function clickOpenLogs() {
    (findButton("Open logs folder").onClick as () => void)();
  }

  it("opens the logs directory in the resolved editor", async () => {
    seedAll();
    render();
    clickOpenLogs();
    await flush();
    expect(h.openInEditorCalls).toHaveLength(1);
    expect(h.openInEditorCalls[0]).toMatchObject({
      input: { cwd: "/logs", editor: "vscode" },
    });
  });

  it("records an error when no editor is available", async () => {
    h.preferredEditor = null;
    seedAll();
    render();
    clickOpenLogs();
    await flush();
    expect(h.openInEditorCalls).toHaveLength(0);
    expect(h.setStateCalls.map((call) => call.applied)).toContain("No available editors found.");
  });

  it("does nothing when there is no logs directory configured", async () => {
    h.observability = { logsDirectoryPath: null };
    seedAll();
    render();
    clickOpenLogs();
    await flush();
    expect(h.openInEditorCalls).toHaveLength(0);
  });

  it("records the failure message when opening the editor fails", async () => {
    h.openInEditorResult = { _tag: "Failure", error: new Error("editor missing") };
    seedAll();
    render();
    clickOpenLogs();
    await flush();
    expect(h.setStateCalls.map((call) => call.applied)).toContain("editor missing");
  });

  it("stays silent when opening the editor is interrupted", async () => {
    h.openInEditorResult = { _tag: "Interrupted" };
    seedAll();
    render();
    clickOpenLogs();
    await flush();
    expect(h.setStateCalls.map((call) => call.applied)).not.toContain(
      "Unable to open logs folder.",
    );
  });
});

describe("DiagnosticsSettingsPanel diagnostic log download", () => {
  it("renders the final download section with status-bar clearance", () => {
    seedAll();
    const markup = render();

    expect(markup).toContain('class="pb-12"');
    expect(markup).toContain('data-section-title="Diagnostic logs"');
    expect(markup).toContain("Download diagnostic logs");
    expect(markup).toContain("server.log");
    expect(markup).toContain("frontend.log");
    expect(markup).toContain("Download logs");
  });

  it("disables the download action while the archive is being prepared", () => {
    h.stateSeeds.push({ match: (initial) => initial === "idle", value: "downloading" });
    seedAll();
    const markup = render();

    expect(markup).toContain("Preparing logs...");
    expect(findButton("Download diagnostic logs").disabled).toBe(true);
  });

  it("downloads the captured frontend snapshot", async () => {
    seedAll();
    render();

    (findButton("Download diagnostic logs").onClick as () => void)();
    await flush();

    expect(h.downloadCalls).toEqual(["captured frontend warning\n"]);
  });

  it("shows an actionable toast when the archive cannot be downloaded", async () => {
    h.downloadError = new Error("server unavailable");
    seedAll();
    render();

    (findButton("Download diagnostic logs").onClick as () => void)();
    await flush();

    expect(h.toasts).toContainEqual(
      expect.objectContaining({
        type: "error",
        title: "Could not download diagnostic logs",
        description: "server unavailable",
      }),
    );
  });
});
