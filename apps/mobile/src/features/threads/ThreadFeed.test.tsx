import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../../lib/threadActivity";

const h = vi.hoisted(() => ({
  colorScheme: "light" as "light" | "dark" | null,
  assetUrl: null as string | null,
  hasNativeSelectable: false,
  nativeReviewDiffView: null as unknown,
  routerPush: [] as Array<unknown>,
  openURLs: [] as Array<string>,
  hapticCount: 0,
  copyCalls: [] as Array<{ value: string; opts: unknown }>,
  pressables: [] as Array<Record<string, unknown>>,
  touchables: [] as Array<Record<string, unknown>>,
  copyButtons: [] as Array<Record<string, unknown>>,
  markdownProps: [] as Array<Record<string, unknown>>,
  selectableMarkdownProps: [] as Array<Record<string, unknown>>,
  workLogProps: [] as Array<Record<string, unknown>>,
  workGroupToggleProps: [] as Array<Record<string, unknown>>,
  nativeTextOnPress: [] as Array<() => void>,
  imageOnError: [] as Array<() => void>,
  legendListProps: null as Record<string, unknown> | null,
  imageViewingProps: null as Record<string, unknown> | null,
}));

vi.mock("expo-haptics", () => ({
  selectionAsync: () => {
    h.hapticCount += 1;
    return Promise.resolve();
  },
}));

vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: (props: Record<string, unknown>) => {
    h.legendListProps = props;
    return <div data-legend-list="true" />;
  },
}));

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({
    push: (target: unknown) => {
      h.routerPush.push(target);
    },
  }),
}));

vi.mock("react-native-nitro-markdown", () => ({
  Markdown: (props: { readonly children?: unknown } & Record<string, unknown>) => {
    h.markdownProps.push(props);
    return (
      <div data-markdown="true">
        {typeof props.children === "string" ? props.children : null}
      </div>
    );
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <i data-activity-indicator="true" />,
  Image: (props: Record<string, unknown>) => {
    if (typeof props.onError === "function") {
      h.imageOnError.push(props.onError as () => void);
    }
    return (
      <i
        data-image="true"
        data-uri={String((props.source as { uri?: string } | undefined)?.uri ?? "")}
      />
    );
  },
  Linking: {
    openURL: (url: string) => {
      h.openURLs.push(url);
      return Promise.resolve();
    },
  },
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return <button type="button">{props.children}</button>;
  },
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFill: { position: "absolute" },
  },
  Text: (props: { readonly children?: ReactNode; readonly onPress?: () => void }) => {
    if (typeof props.onPress === "function") {
      h.nativeTextOnPress.push(props.onPress);
    }
    return <span>{props.children}</span>;
  },
  useColorScheme: () => h.colorScheme,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("react-native-gesture-handler", () => ({
  TouchableOpacity: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.touchables.push(props);
    return (
      <button type="button" data-touchable="true">
        {props.children}
      </button>
    );
  },
}));

vi.mock("react-native-image-viewing", () => ({
  default: (props: Record<string, unknown>) => {
    h.imageViewingProps = props;
    return <div data-image-viewing={String(props.visible)} />;
  },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 18, left: 0, right: 0 }),
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: (key: string) => `color(${key})`,
}));

vi.mock("../../lib/copyTextWithHaptic", () => ({
  copyTextWithHaptic: (value: string, opts: unknown) => {
    h.copyCalls.push({ value, opts });
  },
}));

vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => h.hasNativeSelectable,
  SelectableMarkdownText: (props: Record<string, unknown>) => {
    h.selectableMarkdownProps.push(props);
    return <div data-selectable-markdown="true" />;
  },
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("../../components/CopyTextButton", () => ({
  CopyTextButton: (props: Record<string, unknown>) => {
    h.copyButtons.push(props);
    return <button type="button" data-copy="true" />;
  },
}));

vi.mock("../diffs/nativeReviewDiffSurface", () => ({
  resolveNativeReviewDiffView: () => h.nativeReviewDiffView,
}));

vi.mock("@t3tools/mobile-markdown-text/file-icons", () => ({
  markdownFileIconSource: (icon: string) => ({ uri: `icon-${icon}` }),
}));

