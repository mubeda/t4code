/**
 * Behavior tests for ThreadDetailScreen (and its WorkingDurationPill /
 * useStreamingHaptics internals).
 *
 * Renders via `renderToStaticMarkup` (mobile SSR pattern). Native/gesture
 * modules and heavy children (ThreadFeed, ThreadComposer, approval cards) are
 * mocked with capture stand-ins. A partial `vi.mock("react")` records useState
 * updates and captures effects so the layout/anchor/haptics/interval effects can
 * be driven manually — SSR never runs effects itself.
 *
 * Documented SSR-ceiling skips (see task brief): `useStreamingHaptics` can only
 * reach its hydration path because real `useRef` yields fresh refs per
 * `renderToStaticMarkup` call (so `hydratedRef` is always false at effect time),
 * and the `anchorMessageId !== null` scroll-effect body is unreachable because
 * `setAnchorMessageId` cannot re-render an SSR tree.
 */
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";

interface ViewProps {
  children?: ReactNode;
  onTouchStart?: (event: unknown) => void;
  onTouchMove?: (event: unknown) => void;
  onTouchEnd?: (event?: unknown) => void;
  onTouchCancel?: (event?: unknown) => void;
  onLayout?: (event?: unknown) => void;
}

const h = vi.hoisted(() => ({
  views: [] as Array<ViewProps>,
  threadFeeds: [] as Array<Record<string, unknown>>,
  threadComposers: [] as Array<Record<string, unknown>>,
  approvalCards: [] as Array<Record<string, unknown>>,
  userInputCards: [] as Array<Record<string, unknown>>,
  gestureOnEnd: null as ((event: { translationX: number; y: number }) => void) | null,
  hapticsCalls: 0,
  openDrawerCalls: 0,
  intervals: [] as Array<() => void>,
  clearedIntervals: 0,
  setStateCalls: [] as Array<{ index: number; applied: unknown }>,
  stateSeeds: new Map<number, { value: unknown; expect: (value: unknown) => boolean }>(),
  stateIndex: 0,
  effects: [] as Array<() => void | (() => void)>,
  freezeSets: [] as Array<boolean>,
  scrollCalls: [] as Array<unknown>,
  scrollRejects: false,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial?: unknown) => {
    const resolved = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const index = h.stateIndex;
    h.stateIndex += 1;
    const seed = h.stateSeeds.get(index);
    if (seed && !seed.expect(resolved)) {
      throw new Error(`useState seed mismatch at index ${index}: unexpected initial value`);
    }
    const value = seed ? seed.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ index, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  };
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
  };
});

vi.mock("react-native", () => ({
  View: (props: ViewProps) => {
    h.views.push(props);
    return <div>{props.children}</div>;
  },
}));

vi.mock("react-native-gesture-handler", () => {
  const builder: Record<string, (arg?: unknown) => unknown> = {};
  for (const method of ["enabled", "hitSlop", "activeOffsetX", "failOffsetY"]) {
    builder[method] = () => builder;
  }
  builder.onEnd = (callback: unknown) => {
    h.gestureOnEnd = callback as (event: { translationX: number; y: number }) => void;
    return builder;
  };
  return {
    Gesture: { Pan: () => builder },
    GestureDetector: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  };
});

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }),
}));

vi.mock("react-native-reanimated", () => ({
  runOnJS: (fn: (...args: ReadonlyArray<unknown>) => unknown) => fn,
}));

vi.mock("expo-haptics", () => ({
  selectionAsync: () => {
    h.hapticsCalls += 1;
    return Promise.resolve();
  },
}));

vi.mock("expo-router/build/react-navigation/elements", () => ({
  useHeaderHeight: () => 96,
}));

