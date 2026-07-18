import { describe, expect, it } from "@effect/vitest";

import {
  createTerminalInputScheduler,
  createTerminalInputSchedulerRegistry,
  DEFAULT_MAX_INPUT_FRAME_LENGTH,
  terminalInputKey,
} from "./terminalInput.ts";

interface Deferred {
  readonly promise: Promise<{ ok: boolean; error?: unknown }>;
  resolveOk(): void;
  rejectWith(error: unknown): void;
  resolveFail(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (value: { ok: boolean; error?: unknown }) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<{ ok: boolean; error?: unknown }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolveOk: () => resolve({ ok: true }),
    resolveFail: (error) => resolve({ ok: false, error }),
    rejectWith: (error) => reject(error),
  };
}

const flush = () => Promise.resolve();

describe("createTerminalInputScheduler", () => {
  it("coalesces same-turn input into a single write via a microtask", async () => {
    const sent: string[] = [];
    const scheduler = createTerminalInputScheduler({
      send: async (data) => {
        sent.push(data);
        return { ok: true };
      },
    });
    scheduler.enqueue("a");
    scheduler.enqueue("b");
    scheduler.enqueue("c");
    expect(sent).toEqual([]);
    await flush();
    await flush();
    expect(sent).toEqual(["abc"]);
  });

  it("keeps at most one write in flight and concatenates input queued during it (C3)", async () => {
    const sent: string[] = [];
    const gate = deferred();
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      send: async (data) => {
        sent.push(data);
        call += 1;
        if (call === 1) return gate.promise;
        return { ok: true };
      },
    });
    scheduler.enqueue("1");
    await flush();
    await flush();
    expect(sent).toEqual(["1"]);
    scheduler.enqueue("2");
    scheduler.enqueue("3");
    await flush();
    expect(sent).toEqual(["1"]);
    gate.resolveOk();
    await flush();
    await flush();
    expect(sent).toEqual(["1", "23"]);
  });

  it("splits payloads longer than maxFrameLength at surrogate-safe boundaries", async () => {
    const sent: string[] = [];
    const scheduler = createTerminalInputScheduler({
      maxFrameLength: 4,
      send: async (data) => {
        sent.push(data);
        return { ok: true };
      },
    });
    scheduler.enqueue("😀😀😀");
    await flush();
    await flush();
    await flush();
    expect(sent.join("")).toBe("😀😀😀");
    for (const frame of sent) {
      expect(frame.length).toBeLessThanOrEqual(4);
      const last = frame.charCodeAt(frame.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("makes progress when a one-unit frame starts with a surrogate pair", async () => {
    const sent: string[] = [];
    const scheduler = createTerminalInputScheduler({
      maxFrameLength: 1,
      send: async (data) => {
        sent.push(data);
        return { ok: true };
      },
    });
    scheduler.enqueue("😀x");
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["😀", "x"]);
  });

  it("moves a split surrogate pair into the next multi-unit frame", async () => {
    const sent: string[] = [];
    const scheduler = createTerminalInputScheduler({
      maxFrameLength: 3,
      send: async (data) => {
        sent.push(data);
        return { ok: true };
      },
    });
    scheduler.enqueue("ab😀c");
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["ab", "😀c"]);
  });

  it("falls back to the default for non-finite frame lengths", async () => {
    for (const maxFrameLength of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const sent: string[] = [];
      const scheduler = createTerminalInputScheduler({
        maxFrameLength,
        send: async (data) => {
          sent.push(data);
          return { ok: true };
        },
      });
      scheduler.enqueue("x".repeat(DEFAULT_MAX_INPUT_FRAME_LENGTH + 1));
      await flush();
      await flush();
      await flush();
      expect(sent.map((frame) => frame.length)).toEqual([DEFAULT_MAX_INPUT_FRAME_LENGTH, 1]);
    }
  });

  it("discards the failed payload and all dependent pending input, never replaying (C3, invariant 5)", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const gate = deferred();
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      onWriteError: (error) => errors.push(error),
      send: async (data) => {
        sent.push(data);
        call += 1;
        if (call === 1) return gate.promise;
        return { ok: true };
      },
    });
    scheduler.enqueue("rm -rf ");
    await flush();
    await flush();
    scheduler.enqueue("important");
    gate.resolveFail(new Error("write failed"));
    await flush();
    await flush();
    expect(sent).toEqual(["rm -rf "]);
    expect(errors).toHaveLength(1);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("treats a thrown send as a failure that clears dependent input", async () => {
    const errors: unknown[] = [];
    const scheduler = createTerminalInputScheduler({
      onWriteError: (error) => errors.push(error),
      send: async () => {
        throw new Error("boom");
      },
    });
    scheduler.enqueue("x");
    scheduler.enqueue("y");
    await flush();
    await flush();
    expect(errors).toHaveLength(1);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("ignores a stale successful write after reset and drains the new generation", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const gate = deferred();
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      onWriteError: (error) => errors.push(error),
      send: async (data) => {
        sent.push(data);
        call += 1;
        if (call === 1) return gate.promise;
        return { ok: true };
      },
    });
    scheduler.enqueue("old");
    await flush();
    await flush();
    scheduler.reset();
    scheduler.enqueue("new");
    await flush();
    expect(sent).toEqual(["old"]);
    gate.resolveOk();
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["old", "new"]);
    expect(errors).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("ignores a stale failed write after reset without clearing the new generation", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const gate = deferred();
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      onWriteError: (error) => errors.push(error),
      send: async (data) => {
        sent.push(data);
        call += 1;
        if (call === 1) return gate.promise;
        return { ok: true };
      },
    });
    scheduler.enqueue("old");
    await flush();
    await flush();
    scheduler.reset();
    scheduler.enqueue("new");
    await flush();
    expect(sent).toEqual(["old"]);
    gate.resolveFail(new Error("stale failure"));
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["old", "new"]);
    expect(errors).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("ignores a stale rejected write after reset without clearing the new generation", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const gate = deferred();
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      onWriteError: (error) => errors.push(error),
      send: async (data) => {
        sent.push(data);
        call += 1;
        if (call === 1) return gate.promise;
        return { ok: true };
      },
    });
    scheduler.enqueue("old");
    await flush();
    await flush();
    scheduler.reset();
    scheduler.enqueue("new");
    gate.rejectWith(new Error("stale rejection"));
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["old", "new"]);
    expect(errors).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("contains a throwing write-error observer and remains usable", async () => {
    const sent: string[] = [];
    let call = 0;
    const scheduler = createTerminalInputScheduler({
      onWriteError: () => {
        throw new Error("observer failed");
      },
      send: async (data) => {
        sent.push(data);
        call += 1;
        return call === 1 ? { ok: false, error: new Error("write failed") } : { ok: true };
      },
    });
    scheduler.enqueue("failed");
    await flush();
    await flush();
    scheduler.enqueue("after");
    await flush();
    await flush();
    expect(sent).toEqual(["failed", "after"]);
    expect(scheduler.pendingLength()).toBe(0);
    expect(scheduler.isDraining()).toBe(false);
  });

  it("drains independent input enqueued by the write-error observer", async () => {
    const sent: string[] = [];
    let call = 0;
    let scheduler!: ReturnType<typeof createTerminalInputScheduler>;
    scheduler = createTerminalInputScheduler({
      onWriteError: () => scheduler.enqueue("recovery"),
      send: async (data) => {
        sent.push(data);
        call += 1;
        return call === 1 ? { ok: false, error: new Error("write failed") } : { ok: true };
      },
    });
    scheduler.enqueue("failed");
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(["failed", "recovery"]);
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("reset() drops pending input", () => {
    const scheduler = createTerminalInputScheduler({
      send: async () => ({ ok: true }),
    });
    scheduler.enqueue("abc");
    expect(scheduler.pendingLength()).toBe(3);
    scheduler.reset();
    expect(scheduler.pendingLength()).toBe(0);
  });

  it("ignores empty input without scheduling a write", async () => {
    const sent: string[] = [];
    const scheduler = createTerminalInputScheduler({
      send: async (data) => {
        sent.push(data);
        return { ok: true };
      },
    });
    scheduler.enqueue("");
    await flush();
    expect(sent).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
    expect(scheduler.isDraining()).toBe(false);
  });

  it("exposes a default frame length", () => {
    expect(DEFAULT_MAX_INPUT_FRAME_LENGTH).toBe(16 * 1024);
  });
});

