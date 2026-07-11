import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t4code/contracts";
import { createRef, type ComponentProps, type ReactNode, type Ref } from "react";
import type { WorkLogEntry } from "../../session-logic";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

let MessagesTimelineComponent: typeof import("./MessagesTimeline").MessagesTimeline | null = null;
const SLOW_MESSAGES_TIMELINE_IMPORT_TIMEOUT_MS = 60_000;

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    getItemType?: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    onScroll?: () => void;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
      onSizeChanged?: (size: number) => void;
    };
    contentInsetEndAdjustment?: number;
    className?: string;
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onSizeChanged?.(240);
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    // Simulate the initial scroll callback LegendList fires after layout.
    props.onScroll?.();
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)} data-item-type={props.getItemType?.(item)}>
            {props.renderItem({ item })}
          </div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(async () => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };
  const localStorageStub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };

  vi.stubGlobal("localStorage", localStorageStub);
  vi.stubGlobal("window", {
    localStorage: localStorageStub,
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });

  MessagesTimelineComponent = (await import("./MessagesTimeline")).MessagesTimeline;
}, SLOW_MESSAGES_TIMELINE_IMPORT_TIMEOUT_MS);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

async function loadMessagesTimeline() {
  return MessagesTimelineComponent ?? (await import("./MessagesTimeline")).MessagesTimeline;
}

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("uses LegendList isNearEnd when deciding whether the live edge is visible", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(false);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);
  });

  it("anchors a sent attachment message using its measured height", async () => {
    const MessagesTimeline = await loadMessagesTimeline();
    const onAnchorReady = vi.fn();
    const onAnchorSizeChanged = vi.fn();
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
        attachments: [
          {
            type: "image" as const,
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        onAnchorSizeChanged={onAnchorSizeChanged}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(markup).toContain('data-anchor-index="1"');
    expect(markup).toContain('data-anchor-offset="16"');
    expect(markup).toContain('data-anchor-on-ready="true"');
    expect(markup).not.toContain("data-anchor-max-size=");
    expect(markup).toContain('data-content-inset-end="144"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-visible-content-position="object"');
    expect(markup).toContain('data-maintain-visible-content-position-data="true"');
    expect(markup).toContain('data-maintain-visible-content-position-size="false"');
    expect(onAnchorReady).toHaveBeenCalledOnce();
    expect(onAnchorReady).toHaveBeenCalledWith(secondEntry.message.id, 1);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(secondEntry.message.id, 240);
  });

  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("renders chips for standalone element-pick context messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("SubmitButton");
    expect(markup).not.toContain("&lt;element_context");
    expect(markup).not.toContain("<element_context");
  });

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work Log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t4code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t4code"
      />,
    );

    expect(markup).toContain("t4code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t4code/apps/web/src/session-logic.ts");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders file review comments as source code instead of diffs", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("renders the empty state when there are no rows and no work in flight", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[]} />,
    );

    expect(markup).toContain("Send a message to start the conversation.");
    expect(markup).not.toContain("legend-list");
  });

  it("renders a plain working indicator when the active turn start is unknown", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} isWorking timelineEntries={[]} />,
    );

    expect(markup).toContain("Working...");
  });

  it("renders a self-ticking working timer in seconds for young turns", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={startedAt}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain("Working for");
    expect(markup).toMatch(/Working for <span[^>]*>(29|30|31)s</);
  });

  it("formats the working timer with minutes and seconds", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={startedAt}
        timelineEntries={[]}
      />,
    );

    expect(markup).toMatch(/1m (29|30|31)s/);
  });

  it("formats the working timer with hours and minutes", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const startedAt = new Date(Date.now() - 3_690_000).toISOString();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={startedAt}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain("1h 1m");
  });

  it("formats the working timer with hours only when minutes are zero", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const startedAt = new Date(Date.now() - 3_650_000).toISOString();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={startedAt}
        timelineEntries={[]}
      />,
    );

    expect(markup).toMatch(/1h</);
    expect(markup).not.toContain("1h 0m");
  });

  it("renders a failure marker for failed tool lifecycle entries", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-x");
    expect(markup).toContain('aria-label="Tool call failed"');
  });
});

const TURN_ID = TurnId.make("turn-1");
const LATER_CREATED_AT = "2026-03-17T19:12:33.000Z";

