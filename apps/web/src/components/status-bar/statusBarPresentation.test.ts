import type {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistorySummary,
  ServerProviderUsageSnapshot,
} from "@t4code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderUsageViewModel,
  buildResourceSummaryViewModel,
  buildResourceTopProcessViewModel,
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

  it("summarizes child-process resources and terminal counts", () => {
    const diagnostics: ServerProcessDiagnosticsResult = {
      serverPid: 100,
      readAt: updatedAt,
      processCount: 2,
      totalRssBytes: 736_300_000,
      totalCpuPercent: 4.2,
      processes: [],
      error: Option.none(),
    };

    const vm = buildResourceSummaryViewModel({
      diagnostics,
      terminalCount: 11,
    });

    expect(vm.memoryLabel).toBe("702.2 MB");
    expect(vm.cpuLabel).toBe("4.2%");
    expect(vm.processCountLabel).toBe("2");
    expect(vm.terminalCountLabel).toBe("11");
  });

  it("formats top process rows with per-process CPU instead of aggregate CPU", () => {
    const vm = buildResourceTopProcessViewModel({
      processKey: "123:t4code server",
      pid: 123,
      ppid: 1,
      command: "t4code server",
      depth: 0,
      isServerRoot: true,
      firstSeenAt: updatedAt,
      lastSeenAt: updatedAt,
      currentCpuPercent: 1.2,
      avgCpuPercent: 1.2,
      maxCpuPercent: 9.9,
      cpuSecondsApprox: 0.06,
      currentRssBytes: 10_000,
      maxRssBytes: 10_000,
      sampleCount: 1,
    } satisfies ServerProcessResourceHistorySummary);

    expect(vm.command).toBe("t4code server");
    expect(vm.detailLabel).toBe("1.2% · 123");
  });
});
