import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  scheduler: { name: "scheduler" },
  configs: [] as Array<Record<string, unknown>>,
  operations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("./runtime.ts", () => ({
  createAtomCommandScheduler: () => harness.scheduler,
  createEnvironmentCommand: (_runtime: unknown, config: Record<string, unknown>) => {
    harness.configs.push(config);
    return { label: config.label };
  },
}));

vi.mock("../operations/commands.ts", () => {
  const names = [
    "archiveThread",
    "createThread",
    "deleteThread",
    "interruptThreadTurn",
    "respondToThreadApproval",
    "respondToThreadUserInput",
    "revertThreadCheckpoint",
    "setThreadInteractionMode",
    "setThreadRuntimeMode",
    "startThreadTurn",
    "stopThreadSession",
    "unarchiveThread",
    "updateThreadMetadata",
  ];
  return Object.fromEntries(
    names.map((name) => {
      const operation = vi.fn((input: unknown) => ({ name, input }));
      harness.operations.set(name, operation);
      return [name, operation];
    }),
  );
});

import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

describe("createThreadEnvironmentAtoms", () => {
  it("creates serial per-thread commands and delegates every operation", () => {
    harness.configs.length = 0;
    const runtime = { name: "runtime" } as never;
    const atoms = createThreadEnvironmentAtoms(runtime);
    const expected = [
      ["create", "createThread"],
      ["delete", "deleteThread"],
      ["archive", "archiveThread"],
      ["unarchive", "unarchiveThread"],
      ["updateMetadata", "updateThreadMetadata"],
      ["setRuntimeMode", "setThreadRuntimeMode"],
      ["setInteractionMode", "setThreadInteractionMode"],
      ["startTurn", "startThreadTurn"],
      ["interruptTurn", "interruptThreadTurn"],
      ["respondToApproval", "respondToThreadApproval"],
      ["respondToUserInput", "respondToThreadUserInput"],
      ["revertCheckpoint", "revertThreadCheckpoint"],
      ["stopSession", "stopThreadSession"],
    ] as const;

    expect(Object.keys(atoms)).toEqual(expected.map(([key]) => key));
    expect(harness.configs).toHaveLength(expected.length);
    for (const [index, [, operationName]] of expected.entries()) {
      const config = harness.configs[index]!;
      const input = { threadId: `thread-${index}` };
      expect(config.scheduler).toBe(harness.scheduler);
      expect(config.concurrency).toMatchObject({ mode: "serial" });
      expect((config.execute as (value: unknown) => unknown)(input)).toEqual({
        name: operationName,
        input,
      });
      expect(harness.operations.get(operationName)).toHaveBeenCalledWith(input);
    }

    const concurrency = harness.configs[0]!.concurrency as {
      key: (value: { environmentId: string; input: { threadId: string } }) => string;
    };
    expect(concurrency.key({ environmentId: "env-1", input: { threadId: "thread-1" } })).toBe(
      '["env-1","thread-1"]',
    );
  });
});