function buildAssistantTimelineEntry(overrides: {
  id: string;
  messageId: string;
  text: string;
  turnId?: ReturnType<typeof TurnId.make> | null;
  streaming?: boolean;
  createdAt?: string;
}) {
  const createdAt = overrides.createdAt ?? LATER_CREATED_AT;
  return {
    id: overrides.id,
    kind: "message" as const,
    createdAt,
    message: {
      id: MessageId.make(overrides.messageId),
      role: "assistant" as const,
      text: overrides.text,
      turnId: overrides.turnId ?? null,
      createdAt,
      updatedAt: createdAt,
      streaming: overrides.streaming ?? false,
    },
  };
}

function buildWorkTimelineEntry(id: string, entry: Partial<WorkLogEntry> = {}) {
  return {
    id,
    kind: "work" as const,
    createdAt: MESSAGE_CREATED_AT,
    entry: {
      id: `${id}-entry`,
      createdAt: MESSAGE_CREATED_AT,
      label: "Tool",
      tone: "tool" as const,
      ...entry,
    },
  };
}

type MessagesTimelineProps = ComponentProps<typeof import("./MessagesTimeline").MessagesTimeline>;

async function renderTimeline(
  props: Partial<MessagesTimelineProps> & Pick<MessagesTimelineProps, "timelineEntries">,
) {
  const MessagesTimeline = await loadMessagesTimeline();
  return renderToStaticMarkup(<MessagesTimeline {...buildProps()} {...props} />);
}

describe("MessagesTimeline assistant rows", () => {
  it("renders terminal assistant messages with metadata and copy button", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildUserTimelineEntry("Explain this."),
        buildAssistantTimelineEntry({
          id: "entry-2",
          messageId: "message-assistant-1",
          text: "Here is the answer.",
          turnId: TURN_ID,
        }),
      ],
      latestTurn: {
        turnId: TURN_ID,
        state: "completed",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: LATER_CREATED_AT,
      },
    });

    expect(markup).toContain("Here is the answer.");
    expect(markup).toContain("group/assistant");
    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-message-role="assistant"');
  });

  it("renders a placeholder for empty settled assistant responses", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildAssistantTimelineEntry({
          id: "entry-1",
          messageId: "message-assistant-empty",
          text: "",
        }),
      ],
    });

    expect(markup).toContain("(empty response)");
  });

  it("does not render a placeholder while an assistant message is streaming", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildAssistantTimelineEntry({
          id: "entry-1",
          messageId: "message-assistant-streaming",
          text: "",
          streaming: true,
        }),
      ],
    });

    expect(markup).not.toContain("(empty response)");
  });

  it("renders the changed files summary for assistant turn diffs", async () => {
    const assistantMessageId = MessageId.make("message-assistant-diff");
    const markup = await renderTimeline({
      timelineEntries: [
        buildUserTimelineEntry("Change files."),
        buildAssistantTimelineEntry({
          id: "entry-2",
          messageId: "message-assistant-diff",
          text: "Changed two files.",
          turnId: TURN_ID,
        }),
      ],
      turnDiffSummaryByAssistantMessageId: new Map([
        [
          assistantMessageId,
          {
            turnId: TURN_ID,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-1"),
            status: "ready" as const,
            files: [
              { path: "src/alpha.ts", kind: "modified", additions: 3, deletions: 1 },
              { path: "src/beta.ts", kind: "added", additions: 10, deletions: 0 },
            ],
            assistantMessageId,
            completedAt: LATER_CREATED_AT,
          },
        ],
      ]),
    });

    expect(markup).toContain("Changed files (2)");
    expect(markup).toContain("Collapse all");
    expect(markup).toContain("View diff");
    expect(markup).toContain("alpha.ts");
    expect(markup).toContain("beta.ts");
  });
});

describe("MessagesTimeline turn folds", () => {
  const foldableEntries = () => [
    buildUserTimelineEntry("Do the work."),
    buildWorkTimelineEntry("entry-work", {
      turnId: TURN_ID,
      label: "Read file",
      command: "cat notes.txt",
    }),
    buildAssistantTimelineEntry({
      id: "entry-commentary",
      messageId: "message-commentary",
      text: "Intermediate commentary.",
      turnId: TURN_ID,
      createdAt: "2026-03-17T19:12:30.000Z",
    }),
    buildAssistantTimelineEntry({
      id: "entry-terminal",
      messageId: "message-terminal",
      text: "All done now.",
      turnId: TURN_ID,
    }),
  ];

  it("folds settled turns behind a Worked-for row keeping the terminal message", async () => {
    const markup = await renderTimeline({
      timelineEntries: foldableEntries(),
      latestTurn: {
        turnId: TURN_ID,
        state: "completed",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: LATER_CREATED_AT,
      },
    });

    expect(markup).toContain("Worked for 5.0s");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("All done now.");
    expect(markup).not.toContain("Intermediate commentary.");
    expect(markup).not.toContain("cat notes.txt");
  });

  it("labels interrupted turns as stopped by the user", async () => {
    const markup = await renderTimeline({
      timelineEntries: foldableEntries(),
      latestTurn: {
        turnId: TURN_ID,
        state: "interrupted",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: LATER_CREATED_AT,
      },
    });

    expect(markup).toContain("You stopped after 5.0s");
  });

  it("keeps running turns unfolded", async () => {
    const markup = await renderTimeline({
      timelineEntries: foldableEntries(),
      runningTurnId: TURN_ID,
      latestTurn: {
        turnId: TURN_ID,
        state: "running",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: null,
      },
    });

    expect(markup).not.toContain("Worked for");
    expect(markup).toContain("Intermediate commentary.");
    expect(markup).toContain("All done now.");
  });
});

