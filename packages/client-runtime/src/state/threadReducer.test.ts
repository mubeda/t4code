import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t4code/contracts";
import type { OrchestrationThread } from "@t4code/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function event(type: string, payload: Record<string, unknown>, sequence = 100) {
  return {
    ...baseEventFields,
    sequence,
    occurredAt: `2026-04-02T${String(sequence % 24).padStart(2, "0")}:00:00.000Z`,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type,
    payload: { threadId: ThreadId.make("thread-1"), ...payload },
  } as any;
}

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "T4Code",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.session-set", () => {
    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it("adds a checkpoint and updates latestTurn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T12:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("msg-3"),
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
      }
    });
  });

  describe("thread.reverted", () => {
    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
      }
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("remaining lifecycle variants", () => {
    it.each(["project.meta-updated", "project.deleted"])("ignores %s", (type) => {
      expect(applyThreadDetailEvent(baseThread, event(type, {})).kind).toBe("unchanged");
    });

    it("updates runtime and interaction modes", () => {
      const runtime = applyThreadDetailEvent(
        baseThread,
        event("thread.runtime-mode-set", {
          runtimeMode: "read-only",
          updatedAt: "runtime-updated",
        }),
      );
      const interaction = applyThreadDetailEvent(
        baseThread,
        event("thread.interaction-mode-set", {
          interactionMode: "plan",
          updatedAt: "interaction-updated",
        }),
      );

      expect(runtime).toMatchObject({
        kind: "updated",
        thread: { runtimeMode: "read-only", updatedAt: "runtime-updated" },
      });
      expect(interaction).toMatchObject({
        kind: "updated",
        thread: { interactionMode: "plan", updatedAt: "interaction-updated" },
      });
    });

    it("patches all optional metadata and preserves omitted fields", () => {
      const patched = applyThreadDetailEvent(
        baseThread,
        event("thread.meta-updated", {
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-opus",
          },
          worktreePath: "/tmp/worktree",
          updatedAt: "patched",
        }),
      );
      const omitted = applyThreadDetailEvent(
        baseThread,
        event("thread.meta-updated", { updatedAt: "omitted" }),
      );

      expect(patched).toMatchObject({
        kind: "updated",
        thread: {
          title: "Test Thread",
          modelSelection: { model: "claude-opus" },
          branch: null,
          worktreePath: "/tmp/worktree",
        },
      });
      expect(omitted).toMatchObject({
        kind: "updated",
        thread: {
          title: "Test Thread",
          modelSelection: baseThread.modelSelection,
          branch: null,
          worktreePath: null,
        },
      });
    });

    it("applies turn-start requests with and without a model override", () => {
      const withModel = applyThreadDetailEvent(
        baseThread,
        event("thread.turn-start-requested", {
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "claude-sonnet",
          },
          runtimeMode: "read-only",
          interactionMode: "plan",
        }),
      );
      const withoutModel = applyThreadDetailEvent(
        baseThread,
        event("thread.turn-start-requested", {
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
      );

      expect(withModel).toMatchObject({
        kind: "updated",
        thread: { modelSelection: { model: "claude-sonnet" }, runtimeMode: "read-only" },
      });
      expect(withoutModel).toMatchObject({
        kind: "updated",
        thread: { modelSelection: baseThread.modelSelection },
      });
    });

    it("only interrupts the matching latest turn and fills missing timestamps", () => {
      const latestTurn = {
        turnId: TurnId.make("turn-1"),
        state: "running" as const,
        requestedAt: "requested",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      };
      expect(
        applyThreadDetailEvent(baseThread, event("thread.turn-interrupt-requested", {})).kind,
      ).toBe("unchanged");
      expect(
        applyThreadDetailEvent(
          { ...baseThread, latestTurn },
          event("thread.turn-interrupt-requested", {
            turnId: TurnId.make("turn-other"),
            createdAt: "interrupt",
          }),
        ).kind,
      ).toBe("unchanged");
      expect(
        applyThreadDetailEvent(
          { ...baseThread, latestTurn },
          event("thread.turn-interrupt-requested", {
            turnId: TurnId.make("turn-1"),
            createdAt: "interrupt",
          }),
        ),
      ).toMatchObject({
        kind: "updated",
        thread: {
          latestTurn: { state: "interrupted", startedAt: "interrupt", completedAt: "interrupt" },
        },
      });
    });
  });

  describe("message merge variants", () => {
    const existingMessage = {
      id: MessageId.make("msg-existing"),
      role: "assistant" as const,
      text: "existing",
      turnId: TurnId.make("turn-1"),
      streaming: true,
      createdAt: "created",
      updatedAt: "old-updated",
    };

    it("merges a completed message without erasing text and preserves other messages", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          messages: [{ ...existingMessage, id: MessageId.make("msg-other") }, existingMessage],
        },
        event("thread.message-sent", {
          messageId: existingMessage.id,
          role: "assistant",
          text: "",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          attachments: [{ type: "image", name: "image.png", url: "data:image/png;base64,eA==" }],
          createdAt: "created",
          updatedAt: "new-updated",
        }),
      );

      expect(result).toMatchObject({
        kind: "updated",
        thread: {
          messages: [
            { id: "msg-other", text: "existing" },
            {
              id: "msg-existing",
              text: "existing",
              streaming: false,
              updatedAt: "new-updated",
              attachments: [{ name: "image.png" }],
            },
          ],
        },
      });
    });

    it("replaces existing text for a completed message", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          messages: [existingMessage],
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "requested",
            startedAt: "started",
            completedAt: null,
            assistantMessageId: null,
          },
        },
        event("thread.message-sent", {
          messageId: existingMessage.id,
          role: "assistant",
          text: "replacement",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "created",
          updatedAt: "updated",
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: { messages: [{ text: "replacement", turnId: "turn-1" }] },
      });
    });

    it.each(["interrupted", "error"] as const)(
      "preserves a previously %s turn when the final assistant message arrives",
      (state) => {
        const result = applyThreadDetailEvent(
          {
            ...baseThread,
            latestTurn: {
              turnId: TurnId.make("turn-1"),
              state,
              requestedAt: "requested",
              startedAt: "started",
              completedAt: null,
              assistantMessageId: null,
            },
          },
          event("thread.message-sent", {
            messageId: MessageId.make(`msg-${state}`),
            role: "assistant",
            text: "done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "created",
            updatedAt: "completed",
          }),
        );
        expect(result).toMatchObject({ kind: "updated", thread: { latestTurn: { state } } });
      },
    );

    it("starts an assistant turn and rebinds only its checkpoint", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          checkpoints: [
            {
              turnId: TurnId.make("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: CheckpointRef.make("ref-2"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "checkpoint",
            },
            {
              turnId: TurnId.make("other-turn"),
              checkpointTurnCount: 3,
              checkpointRef: CheckpointRef.make("ref-3"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "checkpoint",
            },
          ],
        },
        event("thread.message-sent", {
          messageId: MessageId.make("msg-turn-2"),
          role: "assistant",
          text: "partial",
          turnId: TurnId.make("turn-2"),
          streaming: true,
          createdAt: "created",
          updatedAt: "updated",
        }),
      );

      expect(result).toMatchObject({
        kind: "updated",
        thread: {
          latestTurn: {
            turnId: "turn-2",
            state: "running",
            requestedAt: "created",
            startedAt: "created",
            completedAt: null,
          },
          checkpoints: [
            { turnId: "turn-2", assistantMessageId: "msg-turn-2" },
            { turnId: "other-turn", assistantMessageId: null },
          ],
        },
      });
    });

    it("uses the event time when an existing turn has not started", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "requested",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        },
        event("thread.message-sent", {
          messageId: MessageId.make("msg-started"),
          role: "assistant",
          text: "stream",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "started-by-message",
          updatedAt: "updated",
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: { latestTurn: { startedAt: "started-by-message" } },
      });
    });
  });

  describe("session settlement variants", () => {
    it.each([
      ["idle", "completed"],
      ["error", "error"],
      ["interrupted", "interrupted"],
      ["stopped", "interrupted"],
    ] as const)("maps %s sessions to %s turns", (status, state) => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "requested",
            startedAt: "started",
            completedAt: "placeholder",
            assistantMessageId: null,
          },
        },
        event("thread.session-set", {
          session: {
            threadId: ThreadId.make("thread-1"),
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: status === "error" ? "failed" : null,
            updatedAt: "session-ended",
          },
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: { latestTurn: { state, completedAt: "session-ended" } },
      });
    });

    it("keeps a turn unsettled while a session is starting", () => {
      const latestTurn = {
        turnId: TurnId.make("turn-1"),
        state: "running" as const,
        requestedAt: "requested",
        startedAt: "started",
        completedAt: null,
        assistantMessageId: null,
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, latestTurn },
        event("thread.session-set", {
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "starting",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "starting",
          },
        }),
      );
      expect(result).toMatchObject({ kind: "updated", thread: { latestTurn } });
    });

    it("preserves timing and message identity when the same running turn resumes", () => {
      const latestTurn = {
        turnId: TurnId.make("turn-1"),
        state: "running" as const,
        requestedAt: "requested",
        startedAt: null,
        completedAt: "placeholder",
        assistantMessageId: MessageId.make("assistant"),
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, latestTurn },
        event("thread.session-set", {
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "resumed",
          },
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: {
          latestTurn: {
            requestedAt: "requested",
            startedAt: "resumed",
            completedAt: null,
            assistantMessageId: "assistant",
          },
        },
      });
    });
  });

  describe("ordered collections and checkpoint guards", () => {
    it("replaces and sorts proposed plans", () => {
      const plan = (id: string, createdAt: string) => ({
        id,
        turnId: null,
        planMarkdown: id,
        implementedAt: null,
        implementationThreadId: null,
        createdAt,
        updatedAt: createdAt,
      });
      const result = applyThreadDetailEvent(
        { ...baseThread, proposedPlans: [plan("b", "2026-04-02"), plan("old", "2026-04-01")] },
        event("thread.proposed-plan-upserted", {
          proposedPlan: plan("old", "2026-04-02"),
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: { proposedPlans: [{ id: "b" }, { id: "old" }] },
      });
    });

    it("rejects a missing downgrade and replaces checkpoints in turn order", () => {
      const existing = {
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("ready-ref"),
        status: "ready" as const,
        files: [],
        assistantMessageId: null,
        completedAt: "ready",
      };
      const rejected = applyThreadDetailEvent(
        { ...baseThread, checkpoints: [existing] },
        event("thread.turn-diff-completed", {
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("missing-ref"),
          status: "missing",
          files: [],
          assistantMessageId: null,
          completedAt: "missing",
        }),
      );
      expect(rejected.kind).toBe("unchanged");

      const replaced = applyThreadDetailEvent(
        {
          ...baseThread,
          checkpoints: [
            existing,
            {
              turnId: TurnId.make("turn-3"),
              checkpointTurnCount: 3,
              checkpointRef: existing.checkpointRef,
              status: existing.status,
              files: existing.files,
              assistantMessageId: existing.assistantMessageId,
              completedAt: existing.completedAt,
            },
          ],
        },
        event("thread.turn-diff-completed", {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("error-ref"),
          status: "error",
          files: [],
          assistantMessageId: null,
          completedAt: "error",
        }),
      );
      expect(replaced).toMatchObject({
        kind: "updated",
        thread: {
          checkpoints: [{ turnId: "turn-1" }, { turnId: "turn-2" }, { turnId: "turn-3" }],
          latestTurn: { state: "error" },
        },
      });
    });

    it("keeps a live turn running when its mid-turn diff completes", () => {
      const latestTurn = {
        turnId: TurnId.make("turn-live"),
        state: "running" as const,
        requestedAt: "requested",
        startedAt: "started",
        completedAt: null,
        assistantMessageId: null,
      };
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-live"),
            lastError: null,
            updatedAt: "running",
          },
        },
        event("thread.turn-diff-completed", {
          turnId: TurnId.make("turn-live"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("live-ref"),
          status: "missing",
          files: [],
          assistantMessageId: null,
          completedAt: "mid-turn",
        }),
      );
      expect(result).toMatchObject({ kind: "updated", thread: { latestTurn } });
    });

    it("does not replace an unrelated latest turn with a completed diff", () => {
      const latestTurn = {
        turnId: TurnId.make("newer-turn"),
        state: "running" as const,
        requestedAt: "requested",
        startedAt: "started",
        completedAt: null,
        assistantMessageId: null,
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, latestTurn },
        event("thread.turn-diff-completed", {
          turnId: TurnId.make("older-turn"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("older-ref"),
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "older-completed",
        }),
      );
      expect(result).toMatchObject({ kind: "updated", thread: { latestTurn } });
    });

    it("replaces duplicate activities and orders missing sequences by time and id", () => {
      const activity = (id: string, createdAt: string, sequence?: number) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command" as const,
        summary: id,
        payload: {},
        turnId: null,
        ...(sequence === undefined ? {} : { sequence }),
        createdAt,
      });
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          activities: [
            activity("same", "2026-04-03"),
            activity("z", "2026-04-02"),
            activity("a", "2026-04-02"),
            activity("numbered", "2026-04-04", 1),
          ],
        },
        event("thread.activity-appended", {
          activity: activity("same", "2026-04-01"),
        }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: { activities: [{ id: "numbered" }, { id: "same" }, { id: "a" }, { id: "z" }] },
      });
    });
  });

  describe("revert and forward compatibility", () => {
    it("clears the latest turn and retains system and unbound messages when no checkpoint remains", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          messages: [
            {
              id: MessageId.make("system"),
              role: "system",
              text: "system",
              turnId: TurnId.make("removed"),
              streaming: false,
              createdAt: "created",
              updatedAt: "updated",
            },
            {
              id: MessageId.make("unbound"),
              role: "user",
              text: "unbound",
              turnId: null,
              streaming: false,
              createdAt: "created",
              updatedAt: "updated",
            },
            {
              id: MessageId.make("removed"),
              role: "assistant",
              text: "removed",
              turnId: TurnId.make("removed"),
              streaming: false,
              createdAt: "created",
              updatedAt: "updated",
            },
          ],
          proposedPlans: [
            {
              id: "global-plan",
              turnId: null,
              planMarkdown: "global",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "created",
              updatedAt: "updated",
            },
            {
              id: "removed-plan",
              turnId: TurnId.make("removed"),
              planMarkdown: "removed",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "created",
              updatedAt: "updated",
            },
          ],
          activities: [
            {
              id: EventId.make("global-activity"),
              tone: "info",
              kind: "status",
              summary: "global",
              payload: {},
              turnId: null,
              createdAt: "created",
            },
            {
              id: EventId.make("removed-activity"),
              tone: "info",
              kind: "status",
              summary: "removed",
              payload: {},
              turnId: TurnId.make("removed"),
              createdAt: "created",
            },
          ],
          checkpoints: [
            {
              turnId: TurnId.make("removed-checkpoint"),
              checkpointTurnCount: 2,
              checkpointRef: CheckpointRef.make("removed-ref"),
              status: "missing",
              files: [],
              assistantMessageId: null,
              completedAt: "completed",
            },
          ],
        },
        event("thread.reverted", { turnCount: 0 }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: {
          latestTurn: null,
          messages: [{ id: "system" }, { id: "unbound" }],
          proposedPlans: [{ id: "global-plan" }],
          activities: [{ id: "global-activity" }],
          checkpoints: [],
        },
      });
    });

    it("restores a retained missing checkpoint without an assistant message", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          checkpoints: [
            {
              turnId: TurnId.make("turn-missing"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("missing-ref"),
              status: "missing",
              files: [],
              assistantMessageId: null,
              completedAt: "missing-completed",
            },
          ],
        },
        event("thread.reverted", { turnCount: 1 }),
      );
      expect(result).toMatchObject({
        kind: "updated",
        thread: {
          latestTurn: {
            turnId: "turn-missing",
            state: "completed",
            assistantMessageId: null,
          },
        },
      });
    });

    it.each([
      "thread.user-input-response-requested",
      "thread.checkpoint-revert-requested",
      "thread.future-event",
    ])("ignores %s", (type) => {
      expect(applyThreadDetailEvent(baseThread, event(type, {})).kind).toBe("unchanged");
    });
  });
});