describe("createTerminalInputSchedulerRegistry", () => {
  it("returns one scheduler per key and a fresh instance after release", () => {
    const registry = createTerminalInputSchedulerRegistry();
    let factoryCalls = 0;
    const make = () => {
      factoryCalls += 1;
      return createTerminalInputScheduler({ send: async () => ({ ok: true }) });
    };

    const a1 = registry.acquire("a", make);
    const a2 = registry.acquire("a", make);

    expect(a1).toBe(a2);
    expect(factoryCalls).toBe(1);
    expect(registry.size()).toBe(1);

    registry.release("a");
    expect(registry.size()).toBe(0);

    const a3 = registry.acquire("a", make);
    expect(a3).not.toBe(a1);
    expect(factoryCalls).toBe(2);
  });

  it("drops input released before its scheduled drain starts", async () => {
    const sent: string[] = [];
    const registry = createTerminalInputSchedulerRegistry();
    const scheduler = registry.acquire("a", () =>
      createTerminalInputScheduler({
        send: async (data) => {
          sent.push(data);
          return { ok: true };
        },
      }),
    );

    scheduler.enqueue("never-send");
    registry.release("a");
    await flush();
    await flush();

    expect(sent).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
    expect(registry.size()).toBe(0);
  });

  it("invalidates dependent input when released during an in-flight write", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const gate = deferred();
    const registry = createTerminalInputSchedulerRegistry();
    const scheduler = registry.acquire("a", () =>
      createTerminalInputScheduler({
        onWriteError: (error) => errors.push(error),
        send: async (data) => {
          sent.push(data);
          return gate.promise;
        },
      }),
    );

    scheduler.enqueue("in-flight");
    await flush();
    await flush();
    scheduler.enqueue("dependent");
    registry.release("a");

    expect(registry.size()).toBe(0);
    const reacquired = registry.acquire("a", () =>
      createTerminalInputScheduler({ send: async () => ({ ok: true }) }),
    );
    expect(reacquired).not.toBe(scheduler);

    gate.resolveFail(new Error("closed while writing"));
    await flush();
    await flush();
    await flush();

    expect(sent).toEqual(["in-flight"]);
    expect(errors).toEqual([]);
    expect(scheduler.pendingLength()).toBe(0);
    expect(scheduler.isDraining()).toBe(false);
  });

  it("keeps independent terminals isolated", async () => {
    const registry = createTerminalInputSchedulerRegistry();
    const sentA: string[] = [];
    const sentB: string[] = [];
    let resolveA!: () => void;
    const a = registry.acquire("a", () =>
      createTerminalInputScheduler({
        send: async (data) => {
          sentA.push(data);
          await new Promise<void>((resolve) => {
            resolveA = resolve;
          });
          return { ok: true };
        },
      }),
    );
    const b = registry.acquire("b", () =>
      createTerminalInputScheduler({
        send: async (data) => {
          sentB.push(data);
          return { ok: true };
        },
      }),
    );

    a.enqueue("a-input");
    b.enqueue("b-input");
    await flush();
    await flush();

    expect(sentA).toEqual(["a-input"]);
    expect(sentB).toEqual(["b-input"]);
    resolveA();
    await flush();
  });

  it("builds stable collision-safe tuple keys", () => {
    expect(terminalInputKey("env", "thread", "term")).toBe(
      terminalInputKey("env", "thread", "term"),
    );
    expect(terminalInputKey("env", "thread", "term")).not.toBe(
      terminalInputKey("env", "thread", "other"),
    );
    expect(terminalInputKey("env", "thread|term", "x")).not.toBe(
      terminalInputKey("env|thread", "term", "x"),
    );
    expect(terminalInputKey("env", "thread", "term")).toBe(
      JSON.stringify(["env", "thread", "term"]),
    );
  });
});
