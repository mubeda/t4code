import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t4code/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage, Thread } from "../types";
import type { ComposerImageAttachment } from "../composerDraftStore";

const atomRegistry = vi.hoisted(() => ({
  get: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: atomRegistry,
}));

import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildLocalDraftThread,
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveLockedProvider,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  resolveSendEnvMode,
  shouldWriteThreadErrorToCurrentServerThread,
  threadHasStarted,
  waitForStartedServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

beforeEach(() => {
  atomRegistry.get.mockReset();
  atomRegistry.subscribe.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("local draft and attachment helpers", () => {
  it("projects draft routing metadata into a local thread", () => {
    const result = buildLocalDraftThread(
      threadId,
      {
        threadId,
        environmentId,
        projectId,
        logicalProjectKey: "local:project-1",
        createdAt: now,
        runtimeMode: "read-only",
        interactionMode: "plan",
        branch: "feature/test",
        worktreePath: "/tmp/worktree",
        envMode: "worktree",
        startFromOrigin: true,
      },
      {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
    );

    expect(result).toMatchObject({
      id: threadId,
      environmentId,
      projectId,
      title: "New thread",
      runtimeMode: "read-only",
      interactionMode: "plan",
      branch: "feature/test",
      worktreePath: "/tmp/worktree",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("revokes only blob image previews and collects the same URLs", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL });
    const message = {
      role: "user",
      attachments: [
        { type: "text", previewUrl: "blob:not-an-image" },
        { type: "image", previewUrl: undefined },
        { type: "image", previewUrl: "https://example.test/image.png" },
        { type: "image", previewUrl: "blob:first" },
        { type: "image", previewUrl: "blob:second" },
      ],
    } as unknown as ChatMessage;

    revokeBlobPreviewUrl(undefined);
    revokeBlobPreviewUrl("https://example.test/image.png");
    revokeUserMessagePreviewUrls({ role: "assistant" } as ChatMessage);
    revokeUserMessagePreviewUrls(message);

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:first");
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:second");
    expect(collectUserMessageBlobPreviewUrls({ role: "system" } as ChatMessage)).toEqual([]);
    expect(collectUserMessageBlobPreviewUrls(message)).toEqual(["blob:first", "blob:second"]);
  });

  it("leaves blob previews alone when the URL API is unavailable", () => {
    vi.stubGlobal("URL", undefined);
    expect(() => revokeBlobPreviewUrl("blob:preview")).not.toThrow();
  });

  it("clones retry blob URLs while preserving non-blob and failed clones", () => {
    const file = new File(["image"], "image.png", { type: "image/png" });
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: file.size,
      previewUrl: "blob:original",
      file,
    };
    const createObjectURL = vi.fn(() => "blob:retry");
    vi.stubGlobal("URL", { createObjectURL });

    expect(cloneComposerImageForRetry(image)).toEqual({ ...image, previewUrl: "blob:retry" });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(cloneComposerImageForRetry({ ...image, previewUrl: "data:image/png;base64,eA==" })).toEqual({
      ...image,
      previewUrl: "data:image/png;base64,eA==",
    });

    createObjectURL.mockImplementation(() => {
      throw new Error("object URLs disabled");
    });
    expect(cloneComposerImageForRetry(image)).toBe(image);

    vi.stubGlobal("URL", undefined);
    expect(cloneComposerImageForRetry(image)).toBe(image);
  });
});

describe("readFileAsDataUrl", () => {
  class ScriptedFileReader {
    static outcomes: Array<{ result?: string | ArrayBuffer | null; error?: Error | null }> = [];
    result: string | ArrayBuffer | null = null;
    error: Error | null = null;
    private readonly listeners = new Map<string, () => void>();

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    readAsDataURL(): void {
      const outcome = ScriptedFileReader.outcomes.shift() ?? {};
      this.result = outcome.result ?? null;
      this.error = outcome.error ?? null;
      this.listeners.get("error" in outcome ? "error" : "load")?.();
    }
  }

  it("resolves string data and rejects non-string reader results", async () => {
    vi.stubGlobal("FileReader", ScriptedFileReader);
    const file = new File(["image"], "image.png", { type: "image/png" });
    ScriptedFileReader.outcomes.push(
      { result: "data:image/png;base64,aW1hZ2U=" },
      { result: new ArrayBuffer(1) },
    );

    await expect(readFileAsDataUrl(file)).resolves.toBe("data:image/png;base64,aW1hZ2U=");
    await expect(readFileAsDataUrl(file)).rejects.toThrow("Could not read image data.");
  });

  it("preserves reader errors and supplies a fallback error", async () => {
    vi.stubGlobal("FileReader", ScriptedFileReader);
    const file = new File(["image"], "image.png", { type: "image/png" });
    const failure = new Error("reader failed");
    ScriptedFileReader.outcomes.push({ error: failure }, { error: null });

    await expect(readFileAsDataUrl(file)).rejects.toBe(failure);
    await expect(readFileAsDataUrl(file)).rejects.toThrow("Failed to read image.");
  });
});

describe("thread lifecycle helpers", () => {
  it("detects every server-start signal and derives the locked provider fallback", () => {
    expect(threadHasStarted(undefined)).toBe(false);
    expect(threadHasStarted(makeThread())).toBe(false);
    expect(threadHasStarted(makeThread({ messages: [{ id: "message" } as never] }))).toBe(true);
    expect(threadHasStarted(makeThread({ latestTurn: completedTurn }))).toBe(true);
    expect(threadHasStarted(makeThread({ session: readySession }))).toBe(true);

    expect(
      deriveLockedProvider({
        thread: makeThread(),
        selectedProvider: "codex",
        threadProvider: "cursor",
      }),
    ).toBeNull();
    expect(
      deriveLockedProvider({
        thread: makeThread({ session: readySession }),
        selectedProvider: "cursor",
        threadProvider: "grok",
      }),
    ).toBe("codex");
    expect(
      deriveLockedProvider({
        thread: makeThread({
          session: { ...readySession, providerName: "" as never },
        }),
        selectedProvider: "cursor",
        threadProvider: "grok",
      }),
    ).toBe("grok");
    expect(
      deriveLockedProvider({
        thread: makeThread({ messages: [{ id: "message" } as never] }),
        selectedProvider: "cursor",
        threadProvider: "",
      }),
    ).toBe("cursor");
    expect(
      deriveLockedProvider({
        thread: makeThread({ latestTurn: completedTurn }),
        selectedProvider: "",
        threadProvider: null,
      }),
    ).toBeNull();
  });

  it("waits for subscription acknowledgement, immediate refresh, and timeout", async () => {
    const started = makeThread({ latestTurn: completedTurn });
    const unsubscribe = vi.fn();
    let listener: ((thread: Thread | undefined) => void) | undefined;
    atomRegistry.subscribe.mockImplementation((_atom, nextListener) => {
      listener = nextListener;
      return unsubscribe;
    });

    atomRegistry.get.mockReturnValueOnce(started);
    await expect(
      waitForStartedServerThread({ environmentId, threadId }, 50),
    ).resolves.toBe(true);
    expect(atomRegistry.subscribe).not.toHaveBeenCalled();

    atomRegistry.get.mockReset();
    atomRegistry.get.mockReturnValue(undefined);
    const subscribed = waitForStartedServerThread({ environmentId, threadId }, 50);
    listener?.(started);
    await expect(subscribed).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    atomRegistry.get.mockReset();
    atomRegistry.get.mockReturnValueOnce(undefined).mockReturnValueOnce(started);
    await expect(
      waitForStartedServerThread({ environmentId, threadId }, 50),
    ).resolves.toBe(true);

    vi.useFakeTimers();
    atomRegistry.get.mockReset();
    atomRegistry.get.mockReturnValue(undefined);
    const timedOut = waitForStartedServerThread({ environmentId, threadId }, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toBe(false);
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });

  it("blocks a restricted current provider and allows changes between unrestricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "stale-model",
        },
        currentProviderInstanceId: ProviderInstanceId.make("grok"),
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      }),
    ).not.toBeNull();

    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBeNull();
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge without a local dispatch snapshot", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: null,
        phase: "ready",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });

  it("requires a started latest turn while running and detects either session field settling", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const common = {
      localDispatch,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        phase: "running",
        latestTurn: null,
        session: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        phase: "ready",
        latestTurn: completedTurn,
        session: { ...readySession, status: "running" },
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        ...common,
        phase: "ready",
        latestTurn: completedTurn,
        session: { ...readySession, updatedAt: "2026-03-29T02:00:00.000Z" },
      }),
    ).toBe(true);
  });
});
