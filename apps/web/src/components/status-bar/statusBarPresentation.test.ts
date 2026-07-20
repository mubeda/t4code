import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceTotals,
  ServerProcessUiCoverage,
  ServerProviderUsageSnapshot,
} from "@t4code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderUsageViewModel,
  buildResourceSummaryViewModel,
} from "./statusBarPresentation";

const updatedAt = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");

function providerSnapshot(
  patch: Partial<ServerProviderUsageSnapshot>,
): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    status: "ok",
    session: {
      usedPercent: 11,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null,
    },
    weekly: {
      usedPercent: 83,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null,
    },
    updatedAt,
    error: null,
    metadata: {},
    ...patch,
  };
}

const mebibytes = (value: number): number => value * 1024 ** 2;

function processEntry(
  patch: Partial<ServerProcessDiagnosticsEntry> &
    Pick<ServerProcessDiagnosticsEntry, "processKey" | "pid" | "scope" | "kind" | "label">,
): ServerProcessDiagnosticsEntry {
  return {
    ppid: 1,
    pgid: Option.none(),
    status: "Run",
    cpuPercent: 1,
    rssBytes: mebibytes(50),
    elapsed: "00:00:01",
    command: `command-for-${patch.pid}`,
    depth: 0,
    childPids: [],
    confidence: "exact",
    ...patch,
  };
}

const resourceProcesses: ReadonlyArray<ServerProcessDiagnosticsEntry> = [
  processEntry({
    processKey: "100:1",
    pid: 100,
    scope: "core",
    kind: "server",
    label: "T4Code Server",
    command: "t4code server",
    rssBytes: mebibytes(250),
    cpuPercent: 2,
  }),
  processEntry({
    processKey: "101:1",
    pid: 101,
    scope: "core",
    kind: "ui",
    label: "T4Code UI",
    command: "T4Code WebContent",
    rssBytes: mebibytes(150),
    cpuPercent: 1,
  }),
  processEntry({
    processKey: "200:1",
    pid: 200,
    scope: "external",
    kind: "provider",
    label: "Codex",
    command: "codex app-server",
    rssBytes: mebibytes(150),
    cpuPercent: 4,
  }),
  processEntry({
    processKey: "201:1",
    pid: 201,
    scope: "external",
    kind: "terminal",
    label: "Build terminal",
    command: "pnpm test --filter web",
    rssBytes: mebibytes(100),
    cpuPercent: 2,
  }),
  processEntry({
    processKey: "202:1",
    pid: 202,
    scope: "external",
    kind: "unknown",
    label: "Unattributed process",
    command: "helper --serve",
    rssBytes: mebibytes(50),
    cpuPercent: 1,
    confidence: "fallback",
  }),
];

function diagnosticsFixture(
  patch: Partial<ServerProcessDiagnosticsResult> = {},
): ServerProcessDiagnosticsResult {
  return {
    serverPid: 100,
    readAt: updatedAt,
    totals: {
      combined: { processCount: 5, rssBytes: mebibytes(700), cpuPercent: 10 },
      core: { processCount: 2, rssBytes: mebibytes(400), cpuPercent: 3 },
      external: { processCount: 3, rssBytes: mebibytes(300), cpuPercent: 7 },
    },
    uiCoverage: { status: "available", message: Option.none() },
    processes: [...resourceProcesses],
    error: Option.none(),
    ...patch,
  };
}

function buildResourcePresentation(
  diagnostics: ServerProcessDiagnosticsResult | null,
  localCore: {
    readonly totals: ServerProcessResourceTotals;
    readonly uiCoverage: ServerProcessUiCoverage;
  } | null = null,
) {
  return buildResourceSummaryViewModel({
    diagnostics,
    localCore,
  });
}

