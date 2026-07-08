import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type UserInputQuestion,
} from "@t3tools/contracts";

import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveThreadFeedPresentation,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId" | "title">,
): OrchestrationThread {
  return {
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
    ...input,
  };
}

describe("buildThreadFeed", () => {
  it("keeps historic work entries attributed to their turns", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Runtime warning thread",
      latestTurn: {
        turnId: TurnId.make("turn-latest"),
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("activity-old"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-old"),
          payload: {
            message: "Old warning",
          },
        }),
        makeActivity({
          id: EventId.make("activity-latest"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-latest"),
          payload: {
            message: "Latest warning",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-old",
        activities: [{ id: "activity-old", turnId: "turn-old" }],
      },
      {
        type: "activity-group",
        turnId: "turn-latest",
        activities: [{ id: "activity-latest", turnId: "turn-latest" }],
      },
    ]);
  });

  it("collapses matching tool lifecycle rows like desktop", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-1"),
      title: "Collapsed tools",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-updated"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Run tests",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run tests completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];

    expect(group).toMatchObject({
      type: "activity-group",
    });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toEqual([
      {
        id: "tool-completed",
        createdAt: "2026-04-01T00:00:02.000Z",
        turnId: "turn-1",
        summary: "Run tests",
        detail: "bun run test",
        fullDetail: "/bin/zsh -lc 'bun run test'",
        copyText: "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
        icon: "command",
        toolLike: true,
        status: "success",
      },
    ]);
  });

  it("keeps MCP inputs available to expanded mobile work rows", () => {
    const turnId = TurnId.make("turn-mcp");
    const thread = makeThread({
      id: ThreadId.make("thread-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Expandable MCP call",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Call repository tool",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "Call repository tool",
            itemType: "mcp_tool_call",
            detail: "repository.search",
            status: "completed",
            data: {
              item: {
                server: "repository",
                tool: "search",
                arguments: { query: "work log" },
              },
            },
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities[0]?.icon).toBe("wrench");
    expect(group.activities[0]?.fullDetail).toContain('"query": "work log"');
    expect(group.activities[0]?.fullDetail).toContain("repository.search");
  });

  it("folds settled turn work while leaving the terminal answer visible", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-3"),
      projectId: ProjectId.make("project-1"),
      title: "Folded work",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:18.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "I am checking.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:02.000Z",
          updatedAt: "2026-04-01T00:00:03.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Done.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:18.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Read files",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Read files",
            itemType: "file_read",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["turn-fold:turn-1", "assistant-final"]);
    expect(collapsed[0]).toMatchObject({
      type: "turn-fold",
      label: "Worked for 17s",
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-commentary",
      "tool-completed",
      "assistant-final",
    ]);
  });

  it("measures a steer-superseded turn from its user boundary through trailing work", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thread = makeThread({
      id: ThreadId.make("thread-steered"),
      projectId: ProjectId.make("project-1"),
      title: "Steered work",
      latestTurn: {
        turnId: secondTurnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:14.000Z",
        startedAt: "2026-04-01T00:00:14.000Z",
        completedAt: null,
        assistantMessageId: MessageId.make("assistant-next"),
      },
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "Do it once more.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "Kicking off call 1.",
          turnId: firstTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:09.000Z",
          updatedAt: "2026-04-01T00:00:09.000Z",
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Actually do 15.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:14.000Z",
          updatedAt: "2026-04-01T00:00:14.000Z",
        },
        {
          id: MessageId.make("assistant-next"),
          role: "assistant",
          text: "One down - adjusting.",
          turnId: secondTurnId,
          streaming: true,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:17.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("work-1"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Ran command",
          createdAt: "2026-04-01T00:00:12.000Z",
          turnId: firstTurnId,
          payload: {
            title: "Ran command",
            itemType: "command_execution",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.find((entry) => entry.type === "turn-fold")).toMatchObject({
      turnId: firstTurnId,
      label: "Worked for 12s",
    });
  });

  it("keeps an active turn expanded and classifies error-shaped tool output", () => {
    const turnId = TurnId.make("turn-running");
    const thread = makeThread({
      id: ThreadId.make("thread-4"),
      projectId: ProjectId.make("project-1"),
      title: "Running work",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-failed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run command",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Run command",
            itemType: "command_execution",
            detail: "zsh: command not found: nope",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toEqual(feed);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "failure" }],
    });
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      fullDetail: null,
      copyText: id,
      icon: "command",
      toolLike: true,
      status,
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });
});

