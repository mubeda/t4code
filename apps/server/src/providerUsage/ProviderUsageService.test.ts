import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  makeProviderUsageService,
  MIN_MANUAL_REFRESH_MS,
  STALE_THRESHOLD_MS,
  type ProviderUsageFetcher,
} from "./ProviderUsageService.ts";

function snapshot(input: {
  readonly provider: "claude" | "codex";
  readonly status?: ServerProviderUsageSnapshot["status"];
  readonly updatedAt: DateTime.Utc;
  readonly error?: string | null;
}): ServerProviderUsageSnapshot {
  return {
    provider: input.provider,
    status: input.status ?? "ok",
    session: null,
    weekly: null,
    updatedAt: input.updatedAt,
    error: input.error ?? null,
    metadata: {},
  };
}

describe("ProviderUsageService", () => {
  it.effect("returns unavailable snapshots before any provider fetch succeeds", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
      const service = yield* makeProviderUsageService({
        fetchers: [],
        now: Effect.succeed(now),
      });

      const result = yield* service.read;

      expect(result.isFetching).toBe(false);
      expect(result.providers.map((provider) => provider.provider)).toEqual(["claude", "codex"]);
      expect(result.providers.every((provider) => provider.status === "unavailable")).toBe(true);
    }),
  );

  it.effect("normalizes provider fetch failures into error snapshots", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
      const fetcher: ProviderUsageFetcher = {
        provider: "codex",
        fetch: Effect.fail(new Error("codex auth missing")),
      };
      const service = yield* makeProviderUsageService({
        fetchers: [fetcher],
        now: Effect.succeed(now),
      });

      const result = yield* service.refresh({ providers: ["codex"] });
      const codex = result.providers.find((provider) => provider.provider === "codex");

      expect(codex?.status).toBe("error");
      expect(codex?.error).toContain("codex auth missing");
    }),
  );

  it.effect("returns the existing snapshot when manual refresh is debounced", () =>
    Effect.gen(function* () {
      const nowRef = yield* Ref.make(DateTime.makeUnsafe("2026-07-07T18:00:00.000Z"));
      const calls = yield* Ref.make(0);
      const fetcher: ProviderUsageFetcher = {
        provider: "codex",
        fetch: Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) => Ref.get(nowRef).pipe(Effect.map((now) => ({ count, now })))),
          Effect.map(({ count, now }) =>
            snapshot({
              provider: "codex",
              updatedAt: now,
              error: `fetch-${count}`,
            }),
          ),
        ),
      };
      const service = yield* makeProviderUsageService({
        fetchers: [fetcher],
        now: Ref.get(nowRef),
      });

      yield* service.refresh({ providers: ["codex"] });
      yield* Ref.set(
        nowRef,
        DateTime.makeUnsafe(18 * 60 * 60 * 1_000 + MIN_MANUAL_REFRESH_MS - 1),
      );
      const result = yield* service.refresh({ providers: ["codex"] });

      expect(yield* Ref.get(calls)).toBe(1);
      expect(result.providers.find((provider) => provider.provider === "codex")?.error).toBe(
        "fetch-1",
      );
    }),
  );

  it.effect("marks old successful snapshots as unavailable on read", () =>
    Effect.gen(function* () {
      const first = DateTime.makeUnsafe("2026-07-07T18:00:00.000Z");
      const staleRead = DateTime.makeUnsafe(
        DateTime.toEpochMillis(first) + STALE_THRESHOLD_MS + 1,
      );
      const nowRef = yield* Ref.make(first);
      const fetcher: ProviderUsageFetcher = {
        provider: "claude",
        fetch: Ref.get(nowRef).pipe(
          Effect.map((now) =>
            snapshot({
              provider: "claude",
              updatedAt: now,
            }),
          ),
        ),
      };
      const service = yield* makeProviderUsageService({
        fetchers: [fetcher],
        now: Ref.get(nowRef),
      });

      yield* service.refresh({ providers: ["claude"] });
      yield* Ref.set(nowRef, staleRead);
      const result = yield* service.read;
      const claude = result.providers.find((provider) => provider.provider === "claude");

      expect(claude?.status).toBe("unavailable");
      expect(claude?.error).toBe("Provider usage snapshot is stale.");
    }),
  );
});
