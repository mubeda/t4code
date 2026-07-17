import { EnvironmentId, ThreadId } from "@t4code/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  queryResults: [] as Array<{ data: unknown; error: unknown }>,
  queryInputs: [] as unknown[],
  attach: vi.fn((input: unknown) => ({ kind: "attach", input })),
  metadata: vi.fn((input: unknown) => ({ kind: "metadata", input })),
  combine: vi.fn((summary: unknown, buffer: unknown) => ({ summary, buffer, status: "running" })),
  selectRunning: vi.fn((sessions: unknown) => sessions),
}));

vi.mock("react", () => ({ useMemo: (factory: () => unknown) => factory() }));
vi.mock("@t4code/client-runtime/state/terminal", () => ({
  combineTerminalSessionState: (summary: unknown, buffer: unknown) =>
    harness.combine(summary, buffer),
  EMPTY_TERMINAL_BUFFER_STATE: { emptyBuffer: true },
  EMPTY_TERMINAL_SESSION_STATE: { emptySession: true },
  selectRunningSubprocessTerminalIds: (sessions: unknown) => harness.selectRunning(sessions),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    const index = harness.queryInputs.length;
    harness.queryInputs.push(input);
    return harness.queryResults[index] ?? { data: null, error: null };
  },
}));
vi.mock("./terminal", () => ({
  terminalEnvironment: {
    attach: (input: unknown) => harness.attach(input),
    metadata: (input: unknown) => harness.metadata(input),
  },
}));

import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
  useThreadRunningTerminalIds,
} from "./terminalSessions";

const environmentId = EnvironmentId.make("environment-1");
const terminal = { threadId: "thread-1", terminalId: "terminal-1", cwd: "/repo" } as never;

beforeEach(() => {
  harness.queryResults = [];
  harness.queryInputs.length = 0;
  harness.attach.mockClear();
  harness.metadata.mockClear();
  harness.combine.mockClear();
  harness.selectRunning.mockClear();
});

describe("useAttachedTerminalSession", () => {
  it("returns the empty state when either scope input is missing", () => {
    expect(useAttachedTerminalSession({ environmentId: null, terminal })).toEqual({
      emptySession: true,
    });
    expect(harness.queryInputs).toEqual([null, null]);

    harness.queryInputs.length = 0;
    expect(useAttachedTerminalSession({ environmentId, terminal: null })).toEqual({
      emptySession: true,
    });
    expect(harness.queryInputs[0]).toBeNull();
    expect(harness.queryInputs[1]).not.toBeNull();
  });

  it("combines matching metadata and attached buffers", () => {
    const summary = { threadId: "thread-1", terminalId: "terminal-1" };
    harness.queryResults = [
      { data: { output: "ready" }, error: null },
      {
        data: [
          { threadId: "other", terminalId: "terminal-1" },
          { threadId: "thread-1", terminalId: "other" },
          summary,
        ],
        error: null,
      },
    ];
    expect(useAttachedTerminalSession({ environmentId, terminal })).toEqual({
      summary,
      buffer: { output: "ready" },
      status: "running",
    });
    expect(harness.attach).toHaveBeenCalledWith({ environmentId, input: terminal });
  });

  it("uses empty fallbacks and overlays attach errors", () => {
    harness.queryResults = [
      { data: null, error: "attach failed" },
      { data: undefined, error: null },
    ];
    expect(useAttachedTerminalSession({ environmentId, terminal })).toEqual({
      summary: null,
      buffer: { emptyBuffer: true },
      status: "error",
      error: "attach failed",
    });
  });
});

describe("useKnownTerminalSessions", () => {
  it("returns no sessions without an environment or metadata", () => {
    expect(useKnownTerminalSessions({ environmentId: null, threadId: null })).toEqual([]);
    expect(harness.queryInputs).toEqual([null]);

    harness.queryInputs.length = 0;
    harness.queryResults = [{ data: null, error: null }];
    expect(useKnownTerminalSessions({ environmentId, threadId: null })).toEqual([]);
  });

  it("filters by thread and sorts numeric terminal ids", () => {
    harness.queryResults = [
      {
        data: [
          { threadId: "thread-1", terminalId: "terminal-10" },
          { threadId: "other", terminalId: "terminal-1" },
          { threadId: "thread-1", terminalId: "terminal-2" },
        ],
        error: null,
      },
    ];
    const sessions = useKnownTerminalSessions({
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    expect(sessions.map((session) => session.target.terminalId)).toEqual([
      "terminal-2",
      "terminal-10",
    ]);

    harness.queryInputs.length = 0;
    harness.queryResults = [
      {
        data: [
          { threadId: "thread-2", terminalId: "terminal-1" },
          { threadId: "thread-1", terminalId: "terminal-2" },
        ],
        error: null,
      },
    ];
    expect(useKnownTerminalSessions({ environmentId, threadId: null })).toHaveLength(2);
  });

  it("selects running subprocess terminal ids", () => {
    harness.queryResults = [{ data: [], error: null }];
    expect(
      useThreadRunningTerminalIds({ environmentId, threadId: ThreadId.make("thread-1") }),
    ).toEqual([]);
    expect(harness.selectRunning).toHaveBeenCalledWith([]);
  });
});
