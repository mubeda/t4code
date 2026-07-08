import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { QueuedThreadMessage } from "./thread-outbox-model";

// ── Instrumented hooks harness (see AddProjectScreen.test.tsx) ────────
// `useThreadOutboxDrain` is invoked directly; its captured effects are run
// manually. Real thread-outbox-model helpers and AsyncResult/Cause drive the
// delivery/retry decision tree; all collaborator hooks are mocked.
type Respond = (input: unknown) => unknown;

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  atomStore: new Map<unknown, unknown>(),
  dispatchingId: null as unknown,
  queuedByKey: {} as Record<string, ReadonlyArray<unknown>>,
  shellStatuses: new Map<unknown, string>(),
  threads: [] as ReadonlyArray<unknown>,
  connectedEnvironments: [] as ReadonlyArray<unknown>,
  commandCalls: [] as Array<{ key: string; input: unknown }>,
  commandResults: {} as Record<string, Respond>,
  defaultRespond: (() => undefined) as Respond,
  ensureLoadedCalls: 0,
  removeCalls: [] as unknown[],
  removeImpl: (() => Promise.resolve()) as (message: unknown) => Promise<void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
    useLayoutEffect: (effect: () => void | (() => void)) => {
      h.effects.push(effect);
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ],
    useContext: () => undefined,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (_atom: unknown) => h.dispatchingId,
}));

vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => h.atomStore.get(atom),
    set: (atom: unknown, value: unknown) => {
      h.atomStore.set(atom, value);
    },
  },
}));

vi.mock("./threads", () => ({
  threadEnvironment: {
    startTurn: { key: "startTurn" },
    updateMetadata: { key: "updateMetadata" },
    setRuntimeMode: { key: "setRuntimeMode" },
    setInteractionMode: { key: "setInteractionMode" },
  },
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: { key?: string } | null) => (input: unknown) => {
    const key = command?.key ?? "unknown";
    h.commandCalls.push({ key, input });
    const respond = h.commandResults[key] ?? h.defaultRespond;
    return Promise.resolve(respond(input));
  },
}));

vi.mock("./entities", () => ({
  useThreadShells: () => h.threads,
}));

vi.mock("./thread-outbox", () => ({
  ensureThreadOutboxLoaded: () => {
    h.ensureLoadedCalls += 1;
  },
  removeThreadOutboxMessage: (message: unknown) => {
    h.removeCalls.push(message);
    return h.removeImpl(message);
  },
}));

vi.mock("./use-thread-outbox", () => ({
  useThreadOutboxMessages: () => h.queuedByKey,
  useThreadOutboxShellStatuses: () => h.shellStatuses,
}));

vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: h.connectedEnvironments }),
}));

import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = `${environmentId}:${threadId}`;
const now = "2026-01-01T00:00:00.000Z";

const modelA: ModelSelection = { instanceId: "codex" as never, model: "gpt-5.4" };
const modelB: ModelSelection = { instanceId: "codex" as never, model: "gpt-5.1" };

function makeMessage(overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage {
  return {
    environmentId,
    threadId,
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "hello",
    attachments: [],
    createdAt: now,
    ...overrides,
  };
}

function makeThread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    modelSelection: modelA,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function connectThread(thread: EnvironmentThreadShell = makeThread()): void {
  h.threads = [thread];
  h.connectedEnvironments = [{ environmentId, connectionState: "connected" }];
}

function commandCallsFor(key: string): Array<{ key: string; input: unknown }> {
  return h.commandCalls.filter((call) => call.key === key);
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const effect of Array.from(h.effects)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  h.effects.length = 0;
  h.atomStore.clear();
  h.dispatchingId = null;
  h.queuedByKey = {};
  h.shellStatuses = new Map();
  h.threads = [];
  h.connectedEnvironments = [];
  h.commandCalls.length = 0;
  h.commandResults = {};
  h.defaultRespond = () => AsyncResult.success(undefined);
  h.ensureLoadedCalls = 0;
  h.removeCalls.length = 0;
  h.removeImpl = () => Promise.resolve();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useThreadOutboxDrain mount", () => {
  it("loads the outbox and cleans up timers", () => {
    useThreadOutboxDrain();
    const cleanups = runEffects();
    expect(h.ensureLoadedCalls).toBe(1);
    for (const cleanup of cleanups) cleanup();
  });
});