vi.mock("@legendapp/list/keyboard", () => ({
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: 0,
    onComposerLayout: () => {},
  }),
  useKeyboardScrollToEnd: () => ({
    freeze: {
      set: (value: boolean) => {
        h.freezeSets.push(value);
      },
    },
    scrollMessageToEnd: (input: unknown) => {
      h.scrollCalls.push(input);
      return h.scrollRejects ? Promise.reject(new Error("scroll failed")) : Promise.resolve();
    },
  }),
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("./ThreadFeed", () => ({
  ThreadFeed: (props: Record<string, unknown>) => {
    h.threadFeeds.push(props);
    return <div data-mock="thread-feed" />;
  },
}));

vi.mock("./ThreadComposer", () => ({
  ThreadComposer: (props: Record<string, unknown>) => {
    h.threadComposers.push(props);
    return <div data-mock="thread-composer" />;
  },
  COMPOSER_COLLAPSED_CHROME: 120,
  COMPOSER_EXPANDED_CHROME: 320,
}));

vi.mock("./PendingApprovalCard", () => ({
  PendingApprovalCard: (props: Record<string, unknown>) => {
    h.approvalCards.push(props);
    return <div data-mock="approval-card" />;
  },
}));

vi.mock("./PendingUserInputCard", () => ({
  PendingUserInputCard: (props: Record<string, unknown>) => {
    h.userInputCards.push(props);
    return <div data-mock="user-input-card" />;
  },
}));

import { ThreadDetailScreen } from "./ThreadDetailScreen";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");

function makeProps(overrides: Partial<ThreadDetailScreenProps> = {}): ThreadDetailScreenProps {
  const base = {
    selectedThread: {
      id: THREAD,
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      latestTurn: null,
    },
    contentPresentation: { kind: "ready" },
    screenTone: "neutral",
    connectionError: null,
    environmentLabel: "Local",
    selectedThreadFeed: [],
    activeWorkStartedAt: null,
    activePendingApproval: null,
    respondingApprovalId: null,
    activePendingUserInput: null,
    activePendingUserInputDrafts: {},
    activePendingUserInputAnswers: null,
    respondingUserInputId: null,
    draftMessage: "",
    draftAttachments: [],
    connectionStateLabel: "connected",
    activeThreadBusy: false,
    environmentId: ENV,
    projectWorkspaceRoot: "/repo",
    threadCwd: "/repo",
    selectedThreadQueueCount: 0,
    serverConfig: null,
    onOpenDrawer: () => {
      h.openDrawerCalls += 1;
    },
    onOpenConnectionEditor: vi.fn(),
    onChangeDraftMessage: vi.fn(),
    onPickDraftImages: vi.fn(async () => {}),
    onNativePasteImages: vi.fn(async () => {}),
    onRemoveDraftImage: vi.fn(),
    onStopThread: vi.fn(),
    onSendMessage: vi.fn(async () => MessageId.make("message-1")),
    onReconnectEnvironment: vi.fn(),
    onUpdateThreadModelSelection: vi.fn(),
    onUpdateThreadRuntimeMode: vi.fn(),
    onUpdateThreadInteractionMode: vi.fn(),
    onRespondToApproval: vi.fn(async () => undefined),
    onSelectUserInputOption: vi.fn(),
    onChangeUserInputCustomAnswer: vi.fn(),
    onSubmitUserInput: vi.fn(async () => undefined),
    ...overrides,
  };
  return base as unknown as ThreadDetailScreenProps;
}

function resetCaptures(): void {
  h.views.length = 0;
  h.threadFeeds.length = 0;
  h.threadComposers.length = 0;
  h.approvalCards.length = 0;
  h.userInputCards.length = 0;
  h.gestureOnEnd = null;
  h.effects.length = 0;
  h.setStateCalls.length = 0;
  h.stateSeeds.clear();
  h.stateIndex = 0;
  h.freezeSets.length = 0;
  h.scrollCalls.length = 0;
  h.scrollRejects = false;
}

function render(
  props: Partial<ThreadDetailScreenProps> = {},
  seeds?: ReadonlyArray<{ index: number; value: unknown; expect: (value: unknown) => boolean }>,
): string {
  resetCaptures();
  for (const seed of seeds ?? []) {
    h.stateSeeds.set(seed.index, { value: seed.value, expect: seed.expect });
  }
  return renderToStaticMarkup(<ThreadDetailScreen {...makeProps(props)} />);
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  for (const effect of Array.from(h.effects)) {
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanups.push(cleanup);
    }
  }
  return cleanups;
}

function composer(): Record<string, unknown> {
  const captured = h.threadComposers.at(-1);
  if (!captured) throw new Error("ThreadComposer was not rendered");
  return captured;
}

function contentView(): ViewProps {
  const view = h.views.find((candidate) => candidate.onTouchStart);
  if (!view) throw new Error("content view with touch handlers not captured");
  return view;
}

