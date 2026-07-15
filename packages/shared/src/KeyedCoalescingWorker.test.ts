import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  it.effect("processes undefined values instead of treating them as missing work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: Array<undefined> = [];
        const worker = yield* makeKeyedCoalescingWorker<string, undefined, never, never>({
          merge: (_current, next) => next,
          process: (_key, value) => Effect.sync(() => processed.push(value)).pipe(Effect.asVoid),
        });

        const completion = yield* worker
          .enqueue("terminal-1", undefined)
          .pipe(
            Effect.andThen(worker.drainKey("terminal-1")),
            Effect.timeoutOption("1 second"),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* TestClock.adjust("1 second");

        expect(Option.isSome(yield* Fiber.join(completion))).toBe(true);
        expect(processed).toEqual([undefined]);
      }),
    ),
  );

  it.live("processes a null value queued while the key is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: Array<string | null> = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string | null, never, never>({
          merge: (_current, next) => next,
          process: (_key, value) =>
            Effect.gen(function* () {
              processed.push(value);
              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", null);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["first", null]);
      }),
    ),
  );

  it.live("processes a first enqueue and drains an idle key immediately", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.sync(() => processed.push(`${key}:${value}`)).pipe(Effect.asVoid),
        });

        yield* worker.drainKey("idle");
        yield* worker.enqueue("terminal-1", "first");
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first"]);
      }),
    ),
  );

  it.live("coalesces queued values before processing the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const merged: Array<readonly [string, string]> = [];
        const blockerStarted = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const targetProcessed = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (current, next) => {
            merged.push([current, next]);
            return `${current}+${next}`;
          },
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (key === "blocker") {
                yield* Deferred.succeed(blockerStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocker);
              } else {
                yield* Deferred.succeed(targetProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("blocker", "hold");
        yield* Deferred.await(blockerStarted);
        yield* worker.enqueue("target", "one");
        yield* worker.enqueue("target", "two");
        yield* Deferred.succeed(releaseBlocker, undefined);
        yield* Deferred.await(targetProcessed);
        yield* worker.drainKey("target");

        expect(merged).toEqual([["one", "two"]]);
        expect(processed).toEqual(["blocker:hold", "target:one+two"]);
      }),
    ),
  );

  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const latestStarted = yield* Deferred.make<void>();
        const releaseLatest = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (current, next) => `${current}+${next}`,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second+third") {
                yield* Deferred.succeed(latestStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseLatest);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        yield* worker.enqueue("terminal-1", "third");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(latestStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseLatest, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second+third"]);
      }),
    ),
  );

  it.live("tracks queued and idle keys independently when draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();
        const secondDrained = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key) =>
            key === "first"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.orDie,
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie, Effect.asVoid),
        });

        yield* worker.enqueue("first", "one");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("second", "two");
        yield* worker
          .drainKey("second")
          .pipe(
            Effect.andThen(Deferred.succeed(secondDrained, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );

        yield* worker.drainKey("idle");
        expect(yield* Deferred.isDone(secondDrained)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondProcessed);
        yield* Deferred.await(secondDrained);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                return yield* Effect.fail("boom");
              }

              if (value === "second") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.effect("recovers when process throws before returning an Effect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const brokenInvoked = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) => {
            processed.push(`${key}:${value}`);
            if (key === "broken") {
              Deferred.doneUnsafe(brokenInvoked, Effect.void);
              throw new Error("process construction failed");
            }
            return Effect.void;
          },
        });

        yield* worker.enqueue("broken", "first");
        yield* Deferred.await(brokenInvoked);
        yield* Effect.yieldNow;

        const completion = yield* Effect.gen(function* () {
          yield* worker.drainKey("broken");
          yield* worker.enqueue("healthy", "second");
          yield* worker.drainKey("healthy");
        }).pipe(Effect.timeoutOption("1 second"), Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");

        expect(Option.isSome(yield* Fiber.join(completion))).toBe(true);
        expect(processed).toEqual(["broken:first", "healthy:second"]);
      }),
    ),
  );

  it.effect("recovers when a recursively coalesced process invocation throws synchronously", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const recursiveInvoked = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) => {
            processed.push(`${key}:${value}`);
            if (value === "second") {
              Deferred.doneUnsafe(recursiveInvoked, Effect.void);
              throw new Error("recursive process construction failed");
            }
            return value === "first"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.orDie,
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void;
          },
        });

        yield* worker.enqueue("recursive", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("recursive", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(recursiveInvoked);
        yield* Effect.yieldNow;

        const completion = yield* Effect.gen(function* () {
          yield* worker.drainKey("recursive");
          yield* worker.enqueue("healthy", "third");
          yield* worker.drainKey("healthy");
        }).pipe(Effect.timeoutOption("1 second"), Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");

        expect(Option.isSome(yield* Fiber.join(completion))).toBe(true);
        expect(processed).toEqual(["recursive:first", "recursive:second", "healthy:third"]);
      }),
    ),
  );

  it.live("cleans up a failed key with no pending value and continues with other keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const secondProcessed = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) => {
            processed.push(`${key}:${value}`);
            return key === "failed"
              ? Effect.fail("boom")
              : Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie, Effect.asVoid);
          },
        });

        yield* worker.enqueue("failed", "first");
        yield* worker.enqueue("healthy", "second");
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("failed");
        yield* worker.drainKey("healthy");

        expect(processed).toEqual(["failed:first", "healthy:second"]);
      }),
    ),
  );

  it.live("retains queued work when merge throws and keeps the worker usable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const blockerStarted = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const targetProcessed = yield* Deferred.make<void>();
        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: () => {
            throw new Error("merge failed");
          },
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);
              if (key === "blocker") {
                yield* Deferred.succeed(blockerStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseBlocker);
              } else {
                yield* Deferred.succeed(targetProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("blocker", "hold");
        yield* Deferred.await(blockerStarted);
        yield* worker.enqueue("target", "one");
        const mergeExit = yield* Effect.exit(worker.enqueue("target", "two"));

        expect(Exit.isFailure(mergeExit)).toBe(true);

        yield* Deferred.succeed(releaseBlocker, undefined);
        yield* Deferred.await(targetProcessed);
        yield* worker.drainKey("target");

        expect(processed).toEqual(["blocker:hold", "target:one"]);
      }),
    ),
  );

  it.live("interrupts active processing when its scope closes", () =>
    Effect.gen(function* () {
      const processStarted = yield* Deferred.make<void>();
      const processInterrupted = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
        merge: (_current, next) => next,
        process: () =>
          Deferred.succeed(processStarted, undefined).pipe(
            Effect.orDie,
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(processInterrupted, undefined).pipe(Effect.orDie),
            ),
          ),
      }).pipe(Effect.provideService(Scope.Scope, scope));

      yield* worker.enqueue("terminal-1", "first");
      yield* Deferred.await(processStarted);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(processInterrupted);
    }),
  );
});
