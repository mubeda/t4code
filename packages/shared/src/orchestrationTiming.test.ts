import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  formatDuration,
  formatElapsed,
  isLatestTurnSettled,
} from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it("normalizes invalid and negative durations", () => {
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
    expect(formatDuration(-1)).toBe("0ms");
  });

  it("formats millisecond and second boundaries", () => {
    expect(formatDuration(0)).toBe("1ms");
    expect(formatDuration(1.4)).toBe("1ms");
    expect(formatDuration(999.6)).toBe("1000ms");
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(9_999)).toBe("10.0s");
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(59_999)).toBe("60s");
  });

  it("formats minute boundaries without redundant seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(119_999)).toBe("2m");
  });
});

describe("formatElapsed", () => {
  it("returns null when either timestamp cannot define a valid interval", () => {
    expect(formatElapsed("2026-01-01T00:00:00Z", undefined)).toBeNull();
    expect(formatElapsed("invalid", "2026-01-01T00:00:01Z")).toBeNull();
    expect(formatElapsed("2026-01-01T00:00:00Z", "invalid")).toBeNull();
    expect(formatElapsed("2026-01-01T00:00:01Z", "2026-01-01T00:00:00Z")).toBeNull();
  });

  it("formats a valid elapsed interval", () => {
    expect(formatElapsed("2026-01-01T00:00:00Z", "2026-01-01T00:00:01.250Z")).toBe("1.3s");
  });
});

describe("latest turn activity", () => {
  const completedTurn = {
    turnId: "turn-1",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
  };

  it("requires a started and completed latest turn", () => {
    expect(isLatestTurnSettled(null, null)).toBe(false);
    expect(isLatestTurnSettled({ ...completedTurn, startedAt: null }, null)).toBe(false);
    expect(isLatestTurnSettled({ ...completedTurn, completedAt: null }, null)).toBe(false);
  });

  it("treats a completed turn as settled unless orchestration is running", () => {
    expect(isLatestTurnSettled(completedTurn, null)).toBe(true);
    expect(isLatestTurnSettled(completedTurn, { orchestrationStatus: "running" })).toBe(false);
    expect(isLatestTurnSettled(completedTurn, { orchestrationStatus: "idle" })).toBe(true);
  });

  it("derives the active start from the unsettled turn before the send fallback", () => {
    expect(deriveActiveWorkStartedAt({ ...completedTurn, completedAt: null }, null, "send")).toBe(
      completedTurn.startedAt,
    );
    expect(deriveActiveWorkStartedAt(null, null, "send")).toBe("send");
    expect(deriveActiveWorkStartedAt(completedTurn, null, "send")).toBe("send");
  });
});
