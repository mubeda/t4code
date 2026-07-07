import type { ServerProcessDiagnosticsResult, ServerProviderUsageResult } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AppStatusBarView,
  STATUS_BAR_USAGE_REFRESH_INTERVAL_MS,
  createStatusBarRefreshHandler,
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
  processCount: 2,
  totalRssBytes: 736_300_000,
  totalCpuPercent: 4.2,
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
  });

  it("builds a refresh handler that refreshes provider usage and the query", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue({ _tag: "Success" });
    const refreshQuery = vi.fn();
    const environmentId = EnvironmentId.make("environment-test");
    const handler = createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshQuery,
    });

    await handler();

    expect(refreshProviderUsage).toHaveBeenCalledWith({
      environmentId,
      input: { providers: ["claude", "codex"] },
    });
    expect(refreshQuery).toHaveBeenCalledTimes(1);
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
});