let activityCounter = 0;

function nextActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "kind" | "summary">,
): OrchestrationThreadActivity {
  activityCounter += 1;
  const seconds = String(activityCounter % 60).padStart(2, "0");
  return makeActivity({
    id: EventId.make(`act-${activityCounter}`),
    createdAt: `2026-04-01T00:00:${seconds}.000Z`,
    ...input,
  });
}

function feedActivitiesFor(
  ...activities: ReadonlyArray<OrchestrationThreadActivity>
): ThreadFeedActivity[] {
  const thread = makeThread({
    id: ThreadId.make("thread-work"),
    projectId: ProjectId.make("project-work"),
    title: "Work",
    activities,
  });
  return buildThreadFeed(thread).flatMap((entry) =>
    entry.type === "activity-group" ? [...entry.activities] : [],
  );
}

function singleFeedActivity(activity: OrchestrationThreadActivity): ThreadFeedActivity {
  const [first] = feedActivitiesFor(activity);
  if (!first) {
    throw new Error("expected a derived feed activity");
  }
  return first;
}

describe("buildThreadFeed work-log derivation", () => {
  it("skips lifecycle noise that should never surface as work rows", () => {
    const activities = feedActivitiesFor(
      nextActivity({ kind: "tool.started", summary: "Started tool" }),
      nextActivity({ kind: "task.started", summary: "Started task" }),
      nextActivity({ kind: "context-window.updated", summary: "Context grew" }),
      nextActivity({ kind: "tool.completed", summary: "Checkpoint captured" }),
      nextActivity({
        kind: "tool.updated",
        summary: "Exit plan",
        tone: "tool",
        payload: { detail: "ExitPlanMode: finalize" },
      }),
    );
    expect(activities).toEqual([]);
  });

  it("maps each request kind and item type to its icon", () => {
    const cases: ReadonlyArray<{
      readonly activity: OrchestrationThreadActivity;
      readonly icon: ThreadFeedActivity["icon"];
    }> = [
      {
        activity: nextActivity({ kind: "user-input.requested", summary: "Need input" }),
        icon: "message",
      },
      {
        activity: nextActivity({ kind: "user-input.resolved", summary: "Got input" }),
        icon: "message",
      },
      {
        activity: nextActivity({ kind: "runtime.warning", summary: "Careful" }),
        icon: "warning",
      },
      {
        activity: nextActivity({
          kind: "approval.requested",
          summary: "Approve run",
          tone: "approval",
          payload: { requestKind: "command" },
        }),
        icon: "command",
      },
      {
        activity: nextActivity({
          kind: "approval.requested",
          summary: "Approve read",
          tone: "approval",
          payload: { requestKind: "file-read" },
        }),
        icon: "eye",
      },
      {
        activity: nextActivity({
          kind: "approval.requested",
          summary: "Approve change",
          tone: "approval",
          payload: { requestKind: "file-change" },
        }),
        icon: "edit",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Search web",
          tone: "tool",
          payload: { itemType: "web_search" },
        }),
        icon: "globe",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "View image",
          tone: "tool",
          payload: { itemType: "image_view" },
        }),
        icon: "eye",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Call MCP",
          tone: "tool",
          payload: { itemType: "mcp_tool_call" },
        }),
        icon: "wrench",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Dynamic tool",
          tone: "tool",
          payload: { itemType: "dynamic_tool_call" },
        }),
        icon: "hammer",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Collab tool",
          tone: "tool",
          payload: { itemType: "collab_agent_tool_call" },
        }),
        icon: "hammer",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Changed files",
          tone: "tool",
          payload: { itemType: "file_change" },
        }),
        icon: "edit",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Broke",
          tone: "error",
        }),
        icon: "alert",
      },
      {
        activity: nextActivity({
          kind: "task.progress",
          summary: "Planning",
          payload: { summary: "Planning ahead" },
        }),
        icon: "agent",
      },
      {
        activity: nextActivity({
          kind: "note.added",
          summary: "Noted",
          tone: "info",
        }),
        icon: "check",
      },
      {
        activity: nextActivity({
          kind: "tool.completed",
          summary: "Unlabeled tool",
          tone: "tool",
        }),
        icon: "zap",
      },
    ];

    for (const { activity, icon } of cases) {
      expect(singleFeedActivity(activity).icon).toBe(icon);
    }
  });

  it("prefers explicit request types when a request kind is missing", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "approval.requested",
        summary: "Exec approval",
        tone: "approval",
        payload: { requestType: "exec_command_approval" },
      }),
    );
    expect(activity.icon).toBe("command");
    expect(activity.toolLike).toBe(true);
  });

  it("extracts commands from every candidate location", () => {
    expect(
      singleFeedActivity(
        nextActivity({
          kind: "tool.completed",
          summary: "Item command",
          tone: "tool",
          payload: { itemType: "command_execution", data: { item: { command: "ls -la" } } },
        }),
      ).detail,
    ).toBe("ls -la");

    expect(
      singleFeedActivity(
        nextActivity({
          kind: "tool.completed",
          summary: "Input command",
          tone: "tool",
          payload: { data: { item: { input: { command: "pwd" } } } },
        }),
      ).detail,
    ).toBe("pwd");

    expect(
      singleFeedActivity(
        nextActivity({
          kind: "tool.completed",
          summary: "Result command",
          tone: "tool",
          payload: { data: { item: { result: { command: "whoami" } } } },
        }),
      ).detail,
    ).toBe("whoami");

    expect(
      singleFeedActivity(
        nextActivity({
          kind: "tool.completed",
          summary: "Data command",
          tone: "tool",
          payload: { data: { command: "date" } },
        }),
      ).detail,
    ).toBe("date");
  });

  it("derives a command from command_execution detail and strips the exit code", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Run echo",
        tone: "tool",
        payload: { itemType: "command_execution", detail: "echo hi <exited with exit code 0>" },
      }),
    );
    expect(activity.detail).toBe("echo hi");
    expect(activity.icon).toBe("command");
  });

  it("formats array-shaped commands and quotes arguments with whitespace", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Git commit",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          data: { item: { command: ["git", "commit", "-m", "hello world"] } },
        },
      }),
    );
    expect(activity.detail).toBe('git commit -m "hello world"');
  });

  it("unwraps known shell wrappers while retaining the raw command", () => {
    const cases: ReadonlyArray<{ readonly command: string; readonly unwrapped: string }> = [
      { command: "pwsh -Command 'Get-ChildItem'", unwrapped: "Get-ChildItem" },
      { command: "cmd /c dir", unwrapped: "dir" },
      { command: "bash -lc 'echo hi'", unwrapped: "echo hi" },
    ];
    for (const { command, unwrapped } of cases) {
      const activity = singleFeedActivity(
        nextActivity({
          kind: "tool.completed",
          summary: "Wrapped",
          tone: "tool",
          payload: { itemType: "command_execution", data: { item: { command } } },
        }),
      );
      expect(activity.detail).toBe(unwrapped);
      expect(activity.fullDetail).toContain(command);
    }
  });

  it("collects changed files across nested payload structures", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Apply patch",
        tone: "tool",
        payload: {
          itemType: "file_change",
          data: {
            changes: [{ path: "a.ts" }, { newPath: "b.ts" }, { oldPath: "c.ts" }],
            files: [{ filePath: "d.ts" }],
          },
        },
      }),
    );
    expect(activity.icon).toBe("edit");
    expect(activity.detail).toBe("a.ts +3 more");
    expect(activity.fullDetail).toContain("a.ts\nb.ts\nc.ts\nd.ts");
  });

  it("previews a lone changed file without a counter", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Edit one",
        tone: "tool",
        payload: { data: { changes: [{ path: "only.ts" }] } },
      }),
    );
    expect(activity.detail).toBe("only.ts");
  });

  it("caps the number of collected changed files", () => {
    const many = Array.from({ length: 20 }, (_unused, index) => ({ path: `file-${index}.ts` }));
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Massive change",
        tone: "tool",
        payload: { data: { files: many } },
      }),
    );
    expect(activity.fullDetail?.split("\n").filter((line) => line.endsWith(".ts")).length).toBe(12);
  });

  it("classifies tool output that looks like a failure", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Missing file",
        tone: "tool",
        payload: { itemType: "command_execution", detail: "cat nope: No such file or directory" },
      }),
    );
    expect(activity.status).toBe("failure");
  });

  it("marks in-progress tool rows as neutral", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.updated",
        summary: "Still running",
        tone: "tool",
        payload: { itemType: "command_execution", status: "inProgress" },
      }),
    );
    expect(activity.status).toBe("neutral");
  });

  it("treats a declined lifecycle status as a failure", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "tool.completed",
        summary: "Declined",
        tone: "tool",
        payload: { itemType: "command_execution", status: "declined" },
      }),
    );
    expect(activity.status).toBe("failure");
  });

  it("reports no status for non tool-like rows", () => {
    const activity = singleFeedActivity(
      nextActivity({ kind: "note.added", summary: "Just a note", tone: "info" }),
    );
    expect(activity.status).toBeNull();
    expect(activity.toolLike).toBe(false);
  });

  it("uses the task summary as a heading and capitalizes it", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "task.completed",
        summary: "unused summary",
        payload: { summary: "wrote the report" },
      }),
    );
    expect(activity.summary).toBe("Wrote the report");
  });

  it("falls back to the task detail as a label when no summary exists", () => {
    const activity = singleFeedActivity(
      nextActivity({
        kind: "task.progress",
        summary: "unused",
        payload: { detail: "still working" },
      }),
    );
    expect(activity.summary).toBe("Still working");
  });

  it("collapses adjacent updates that share a collapse key", () => {
    const turnId = TurnId.make("turn-collapse");
    const activities = feedActivitiesFor(
      nextActivity({
        kind: "tool.updated",
        summary: "Build",
        tone: "tool",
        turnId,
        payload: { title: "Build", itemType: "command_execution", detail: "make build" },
      }),
      nextActivity({
        kind: "tool.updated",
        summary: "Build",
        tone: "tool",
        turnId,
        payload: { title: "Build", itemType: "command_execution", detail: "make build" },
      }),
    );
    expect(activities).toHaveLength(1);
  });

  it("keeps updates with distinct collapse keys separate", () => {
    const turnId = TurnId.make("turn-distinct");
    const activities = feedActivitiesFor(
      nextActivity({
        kind: "tool.updated",
        summary: "Build",
        tone: "tool",
        turnId,
        payload: { title: "Build", itemType: "command_execution", detail: "make one" },
      }),
      nextActivity({
        kind: "tool.updated",
        summary: "Build",
        tone: "tool",
        turnId,
        payload: { title: "Build", itemType: "command_execution", detail: "make two" },
      }),
    );
    expect(activities).toHaveLength(2);
  });

  it("filters historic work entries older than the oldest loaded message", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-loaded"),
      projectId: ProjectId.make("project-loaded"),
      title: "Loaded window",
      messages: [
        {
          id: MessageId.make("message-loaded"),
          role: "assistant",
          text: "Recent answer",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:05:00.000Z",
          updatedAt: "2026-04-01T00:05:00.000Z",
        },
      ],
      activities: [
        nextActivity({
          kind: "tool.completed",
          summary: "Old work",
          tone: "tool",
          createdAt: "2026-04-01T00:01:00.000Z",
          payload: { itemType: "command_execution", detail: "old" },
        }),
        nextActivity({
          kind: "tool.completed",
          summary: "Fresh work",
          tone: "tool",
          createdAt: "2026-04-01T00:06:00.000Z",
          payload: { itemType: "command_execution", detail: "fresh" },
        }),
      ],
    });

    const feed = buildThreadFeed(thread, { loadedMessages: [...thread.messages] });
    const summaries = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities.map((activity) => activity.summary) : [],
    );
    expect(summaries).toEqual(["Fresh work"]);
  });
});

