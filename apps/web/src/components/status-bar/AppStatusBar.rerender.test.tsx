// @vitest-environment happy-dom

import type {
  EnvironmentId,
  ServerProcessDiagnosticsResult,
  ServerProviderUsageResult,
} from "@t4code/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  selectedEnvironmentId: null as EnvironmentId | null,
  localEnvironmentId: null as EnvironmentId | null,
  usageAtom: null as unknown,
  diagnosticsAtoms: new Map<string, unknown>(),
  providerUsageCalls: [] as EnvironmentId[],
  processDiagnosticsCalls: [] as EnvironmentId[],
  resourceProps: [] as Array<Record<string, unknown>>,
  refreshProviderUsage: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () =>
    harness.selectedEnvironmentId === null
      ? null
      : { environmentId: harness.selectedEnvironmentId },
  usePrimaryLocalEnvironmentForSelected: () =>
    harness.localEnvironmentId === null ? null : { environmentId: harness.localEnvironmentId },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerUsage: ({ environmentId }: { environmentId: EnvironmentId }) => {
      harness.providerUsageCalls.push(environmentId);
      return harness.usageAtom;
    },
    processDiagnostics: ({ environmentId }: { environmentId: EnvironmentId }) => {
      harness.processDiagnosticsCalls.push(environmentId);
      const atom = harness.diagnosticsAtoms.get(environmentId);
      if (atom === undefined) throw new Error(`Missing diagnostics atom for ${environmentId}`);
      return atom;
    },
    refreshProviderUsage: { label: "refresh-provider-usage" },
  },
}));

vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => harness.refreshProviderUsage,
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./ProviderUsageSegment", () => ({
  ProviderUsageSegment: () => <span data-provider-usage />,
}));

vi.mock("./ResourceUsageSegment", () => ({
  ResourceUsageSegment: (props: Record<string, unknown>) => {
    harness.resourceProps.push(props);
    return <span data-resource-usage />;
  },
}));

import { AppStatusBar } from "./AppStatusBar";

const readAt = DateTime.makeUnsafe("2026-07-19T18:00:00.000Z");
const remoteEnvironmentId = "remote" as EnvironmentId;
const primaryEnvironmentId = "primary" as EnvironmentId;

function diagnostics(
  rssBytes: number,
  patch: Partial<ServerProcessDiagnosticsResult> = {},
): ServerProcessDiagnosticsResult {
  return {
    serverPid: 100,
    readAt,
    totals: {
      combined: { processCount: 1, rssBytes, cpuPercent: 1 },
      core: { processCount: 1, rssBytes, cpuPercent: 1 },
      external: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
    },
    uiCoverage: { status: "available", message: Option.none() },
    processes: [],
    error: Option.none(),
    ...patch,
  };
}

const usage: ServerProviderUsageResult = {
  readAt,
  isFetching: false,
  providers: [],
};

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
let remoteDiagnosticsAtom: Atom.Writable<
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>,
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>
>;
let localDiagnosticsAtom: Atom.Writable<
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>,
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>
>;

function makeDiagnosticsAtom(
  initial: AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>,
): Atom.Writable<
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>,
  AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error>
> {
  return Atom.make(initial);
}

function latestResourceProps(): Record<string, unknown> {
  const props = harness.resourceProps.at(-1);
  if (props === undefined) throw new Error("ResourceUsageSegment was not rendered.");
  return props;
}

async function renderStatusBar(): Promise<void> {
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <AppStatusBar />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  harness.selectedEnvironmentId = remoteEnvironmentId;
  harness.localEnvironmentId = null;
  harness.providerUsageCalls = [];
  harness.processDiagnosticsCalls = [];
  harness.resourceProps = [];
  harness.refreshProviderUsage.mockReset().mockResolvedValue({ _tag: "Success" });

  const initialRemoteDiagnostics: AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error> =
    AsyncResult.success(diagnostics(700_000_000));
  const initialLocalDiagnostics: AsyncResult.AsyncResult<ServerProcessDiagnosticsResult, Error> =
    AsyncResult.failure<ServerProcessDiagnosticsResult, Error>(
      Cause.fail(new Error("Local diagnostics failed.")),
    );
  remoteDiagnosticsAtom = makeDiagnosticsAtom(initialRemoteDiagnostics);
  localDiagnosticsAtom = makeDiagnosticsAtom(initialLocalDiagnostics);
  harness.usageAtom = Atom.make(AsyncResult.success(usage));
  harness.diagnosticsAtoms = new Map([
    [remoteEnvironmentId, remoteDiagnosticsAtom],
    [primaryEnvironmentId, localDiagnosticsAtom],
  ]);
  registry = AtomRegistry.make({
    scheduleTask: (task) => {
      task();
      return () => {};
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AppStatusBar real hook rerenders", () => {
  it("keeps query hook order stable across browser/desktop and remote/local failures", async () => {
    await renderStatusBar();
    expect(latestResourceProps()).toMatchObject({
      diagnostics: {
        diagnostics: expect.objectContaining({ serverPid: 100 }),
        queryError: null,
      },
      localDiagnostics: null,
    });
    expect(harness.processDiagnosticsCalls).toEqual([remoteEnvironmentId]);

    await act(async () => {
      registry.set(
        remoteDiagnosticsAtom,
        AsyncResult.failure(Cause.fail(new Error("Selected diagnostics failed."))),
      );
      registry.set(
        localDiagnosticsAtom,
        AsyncResult.failure(Cause.fail(new Error("Local diagnostics failed."))),
      );
    });
    expect(harness.processDiagnosticsCalls).not.toContain(primaryEnvironmentId);
    harness.localEnvironmentId = primaryEnvironmentId;
    await renderStatusBar();
    expect(latestResourceProps()).toMatchObject({
      diagnostics: { diagnostics: null, queryError: "Selected diagnostics failed." },
      localDiagnostics: { diagnostics: null, queryError: "Local diagnostics failed." },
    });

    const remoteSuccess = AsyncResult.success<ServerProcessDiagnosticsResult, Error>(
      diagnostics(700_000_000),
    );
    const localSuccess = AsyncResult.success<ServerProcessDiagnosticsResult, Error>(
      diagnostics(100_000_000),
    );
    await act(async () => {
      registry.set(
        remoteDiagnosticsAtom,
        AsyncResult.failure(Cause.fail(new Error("Selected connection lost.")), {
          previousSuccess: Option.some(remoteSuccess),
        }),
      );
      registry.set(
        localDiagnosticsAtom,
        AsyncResult.failure(Cause.fail(new Error("Local connection lost.")), {
          previousSuccess: Option.some(localSuccess),
        }),
      );
    });
    await renderStatusBar();
    expect(latestResourceProps()).toMatchObject({
      diagnostics: {
        diagnostics: expect.objectContaining({ serverPid: 100 }),
        queryError: "Selected connection lost.",
      },
      localDiagnostics: {
        diagnostics: expect.objectContaining({ serverPid: 100 }),
        queryError: "Local connection lost.",
      },
    });

    harness.selectedEnvironmentId = primaryEnvironmentId;
    harness.localEnvironmentId = null;
    const callsBeforeSelectingLocal = harness.processDiagnosticsCalls.length;
    await renderStatusBar();
    expect(latestResourceProps()).toMatchObject({
      diagnostics: {
        diagnostics: null,
        queryError: "Local diagnostics failed.",
      },
      localDiagnostics: null,
    });
    expect(harness.processDiagnosticsCalls.slice(callsBeforeSelectingLocal)).toEqual([
      primaryEnvironmentId,
      primaryEnvironmentId,
    ]);
  });
});
