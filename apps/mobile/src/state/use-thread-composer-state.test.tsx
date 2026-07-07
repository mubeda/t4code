import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { ComposerDraft } from "./use-composer-drafts";

// ── Instrumented hooks harness (see ChatView.hooks.test.tsx) ──────────
// `useCallback`/`useMemo` collapse to identity/eager evaluation so the hook can
// be invoked directly and its returned handlers exercised. Every collaborator
// hook is mocked so no real React hook executes outside a renderer.
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  selectedThreadShell: null as unknown,
  selectedThreadDetail: null as unknown,
  composerDrafts: {} as Record<string, unknown>,
  queuedByKey: {} as Record<string, ReadonlyArray<unknown>>,
  snapshot: { text: "", attachments: [] } as unknown,
  draft: { text: "", attachments: [] } as unknown,
  activeWorkStartedAt: null as unknown,
  feed: [] as ReadonlyArray<unknown>,
  // recorders
  setTextCalls: [] as Array<[string, string]>,
  appendTextCalls: [] as Array<[string, string]>,
  appendAttachmentCalls: [] as Array<[string, ReadonlyArray<unknown>]>,
  removeAttachmentCalls: [] as Array<[string, string]>,
  updateSettingsCalls: [] as Array<[string, unknown]>,
  clearContentCalls: [] as string[],
  ensureLoadedCalls: 0,
  enqueueCalls: [] as unknown[],
  enqueueImpl: (() => Promise.resolve()) as (message: unknown) => Promise<void>,
  pendingErrors: [] as Array<string | null>,
  feedCalls: [] as unknown[],
  pickResult: { images: [] as ReadonlyArray<unknown>, error: null as string | null },
  pasteResult: {
    images: [] as ReadonlyArray<unknown>,
    text: null as string | null,
    error: null as string | null,
  },
  convertResult: [] as ReadonlyArray<unknown>,
  convertImpl: null as null | (() => never),
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
  useAtomValue: (_atom: unknown) => h.composerDrafts,
}));

vi.mock("./use-composer-drafts", () => ({
  composerDraftsAtom: { key: "composer-drafts" },
  ensureComposerDraftsLoaded: () => {
    h.ensureLoadedCalls += 1;
  },
  getComposerDraftSnapshot: (_key: string) => h.snapshot,
  useComposerDraft: (_key: string | null) => h.draft,
  setComposerDraftText: (key: string, value: string) => {
    h.setTextCalls.push([key, value]);
  },
  appendComposerDraftText: (key: string, value: string) => {
    h.appendTextCalls.push([key, value]);
  },
  appendComposerDraftAttachments: (key: string, attachments: ReadonlyArray<unknown>) => {
    h.appendAttachmentCalls.push([key, attachments]);
  },
  removeComposerDraftAttachment: (key: string, imageId: string) => {
    h.removeAttachmentCalls.push([key, imageId]);
  },
  updateComposerDraftSettings: (key: string, settings: unknown) => {
    h.updateSettingsCalls.push([key, settings]);
  },
  clearComposerDraftContent: (key: string) => {
    h.clearContentCalls.push(key);
  },
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (_atom: unknown) => h.composerDrafts,
    set: () => undefined,
  },
}));

vi.mock("../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: (message: string | null) => {
    h.pendingErrors.push(message);
  },
}));

vi.mock("../state/use-thread-detail", () => ({
  useSelectedThreadDetail: () => h.selectedThreadDetail,
}));

vi.mock("../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: h.selectedThreadShell }),
}));

vi.mock("./thread-outbox", () => ({
  enqueueThreadOutboxMessage: (message: unknown) => {
    h.enqueueCalls.push(message);
    return h.enqueueImpl(message);
  },
}));

vi.mock("./use-thread-outbox", () => ({
  useThreadOutboxMessages: () => h.queuedByKey,
}));

vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    commandId: "cmd-1",
    messageId: "msg-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
}));

vi.mock("../lib/composerImages", () => ({
  pickComposerImages: (_input: unknown) => Promise.resolve(h.pickResult),
  pasteComposerClipboard: (_input: unknown) => Promise.resolve(h.pasteResult),
  convertPastedImagesToAttachments: (_input: unknown) => {
    if (h.convertImpl) {
      h.convertImpl();
    }
    return Promise.resolve(h.convertResult);
  },
}));

vi.mock("../lib/threadActivity", () => ({
  buildThreadFeed: (detail: unknown) => {
    h.feedCalls.push(detail);
    return h.feed;
  },
}));