describe("deriveThreadFeedPresentation edge cases", () => {
  function assistantMessage(
    id: string,
    turnId: TurnId,
    text: string,
    createdAt: string,
    streaming = false,
  ): OrchestrationThread["messages"][number] {
    return {
      id: MessageId.make(id),
      role: "assistant",
      text,
      turnId,
      streaming,
      createdAt,
      updatedAt: createdAt,
    };
  }

  it("labels an interrupted turn fold with the stop duration", () => {
    const turnId = TurnId.make("turn-interrupted");
    const thread = makeThread({
      id: ThreadId.make("thread-interrupted"),
      projectId: ProjectId.make("project-interrupted"),
      title: "Interrupted",
      latestTurn: {
        turnId,
        state: "interrupted",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:06.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        assistantMessage("assistant-commentary", turnId, "Working", "2026-04-01T00:00:02.000Z"),
        assistantMessage("assistant-final", turnId, "Stopped", "2026-04-01T00:00:05.000Z"),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed[0]).toMatchObject({
      type: "turn-fold",
      label: "You stopped after 5.0s",
    });
  });

  it("does not fold a turn that still has a streaming message", () => {
    const turnId = TurnId.make("turn-streaming");
    const thread = makeThread({
      id: ThreadId.make("thread-streaming"),
      projectId: ProjectId.make("project-streaming"),
      title: "Streaming",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:09.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        assistantMessage("assistant-commentary", turnId, "Thinking", "2026-04-01T00:00:02.000Z"),
        assistantMessage("assistant-final", turnId, "Answer", "2026-04-01T00:00:08.000Z", true),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.some((entry) => entry.type === "turn-fold")).toBe(false);
    expect(collapsed.map((entry) => entry.id)).toEqual(["assistant-commentary", "assistant-final"]);
  });

  it("drops an activity group once every neutral tool row is filtered", () => {
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "group-neutral",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          {
            id: "neutral-1",
            createdAt: "2026-04-01T00:00:01.000Z",
            turnId: null,
            summary: "Neutral tool",
            detail: null,
            fullDetail: null,
            copyText: "neutral-1",
            icon: "command",
            toolLike: true,
            status: "neutral",
          },
        ],
      },
    ];
    expect(deriveThreadFeedPresentation(feed, null, new Set())).toEqual([]);
  });
});

