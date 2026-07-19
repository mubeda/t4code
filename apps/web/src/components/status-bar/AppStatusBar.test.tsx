import type { ServerProcessDiagnosticsResult, ServerProviderUsageResult } from "@t4code/contracts";
import { EnvironmentId } from "@t4code/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AppStatusBarView,
  STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS,
  STATUS_BAR_USAGE_REFRESH_INTERVAL_MS,
  createStatusBarRefreshHandler,
  createStatusBarResourceRefreshHandler,
  startStatusBarUsageAutoRefresh,
} from "./AppStatusBar";

const readAt = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");

const usage: ServerProviderUsageResult = {
  readAt,
  isFetching: false,
  providers: [
    {
      provider: "claude",
      status: "ok",
      session: {
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null,
      },
      weekly: {
        usedPercent: 56,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null,
      },
      updatedAt: readAt,
      error: null,
      metadata: {},
    },
    {
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
      updatedAt: readAt,
      error: null,
      metadata: {},
    },
  ],
};

const diagnostics: ServerProcessDiagnosticsResult = {
  serverPid: 100,
  readAt,
  totals: {
    combined: { processCount: 2, rssBytes: 736_300_000, cpuPercent: 4.2 },
    core: { processCount: 1, rssBytes: 700_000_000, cpuPercent: 3.2 },
    external: { processCount: 1, rssBytes: 36_300_000, cpuPercent: 1 },
  },
  uiCoverage: { status: "notApplicable", message: Option.none() },
  processes: [],
  error: Option.none(),
};

describe("AppStatusBarView", () => {
  it("renders provider usage and resource summary labels", () => {
    const markup = renderToStaticMarkup(
      <AppStatusBarView
        usage={usage}
        diagnostics={diagnostics}
        terminalCount={11}
        resourceHistory={null}
        onRefresh={() => {}}
      />,
    );

    expect(markup).toContain("Claude");
    expect(markup).toContain("100% 5h");
    expect(markup).toContain("44% wk");
    expect(markup).toContain("Codex");
    expect(markup).toContain("89% 5h");
    expect(markup).toContain("17% wk");
    expect(markup).toContain("702.2 MB");
    expect(markup).toContain("11");
    expect(markup).toContain(
      'aria-label="T4Code native process resources, 702.2 MB, 11 terminals"',
    );
  });

  it("refreshes provider usage and every status-bar query", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue({ _tag: "Success" });
    const refreshUsageQuery = vi.fn();
    const refreshProcessDiagnostics = vi.fn();
    const refreshResourceHistory = vi.fn();
    const environmentId = EnvironmentId.make("environment-test");
    const handler = createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshUsageQuery,
      refreshProcessDiagnostics,
      refreshResourceHistory,
    });

    await handler();

    expect(refreshProviderUsage).toHaveBeenCalledWith({
      environmentId,
      input: { providers: ["claude", "codex"] },
    });
    expect(refreshUsageQuery).toHaveBeenCalledTimes(1);
    expect(refreshProcessDiagnostics).toHaveBeenCalledTimes(1);
    expect(refreshResourceHistory).toHaveBeenCalledTimes(1);
  });

  it("reads provider usage after the native refresh finishes", async () => {
    let finishProviderRefresh: () => void = () => {
      throw new Error("Provider refresh resolver was not initialized.");
    };
    const refreshProviderUsage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProviderRefresh = resolve;
        }),
    );
    const refreshUsageQuery = vi.fn();
    const handler = createStatusBarRefreshHandler({
      environmentId: EnvironmentId.make("environment-test"),
      refreshProviderUsage,
      refreshUsageQuery,
      refreshProcessDiagnostics: vi.fn(),
      refreshResourceHistory: vi.fn(),
    });

    const pending = handler();
    expect(refreshProviderUsage).toHaveBeenCalledTimes(1);
    expect(refreshUsageQuery).not.toHaveBeenCalled();

    finishProviderRefresh();
    await pending;
    expect(refreshUsageQuery).toHaveBeenCalledTimes(1);
  });

  it("refreshes resource queries even when provider refresh fails", async () => {
    const refreshUsageQuery = vi.fn();
    const refreshProcessDiagnostics = vi.fn();
    const refreshResourceHistory = vi.fn();
    const handler = createStatusBarRefreshHandler({
      environmentId: EnvironmentId.make("environment-test"),
      refreshProviderUsage: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      refreshUsageQuery,
      refreshProcessDiagnostics,
      refreshResourceHistory,
    });

    await expect(handler()).rejects.toThrow("provider unavailable");
    expect(refreshUsageQuery).toHaveBeenCalledTimes(1);
    expect(refreshProcessDiagnostics).toHaveBeenCalledTimes(1);
    expect(refreshResourceHistory).toHaveBeenCalledTimes(1);
  });

  it("builds an environment-scoped resource refresh handler", () => {
    const refreshProcessDiagnostics = vi.fn();
    const refreshResourceHistory = vi.fn();
    const handler = createStatusBarResourceRefreshHandler({
      environmentId: EnvironmentId.make("environment-test"),
      refreshProcessDiagnostics,
      refreshResourceHistory,
    });

    handler();

    expect(refreshProcessDiagnostics).toHaveBeenCalledTimes(1);
    expect(refreshResourceHistory).toHaveBeenCalledTimes(1);
  });
});

describe("startStatusBarUsageAutoRefresh", () => {
  it("refreshes immediately and every 30 seconds until cleanup", () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const cleanup = startStatusBarUsageAutoRefresh({ refresh });

      expect(refresh).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(STATUS_BAR_USAGE_REFRESH_INTERVAL_MS - 1);
      expect(refresh).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(STATUS_BAR_USAGE_REFRESH_INTERVAL_MS);
      expect(refresh).toHaveBeenCalledTimes(3);

      cleanup();
      vi.advanceTimersByTime(STATUS_BAR_USAGE_REFRESH_INTERVAL_MS);
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports the two-second resource refresh cadence", () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const cleanup = startStatusBarUsageAutoRefresh({
        refresh,
        intervalMs: STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS,
      });

      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(STATUS_BAR_RESOURCE_REFRESH_INTERVAL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});