describe("MessagesTimeline work groups", () => {
  it("collapses long tool call runs behind a work-toggle row", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildWorkTimelineEntry("work-1", { label: "First", command: "echo one" }),
        buildWorkTimelineEntry("work-2", { label: "Second", command: "echo two" }),
        buildWorkTimelineEntry("work-3", { label: "Third", command: "echo three" }),
      ],
    });

    expect(markup).toContain("+2 previous tool calls");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("echo three");
    expect(markup).not.toContain("echo one");
  });

  it("labels mixed work runs as log entries", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildWorkTimelineEntry("work-1", { label: "Note one", tone: "info" }),
        buildWorkTimelineEntry("work-2", { label: "Note two", tone: "info" }),
        buildWorkTimelineEntry("work-3", { label: "Note three", tone: "info" }),
      ],
    });

    // Current pluralization appends a bare "s" ("log entrys"); assert the
    // singular noun so this test keeps passing if the copy is fixed later.
    expect(markup).toContain("+2 previous log entry");
    expect(markup).not.toContain("tool call");
    expect(markup).toContain("Note three");
  });
});

describe("MessagesTimeline work entry rows", () => {
  async function renderWorkEntry(entry: Parameters<typeof buildWorkTimelineEntry>[1]) {
    return renderTimeline({ timelineEntries: [buildWorkTimelineEntry("work-1", entry)] });
  }

  it("renders command entries with the terminal icon and success indicator", async () => {
    const markup = await renderWorkEntry({
      label: "Run command",
      command: "pnpm test",
      toolLifecycleStatus: "completed",
    });

    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("lucide-check");
    expect(markup).toContain("pnpm test");
    expect(markup).toContain('role="button"');
  });

  it("renders file-read approval entries with the eye icon", async () => {
    const markup = await renderWorkEntry({ label: "Read", requestKind: "file-read" });

    expect(markup).toContain("lucide-eye");
  });

  it("renders file-change approval entries with the pen icon", async () => {
    const markup = await renderWorkEntry({ label: "Edit", requestKind: "file-change" });

    expect(markup).toContain("lucide-square-pen");
  });

  it("renders command approval entries with the terminal icon", async () => {
    const markup = await renderWorkEntry({ label: "Approve", requestKind: "command" });

    expect(markup).toContain("lucide-terminal");
  });

  it("renders MCP tool calls with the wrench icon and expandable payload", async () => {
    const markup = await renderWorkEntry({
      label: "MCP tool",
      itemType: "mcp_tool_call",
      toolData: { server: "docs", args: { q: "hello" } },
    });

    expect(markup).toContain("lucide-wrench");
    expect(markup).toContain('role="button"');
  });

  it("renders web searches with the globe icon", async () => {
    const markup = await renderWorkEntry({
      label: "Search web",
      itemType: "web_search",
      detail: "searched the docs",
    });

    expect(markup).toContain("lucide-globe");
  });

  it("renders image views with the eye icon", async () => {
    const markup = await renderWorkEntry({
      label: "View image",
      itemType: "image_view",
      detail: "screenshot.png",
    });

    expect(markup).toContain("lucide-eye");
  });

  it("renders dynamic tool calls with the hammer icon", async () => {
    const markup = await renderWorkEntry({
      label: "Dyn tool",
      itemType: "dynamic_tool_call",
      detail: "ran helper",
    });

    expect(markup).toContain("lucide-hammer");
  });

  it("renders user-input requests with the message icon", async () => {
    const markup = await renderWorkEntry({
      label: "Question",
      detail: "Which option?",
      sourceActivityKind: "user-input.requested",
    });

    expect(markup).toContain("lucide-message-circle");
  });

  it("renders runtime warnings with warning chrome", async () => {
    const markup = await renderWorkEntry({
      label: "Warning",
      detail: "something odd",
      sourceActivityKind: "runtime.warning",
    });

    expect(markup).toContain("lucide-x");
    expect(markup).toContain("text-warning");
  });

  it("renders runtime errors with destructive chrome", async () => {
    const markup = await renderWorkEntry({
      label: "Crashed",
      detail: "boom",
      tone: "error",
      sourceActivityKind: "runtime.error",
    });

    expect(markup).toContain("text-destructive");
    expect(markup).toContain('aria-label="Tool call failed"');
  });

  it("renders failed thinking entries with the bot icon", async () => {
    const markup = await renderWorkEntry({
      label: "Pondering",
      tone: "thinking",
      toolLifecycleStatus: "failed",
    });

    expect(markup).toContain("lucide-bot");
  });

  it("summarizes multiple changed files in the preview", async () => {
    const markup = await renderWorkEntry({
      label: "Updated files",
      changedFiles: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
      toolLifecycleStatus: "completed",
    });

    expect(markup).toContain("lucide-square-pen");
    expect(markup).toContain("+2 more");
  });

  it("prefers the tool title over the label and strips completed suffixes", async () => {
    const markup = await renderWorkEntry({
      label: "tool call completed",
      toolTitle: "search files completed",
      detail: "3 matches",
      toolLifecycleStatus: "completed",
    });

    expect(markup).toContain("Search files");
    expect(markup).toContain("3 matches");
  });

  it("drops previews that repeat the heading", async () => {
    const markup = await renderWorkEntry({
      label: "Search files",
      detail: "search files",
      toolLifecycleStatus: "completed",
    });

    expect(markup).toContain("Search files");
    expect(markup).not.toContain(">search files<");
  });
});

