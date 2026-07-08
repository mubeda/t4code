import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

// ── Hoisted harness state ────────────────────────────────────────────
// Partial react + atom-react instrumentation lets `useComposerDraft` be
// invoked directly (see FilePreviewPanel.test.tsx pattern). The expo-file-system
// mock is a stateful in-memory file so the persistence round-trip is exercised
// without a real device filesystem.
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  readAtom: ((_atom: unknown) => undefined) as (atom: unknown) => unknown,
}));

const fs = vi.hoisted(() => ({
  content: null as string | null,
  exists: false,
  throwOnText: false,
  throwOnWrite: false,
  throwOnCreateDir: false,
  textCalls: 0,
  writeCalls: 0,
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
  useAtomValue: (atom: unknown) => h.readAtom(atom),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    constructor(..._args: ReadonlyArray<unknown>) {
      void _args;
    }
    create(_options?: unknown): void {
      if (fs.throwOnCreateDir) {
        throw new Error("mkdir failed");
      }
    }
  }
  class File {
    constructor(..._args: ReadonlyArray<unknown>) {
      void _args;
    }
    get exists(): boolean {
      return fs.exists;
    }
    text(): Promise<string> {
      fs.textCalls += 1;
      if (fs.throwOnText) {
        return Promise.reject(new Error("read failed"));
      }
      return Promise.resolve(fs.content ?? "");
    }
    create(_options?: unknown): void {
      fs.exists = true;
    }
    write(data: string): void {
      fs.writeCalls += 1;
      if (fs.throwOnWrite) {
        throw new Error("write failed");
      }
      fs.content = data;
      fs.exists = true;
    }
  }
  return { Paths: { document: "/docs" }, Directory, File };
});

import { appAtomRegistry } from "./atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraft,
  clearComposerDraftContent,
  clearComposerDraftContentState,
  composerDraftsAtom,
  ComposerDraftPersistenceError,
  decodePersistedComposerDrafts,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  removeComposerDraftsForEnvironment,
  replaceComposerDraftAttachments,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  type ComposerDraft,
} from "./use-composer-drafts";
import type { DraftComposerImageAttachment } from "../lib/composerImages";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

const ATTACHMENT: DraftComposerImageAttachment = {
  id: "img-1",
  previewUri: "file://preview-1.png",
  type: "image",
  name: "img-1.png",
  mimeType: "image/png",
  sizeBytes: 10,
  dataUrl: "data:image/png;base64,AAAA",
};

const ATTACHMENT_2: DraftComposerImageAttachment = {
  ...ATTACHMENT,
  id: "img-2",
  previewUri: "file://preview-2.png",
  name: "img-2.png",
};

function currentDrafts(): Record<string, ComposerDraft> {
  return appAtomRegistry.get(composerDraftsAtom);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Re-import the module (and its atom-registry) with a fresh module graph so the
 * module-private `loadPromise` / `persistTimer` state starts clean. The static
 * `vi.mock` factories still apply after `resetModules`.
 */
async function freshModule() {
  vi.resetModules();
  const mod = await import("./use-composer-drafts");
  const registry = (await import("./atom-registry")).appAtomRegistry;
  return { mod, registry };
}

beforeEach(() => {
  h.effects.length = 0;
  h.readAtom = (atom) => appAtomRegistry.get(atom as Parameters<typeof appAtomRegistry.get>[0]);
  fs.content = null;
  fs.exists = false;
  fs.throwOnText = false;
  fs.throwOnWrite = false;
  fs.throwOnCreateDir = false;
  fs.textCalls = 0;
  fs.writeCalls = 0;
  appAtomRegistry.set(composerDraftsAtom, {});
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("mobile composer drafts", () => {
  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("drops fully empty drafts while decoding persisted state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-empty": { text: "", attachments: [] },
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });
  });

  it("clears sent content without clearing the selected model or workspace", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        ...draft,
        text: "",
        attachments: [],
      },
    });
  });

  it("deletes a content-only draft when its content state is cleared", () => {
    const draftKey = "environment-1:thread-1";
    expect(
      clearComposerDraftContentState({ [draftKey]: { text: "bye", attachments: [] } }, draftKey),
    ).toEqual({});
  });

  it("returns the map unchanged when clearing content for a missing draft", () => {
    const map = { "environment-1:thread-1": DRAFT };
    expect(clearComposerDraftContentState(map, "environment-1:absent")).toBe(map);
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("returns the empty draft snapshot for an unknown key", () => {
    expect(getComposerDraftSnapshot("environment-1:absent")).toEqual({
      text: "",
      attachments: [],
    });
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });
});