describe("statusBarPresentation", () => {
  it("builds provider view models with remaining quota labels", () => {
    const vm = buildProviderUsageViewModel(providerSnapshot({}));

    expect(vm.provider).toBe("codex");
    expect(vm.status).toBe("ok");
    expect(vm.windows.map((window) => window.remainingLabel)).toEqual(["89%", "17%"]);
    expect(vm.compactLabel).toBe("89% 5h · 17% wk");
  });

  it("builds unavailable provider view models", () => {
    const vm = buildProviderUsageViewModel(
      providerSnapshot({
        status: "unavailable",
        session: null,
        weekly: null,
        error: "No auth",
      }),
    );

    expect(vm.compactLabel).toBe("--");
    expect(vm.error).toBe("No auth");
  });

  it("uses Combined for the headline and separates Core from External totals", () => {
    const vm = buildResourcePresentation(diagnosticsFixture());

    expect(vm.headline).toMatchObject({
      memoryLabel: "700.0 MB",
      cpuLabel: "10.0%",
      processCountLabel: "5",
    });
    expect(vm.core).toMatchObject({
      memoryLabel: "400.0 MB",
      cpuLabel: "3.0%",
      processCountLabel: "2",
    });
    expect(vm.external).toMatchObject({
      memoryLabel: "300.0 MB",
      cpuLabel: "7.0%",
      processCountLabel: "3",
    });
  });

  it("orders highest consumers by RSS and shows scope, memory, and CPU for every row", () => {
    const vm = buildResourcePresentation(diagnosticsFixture());

    expect(vm.consumers.map((consumer) => consumer.label)).toEqual([
      "T4Code Server",
      "Codex",
      "T4Code UI",
      "Build terminal",
      "Unattributed process",
    ]);
    expect(
      vm.consumers.map(({ scopeLabel, memoryLabel, cpuLabel }) => ({
        scopeLabel,
        memoryLabel,
        cpuLabel,
      })),
    ).toEqual([
      { scopeLabel: "Core", memoryLabel: "250.0 MB", cpuLabel: "2.0%" },
      { scopeLabel: "External", memoryLabel: "150.0 MB", cpuLabel: "4.0%" },
      { scopeLabel: "Core", memoryLabel: "150.0 MB", cpuLabel: "1.0%" },
      { scopeLabel: "External", memoryLabel: "100.0 MB", cpuLabel: "2.0%" },
      { scopeLabel: "External", memoryLabel: "50.0 MB", cpuLabel: "1.0%" },
    ]);
  });

  it("breaks equal-memory ties by label and then process key", () => {
    const tied = [
      processEntry({
        processKey: "3:1",
        pid: 3,
        scope: "external",
        kind: "helper",
        label: "Zulu",
      }),
      processEntry({
        processKey: "2:1",
        pid: 2,
        scope: "external",
        kind: "helper",
        label: "Alpha",
      }),
      processEntry({
        processKey: "1:1",
        pid: 1,
        scope: "external",
        kind: "helper",
        label: "Alpha",
      }),
    ];
    const vm = buildResourcePresentation(
      diagnosticsFixture({
        totals: {
          combined: { processCount: 3, rssBytes: mebibytes(150), cpuPercent: 3 },
          core: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
          external: { processCount: 3, rssBytes: mebibytes(150), cpuPercent: 3 },
        },
        processes: tied,
      }),
    );

    expect(vm.consumers.map((consumer) => consumer.processKey)).toEqual(["1:1", "2:1", "3:1"]);
  });

  it.each([
    ["partial", "Some UI processes could not be sampled."],
    ["unavailable", "UI process accounting is unavailable."],
  ] as const)("creates a warning for %s UI coverage", (status, message) => {
    const vm = buildResourcePresentation(
      diagnosticsFixture({
        uiCoverage: { status, message: Option.some(message) },
      }),
    );

    expect(vm.warning?.message).toContain(message);
  });

  it("does not warn when UI coverage is not applicable", () => {
    const vm = buildResourcePresentation(
      diagnosticsFixture({
        uiCoverage: { status: "notApplicable", message: Option.none() },
      }),
    );

    expect(vm.warning).toBeNull();
  });

  it("retains a stale last-good sample and reports the refresh failure", () => {
    const vm = buildResourcePresentation(
      diagnosticsFixture({
        error: Option.some({ message: "Process refresh timed out." }),
      }),
    );

    expect(vm.headline?.memoryLabel).toBe("700.0 MB");
    expect(vm.core?.memoryLabel).toBe("400.0 MB");
    expect(vm.external?.memoryLabel).toBe("300.0 MB");
    expect(vm.warning?.message).toContain("Showing the last successful sample.");
    expect(vm.warning?.message).toContain("Process refresh timed out.");
  });

  it("uses unavailable presentation instead of healthy zeroes without a good sample", () => {
    const vm = buildResourcePresentation(
      diagnosticsFixture({
        totals: {
          combined: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
          core: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
          external: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
        },
        processes: [],
        error: Option.some({ message: "No process sample is available." }),
      }),
    );

    expect(vm.headline).toBeNull();
    expect(vm.core).toBeNull();
    expect(vm.external).toBeNull();
    expect(vm.consumers).toEqual([]);
    expect(vm.warning?.message).toContain("No process sample is available.");
  });

  it("keeps local Core separate from the selected remote-host totals", () => {
    const vm = buildResourcePresentation(diagnosticsFixture(), {
      totals: { processCount: 2, rssBytes: mebibytes(900), cpuPercent: 12 },
      uiCoverage: {
        status: "unavailable",
        message: Option.some("This device UI usage is unavailable."),
      },
    });

    expect(vm.headline?.memoryLabel).toBe("700.0 MB");
    expect(vm.core?.memoryLabel).toBe("400.0 MB");
    expect(vm.external?.memoryLabel).toBe("300.0 MB");
    expect(vm.localCore).toMatchObject({
      memoryLabel: "900.0 MB",
      cpuLabel: "12.0%",
      processCountLabel: "2",
      coverageLabel: "UI unavailable",
    });
  });

  it("rejects selected-host totals that do not reconcile", () => {
    expect(() =>
      buildResourcePresentation(
        diagnosticsFixture({
          totals: {
            combined: { processCount: 99, rssBytes: mebibytes(700), cpuPercent: 10 },
            core: { processCount: 2, rssBytes: mebibytes(400), cpuPercent: 3 },
            external: { processCount: 3, rssBytes: mebibytes(300), cpuPercent: 7 },
          },
        }),
      ),
    ).toThrow(/reconcile/i);
  });
});