describe("derivePendingApprovals", () => {
  it("opens, resolves, and sorts approvals by creation time", () => {
    const approvals = derivePendingApprovals([
      nextActivity({
        kind: "approval.requested",
        summary: "Approve exec",
        tone: "approval",
        createdAt: "2026-04-01T00:00:03.000Z",
        payload: {
          requestId: "req-late",
          requestKind: "command",
          detail: "run tests",
        },
      }),
      nextActivity({
        kind: "approval.requested",
        summary: "Approve read",
        tone: "approval",
        createdAt: "2026-04-01T00:00:01.000Z",
        payload: { requestId: "req-early", requestType: "file_read_approval" },
      }),
      nextActivity({
        kind: "approval.requested",
        summary: "Approve patch",
        tone: "approval",
        createdAt: "2026-04-01T00:00:02.000Z",
        payload: { requestId: "req-resolved", requestType: "apply_patch_approval" },
      }),
      nextActivity({
        kind: "approval.resolved",
        summary: "Resolved patch",
        tone: "approval",
        createdAt: "2026-04-01T00:00:04.000Z",
        payload: { requestId: "req-resolved" },
      }),
    ]);

    expect(approvals.map((approval) => approval.requestId)).toEqual(["req-early", "req-late"]);
    expect(approvals[0]).toMatchObject({ requestKind: "file-read" });
    expect(approvals[1]).toMatchObject({ requestKind: "command", detail: "run tests" });
  });

  it("ignores requests without a resolvable kind or id", () => {
    const approvals = derivePendingApprovals([
      nextActivity({
        kind: "approval.requested",
        summary: "No kind",
        tone: "approval",
        payload: { requestId: "req-nokind", requestType: "mystery_approval" },
      }),
      nextActivity({
        kind: "approval.requested",
        summary: "No id",
        tone: "approval",
        payload: { requestKind: "command" },
      }),
    ]);
    expect(approvals).toEqual([]);
  });

  it("clears a stale pending approval when the provider reports failure", () => {
    const approvals = derivePendingApprovals([
      nextActivity({
        kind: "approval.requested",
        summary: "Approve",
        tone: "approval",
        payload: { requestId: "req-stale", requestKind: "command" },
      }),
      nextActivity({
        kind: "provider.approval.respond.failed",
        summary: "Failed",
        tone: "error",
        payload: {
          requestId: "req-stale",
          detail: "Unknown pending approval request for this turn",
        },
      }),
    ]);
    expect(approvals).toEqual([]);
  });

  it("keeps a pending approval when a failure is unrelated to staleness", () => {
    const approvals = derivePendingApprovals([
      nextActivity({
        kind: "approval.requested",
        summary: "Approve",
        tone: "approval",
        payload: { requestId: "req-live", requestKind: "file-change" },
      }),
      nextActivity({
        kind: "provider.approval.respond.failed",
        summary: "Failed",
        tone: "error",
        payload: { requestId: "req-live", detail: "network hiccup" },
      }),
    ]);
    expect(approvals.map((approval) => approval.requestId)).toEqual(["req-live"]);
  });
});

