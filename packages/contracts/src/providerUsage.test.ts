import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  CodexRateLimitResetOutcome,
  ConsumeCodexRateLimitResetInput,
  ConsumeCodexRateLimitResetResult,
  ServerProviderUsageResetCredits,
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
} from "./providerUsage.ts";

const decodeProviderUsageSnapshot = Schema.decodeUnknownSync(ServerProviderUsageSnapshot);
const encodeProviderUsageSnapshot = Schema.encodeSync(ServerProviderUsageSnapshot);

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("provider usage contracts", () => {
  it("accepts Claude and Codex provider usage snapshots", () => {
    const resetAt = DateTime.makeUnsafe("2026-07-07T20:00:00.000Z");
    const updatedAt = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");

    expect(
      decodes(ServerProviderUsageResult, {
        readAt: updatedAt,
        isFetching: false,
        providers: [
          {
            provider: "claude",
            status: "ok",
            session: {
              usedPercent: 0,
              windowMinutes: 300,
              resetsAt: resetAt,
              resetDescription: "2h",
            },
            weekly: {
              usedPercent: 56,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null,
            },
            fableWeekly: {
              usedPercent: 12,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null,
            },
            planType: null,
            rateLimitResetCredits: null,
            updatedAt,
            error: null,
            metadata: {
              source: "oauth",
            },
          },
          {
            provider: "codex",
            status: "ok",
            session: {
              usedPercent: 11,
              windowMinutes: 300,
              resetsAt: resetAt,
              resetDescription: "2h",
            },
            weekly: {
              usedPercent: 83,
              windowMinutes: 10080,
              resetsAt: null,
              resetDescription: null,
            },
            fableWeekly: null,
            planType: "plus",
            rateLimitResetCredits: {
              availableCount: 2,
              totalEarnedCount: 5,
              nextExpiresAt: resetAt,
            },
            updatedAt,
            error: null,
            metadata: {},
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unsupported provider identifiers", () => {
    expect(
      decodes(ServerProviderUsageSnapshot, {
        provider: "gemini",
        status: "ok",
        session: null,
        weekly: null,
        fableWeekly: null,
        planType: null,
        rateLimitResetCredits: null,
        updatedAt: DateTime.makeUnsafe("2026-07-07T18:00:00.000Z"),
        error: null,
        metadata: {},
      }),
    ).toBe(false);
  });

  it("rejects negative window durations", () => {
    expect(
      decodes(ServerProviderUsageWindow, {
        usedPercent: 10,
        windowMinutes: -1,
        resetsAt: null,
        resetDescription: null,
      }),
    ).toBe(false);
  });

  it("decodes nullable provider extensions and non-negative Codex reset credits", () => {
    const expiresAt = DateTime.makeUnsafe("2026-07-08T18:00:00.000Z");

    expect(
      decodes(ServerProviderUsageResetCredits, {
        availableCount: 0,
        totalEarnedCount: null,
        nextExpiresAt: null,
      }),
    ).toBe(true);
    expect(
      decodes(ServerProviderUsageResetCredits, {
        availableCount: 1,
        totalEarnedCount: 3,
        nextExpiresAt: expiresAt,
      }),
    ).toBe(true);
    expect(
      decodes(ServerProviderUsageResetCredits, {
        availableCount: -1,
        totalEarnedCount: 3,
        nextExpiresAt: expiresAt,
      }),
    ).toBe(false);
    expect(
      decodes(ServerProviderUsageResetCredits, {
        availableCount: 1,
        totalEarnedCount: -1,
        nextExpiresAt: expiresAt,
      }),
    ).toBe(false);
  });

  it("defaults missing nullable provider extensions while encoding them explicitly", () => {
    const snapshot = {
      provider: "claude",
      status: "ok",
      session: null,
      weekly: null,
      updatedAt: DateTime.makeUnsafe("2026-07-07T18:00:00.000Z"),
      error: null,
      metadata: {},
    };

    expect(decodes(ServerProviderUsageSnapshot, snapshot)).toBe(true);
    const decoded = decodeProviderUsageSnapshot(snapshot);
    expect(decoded).toMatchObject({
      fableWeekly: null,
      planType: null,
      rateLimitResetCredits: null,
    });
    expect(encodeProviderUsageSnapshot(decoded)).toMatchObject({
      fableWeekly: null,
      planType: null,
      rateLimitResetCredits: null,
    });
  });

  it("decodes each Codex rate-limit reset outcome", () => {
    for (const outcome of ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]) {
      expect(decodes(CodexRateLimitResetOutcome, outcome)).toBe(true);
    }

    expect(decodes(CodexRateLimitResetOutcome, "unknown")).toBe(false);
    expect(decodes(ConsumeCodexRateLimitResetInput, { requestId: "request-123" })).toBe(true);
    expect(
      decodes(ConsumeCodexRateLimitResetResult, {
        outcome: "reset",
        usage: {
          readAt: DateTime.makeUnsafe("2026-07-07T18:00:00.000Z"),
          isFetching: false,
          providers: [],
        },
      }),
    ).toBe(true);
  });
});