describe("useThreadOutboxDrain delivery gating", () => {
  it("does nothing while another message is dispatching", async () => {
    h.dispatchingId = MessageId.make("message-9");
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(h.commandCalls).toHaveLength(0);
  });

  it("skips empty queues", async () => {
    h.queuedByKey = { [threadKey]: [] };

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(h.commandCalls).toHaveLength(0);
  });

  it("skips a queue keyed differently from the live thread", async () => {
    h.queuedByKey = { "mismatched-key": [makeMessage()] };
    connectThread();

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });

  it("waits when the environment is not connected", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    h.threads = [makeThread()];
    h.connectedEnvironments = [];

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });

  it("waits when the running thread is busy", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread(makeThread({ session: { status: "running", activeTurnId: "turn-1" } }));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });
});

describe("useThreadOutboxDrain missing-thread removal", () => {
  it("removes a message for a missing thread once the shell is live", async () => {
    const message = makeMessage();
    h.queuedByKey = { [threadKey]: [message] };
    h.threads = [];
    h.shellStatuses = new Map([[environmentId, "live"]]);

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(h.removeCalls).toHaveLength(1);
    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });

  it("schedules a retry when removing a missing-thread message fails", async () => {
    const message = makeMessage();
    h.queuedByKey = { [threadKey]: [message] };
    h.threads = [];
    h.shellStatuses = new Map([[environmentId, "live"]]);
    h.removeImpl = () => Promise.reject(new Error("remove failed"));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(h.removeCalls).toHaveLength(1);
    // A backoff timer was scheduled; advancing it re-arms the drain tick.
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1_000);
  });
});

describe("useThreadOutboxDrain sending", () => {
  it("syncs settings, starts the turn, and removes the delivered message", async () => {
    const message = makeMessage({
      modelSelection: modelB,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    h.queuedByKey = { [threadKey]: [message] };
    connectThread();

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("updateMetadata")).toHaveLength(1);
    expect(commandCallsFor("setRuntimeMode")).toHaveLength(1);
    expect(commandCallsFor("setInteractionMode")).toHaveLength(1);
    expect(commandCallsFor("startTurn")).toHaveLength(1);
    const startInput = commandCallsFor("startTurn")[0]!.input as {
      input: { message: { messageId: MessageId; text: string }; runtimeMode: string };
    };
    expect(startInput.input.message.text).toBe("hello");
    expect(startInput.input.runtimeMode).toBe("approval-required");
    expect(h.removeCalls).toHaveLength(1);
  });

  it("skips settings sync when the queued settings already match the thread", async () => {
    // No per-message overrides: resolved settings equal the thread's.
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("updateMetadata")).toHaveLength(0);
    expect(commandCallsFor("setRuntimeMode")).toHaveLength(0);
    expect(commandCallsFor("setInteractionMode")).toHaveLength(0);
    expect(commandCallsFor("startTurn")).toHaveLength(1);
    expect(h.removeCalls).toHaveLength(1);
  });

  it("aborts delivery when the metadata sync fails", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage({ modelSelection: modelB })] };
    connectThread();
    h.commandResults.updateMetadata = () => AsyncResult.failure(Cause.fail(new Error("meta down")));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
    expect(h.removeCalls).toHaveLength(0);
  });

  it("aborts delivery when the runtime-mode sync fails", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage({ runtimeMode: "approval-required" })] };
    connectThread();
    h.commandResults.setRuntimeMode = () => AsyncResult.failure(Cause.fail(new Error("rt down")));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });

  it("aborts delivery when the interaction-mode sync fails", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage({ interactionMode: "plan" })] };
    connectThread();
    h.commandResults.setInteractionMode = () =>
      AsyncResult.failure(Cause.fail(new Error("im down")));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(0);
  });

  it("retries when startTurn fails with a transient transport error", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();
    h.commandResults.startTurn = () =>
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected")));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    // Transient failure keeps the message and schedules a retry.
    expect(h.removeCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
  });

  it("discards the message when startTurn fails deterministically", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();
    h.commandResults.startTurn = () =>
      AsyncResult.failure(Cause.fail(new Error("Thread no longer exists")));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    // Deterministic failure discards the message by removing it.
    expect(h.removeCalls).toHaveLength(1);
  });

  it("schedules a retry when removing a delivered message throws", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();
    h.removeImpl = () => Promise.reject(new Error("remove failed"));

    useThreadOutboxDrain();
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn")).toHaveLength(1);
    expect(h.removeCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
  });

  it("waits for the retry backoff window before re-dispatching", async () => {
    h.queuedByKey = { [threadKey]: [makeMessage()] };
    connectThread();
    h.commandResults.startTurn = () =>
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected")));

    useThreadOutboxDrain();
    // First pass fails and records a not-before timestamp for the message.
    runEffects();
    await flush();
    const startTurnsAfterFirst = commandCallsFor("startTurn").length;

    // Second pass (same refs) is inside the backoff window and must skip.
    runEffects();
    await flush();

    expect(commandCallsFor("startTurn").length).toBe(startTurnsAfterFirst);
  });
});