describe("derivePendingUserInputs", () => {
  function requestedActivity(
    requestId: string,
    payload: Record<string, unknown>,
    createdAt = "2026-04-01T00:00:01.000Z",
  ): OrchestrationThreadActivity {
    return nextActivity({
      kind: "user-input.requested",
      summary: "Need input",
      tone: "info",
      createdAt,
      payload: { requestId, ...payload },
    });
  }

  const validQuestion = {
    id: "q1",
    header: "Pick one",
    question: "Which option?",
    options: [
      { label: "Yes", description: "Affirmative" },
      { label: "No", description: "Negative" },
    ],
    multiSelect: false,
  };

  it("collects and resolves user input requests", () => {
    const inputs = derivePendingUserInputs([
      requestedActivity("input-1", { questions: [validQuestion] }),
      requestedActivity(
        "input-2",
        { questions: [{ ...validQuestion, id: "q2" }] },
        "2026-04-01T00:00:02.000Z",
      ),
      nextActivity({
        kind: "user-input.resolved",
        summary: "Answered",
        tone: "info",
        createdAt: "2026-04-01T00:00:03.000Z",
        payload: { requestId: "input-2" },
      }),
    ]);

    expect(inputs.map((input) => input.requestId)).toEqual(["input-1"]);
    expect(inputs[0]?.questions[0]).toMatchObject({ id: "q1", multiSelect: false });
  });

  it("rejects malformed question payloads", () => {
    const rejected = derivePendingUserInputs([
      requestedActivity("no-questions", { questions: "nope" }),
      requestedActivity("empty-questions", { questions: [] }),
      requestedActivity("bad-entry", { questions: [42] }),
      requestedActivity("missing-fields", {
        questions: [{ id: "q", header: "h", question: "?" }],
      }),
      requestedActivity("bad-options", {
        questions: [{ ...validQuestion, options: [{ label: "only" }] }],
      }),
      requestedActivity("empty-options", {
        questions: [{ ...validQuestion, options: [] }],
      }),
    ]);
    expect(rejected).toEqual([]);
  });

  it("clears a stale user input request on provider failure", () => {
    const inputs = derivePendingUserInputs([
      requestedActivity("stale-input", { questions: [validQuestion] }),
      nextActivity({
        kind: "provider.user-input.respond.failed",
        summary: "Failed",
        tone: "error",
        createdAt: "2026-04-01T00:00:05.000Z",
        payload: {
          requestId: "stale-input",
          detail: "stale pending user-input request",
        },
      }),
    ]);
    expect(inputs).toEqual([]);
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("keeps only the custom answer once text is entered", () => {
    const result = setPendingUserInputCustomAnswer({ selectedOptionLabel: "Yes" }, "typed answer");
    expect(result).toEqual({ customAnswer: "typed answer" });
  });

  it("retains the selected option when the custom answer is cleared", () => {
    const result = setPendingUserInputCustomAnswer({ selectedOptionLabel: "Yes" }, "   ");
    expect(result).toEqual({ customAnswer: "   ", selectedOptionLabel: "Yes" });
  });

  it("tolerates an undefined draft", () => {
    const result = setPendingUserInputCustomAnswer(undefined, "hello");
    expect(result).toEqual({ customAnswer: "hello" });
  });
});

describe("buildPendingUserInputAnswers", () => {
  const questions: ReadonlyArray<UserInputQuestion> = [
    {
      id: "q1",
      header: "First",
      question: "One?",
      options: [{ label: "A", description: "a" }],
      multiSelect: false,
    },
    {
      id: "q2",
      header: "Second",
      question: "Two?",
      options: [{ label: "B", description: "b" }],
      multiSelect: false,
    },
  ];

  it("prefers custom answers and falls back to the selected option", () => {
    const draftAnswers: Record<string, PendingUserInputDraftAnswer> = {
      q1: { customAnswer: "  custom  ", selectedOptionLabel: "A" },
      q2: { selectedOptionLabel: "B" },
    };
    expect(buildPendingUserInputAnswers(questions, draftAnswers)).toEqual({
      q1: "custom",
      q2: "B",
    });
  });

  it("returns null when any question is unanswered", () => {
    const draftAnswers: Record<string, PendingUserInputDraftAnswer> = {
      q1: { selectedOptionLabel: "A" },
      q2: { customAnswer: "   " },
    };
    expect(buildPendingUserInputAnswers(questions, draftAnswers)).toBeNull();
  });
});
