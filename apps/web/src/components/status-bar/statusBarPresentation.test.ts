import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistorySummary,
  ServerProcessResourceHistoryResult,
  ServerProviderUsageSnapshot,
} from "@t4code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderUsageViewModel,
  buildResourceSummaryViewModel,
  buildResourceTopProcessViewModel,
  selectCurrentTopProcesses,
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

  it("summarizes native process-tree resources and terminal counts", () => {
    const diagnostics: ServerProcessDiagnosticsResult = {
      serverPid: 100,
      readAt: updatedAt,
      totals: {
        combined: { processCount: 2, rssBytes: 736_300_000, cpuPercent: 4.2 },
        core: { processCount: 1, rssBytes: 700_000_000, cpuPercent: 3.2 },
        external: { processCount: 1, rssBytes: 36_300_000, cpuPercent: 1 },
      },
      uiCoverage: { status: "notApplicable", message: Option.none() },
      processes: [],
      error: Option.none(),
    };

    const vm = buildResourceSummaryViewModel({
      diagnostics,
      resourceHistory: null,
      terminalCount: 11,
    });

    expect(vm.memoryLabel).toBe("702.2 MB");
    expect(vm.cpuLabel).toBe("4.2%");
    expect(vm.processCountLabel).toBe("2");
    expect(vm.terminalCountLabel).toBe("11");
  });

  it("uses empty resource labels when no process data is available", () => {
    const vm = buildResourceSummaryViewModel({
      diagnostics: null,
      resourceHistory: null,
      terminalCount: -1,
    });

    expect(vm).toEqual({
      memoryLabel: "--",
      cpuLabel: "--",
      processCountLabel: "0",
      terminalCountLabel: "0",
    });
  });

  it("formats top process rows with per-process CPU instead of aggregate CPU", () => {
    const vm = buildResourceTopProcessViewModel({
      processKey: "123:100",
      pid: 123,
      ppid: 1,
      pgid: Option.none(),
      status: "Run",
      cpuPercent: 1.2,
      rssBytes: 10_000,
      elapsed: "00:00:01",
      command: "t4code server",
      depth: 0,
      childPids: [],
      scope: "core",
      kind: "server",
      label: "T4Code Server",
      confidence: "exact",
    } satisfies ServerProcessDiagnosticsEntry);

    expect(vm.command).toBe("t4code server");
    expect(vm.detailLabel).toBe("1.2% · 123");
  });

  it("orders temporary top rows from current live CPU with stable key ties", () => {
    const process = (
      pid: number,
      processKey: string,
      cpuPercent: number,
    ): ServerProcessDiagnosticsEntry => ({
      processKey,
      pid,
      ppid: 1,
      pgid: Option.none(),
      status: "Run",
      cpuPercent,
      rssBytes: 10_000,
      elapsed: "00:00:01",
      command: `process-${pid}`,
      depth: 0,
      childPids: [],
      scope: "external",
      kind: "provider",
      label: `Process ${pid}`,
      confidence: "exact",
    });

    expect(
      selectCurrentTopProcesses([
        process(1, "1:100", 1),
        process(3, "3:100", 5),
        process(2, "2:100", 5),
      ]).map((entry) => entry.processKey),
    ).toEqual(["2:100", "3:100", "1:100"]);
  });

  it("derives the compact summary strictly from current diagnostics", () => {
    const process = {
      processKey: "100:t4code.exe",
      pid: 100,
      ppid: 1,
      command: "exited-high-usage",
      depth: 0,
      scope: "core",
      kind: "server",
      label: "T4Code Server",
      confidence: "exact",
      firstSeenAt: updatedAt,
      lastSeenAt: updatedAt,
      currentCpuPercent: 99,
      avgCpuPercent: 99,
      maxCpuPercent: 99,
      cpuSecondsApprox: 100,
      currentRssBytes: 999_999_999,
      maxRssBytes: 999_999_999,
      sampleCount: 2,
    } satisfies ServerProcessResourceHistorySummary;
    const resourceHistory: ServerProcessResourceHistoryResult = {
      readAt: updatedAt,
      windowMs: 60_000,
      bucketMs: 10_000,
      sampleIntervalMs: 2_000,
      retainedSampleCount: 2,
      cpuSecondsApprox: { combined: 100, core: 100, external: 0 },
      uiCoverage: { status: "notApplicable", message: Option.none() },
      buckets: [],
      processes: [process],
      error: Option.none(),
    };

    const vm = buildResourceSummaryViewModel({
      diagnostics: {
        serverPid: 100,
        readAt: updatedAt,
        totals: {
          combined: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
          core: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
          external: { processCount: 0, rssBytes: 0, cpuPercent: 0 },
        },
        uiCoverage: { status: "notApplicable", message: Option.none() },
        processes: [],
        error: Option.none(),
      },
      resourceHistory,
      terminalCount: 0,
    });

    expect(vm.memoryLabel).toBe("0 B");
    expect(vm.cpuLabel).toBe("0.0%");
    expect(vm.processCountLabel).toBe("0");
  });
});