describe("MessagesTimeline user message affordances", () => {
  it("renders the revert button when the message has revertable turns", async () => {
    const entry = buildUserTimelineEntry("Revert me.");
    const markup = await renderTimeline({
      timelineEntries: [entry],
      revertTurnCountByUserMessageId: new Map([[entry.message.id, 2]]),
    });

    expect(markup).toContain('aria-label="Revert to this message"');
    expect(markup).toContain("lucide-undo-2");
  });

  it("disables the revert button while a checkpoint revert is running", async () => {
    const entry = buildUserTimelineEntry("Revert me.");
    const markup = await renderTimeline({
      timelineEntries: [entry],
      revertTurnCountByUserMessageId: new Map([[entry.message.id, 1]]),
      isRevertingCheckpoint: true,
    });

    expect(markup).toContain('aria-label="Revert to this message"');
    expect(markup).toContain("disabled");
  });

  it("renders preview annotation cards with comment, targets and style changes", async () => {
    const text = [
      "Make the button blue",
      "",
      "<preview_annotation>",
      "Preview annotation:",
      "Id: anno-1",
      "Page: Dashboard",
      "Comment: Blue please",
      "Targets: 1 selected element.",
      "Requested visual changes:",
      "- color: red → blue",
      "The attached screenshot is the annotated preview crop.",
      "</preview_annotation>",
    ].join("\n");
    const entry = {
      ...buildUserTimelineEntry(text),
      message: {
        ...buildUserTimelineEntry(text).message,
        attachments: [
          {
            type: "image" as const,
            id: "attachment-annotation",
            name: "preview-annotation-anno-1.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    };
    const markup = await renderTimeline({ timelineEntries: [entry] });

    expect(markup).toContain("Blue please");
    expect(markup).toContain("1 selected element.");
    expect(markup).toContain("lucide-paintbrush");
    expect(markup).toContain("Annotated preview crop");
    expect(markup).toContain("Make the button blue");
    expect(markup).not.toContain("<preview_annotation>");
  });
});

describe("MessagesTimeline row typing and scroll wiring", () => {
  it("derives distinct item types per row kind", async () => {
    const markup = await renderTimeline({
      isWorking: true,
      timelineEntries: [
        buildUserTimelineEntry("A question"),
        buildAssistantTimelineEntry({
          id: "entry-2",
          messageId: "message-assistant-types",
          text: "An answer",
        }),
        buildWorkTimelineEntry("entry-3", { label: "Tooling", command: "ls" }),
      ],
    });

    expect(markup).toContain('data-item-type="message:user"');
    expect(markup).toContain('data-item-type="message:assistant"');
    expect(markup).toContain('data-item-type="work"');
    expect(markup).toContain('data-item-type="working"');
  });

  it("reports the live-edge state from the list scroll state", async () => {
    const onIsAtEndChange = vi.fn();
    const listRef = createRef<LegendListRef | null>();
    listRef.current = {
      getState: () => ({
        isNearEnd: true,
        scroll: 0,
        scrollLength: 400,
        positionAtIndex: () => 10,
        sizeAtIndex: () => 40,
      }),
    } as unknown as LegendListRef;

    const secondUser = {
      ...buildUserTimelineEntry("Second question"),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Second question").message,
        id: MessageId.make("message-user-scroll-2"),
      },
    };
    await renderTimeline({
      listRef,
      onIsAtEndChange,
      timelineEntries: [buildUserTimelineEntry("First question"), secondUser],
    });

    expect(onIsAtEndChange).toHaveBeenCalledWith(true);
  });
});

describe("MessagesTimeline proposed plans", () => {
  it("renders proposed plan rows through the plan card", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        {
          id: "entry-plan",
          kind: "proposed-plan" as const,
          createdAt: MESSAGE_CREATED_AT,
          proposedPlan: {
            id: "plan-1",
            turnId: TURN_ID,
            planMarkdown: "Follow the plan steps carefully.",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
          },
        },
      ],
    });

    expect(markup).toContain('data-item-type="proposed-plan"');
    expect(markup).toContain("Follow the plan steps carefully.");
  });
});