describe("composer draft mutations", () => {
  const key = "environment-1:thread-1";

  it("sets and then clears draft text, deleting empty drafts", () => {
    setComposerDraftText(key, "typing");
    expect(currentDrafts()[key]).toEqual({ text: "typing", attachments: [] });

    // Clearing text on a content-only draft deletes the entry.
    setComposerDraftText(key, "");
    expect(currentDrafts()[key]).toBeUndefined();
  });

  it("keeps a draft with settings even when its text is cleared", () => {
    updateComposerDraftSettings(key, { runtimeMode: "approval-required" });
    setComposerDraftText(key, "");
    expect(currentDrafts()[key]).toEqual({
      text: "",
      attachments: [],
      runtimeMode: "approval-required",
    });
  });

  it("appends text onto the existing draft value", () => {
    setComposerDraftText(key, "foo");
    appendComposerDraftText(key, "bar");
    expect(currentDrafts()[key]?.text).toBe("foobar");
  });

  it("ignores empty attachment appends and appends non-empty ones", () => {
    appendComposerDraftAttachments(key, []);
    expect(currentDrafts()[key]).toBeUndefined();

    appendComposerDraftAttachments(key, [ATTACHMENT]);
    appendComposerDraftAttachments(key, [ATTACHMENT_2]);
    expect(currentDrafts()[key]?.attachments).toEqual([ATTACHMENT, ATTACHMENT_2]);
  });

  it("replaces attachments and deletes the draft when the result is empty", () => {
    appendComposerDraftAttachments(key, [ATTACHMENT]);
    replaceComposerDraftAttachments(key, [ATTACHMENT_2]);
    expect(currentDrafts()[key]?.attachments).toEqual([ATTACHMENT_2]);

    replaceComposerDraftAttachments(key, []);
    expect(currentDrafts()[key]).toBeUndefined();
  });

  it("removes a single attachment and deletes the draft when it becomes empty", () => {
    appendComposerDraftAttachments(key, [ATTACHMENT, ATTACHMENT_2]);
    removeComposerDraftAttachment(key, ATTACHMENT.id);
    expect(currentDrafts()[key]?.attachments).toEqual([ATTACHMENT_2]);

    removeComposerDraftAttachment(key, ATTACHMENT_2.id);
    expect(currentDrafts()[key]).toBeUndefined();
  });

  it("updates draft settings, keeping non-empty drafts", () => {
    updateComposerDraftSettings(key, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    });
    expect(currentDrafts()[key]?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });

  it("deletes the draft when a settings update leaves it empty", () => {
    updateComposerDraftSettings(key, { modelSelection: undefined });
    expect(currentDrafts()[key]).toBeUndefined();
  });

  it("clears draft content and deletes content-only drafts", () => {
    setComposerDraftText(key, "clear me");
    appendComposerDraftAttachments(key, [ATTACHMENT]);
    clearComposerDraftContent(key);
    expect(currentDrafts()[key]).toBeUndefined();
  });

  it("clears an existing draft and no-ops for a missing one", () => {
    setComposerDraftText(key, "delete me");
    clearComposerDraft(key);
    expect(currentDrafts()[key]).toBeUndefined();

    // No-op branch: clearing an absent draft leaves the map untouched.
    const before = currentDrafts();
    clearComposerDraft("environment-1:absent");
    expect(currentDrafts()).toBe(before);
  });
});

describe("useComposerDraft hook (instrumented)", () => {
  it("returns the empty draft for a null key and schedules hydration", () => {
    const result = useComposerDraft(null);
    expect(result).toEqual({ text: "", attachments: [] });
    // The mount effect was captured; running it triggers hydration.
    expect(h.effects).toHaveLength(1);
    h.effects[0]!();
  });

  it("returns the normalized draft for a known key", () => {
    const key = "environment-1:thread-1";
    appAtomRegistry.set(composerDraftsAtom, {
      [key]: { text: "draft", attachments: [ATTACHMENT] },
    });
    const result = useComposerDraft(key);
    expect(result).toEqual({ text: "draft", attachments: [ATTACHMENT] });
  });
});