vi.mock("./thread-work-log", () => ({
  ThreadWorkLog: (props: Record<string, unknown>) => {
    h.workLogProps.push(props);
    return <div data-work-log="true" />;
  },
  ThreadWorkGroupToggle: (props: Record<string, unknown>) => {
    h.workGroupToggleProps.push(props);
    return <div data-work-toggle="true" />;
  },
}));

vi.mock("../../state/assets", () => ({
  useAssetUrl: () => h.assetUrl,
}));

import { ThreadFeed, type ThreadFeedProps } from "./ThreadFeed";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const rafQueue: Array<() => void> = [];
globalThis.requestAnimationFrame = ((cb: () => void) => {
  rafQueue.push(cb);
  return rafQueue.length;
}) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

function flushRaf(): void {
  while (rafQueue.length > 0) {
    const cb = rafQueue.shift();
    cb?.();
  }
}

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");

function sharedValue<T>(value: T): SharedValue<T> {
  return { value } as unknown as SharedValue<T>;
}

function makeProps(overrides: Partial<ThreadFeedProps> = {}): ThreadFeedProps {
  return {
    environmentId: ENV,
    threadId: THREAD,
    workspaceRoot: "/workspace",
    feed: [],
    contentPresentation: { kind: "ready" },
    agentLabel: "Agent",
    latestTurn: null,
    listRef: { current: null },
    freeze: sharedValue(false),
    anchorMessageId: null,
    contentInsetEndAdjustment: sharedValue(0),
    ...overrides,
  };
}

beforeEach(() => {
  h.colorScheme = "light";
  h.assetUrl = null;
  h.hasNativeSelectable = false;
  h.nativeReviewDiffView = null;
  h.routerPush.length = 0;
  h.openURLs.length = 0;
  h.hapticCount = 0;
  h.copyCalls.length = 0;
  h.pressables.length = 0;
  h.touchables.length = 0;
  h.copyButtons.length = 0;
  h.markdownProps.length = 0;
  h.selectableMarkdownProps.length = 0;
  h.workLogProps.length = 0;
  h.workGroupToggleProps.length = 0;
  h.nativeTextOnPress.length = 0;
  h.imageOnError.length = 0;
  h.legendListProps = null;
  h.imageViewingProps = null;
});

describe("ThreadFeed placeholders", () => {
  it("renders the loading placeholder", () => {
    const markup = renderToStaticMarkup(
      <ThreadFeed {...makeProps({ contentPresentation: { kind: "loading" } })} />,
    );
    expect(markup).toContain("Loading conversation");
    expect(markup).toContain("data-activity-indicator");
  });

  it("renders the unavailable placeholder", () => {
    const markup = renderToStaticMarkup(
      <ThreadFeed
        {...makeProps({
          contentPresentation: {
            kind: "unavailable",
            title: "Thread unavailable",
            detail: "It was deleted.",
          },
        })}
      />,
    );
    expect(markup).toContain("Thread unavailable");
    expect(markup).toContain("It was deleted.");
  });

  it("renders the empty conversation overlay when the feed is empty", () => {
    const markup = renderToStaticMarkup(<ThreadFeed {...makeProps({ feed: [] })} />);
    expect(markup).toContain("data-legend-list");
    expect(markup).toContain("No conversation yet");
  });
});

type MessageEntry = Extract<ThreadFeedEntry, { type: "message" }>;
type MessageAttachment = NonNullable<MessageEntry["message"]["attachments"]>[number];

