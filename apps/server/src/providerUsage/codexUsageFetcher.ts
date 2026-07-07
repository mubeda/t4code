import type { ServerProviderUsageSnapshot, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

interface RpcRateWindow {
  readonly usedPercent?: unknown;
  readonly windowDurationMins?: unknown;
  readonly resetsAt?: unknown;
}

interface CodexRateLimitsResponse {
  readonly rateLimits?: {
    readonly primary?: RpcRateWindow;
    readonly secondary?: RpcRateWindow;
  };
}

function parseResetTimestamp(value: unknown): DateTime.Utc | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return DateTime.makeUnsafe(value < 10_000_000_000 ? value * 1_000 : value);
}

function mapRateWindow(window: RpcRateWindow | undefined): ServerProviderUsageWindow | null {
  if (!window) return null;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  if (
    typeof window.windowDurationMins !== "number" ||
    !Number.isFinite(window.windowDurationMins) ||
    window.windowDurationMins < 0
  ) {
    return null;
  }
  return {
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    windowMinutes: Math.floor(window.windowDurationMins),
    resetsAt: parseResetTimestamp(window.resetsAt),
    resetDescription: null,
  };
}

export function mapCodexRateLimitsResponse(
  raw: CodexRateLimitsResponse,
  now: DateTime.Utc,
): ServerProviderUsageSnapshot {
  const session = mapRateWindow(raw.rateLimits?.primary);
  const weekly = mapRateWindow(raw.rateLimits?.secondary);
  if (!session && !weekly) {
    return {
      provider: "codex",
      status: "unavailable",
      session: null,
      weekly: null,
      updatedAt: now,
      error: "Codex did not report rate-limit windows.",
      metadata: {},
    };
  }

  return {
    provider: "codex",
    status: "ok",
    session,
    weekly,
    updatedAt: now,
    error: null,
    metadata: {
      source: "app-server",
    },
  };
}

export const fetchCodexUsageSnapshot = DateTime.now.pipe(
  Effect.map((now) =>
    mapCodexRateLimitsResponse(
      {
        rateLimits: {},
      },
      now,
    ),
  ),
);