describe("composer draft persistence (isolated module graph)", () => {
  const persistedContent =
    '{"schemaVersion":1,"drafts":{"environment-remote:thread-remote":{"text":"persisted","attachments":[]}}}';

  it("hydrates persisted drafts, letting in-memory drafts win on conflict", async () => {
    fs.exists = true;
    fs.content = persistedContent;
    const { mod, registry } = await freshModule();
    registry.set(mod.composerDraftsAtom, {
      "environment-remote:thread-remote": { text: "in-memory", attachments: [] },
      "environment-local:thread-local": { text: "local", attachments: [] },
    });

    mod.ensureComposerDraftsLoaded();
    await flushMicrotasks();

    expect(registry.get(mod.composerDraftsAtom)).toEqual({
      // in-memory value overrides the persisted one for the same key
      "environment-remote:thread-remote": { text: "in-memory", attachments: [] },
      "environment-local:thread-local": { text: "local", attachments: [] },
    });
    expect(fs.textCalls).toBe(1);
  });

  it("does not mutate state when there is no persisted file", async () => {
    fs.exists = false;
    const { mod, registry } = await freshModule();
    registry.set(mod.composerDraftsAtom, {
      "environment-local:thread-local": { text: "local", attachments: [] },
    });

    mod.ensureComposerDraftsLoaded();
    await flushMicrotasks();

    expect(registry.get(mod.composerDraftsAtom)).toEqual({
      "environment-local:thread-local": { text: "local", attachments: [] },
    });
  });

  it("only loads once even when hydration is requested repeatedly", async () => {
    fs.exists = true;
    fs.content = persistedContent;
    const { mod } = await freshModule();

    mod.ensureComposerDraftsLoaded();
    mod.ensureComposerDraftsLoaded();
    await flushMicrotasks();

    expect(fs.textCalls).toBe(1);
  });

  it("swallows a persisted read failure and keeps in-memory drafts", async () => {
    fs.exists = true;
    fs.throwOnText = true;
    const { mod, registry } = await freshModule();
    registry.set(mod.composerDraftsAtom, {
      "environment-local:thread-local": { text: "local", attachments: [] },
    });

    mod.ensureComposerDraftsLoaded();
    await flushMicrotasks();

    expect(registry.get(mod.composerDraftsAtom)).toEqual({
      "environment-local:thread-local": { text: "local", attachments: [] },
    });
  });

  it("clears an environment's drafts and persists the remainder", async () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retained = EnvironmentId.make("environment-local");
    const { mod, registry } = await freshModule();
    registry.set(mod.composerDraftsAtom, {
      [`${environmentId}:thread-cloud`]: { text: "cloud", attachments: [] },
      [`${retained}:thread-local`]: { text: "local", attachments: [] },
    });
    // Schedule a pending persist timer so the clear path also exercises the
    // `persistTimer !== null` cancellation branch.
    mod.setComposerDraftText(`${retained}:thread-local`, "local edited");

    await mod.clearComposerDraftsEnvironment(environmentId);

    expect(registry.get(mod.composerDraftsAtom)).toEqual({
      [`${retained}:thread-local`]: { text: "local edited", attachments: [] },
    });
    expect(fs.writeCalls).toBeGreaterThanOrEqual(1);
    expect(fs.content).toContain("environment-local");
    expect(fs.content).not.toContain("thread-cloud");
  });

  it("propagates a structured error when the persistence write fails", async () => {
    fs.throwOnWrite = true;
    const environmentId = EnvironmentId.make("environment-cloud");
    const { mod, registry } = await freshModule();
    registry.set(mod.composerDraftsAtom, {
      "environment-local:thread-local": { text: "local", attachments: [] },
    });

    const error = await mod
      .clearComposerDraftsEnvironment(environmentId)
      .then(() => null)
      .catch((cause: unknown) => cause);

    // The error originates from the freshly-imported module graph, so compare
    // against that graph's class rather than the statically-imported one.
    expect(error).toBeInstanceOf(mod.ComposerDraftPersistenceError);
    expect((error as ComposerDraftPersistenceError).operation).toBe("write");
  });
});

describe("composer draft debounced persistence", () => {
  const key = "environment-1:thread-1";

  it("persists drafts after the debounce window, collapsing rapid edits", async () => {
    setComposerDraftText(key, "first");
    // A second edit before the debounce fires cancels the earlier timer.
    setComposerDraftText(key, "second");

    await vi.advanceTimersByTimeAsync(200);

    expect(fs.writeCalls).toBe(1);
    expect(fs.content).toContain("second");
  });

  it("swallows a debounced write failure without throwing", async () => {
    fs.throwOnWrite = true;
    setComposerDraftText(key, "will fail to persist");

    // Advancing the debounce fires the write; the failure is swallowed so this
    // does not reject, and the in-memory draft is unaffected.
    await vi.advanceTimersByTimeAsync(200);
    expect(fs.writeCalls).toBe(1);
    expect(currentDrafts()[key]?.text).toBe("will fail to persist");
  });
});