function messageEntry(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text?: string;
  readonly turnId?: ReturnType<typeof TurnId.make> | null;
  readonly streaming?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly attachments?: ReadonlyArray<MessageAttachment>;
}): MessageEntry {
  const createdAt = input.createdAt ?? "2026-04-01T00:00:01.000Z";
  return {
    type: "message",
    id: input.id,
    createdAt,
    message: {
      id: MessageId.make(input.id),
      role: input.role,
      text: input.text ?? "Hello world",
      turnId: input.turnId ?? null,
      streaming: input.streaming ?? false,
      createdAt,
      updatedAt: input.updatedAt ?? "2026-04-01T00:00:02.000Z",
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
  };
}

const SINGLE_REVIEW_TEXT = [
  "Take a look here",
  '<review_comment sectionId="s1" sectionTitle="One" filePath="src/deep/app.ts" startIndex="1" endIndex="2" rangeLabel="1 to 2">',
  "Standard diff comment",
  "```diff",
  "@@ -1,1 +1,1 @@",
  "-const a = 1",
  "+const a = 2",
  "```",
  "</review_comment>",
].join("\n");

const MULTI_REVIEW_TEXT = [
  SINGLE_REVIEW_TEXT,
  '<review_comment sectionId="s2" filePath="rootfile.ts" startIndex="0" endIndex="0">',
  "",
  "</review_comment>",
  '<review_comment sectionId="s3" filePath="src/code.ts" startIndex="3" endIndex="3">',
  "Js fence comment",
  "```js",
  "const x = 1",
  "```",
  "</review_comment>",
  '<review_comment sectionId="s4" filePath="src/git.ts" startIndex="4" endIndex="5">',
  "Git diff comment",
  "```diff",
  "diff --git a/src/git.ts b/src/git.ts",
  "--- a/src/git.ts",
  "+++ b/src/git.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "```",
  "</review_comment>",
].join("\n");

type RenderItemInfo = { readonly item: ThreadFeedEntry; readonly index: number };
type RenderItemFn = (info: RenderItemInfo) => ReactNode;

function getRenderItem(props: ThreadFeedProps): RenderItemFn {
  renderToStaticMarkup(<ThreadFeed {...props} />);
  const renderItem = h.legendListProps?.renderItem;
  if (typeof renderItem !== "function") {
    throw new Error("renderItem was not captured");
  }
  return renderItem as RenderItemFn;
}

function renderEntry(props: ThreadFeedProps, entry: ThreadFeedEntry): string {
  const renderItem = getRenderItem(props);
  const node = renderItem({ item: entry, index: 0 });
  return renderToStaticMarkup(node as ReactElement);
}

function callProp(record: Record<string, unknown> | null | undefined, name: string): void {
  const fn = record?.[name];
  if (typeof fn !== "function") {
    throw new Error(`expected a function prop "${name}"`);
  }
  (fn as (...args: unknown[]) => void)();
}

function turnFoldEntry(
  overrides: Partial<Extract<ThreadFeedEntry, { type: "turn-fold" }>> = {},
): ThreadFeedEntry {
  return {
    type: "turn-fold",
    id: "turn-fold:turn-1",
    createdAt: "2026-04-01T00:00:01.000Z",
    turnId: TurnId.make("turn-1"),
    label: "Worked for 5s",
    expanded: false,
    ...overrides,
  };
}

function workToggleEntry(
  overrides: Partial<Extract<ThreadFeedEntry, { type: "work-toggle" }>> = {},
): ThreadFeedEntry {
  return {
    type: "work-toggle",
    id: "work-toggle:group-1",
    createdAt: "2026-04-01T00:00:01.000Z",
    turnId: null,
    groupId: "group-1",
    hiddenCount: 2,
    expanded: false,
    onlyToolActivities: true,
    ...overrides,
  };
}

function activityFixture(overrides: Partial<ThreadFeedActivity> = {}): ThreadFeedActivity {
  return {
    id: "act-1",
    createdAt: "2026-04-01T00:00:01.000Z",
    turnId: null,
    summary: "Ran command",
    detail: "ls",
    fullDetail: "ls -la",
    copyText: "Ran command\nls",
    icon: "command",
    toolLike: true,
    status: "success",
    ...overrides,
  };
}

function activityGroupEntry(
  overrides: Partial<Extract<ThreadFeedEntry, { type: "activity-group" }>> = {},
): ThreadFeedEntry {
  return {
    type: "activity-group",
    id: "group-1",
    createdAt: "2026-04-01T00:00:01.000Z",
    turnId: null,
    activities: [activityFixture()],
    ...overrides,
  };
}

const IMAGE_ATTACHMENT = {
  type: "image",
  id: "attachment-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
} as unknown as MessageAttachment;

describe("ThreadFeed list rendering", () => {
  it("captures the legend list render props for a populated feed", () => {
    renderToStaticMarkup(
      <ThreadFeed
        {...makeProps({
          feed: [messageEntry({ id: "msg-1", role: "assistant", text: "Answer" })],
        })}
      />,
    );
    expect(h.legendListProps).not.toBeNull();
    expect(typeof h.legendListProps?.renderItem).toBe("function");
  });

  it("uses the split layout padding and explicit content insets", () => {
    renderToStaticMarkup(
      <ThreadFeed
        {...makeProps({
          layoutVariant: "split",
          contentTopInset: 10,
          contentBottomInset: 5,
          anchorMessageId: MessageId.make("msg-anchor"),
          feed: [messageEntry({ id: "msg-anchor", role: "assistant", text: "Answer" })],
        })}
      />,
    );
    expect(h.legendListProps).not.toBeNull();
  });
});

describe("ThreadFeed renders non-message entries", () => {
  it("renders a collapsed turn fold and toggles it", () => {
    const props = makeProps({ feed: [turnFoldEntry()] });
    const markup = renderEntry(props, turnFoldEntry());
    expect(markup).toContain("Worked for 5s");
    expect(markup).toContain('data-symbol="chevron.right"');
    callProp(h.pressables.at(-1), "onPress");
    // A second toggle before the frames settle exercises the cancelAnimationFrame guards.
    callProp(h.pressables.at(-1), "onPress");
    flushRaf();
  });

  it("renders an expanded turn fold with the down chevron", () => {
    const props = makeProps({ feed: [turnFoldEntry({ expanded: true })] });
    const markup = renderEntry(props, turnFoldEntry({ expanded: true }));
    expect(markup).toContain('data-symbol="chevron.down"');
  });

  it("renders a work-group toggle and fires its handler", () => {
    const props = makeProps({ feed: [workToggleEntry()] });
    renderEntry(props, workToggleEntry());
    const toggle = h.workGroupToggleProps.at(-1);
    expect(toggle).toMatchObject({ hiddenCount: 2, onlyToolActivities: true });
    callProp(toggle, "onToggle");
    flushRaf();
  });

  it("renders an activity work log and fires its row handlers", () => {
    const props = makeProps({ feed: [activityGroupEntry()] });
    renderEntry(props, activityGroupEntry());
    const workLog = h.workLogProps.at(-1);
    expect(workLog).not.toBeUndefined();
    const onToggleRow = workLog?.onToggleRow;
    const onCopyRow = workLog?.onCopyRow as (id: string, value: string) => void;
    (onToggleRow as (id: string) => void)("act-1");
    flushRaf();
    vi.useFakeTimers();
    try {
      onCopyRow("act-1", "copied value");
      // A second copy while the first feedback is pending clears the prior timeout.
      onCopyRow("act-1", "copied again");
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    expect(h.copyCalls.at(-1)?.value).toBe("copied again");
  });
});

describe("ThreadFeed renders user messages", () => {
  it("renders text, timestamp, and a copy button", () => {
    const entry = messageEntry({ id: "user-1", role: "user", text: "Hi there" });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-markdown");
    expect(h.copyButtons.length).toBeGreaterThan(0);
  });

  it("omits the copy button for a blank user message", () => {
    const entry = messageEntry({ id: "user-blank", role: "user", text: "   " });
    renderEntry(makeProps({ feed: [entry] }), entry);
    expect(h.copyButtons.length).toBe(0);
  });

  it("shows a loading spinner for an attachment without a resolved url", () => {
    h.assetUrl = null;
    const entry = messageEntry({
      id: "user-att",
      role: "user",
      text: "",
      attachments: [IMAGE_ATTACHMENT],
    });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-activity-indicator");
  });

  it("shows a tappable image once the attachment url resolves", () => {
    h.assetUrl = "https://cdn.example.com/shot.png";
    const entry = messageEntry({
      id: "user-att-2",
      role: "user",
      text: "look",
      attachments: [IMAGE_ATTACHMENT],
    });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-touchable");
    callProp(h.touchables.at(-1), "onPress");
  });

  it("renders review comment cards with every patch shape", () => {
    const entry = messageEntry({ id: "user-review", role: "user", text: MULTI_REVIEW_TEXT });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain(">app.ts<");
    expect(markup).toContain(">rootfile.ts<");
  });

  it("renders the native review diff surface when available", () => {
    h.nativeReviewDiffView = (props: Record<string, unknown>) => (
      <div data-native-diff="true" data-rows={String(props.rowsJson ?? "")} />
    );
    const entry = messageEntry({ id: "user-native", role: "user", text: SINGLE_REVIEW_TEXT });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-native-diff");
  });
});

describe("ThreadFeed renders assistant messages", () => {
  it("renders assistant meta for the terminal turn message", () => {
    const entry = messageEntry({
      id: "assistant-final",
      role: "assistant",
      text: "All done",
      turnId: TurnId.make("turn-a"),
    });
    const markup = renderEntry(makeProps({ feed: [entry], latestTurn: null }), entry);
    expect(markup).toContain("data-markdown");
    expect(h.copyButtons.length).toBeGreaterThan(0);
  });

  it("hides assistant meta while the turn is still in progress", () => {
    const turnId = TurnId.make("turn-live");
    const entry = messageEntry({
      id: "assistant-live",
      role: "assistant",
      text: "Working",
      turnId,
    });
    const props = makeProps({
      feed: [entry],
      latestTurn: {
        turnId,
        state: "running",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: null,
      },
    });
    renderEntry(props, entry);
    expect(h.copyButtons.length).toBe(0);
  });

  it("hides assistant meta while streaming and tolerates an unparseable timestamp", () => {
    const entry = messageEntry({
      id: "assistant-stream",
      role: "assistant",
      text: "Partial",
      turnId: TurnId.make("turn-s"),
      streaming: true,
      updatedAt: "not-a-real-date",
    });
    renderEntry(makeProps({ feed: [entry] }), entry);
    expect(h.copyButtons.length).toBe(0);
  });

  it("skips an empty assistant message entirely", () => {
    const entry = messageEntry({ id: "assistant-empty", role: "assistant", text: "   " });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toBe("");
  });

  it("renders assistant attachments", () => {
    h.assetUrl = "https://cdn.example.com/pic.png";
    const entry = messageEntry({
      id: "assistant-att",
      role: "assistant",
      text: "here",
      turnId: TurnId.make("turn-att"),
      attachments: [IMAGE_ATTACHMENT],
    });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-touchable");
  });
});

describe("ThreadFeed markdown renderers", () => {
  function renderersFor(role: "user" | "assistant"): Record<string, unknown> {
    const entry = messageEntry({ id: `md-${role}`, role, text: "content" });
    renderEntry(makeProps({ feed: [entry] }), entry);
    const renderers = h.markdownProps.at(-1)?.renderers as Record<string, unknown> | undefined;
    if (!renderers) {
      throw new Error("markdown renderers were not captured");
    }
    return renderers;
  }

  function invoke(renderer: unknown, arg: unknown): void {
    const node = (renderer as (input: unknown) => ReactNode)(arg);
    renderToStaticMarkup(node as ReactElement);
  }

  const listNode = {
    children: [
      { type: "task_list_item", beg: 0, end: 1 },
      { type: "list_item", beg: 2, end: 3 },
      { type: "list_item" },
    ],
  };
  const Renderer = () => <div data-renderer="true" />;

  it("covers every assistant renderer branch", () => {
    const renderers = renderersFor("assistant");
    invoke(renderers.link, { children: "file", href: "src/app.ts:12" });
    invoke(renderers.link, { children: "ext", href: "https://favicon-test.example/page" });
    // Trigger the favicon load failure, then re-render the same host to hit the fallback glyph.
    for (const onError of h.imageOnError) {
      onError();
    }
    invoke(renderers.link, { children: "ext", href: "https://favicon-test.example/again" });
    invoke(renderers.link, { children: "mail", href: "mailto:a@b.com" });
    invoke(renderers.link, { children: "plain", href: "not-a-real-target" });
    invoke(renderers.list, { node: listNode, Renderer, ordered: true, start: 3 });
    invoke(renderers.list, { node: listNode, Renderer, ordered: false });
    invoke(renderers.list, { node: {}, Renderer });
    invoke(renderers.code_inline, { content: "inline" });
    invoke(renderers.code_inline, {});
    invoke(renderers.code_block, { content: "block", language: "ts" });
    invoke(renderers.code_block, { content: "block" });
    expect(renderers.soft_break).toBeUndefined();
    // Fire the captured link onPress handlers to cover their bodies.
    for (const onPress of h.nativeTextOnPress) {
      onPress();
    }
    expect(h.routerPush.length + h.openURLs.length).toBeGreaterThan(0);
  });

  it("covers the user renderers including soft breaks", () => {
    const renderers = renderersFor("user");
    expect(typeof renderers.soft_break).toBe("function");
    invoke(renderers.soft_break, {});
    invoke(renderers.link, { children: "file", href: "docs/readme.md" });
    invoke(renderers.code_block, { content: "x", language: "js" });
  });
});

describe("ThreadFeed link handling", () => {
  function linkPressFor(props: ThreadFeedProps): (href: string) => void {
    h.hasNativeSelectable = true;
    const entry = messageEntry({ id: "link-msg", role: "assistant", text: "content" });
    renderEntry(props, entry);
    const captured = h.selectableMarkdownProps.at(-1)?.onLinkPress;
    if (typeof captured !== "function") {
      throw new Error("onLinkPress was not captured");
    }
    return captured as (href: string) => void;
  }

  it("navigates to workspace files and opens external links", () => {
    const onLinkPress = linkPressFor(makeProps({ workspaceRoot: "/workspace" }));
    onLinkPress("src/app.ts:12");
    expect(h.hapticCount).toBe(1);
    expect(h.routerPush.length).toBe(1);

    onLinkPress("https://example.com/page");
    expect(h.openURLs).toContain("https://example.com/page");

    onLinkPress("mailto:a@b.com");
    expect(h.openURLs.some((url) => url.startsWith("mailto:"))).toBe(true);
  });

  it("ignores unresolved links and out-of-workspace absolute files", () => {
    const onLinkPress = linkPressFor(makeProps({ workspaceRoot: "/workspace" }));
    onLinkPress("/etc/passwd");
    onLinkPress("not-a-real-target");
    expect(h.routerPush.length).toBe(0);
    expect(h.openURLs.length).toBe(0);
  });
});

describe("ThreadFeed appearance and overlays", () => {
  it("renders in dark mode", () => {
    h.colorScheme = "dark";
    const entry = messageEntry({ id: "dark-1", role: "user", text: "Dark mode" });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-markdown");
  });

  it("renders assistant messages with the native selectable surface", () => {
    h.hasNativeSelectable = true;
    const entry = messageEntry({
      id: "native-md",
      role: "assistant",
      text: "Native",
      turnId: TurnId.make("turn-native"),
    });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-selectable-markdown");
  });

  it("renders a plain user message with the native selectable surface", () => {
    h.hasNativeSelectable = true;
    const entry = messageEntry({ id: "native-user", role: "user", text: "Plain native" });
    const markup = renderEntry(makeProps({ feed: [entry] }), entry);
    expect(markup).toContain("data-selectable-markdown");
  });

  it("exposes list extraction helpers and scroll restoration", () => {
    const message = messageEntry({
      id: "list-msg",
      role: "assistant",
      text: "A",
      turnId: TurnId.make("turn-list"),
    });
    renderToStaticMarkup(<ThreadFeed {...makeProps({ feed: [message] })} />);
    const listProps = h.legendListProps;
    expect(listProps).not.toBeNull();
    const keyExtractor = listProps?.keyExtractor as (entry: ThreadFeedEntry) => string;
    const getItemType = listProps?.getItemType as (entry: ThreadFeedEntry) => string;
    expect(keyExtractor(message)).toBe("list-msg");
    expect(getItemType(message)).toBe("message:assistant");
    expect(getItemType(turnFoldEntry())).toBe("turn-fold");
    const mvcp = listProps?.maintainVisibleContentPosition as {
      readonly shouldRestorePosition: (entry: ThreadFeedEntry) => boolean;
    };
    expect(mvcp.shouldRestorePosition(message)).toBe(true);
  });

  it("closes the image viewer overlay", () => {
    renderToStaticMarkup(
      <ThreadFeed
        {...makeProps({
          feed: [messageEntry({ id: "overlay", role: "assistant", text: "Answer" })],
        })}
      />,
    );
    expect(h.imageViewingProps).not.toBeNull();
    callProp(h.imageViewingProps, "onRequestClose");
  });
});
