import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { mapCodexRateLimitsResponse } from "./codexUsageFetcher.ts";

describe("mapCodexRateLimitsResponse", () => {
  it("maps primary and secondary rate-limit windows to session and weekly usage", () => {
    const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
    const result = mapCodexRateLimitsResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 11,
            windowDurationMins: 300,
            resetsAt: 1_783_448_000,
          },
          secondary: {
            usedPercent: 83,
            windowDurationMins: 10080,
            resetsAt: 1_783_880_000,
          },
        },
      },
      now,
    );

    expect(result.status).toBe("ok");
    expect(result.session?.usedPercent).toBe(11);
    expect(result.session?.windowMinutes).toBe(300);
    expect(result.weekly?.usedPercent).toBe(83);
    expect(result.weekly?.windowMinutes).toBe(10080);
  });

  it("returns unavailable when no rate-limit windows are present", () => {
    const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
    const result = mapCodexRateLimitsResponse({}, now);

    expect(result.status).toBe("unavailable");
    expect(result.session).toBeNull();
    expect(result.weekly).toBeNull();
  });
});