vi.mock("@t3tools/client-runtime/errors", () => ({
  safeErrorLogAttributes: (_error: unknown) => ({}),
}));

vi.mock("@t3tools/shared/orchestrationTiming", () => ({
  deriveActiveWorkStartedAt: (..._args: ReadonlyArray<unknown>) => h.activeWorkStartedAt,
}));

import {
  appendReviewCommentToDraft,
  useThreadComposerState,
  useThreadDraftForThread,
} from "./use-thread-composer-state";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const codexInstanceId = ProviderInstanceId.make("codex");
const threadKey = `${environmentId}:${threadId}`;
const now = "2026-01-01T00:00:00.000Z";

const modelSelection: ModelSelection = { instanceId: codexInstanceId, model: "gpt-5.4" };

const ATTACHMENT: DraftComposerImageAttachment = {
  id: "img-1",
  previewUri: "file://preview-1.png",
  type: "image",
  name: "img-1.png",
  mimeType: "image/png",
  sizeBytes: 10,
  dataUrl: "data:image/png;base64,AAAA",
};

function makeShell(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function draftFixture(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return { text: "", attachments: [], ...overrides };
}

beforeEach(() => {
  h.effects.length = 0;
  h.selectedThreadShell = null;
  h.selectedThreadDetail = null;
  h.composerDrafts = {};
  h.queuedByKey = {};
  h.snapshot = draftFixture();
  h.draft = draftFixture();
  h.activeWorkStartedAt = null;
  h.feed = [];
  h.setTextCalls.length = 0;
  h.appendTextCalls.length = 0;
  h.appendAttachmentCalls.length = 0;
  h.removeAttachmentCalls.length = 0;
  h.updateSettingsCalls.length = 0;
  h.clearContentCalls.length = 0;
  h.ensureLoadedCalls = 0;
  h.enqueueCalls.length = 0;
  h.enqueueImpl = () => Promise.resolve();
  h.pendingErrors.length = 0;
  h.feedCalls.length = 0;
  h.pickResult = { images: [], error: null };
  h.pasteResult = { images: [], text: null, error: null };
  h.convertResult = [];
  h.convertImpl = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useThreadComposerState derived values", () => {
  it("derives composer state from the selected draft and outbox", () => {
    h.selectedThreadShell = makeShell();
    h.composerDrafts = {
      [threadKey]: draftFixture({
        text: "draft text",
        attachments: [ATTACHMENT],
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.1" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    };
    h.queuedByKey = { [threadKey]: [{}, {}] };

    const state = useThreadComposerState();

    expect(state.draftMessage).toBe("draft text");
    expect(state.draftAttachments).toEqual([ATTACHMENT]);
    expect(state.modelSelection).toEqual({ instanceId: codexInstanceId, model: "gpt-5.1" });
    expect(state.runtimeMode).toBe("approval-required");
    expect(state.interactionMode).toBe("plan");
    expect(state.selectedThreadQueueCount).toBe(2);
    expect(state.activeThreadBusy).toBe(false);
    expect(state.selectedThreadFeed).toEqual([]);
  });

  it("falls back to thread settings when the draft omits them", () => {
    h.selectedThreadShell = makeShell({
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    h.composerDrafts = {};

    const state = useThreadComposerState();

    expect(state.draftMessage).toBe("");
    expect(state.draftAttachments).toEqual([]);
    expect(state.modelSelection).toEqual(modelSelection);
    expect(state.runtimeMode).toBe("full-access");
    expect(state.interactionMode).toBe("default");
  });

  it("marks the thread busy and builds session activity while running", () => {
    h.selectedThreadShell = makeShell({
      session: { status: "running", activeTurnId: "turn-1" },
    });
    h.activeWorkStartedAt = now;

    const state = useThreadComposerState();

    expect(state.activeThreadBusy).toBe(true);
    expect(state.activeWorkStartedAt).toBe(now);
  });

  it("treats a starting session as busy", () => {
    h.selectedThreadShell = makeShell({ session: { status: "starting", activeTurnId: null } });
    expect(useThreadComposerState().activeThreadBusy).toBe(true);
  });

  it("builds the feed from the detailed thread when present", () => {
    h.selectedThreadShell = makeShell();
    h.selectedThreadDetail = makeShell({ session: { status: "ready", activeTurnId: null } });
    h.feed = [{ kind: "message" }];

    const state = useThreadComposerState();

    expect(state.selectedThreadFeed).toEqual([{ kind: "message" }]);
    expect(h.feedCalls).toHaveLength(1);
  });

  it("returns empty state and no-op handlers when no thread is selected", async () => {
    const state = useThreadComposerState();

    expect(state.draftMessage).toBe("");
    expect(state.modelSelection).toBeNull();
    expect(state.runtimeMode).toBeNull();
    expect(state.interactionMode).toBeNull();
    expect(state.activeThreadBusy).toBe(false);
    expect(state.selectedThreadQueueCount).toBe(0);
    expect(state.activeWorkStartedAt).toBeNull();

    // Every handler short-circuits without a selected thread.
    state.onChangeDraftMessage("ignored");
    await state.onPickDraftImages();
    await state.onPasteIntoDraft();
    await state.onNativePasteImages(["file://x"]);
    state.onRemoveDraftImage("img-1");
    state.onUpdateModelSelection(modelSelection);
    state.onUpdateRuntimeMode("full-access");
    state.onUpdateInteractionMode("plan");
    expect(await state.onSendMessage()).toBeNull();

    expect(h.setTextCalls).toHaveLength(0);
    expect(h.appendAttachmentCalls).toHaveLength(0);
    expect(h.updateSettingsCalls).toHaveLength(0);
    expect(h.enqueueCalls).toHaveLength(0);
  });

  it("runs the mount effect to hydrate drafts", () => {
    useThreadComposerState();
    for (const effect of h.effects) effect();
    expect(h.ensureLoadedCalls).toBe(1);
  });
});

describe("useThreadComposerState handlers", () => {
  beforeEach(() => {
    h.selectedThreadShell = makeShell();
  });

  it("onChangeDraftMessage writes to the scoped draft", () => {
    useThreadComposerState().onChangeDraftMessage("typing");
    expect(h.setTextCalls).toEqual([[threadKey, "typing"]]);
  });

  it("onSendMessage enqueues the snapshot and clears content", async () => {
    h.snapshot = draftFixture({
      text: "  hello  ",
      attachments: [ATTACHMENT],
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.1" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });

    const messageId = await useThreadComposerState().onSendMessage();

    expect(String(messageId)).toBe("msg-1");
    expect(h.enqueueCalls).toHaveLength(1);
    const enqueued = h.enqueueCalls[0] as Record<string, unknown>;
    expect(enqueued.environmentId).toBe(environmentId);
    expect(enqueued.threadId).toBe(threadId);
    expect(enqueued.text).toBe("hello");
    expect(enqueued.attachments).toEqual([ATTACHMENT]);
    expect(enqueued.modelSelection).toEqual({ instanceId: codexInstanceId, model: "gpt-5.1" });
    expect(enqueued.runtimeMode).toBe("approval-required");
    expect(h.clearContentCalls).toEqual([threadKey]);
  });

  it("onSendMessage falls back to thread settings when the snapshot omits them", async () => {
    h.snapshot = draftFixture({ text: "hi", attachments: [] });

    await useThreadComposerState().onSendMessage();

    const enqueued = h.enqueueCalls[0] as Record<string, unknown>;
    expect(enqueued.modelSelection).toEqual(modelSelection);
    expect(enqueued.runtimeMode).toBe("full-access");
    expect(enqueued.interactionMode).toBe("default");
  });

  it("onSendMessage returns null for an empty draft", async () => {
    h.snapshot = draftFixture({ text: "   ", attachments: [] });
    expect(await useThreadComposerState().onSendMessage()).toBeNull();
    expect(h.enqueueCalls).toHaveLength(0);
  });

  it("onSendMessage reports the error message when enqueue rejects", async () => {
    h.snapshot = draftFixture({ text: "hi", attachments: [] });
    h.enqueueImpl = () => Promise.reject(new Error("disk full"));

    expect(await useThreadComposerState().onSendMessage()).toBeNull();
    expect(h.pendingErrors).toContain("disk full");
  });

  it("onSendMessage reports a fallback error when enqueue rejects with a non-error", async () => {
    h.snapshot = draftFixture({ text: "hi", attachments: [] });
    h.enqueueImpl = () => Promise.reject("nope");

    expect(await useThreadComposerState().onSendMessage()).toBeNull();
    expect(h.pendingErrors).toContain("Failed to save the queued message.");
  });

  it("onPickDraftImages appends picked images and reports errors", async () => {
    h.pickResult = { images: [ATTACHMENT], error: "partial failure" };
    await useThreadComposerState().onPickDraftImages();
    expect(h.appendAttachmentCalls).toEqual([[threadKey, [ATTACHMENT]]]);
    expect(h.pendingErrors).toContain("partial failure");
  });

  it("onPickDraftImages does nothing when no images and no error", async () => {
    h.pickResult = { images: [], error: null };
    await useThreadComposerState().onPickDraftImages();
    expect(h.appendAttachmentCalls).toHaveLength(0);
    expect(h.pendingErrors).toHaveLength(0);
  });

  it("onPasteIntoDraft appends images, text, and reports errors", async () => {
    h.pasteResult = { images: [ATTACHMENT], text: "pasted", error: "warn" };
    await useThreadComposerState().onPasteIntoDraft();
    expect(h.appendAttachmentCalls).toEqual([[threadKey, [ATTACHMENT]]]);
    expect(h.appendTextCalls).toEqual([[threadKey, "pasted"]]);
    expect(h.pendingErrors).toContain("warn");
  });

  it("onPasteIntoDraft ignores an empty clipboard result", async () => {
    h.pasteResult = { images: [], text: null, error: null };
    await useThreadComposerState().onPasteIntoDraft();
    expect(h.appendAttachmentCalls).toHaveLength(0);
    expect(h.appendTextCalls).toHaveLength(0);
  });

  it("onNativePasteImages converts and appends images", async () => {
    h.convertResult = [ATTACHMENT];
    await useThreadComposerState().onNativePasteImages(["file://a"]);
    expect(h.appendAttachmentCalls).toEqual([[threadKey, [ATTACHMENT]]]);
  });

  it("onNativePasteImages ignores an empty uri list", async () => {
    await useThreadComposerState().onNativePasteImages([]);
    expect(h.appendAttachmentCalls).toHaveLength(0);
  });

  it("onNativePasteImages swallows conversion failures", async () => {
    h.convertImpl = () => {
      throw new Error("convert failed");
    };
    await useThreadComposerState().onNativePasteImages(["file://a"]);
    expect(h.appendAttachmentCalls).toHaveLength(0);
  });

  it("onRemoveDraftImage removes the scoped attachment", () => {
    useThreadComposerState().onRemoveDraftImage("img-1");
    expect(h.removeAttachmentCalls).toEqual([[threadKey, "img-1"]]);
  });

  it("onUpdateModelSelection / RuntimeMode / InteractionMode update settings", () => {
    const state = useThreadComposerState();
    state.onUpdateModelSelection(modelSelection);
    state.onUpdateRuntimeMode("approval-required");
    state.onUpdateInteractionMode("plan");
    expect(h.updateSettingsCalls).toEqual([
      [threadKey, { modelSelection }],
      [threadKey, { runtimeMode: "approval-required" }],
      [threadKey, { interactionMode: "plan" }],
    ]);
  });
});

describe("appendReviewCommentToDraft", () => {
  it("adds a paragraph separator when the draft already has content", () => {
    h.composerDrafts = { [threadKey]: draftFixture({ text: "existing" }) };
    appendReviewCommentToDraft({ environmentId, threadId, text: "comment" });
    expect(h.setTextCalls).toEqual([[threadKey, "existing\n\ncomment"]]);
    expect(h.appendAttachmentCalls).toHaveLength(0);
  });

  it("omits the separator for an empty draft and appends attachments", () => {
    h.composerDrafts = {};
    appendReviewCommentToDraft({
      environmentId,
      threadId,
      text: "comment",
      attachments: [ATTACHMENT],
    });
    expect(h.setTextCalls).toEqual([[threadKey, "comment"]]);
    expect(h.appendAttachmentCalls).toEqual([[threadKey, [ATTACHMENT]]]);
  });

  it("omits the separator when the draft already ends with a newline", () => {
    h.composerDrafts = { [threadKey]: draftFixture({ text: "existing\n" }) };
    appendReviewCommentToDraft({ environmentId, threadId, text: "comment" });
    expect(h.setTextCalls).toEqual([[threadKey, "existing\ncomment"]]);
  });
});

describe("useThreadDraftForThread", () => {
  it("returns the draft message and attachments for a scoped thread", () => {
    h.draft = draftFixture({ text: "draft body", attachments: [ATTACHMENT] });
    const result = useThreadDraftForThread({ environmentId, threadId });
    expect(result.draftMessage).toBe("draft body");
    expect(result.draftAttachments).toEqual([ATTACHMENT]);
  });

  it("handles a missing environment or thread id", () => {
    h.draft = draftFixture({ text: "" });
    const result = useThreadDraftForThread({});
    expect(result.draftMessage).toBe("");
    expect(result.draftAttachments).toEqual([]);
  });
});
