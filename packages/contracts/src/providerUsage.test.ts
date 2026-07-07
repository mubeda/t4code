import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
  ServerProviderUsageWindow,
} from "./providerUsage.ts";

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
});
