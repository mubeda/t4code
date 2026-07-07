// @effect-diagnostics preferSchemaOverJson:off - Tests use compact JSON strings to model Claude's credentials file.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  fetchClaudeUsageSnapshotWithDependencies,
  mapClaudeOAuthUsageResponse,
  parseClaudeOAuthCredentials,
} from "./claudeUsageFetcher.ts";

describe("mapClaudeOAuthUsageResponse", () => {
  it("maps Claude OAuth usage windows to provider usage", () => {
    const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
    const result = mapClaudeOAuthUsageResponse(
      {
        five_hour: {
          utilization: 100,
          resets_at: "2026-07-07T22:00:00.000Z",
        },
        seven_day: {
          used_percentage: 2,
          resets_at: 1_783_880_000,
        },
      },
      now,
    );

    expect(result.status).toBe("ok");
    expect(result.session?.usedPercent).toBe(100);
    expect(result.session?.windowMinutes).toBe(300);
    expect(result.weekly?.usedPercent).toBe(2);
    expect(result.weekly?.windowMinutes).toBe(10080);
    expect(result.metadata.source).toBe("oauth");
  });
});

describe("parseClaudeOAuthCredentials", () => {
  it("reads Claude Code OAuth access tokens from the credentials file", () => {
    expect(
      parseClaudeOAuthCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "access-token",
            refreshToken: "refresh-token",
          },
        }),
      ),
    ).toEqual({
      accessToken: "access-token",
      source: "credentials-file",
    });
  });
});

describe("fetchClaudeUsageSnapshotWithDependencies", () => {
  it.effect("fetches Claude OAuth usage with the local credentials token", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
      const seenHeaders: Record<string, string> = {};
      const result = yield* fetchClaudeUsageSnapshotWithDependencies({
        now,
        readCredentials: Effect.succeed(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "test-token",
            },
          }),
        ),
        fetchJson: (url, init) => {
          expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
          for (const [key, value] of Object.entries(init.headers ?? {})) {
            seenHeaders[key] = String(value);
          }
          return Effect.succeed({
            ok: true,
            status: 200,
            json: {
              five_hour: { utilization: 25 },
              seven_day: { utilization: 60 },
            },
          });
        },
      });

      expect(seenHeaders.Authorization).toBe("Bearer test-token");
      expect(result.status).toBe("ok");
      expect(result.session?.usedPercent).toBe(25);
      expect(result.weekly?.usedPercent).toBe(60);
    }),
  );
});