describe("MessagesTimeline terminal context bodies", () => {
  const terminalContextBlock = [
    "<terminal_context>",
    "- Terminal 1 lines 1-5:",
    "  1 | pnpm install",
    "  2 | done",
    "</terminal_context>",
  ].join("\n");

  it("renders context-only user messages as bare chips", async () => {
    const markup = await renderTimeline({
      timelineEntries: [buildUserTimelineEntry(terminalContextBlock)],
    });

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("prefixes chips before prose that does not mention the labels inline", async () => {
    const markup = await renderTimeline({
      timelineEntries: [buildUserTimelineEntry(`what went wrong here?\n\n${terminalContextBlock}`)],
    });

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("what went wrong here?");
    expect(markup).toContain('aria-hidden="true"> </span>');
  });
});

describe("MessagesTimeline working timer resilience", () => {
  it("falls back to a zero timer when the turn start timestamp is invalid", async () => {
    const markup = await renderTimeline({
      isWorking: true,
      activeTurnStartedAt: "not-a-timestamp",
      timelineEntries: [],
    });

    expect(markup).toContain("Working for");
    expect(markup).toContain(">0s<");
  });
});

describe("MessagesTimeline work entry expanded bodies", () => {
  it("keeps rows expandable when the raw command differs from the display command", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildWorkTimelineEntry("work-raw", {
          label: "Run",
          command: "ls",
          rawCommand: "ls --color=auto",
        }),
      ],
    });

    expect(markup).toContain('role="button"');
    expect(markup).toContain("lucide-chevron-down");
  });

  it("treats identical raw and display commands as a single command body", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildWorkTimelineEntry("work-same", {
          label: "Run",
          command: "pwd",
          rawCommand: "pwd",
        }),
      ],
    });

    expect(markup).toContain('role="button"');
    expect(markup).toContain("pwd");
  });

  it("tolerates empty labels", async () => {
    const markup = await renderTimeline({
      timelineEntries: [
        buildWorkTimelineEntry("work-empty-label", {
          label: "",
          command: "true",
        }),
      ],
    });

    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("true");
  });
});

describe("MessagesTimeline minimap", () => {
  it("renders minimap strips for each user message once past the threshold", async () => {
    const secondUser = {
      ...buildUserTimelineEntry("Second question"),
      id: "entry-3",
      message: {
        ...buildUserTimelineEntry("Second question").message,
        id: MessageId.make("message-user-2"),
      },
    };
    const markup = await renderTimeline({
      timelineEntries: [
        buildUserTimelineEntry("First question"),
        buildAssistantTimelineEntry({
          id: "entry-2",
          messageId: "message-assistant-mm",
          text: "First answer",
        }),
        secondUser,
      ],
    });

    expect(markup).toContain('data-testid="timeline-minimap"');
    expect(markup).toContain('data-persistent-gutter="false"');
    expect(markup).toContain('aria-label="Jump to message: User message"');
    expect(markup.match(/data-minimap-strip/g)?.length).toBe(2);
    expect(markup).toContain("min(8px, calc(100vh - 18rem))");
  });

  it("does not render the minimap below the item threshold", async () => {
    const markup = await renderTimeline({
      timelineEntries: [buildUserTimelineEntry("Only question")],
    });

    expect(markup).not.toContain('data-testid="timeline-minimap"');
  });
});
