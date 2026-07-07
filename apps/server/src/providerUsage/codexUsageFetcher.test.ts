// @effect-diagnostics preferSchemaOverJson:off - Tests use raw JSON-RPC lines to model the Codex app-server protocol.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  fetchCodexUsageSnapshotWithDependencies,
  mapCodexRateLimitsResponse,
} from "./codexUsageFetcher.ts";

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

  it("uses stable 5h and weekly labels even when Codex reports remaining minutes", () => {
    const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
    const result = mapCodexRateLimitsResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 6,
            windowDurationMins: 42,
          },
          secondary: {
            usedPercent: 12,
            windowDurationMins: 4_321,
          },
        },
      },
      now,
    );

    expect(result.session?.windowMinutes).toBe(300);
    expect(result.weekly?.windowMinutes).toBe(10080);
  });
});

describe("fetchCodexUsageSnapshotWithDependencies", () => {
  it.effect("reads rate limits from the Codex app-server RPC", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
      const writtenMessages: string[] = [];
      const result = yield* fetchCodexUsageSnapshotWithDependencies({
        now,
        authExists: Effect.succeed(true),
        startAppServer: () =>
          Effect.succeed({
            write: (line) =>
              Effect.sync(() => {
                writtenMessages.push(line);
              }),
            readLine: Effect.sync(() => {
              if (writtenMessages.length === 1) {
                return JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: { userAgent: "codex-test/1.0.0" },
                });
              }
              return JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  rateLimits: {
                    primary: { usedPercent: 6, resetsAt: 1_783_448_000 },
                    secondary: { usedPercent: 88, resetsAt: 1_783_880_000 },
                  },
                },
              });
            }),
            close: Effect.void,
          }),
      });

      expect(result.status).toBe("ok");
      expect(result.session?.usedPercent).toBe(6);
      expect(result.weekly?.usedPercent).toBe(88);
      expect(writtenMessages.some((line) => line.includes('"method":"initialized"'))).toBe(true);
      expect(writtenMessages.some((line) => line.includes('"account/rateLimits/read"'))).toBe(true);
    }),
  );
});