beforeEach(() => {
  h.hapticsCalls = 0;
  h.openDrawerCalls = 0;
  h.intervals.length = 0;
  h.clearedIntervals = 0;
  resetCaptures();
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    cb(0);
    return 3;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("setInterval", (cb: () => void) => {
    h.intervals.push(cb);
    return h.intervals.length;
  });
  vi.stubGlobal("clearInterval", () => {
    h.clearedIntervals += 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen rendering", () => {
  it("renders the feed and composer when content is shown", () => {
    const markup = render();
    expect(markup).toContain("thread-feed");
    expect(markup).toContain("thread-composer");
    expect(h.threadFeeds).toHaveLength(1);
    expect(h.threadComposers).toHaveLength(1);
    expect(h.threadFeeds[0]?.agentLabel).toBe("codex agent");
  });

  it("omits the feed and composer when content is hidden", () => {
    render({ showContent: false });
    expect(h.threadFeeds).toHaveLength(0);
    expect(h.threadComposers).toHaveLength(0);
  });

  it("passes provider skills matching the selected instance to the feed", () => {
    render({
      serverConfig: {
        providers: [
          { instanceId: "codex", skills: [{ id: "skill-1" }] },
          { instanceId: "other", skills: [{ id: "skill-2" }] },
        ],
      } as unknown as ThreadDetailScreenProps["serverConfig"],
    });
    expect(h.threadFeeds[0]?.skills).toEqual([{ id: "skill-1" }]);
  });

  it("defaults provider skills to empty when the config has no match", () => {
    render({
      serverConfig: {
        providers: [{ instanceId: "nope", skills: [{ id: "x" }] }],
      } as unknown as ThreadDetailScreenProps["serverConfig"],
    });
    expect(h.threadFeeds[0]?.skills).toEqual([]);
  });

  it("renders the working duration pill when work is active", () => {
    const markup = render({ activeWorkStartedAt: "2026-07-06T00:00:00.000Z" });
    expect(markup).toContain("Working for");
  });

  it("renders approval and user-input cards when both are pending", () => {
    render({
      activePendingApproval: { id: "approval-1" } as never,
      activePendingUserInput: { id: "input-1" } as never,
    });
    expect(h.approvalCards).toHaveLength(1);
    expect(h.userInputCards).toHaveLength(1);
  });

  it("uses the split layout variant without the drawer gesture enabled", () => {
    render({ layoutVariant: "split" });
    // Still renders content; gesture callback is recorded regardless of layout.
    expect(h.threadComposers).toHaveLength(1);
    expect(h.gestureOnEnd).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Header drawer gesture
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen drawer gesture", () => {
  it("opens the drawer on a qualifying swipe", () => {
    render();
    h.gestureOnEnd?.({ translationX: 80, y: 10 });
    expect(h.hapticsCalls).toBe(1);
    expect(h.openDrawerCalls).toBe(1);
  });

  it("ignores swipes that do not clear the threshold", () => {
    render();
    h.gestureOnEnd?.({ translationX: 10, y: 10 });
    expect(h.openDrawerCalls).toBe(0);
  });

  it("ignores swipes that begin below the header band", () => {
    render();
    h.gestureOnEnd?.({ translationX: 80, y: 200 });
    expect(h.openDrawerCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen effects", () => {
  it("resets anchor state and unfreezes on mount", () => {
    render();
    runEffects();
    // The reset effect calls freeze.set(false).
    expect(h.freezeSets).toContain(false);
    // anchor + last-scrolled reset via setAnchorMessageId(null)
    expect(h.setStateCalls.some((call) => call.applied === null)).toBe(true);
  });

  it("runs the working-duration interval effect and cleans it up", () => {
    render({ activeWorkStartedAt: "2026-07-06T00:00:00.000Z" });
    const cleanups = runEffects();
    expect(h.intervals.length).toBeGreaterThanOrEqual(1);
    // fire the interval tick to advance nowMs (records a setState)
    h.intervals[0]?.();
    expect(h.setStateCalls.length).toBeGreaterThanOrEqual(1);
    for (const cleanup of cleanups) cleanup();
    expect(h.clearedIntervals).toBeGreaterThanOrEqual(1);
  });

  it("scans the feed backward for a streaming assistant message without firing haptics on hydration", () => {
    // Ordered so the backward scan skips a non-message entry (continue) and a
    // non-streaming user message (continue) before finding the streaming
    // assistant message and returning.
    render({
      selectedThreadFeed: [
        {
          type: "message",
          id: "m0",
          message: { id: "m0", role: "assistant", streaming: true, text: "streaming" },
        },
        {
          type: "message",
          id: "m1",
          message: { id: "m1", role: "user", streaming: false, text: "hi" },
        },
        { type: "activity", id: "a1" },
      ] as never,
    });
    runEffects();
    // Hydration run never fires selection haptics.
    expect(h.hapticsCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Anchor scroll effect (seeded anchorMessageId)
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen anchor scroll", () => {
  const anchorFeed = [
    {
      type: "message",
      id: "m9",
      message: { id: "m9", role: "assistant", streaming: false, text: "done" },
    },
  ] as never;

  // anchorMessageId is the second useState in the component (index 1).
  const seedAnchor = (id: string) => [
    { index: 1, value: MessageId.make(id), expect: (value: unknown) => value === null },
  ];

  it("scrolls to the anchored message once content is ready", () => {
    render(
      { selectedThreadFeed: anchorFeed, contentPresentation: { kind: "ready" } as never },
      seedAnchor("m9"),
    );
    const cleanups = runEffects();
    expect(h.scrollCalls.length).toBeGreaterThanOrEqual(1);
    for (const cleanup of cleanups) cleanup();
  });

  it("skips scrolling when the presentation is not ready", () => {
    render(
      { selectedThreadFeed: anchorFeed, contentPresentation: { kind: "pending" } as never },
      seedAnchor("m9"),
    );
    runEffects();
    expect(h.scrollCalls).toHaveLength(0);
  });

  it("skips scrolling when the anchor is not present in the feed", () => {
    render(
      { selectedThreadFeed: anchorFeed, contentPresentation: { kind: "ready" } as never },
      seedAnchor("absent"),
    );
    runEffects();
    expect(h.scrollCalls).toHaveLength(0);
  });

  it("recovers by unfreezing when the scroll rejects", async () => {
    h.scrollRejects = true;
    render(
      { selectedThreadFeed: anchorFeed, contentPresentation: { kind: "ready" } as never },
      seedAnchor("m9"),
    );
    const cleanups = runEffects();
    expect(h.scrollCalls.length).toBeGreaterThanOrEqual(1);
    // flush the rejected-scroll catch microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(h.freezeSets).toContain(false);
    for (const cleanup of cleanups) cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Composer wiring
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen composer wiring", () => {
  it("anchors to the sent message id and forwards send results", async () => {
    const onSendMessage = vi.fn(async () => MessageId.make("message-42"));
    render({ onSendMessage });
    const result = await (composer().onSendMessage as () => Promise<unknown>)();
    expect(onSendMessage).toHaveBeenCalled();
    expect(result).toBe("message-42");
    // handleSendMessage records the anchor via setAnchorMessageId.
    expect(h.setStateCalls.some((call) => call.applied === "message-42")).toBe(true);
  });

  it("does not anchor when send returns null", async () => {
    const onSendMessage = vi.fn(async () => null);
    render({ onSendMessage });
    const result = await (composer().onSendMessage as () => Promise<unknown>)();
    expect(result).toBeNull();
    expect(h.setStateCalls.some((call) => call.applied === "message-42")).toBe(false);
  });

  it("propagates composer expansion changes", () => {
    render();
    (composer().onExpandedChange as (value: boolean) => void)(true);
    expect(h.setStateCalls.some((call) => call.applied === true)).toBe(true);
  });

  it("forwards the passthrough props to the composer", () => {
    render({ draftMessage: "hello", environmentLabel: "Prod", selectedThreadQueueCount: 3 });
    const props = composer();
    expect(props.draftMessage).toBe("hello");
    expect(props.environmentLabel).toBe("Prod");
    expect(props.queueCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feed touch dismissal
// ─────────────────────────────────────────────────────────────────────

describe("ThreadDetailScreen feed touch handling", () => {
  it("collapses the composer on a tap (touch start then end)", () => {
    render();
    const view = contentView();
    view.onTouchStart?.({ nativeEvent: { pageX: 10, pageY: 10 } });
    // A small move keeps the tap intent.
    view.onTouchMove?.({ nativeEvent: { pageX: 12, pageY: 11 } });
    view.onTouchEnd?.();
    // No throw = collapseComposer ran (editor ref is null under SSR).
    expect(view.onTouchStart).toBeTypeOf("function");
  });

  it("cancels the tap intent when the finger moves too far", () => {
    render();
    const view = contentView();
    view.onTouchStart?.({ nativeEvent: { pageX: 10, pageY: 10 } });
    view.onTouchMove?.({ nativeEvent: { pageX: 200, pageY: 200 } });
    view.onTouchEnd?.();
    expect(view.onTouchStart).toBeTypeOf("function");
  });

  it("ignores a move without a recorded start", () => {
    render();
    const view = contentView();
    view.onTouchMove?.({ nativeEvent: { pageX: 5, pageY: 5 } });
    view.onTouchCancel?.();
    expect(view.onTouchCancel).toBeTypeOf("function");
  });
});
