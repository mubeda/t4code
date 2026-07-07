import type {
  ServerProviderUsageProvider,
  ServerProviderUsageRefreshInput,
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { fetchClaudeUsageSnapshot } from "./claudeUsageFetcher.ts";
import { fetchCodexUsageSnapshot } from "./codexUsageFetcher.ts";

export const MIN_MANUAL_REFRESH_MS = 30_000;
export const STALE_THRESHOLD_MS = 30 * 60_000;

const PROVIDERS: readonly ServerProviderUsageProvider[] = ["claude", "codex"];

export interface ProviderUsageFetcher {
  readonly provider: ServerProviderUsageProvider;
  readonly fetch: Effect.Effect<ServerProviderUsageSnapshot, unknown>;
}

interface ProviderUsageState {
  readonly snapshots: ReadonlyMap<ServerProviderUsageProvider, ServerProviderUsageSnapshot>;
  readonly isFetching: boolean;
  readonly lastRefreshStartedAtMs: number | null;
  readonly inFlight: Deferred.Deferred<void> | null;
}

export class ProviderUsageService extends Context.Service<
  ProviderUsageService,
  {
    readonly read: Effect.Effect<ServerProviderUsageResult>;
    readonly refresh: (
      input: ServerProviderUsageRefreshInput,
    ) => Effect.Effect<ServerProviderUsageResult>;
  }
>()("t3/providerUsage/ProviderUsageService") {}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableSnapshot(
  provider: ServerProviderUsageProvider,
  now: DateTime.Utc,
  error: string,
): ServerProviderUsageSnapshot {
  return {
    provider,
    status: "unavailable",
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    metadata: {},
  };
}

function errorSnapshot(
  provider: ServerProviderUsageProvider,
  now: DateTime.Utc,
  error: unknown,
): ServerProviderUsageSnapshot {
  return {
    provider,
    status: "error",
    session: null,
    weekly: null,
    updatedAt: now,
    error: toErrorMessage(error),
    metadata: {},
  };
}

function normalizeProviders(input: ServerProviderUsageRefreshInput): readonly ServerProviderUsageProvider[] {
  return input.providers?.length ? input.providers : PROVIDERS;
}

function applyStaleness(
  snapshot: ServerProviderUsageSnapshot,
  now: DateTime.Utc,
): ServerProviderUsageSnapshot {
  if (snapshot.status !== "ok") return snapshot;
  const ageMs = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(snapshot.updatedAt);
  if (ageMs <= STALE_THRESHOLD_MS) return snapshot;
  return unavailableSnapshot(snapshot.provider, snapshot.updatedAt, "Provider usage snapshot is stale.");
}

export const makeProviderUsageService = (input: {
  readonly fetchers: ReadonlyArray<ProviderUsageFetcher>;
  readonly now?: Effect.Effect<DateTime.Utc>;
}) =>
  Effect.gen(function* () {
    const nowEffect = input.now ?? DateTime.now;
    const fetchers = new Map(input.fetchers.map((fetcher) => [fetcher.provider, fetcher]));
    const state = yield* Ref.make<ProviderUsageState>({
      snapshots: new Map(),
      isFetching: false,
      lastRefreshStartedAtMs: null,
      inFlight: null,
    });

    const read = Effect.gen(function* () {
      const now = yield* nowEffect;
      const current = yield* Ref.get(state);
      return {
        readAt: now,
        isFetching: current.isFetching,
        providers: PROVIDERS.map((provider) =>
          applyStaleness(
            current.snapshots.get(provider) ??
              unavailableSnapshot(provider, now, "Provider usage has not been fetched yet."),
            now,
          ),
        ),
      } satisfies ServerProviderUsageResult;
    });

    const refresh: ProviderUsageService["Service"]["refresh"] = (refreshInput) =>
      Effect.gen(function* () {
        const now = yield* nowEffect;
        const nowMs = DateTime.toEpochMillis(now);
        const nextDeferred = yield* Deferred.make<void>();
        const decision = yield* Ref.modify(state, (current) => {
          if (current.inFlight) {
            return [{ type: "await" as const, deferred: current.inFlight }, current];
          }
          if (
            current.lastRefreshStartedAtMs !== null &&
            nowMs - current.lastRefreshStartedAtMs < MIN_MANUAL_REFRESH_MS
          ) {
            return [{ type: "debounced" as const }, current];
          }
          return [
            { type: "start" as const, deferred: nextDeferred },
            {
              ...current,
              isFetching: true,
              lastRefreshStartedAtMs: nowMs,
              inFlight: nextDeferred,
            },
          ];
        });

        if (decision.type === "await") {
          yield* Deferred.await(decision.deferred);
          return yield* read;
        }
        if (decision.type === "debounced") {
          return yield* read;
        }

        const selectedProviders = normalizeProviders(refreshInput);
        const fetched = yield* Effect.forEach(
          selectedProviders,
          (provider) => {
            const fetcher = fetchers.get(provider);
            if (!fetcher) {
              return nowEffect.pipe(
                Effect.map((readAt) =>
                  unavailableSnapshot(provider, readAt, "Provider usage fetcher is unavailable."),
                ),
              );
            }
            return fetcher.fetch.pipe(
              Effect.catch((error) =>
                nowEffect.pipe(Effect.map((readAt) => errorSnapshot(provider, readAt, error))),
              ),
            );
          },
          { concurrency: "unbounded" },
        );

        yield* Ref.update(state, (current) => {
          const snapshots = new Map(current.snapshots);
          for (const snapshot of fetched) {
            snapshots.set(snapshot.provider, snapshot);
          }
          return {
            ...current,
            snapshots,
            isFetching: false,
            inFlight: null,
          };
        });
        yield* Deferred.succeed(decision.deferred, undefined);
        return yield* read;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            yield* Effect.forEach(
              current.inFlight ? [current.inFlight] : [],
              (deferred) => Deferred.succeed(deferred, undefined),
              { discard: true },
            );
            yield* Ref.update(state, (currentState) => ({
              ...currentState,
              isFetching: false,
              inFlight: null,
            }));
            return yield* Effect.fail(error);
          }),
        ),
      );

    return ProviderUsageService.of({ read, refresh });
  });

export const make = makeProviderUsageService({
  fetchers: [
    {
      provider: "claude",
      fetch: fetchClaudeUsageSnapshot,
    },
    {
      provider: "codex",
      fetch: fetchCodexUsageSnapshot,
    },
  ],
});

export const layer = Layer.effect(ProviderUsageService, make);
