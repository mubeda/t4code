/**
 * Unit tests for {@link useThreadActions}.
 *
 * The hook is a bundle of async callbacks with no internal `useState`, so it is
 * exercised with the repo's harness-capture pattern (see Sidebar.test.tsx):
 * a tiny component calls the hook during a `renderToStaticMarkup` pass, the
 * returned object is captured, and its callbacks are then invoked directly with
 * fake refs/targets. Environment mutations run through a mocked
 * `useAtomCommand` that records every dispatch and returns per-key results;
 * failures are built from real `Cause` values so the hook's
 * `squashAtomCommandFailure`/`isAtomCommandInterrupted` logic runs for real.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@t4code/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t4code/contracts/settings";
import { createModelSelection } from "@t4code/shared/model";
import { scopeThreadRef, scopedThreadKey } from "@t4code/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t4code/client-runtime/state/models";
import { AsyncResult } from "effect/unstable/reactivity";
import { squashAtomCommandFailure } from "@t4code/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

// ── hoisted harness state shared by every vi.mock factory ─────────────────────

const h = vi.hoisted(() => {
  const state = {
    commandCalls: [] as Array<{ key: string; input: unknown }>,
    commandResults: {} as Record<string, (input: unknown) => unknown>,
    defaultCommandResult: (() => undefined) as (input?: unknown) => unknown,
    shellsById: new Map<string, unknown>(),
    threadRefs: [] as ScopedThreadRef[],
    project: null as unknown,
    localApi: null as unknown,
    settings: {} as Record<string, unknown>,
    handleNewThread: (() => Promise.resolve()) as (input: unknown) => Promise<unknown>,
    routerMatches: [] as Array<{ params: Record<string, string> }>,
    fallbackThreadId: null as unknown,
    orphanedWorktreePath: null as string | null,
    dependentPanelThreadIds: [] as ThreadId[],
    // spies
    navigate: vi.fn((_options: unknown) => Promise.resolve()),
    refreshArchived: vi.fn(),
    clearDraftThread: vi.fn(),
    clearProjectDraftThreadById: vi.fn(),
    clearTerminalUiState: vi.fn(),
    toastAdd: vi.fn(),
  };
  return state;
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouter: () => ({
      state: { matches: h.routerMatches },
      navigate: h.navigate,
    }),
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { key?: string } | null | undefined) => {
    const key = command && typeof command.key === "string" ? command.key : "unknown";
    return (input: unknown) => {
      h.commandCalls.push({ key, input });
      const respond = h.commandResults[key] ?? h.defaultCommandResult;
      return Promise.resolve(respond(input));
    };
  },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: { close: { key: "terminal.close" } },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    archive: { key: "thread.archive" },
    unarchive: { key: "thread.unarchive" },
    delete: { key: "thread.delete" },
    stopSession: { key: "thread.stopSession" },
  },
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    removeWorktree: { key: "vcs.removeWorktree" },
    refreshStatus: { key: "vcs.refreshStatus" },
  },
}));

vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: unknown) =>
    h.refreshArchived(environmentId),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: unknown) => unknown) =>
    selector({
      clearDraftThread: h.clearDraftThread,
      clearProjectDraftThreadById: h.clearProjectDraftThreadById,
    }),
}));

vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (selector: (state: unknown) => unknown) =>
    selector({ clearTerminalUiState: h.clearTerminalUiState }),
}));

vi.mock("./useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) => selector(h.settings),
}));

vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => h.handleNewThread,
}));

vi.mock("../state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => h.shellsById.get(ref.threadId) ?? null,
  readEnvironmentThreadRefs: (_environmentId: unknown) => h.threadRefs,
  readProject: (_ref: unknown) => h.project,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => h.localApi,
}));

vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: (_input: unknown) => h.fallbackThreadId,
}));

vi.mock("../worktreeCleanup", () => ({
  getOrphanedWorktreePathForThread: (_threads: unknown, _threadId: unknown) =>
    h.orphanedWorktreePath,
  getWorktreeDeletionPlanForThread: (_threads: unknown, _threadId: unknown) =>
    h.orphanedWorktreePath === null
      ? null
      : {
          worktreePath: h.orphanedWorktreePath,
          dependentPanelThreadIds: h.dependentPanelThreadIds,
        },
  formatWorktreePathForDisplay: (path: string) => `display:${path}`,
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: (toast: unknown) => h.toastAdd(toast) },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { ThreadArchiveBlockedError, useThreadActions } from "./useThreadActions";

// ── fixtures ──────────────────────────────────────────────────────────────────

const ENV = EnvironmentId.make("env-1");
const OTHER_ENV = EnvironmentId.make("env-2");
const PROJECT = ProjectId.make("project-a");
const iso = "2026-07-06T12:00:00.000Z";
const codex = ProviderInstanceId.make("codex");

type ThreadSession = NonNullable<EnvironmentThreadShell["session"]>;

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: ThreadId.make("thread-x"),
    status: "ready",
    providerName: "codex",
    activeTurnId: null,
    lastError: null,
    updatedAt: iso,
    runtimeMode: "full-access",
    ...overrides,
  } as ThreadSession;
}

function makeShell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT,
    title: `Thread ${id}`,
    modelSelection: createModelSelection(codex, "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: iso,
    updatedAt: iso,
    archivedAt: null,
    session: null,
    latestUserMessageAt: iso,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    environmentId: ENV,
    ...overrides,
  } as EnvironmentThreadShell;
}

function makeProject(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    id: PROJECT,
    title: "Repo A",
    workspaceRoot: "C:/repo-a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: iso,
    updatedAt: iso,
    environmentId: ENV,
    ...overrides,
  } as EnvironmentProject;
}

type Actions = ReturnType<typeof useThreadActions>;

let hookResult: Actions | null = null;

function Harness() {
  hookResult = useThreadActions();
  return null;
}

function renderActions(): Actions {
  hookResult = null;
  renderToStaticMarkup(createElement(Harness));
  if (!hookResult) throw new Error("hook did not produce a result");
  return hookResult;
}

/** Register a shell so `readThreadShell`/`readEnvironmentThreadRefs` resolve it. */
function registerShell(shell: EnvironmentThreadShell): ScopedThreadRef {
  h.shellsById.set(shell.id, shell);
  const ref = scopeThreadRef(shell.environmentId, shell.id);
  h.threadRefs = [...h.threadRefs, ref];
  return ref;
}

function setCurrentRoute(ref: ScopedThreadRef): void {
  h.routerMatches = [{ params: { environmentId: ref.environmentId, threadId: ref.threadId } }];
}

function failure(message: string) {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

function commandKeys(): string[] {
  return h.commandCalls.map((call) => call.key);
}

beforeEach(() => {
  h.commandCalls.length = 0;
  h.commandResults = {};
  h.defaultCommandResult = () => AsyncResult.success(undefined);
  h.shellsById.clear();
  h.threadRefs = [];
  h.project = makeProject();
  h.localApi = null;
  h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: false };
  h.handleNewThread = () => Promise.resolve();
  h.routerMatches = [];
  h.fallbackThreadId = null;
  h.orphanedWorktreePath = null;
  h.dependentPanelThreadIds = [];
  h.navigate.mockReset().mockImplementation(() => Promise.resolve());
  h.refreshArchived.mockReset();
  h.clearDraftThread.mockReset();
  h.clearProjectDraftThreadById.mockReset();
  h.clearTerminalUiState.mockReset();
  h.toastAdd.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("archiveThread", () => {
  it("resolves to success without dispatching when the thread is not in the store", async () => {
    const actions = renderActions();
    const result = await actions.archiveThread(scopeThreadRef(ENV, ThreadId.make("ghost")));
    expect(result._tag).toBe("Success");
    expect(commandKeys()).not.toContain("thread.archive");
  });

  it("blocks archiving a running thread with an active turn", async () => {
    const shell = makeShell("t-run", {
      session: makeSession({ status: "running", activeTurnId: "turn-1" as never }),
    });
    const ref = registerShell(shell);
    const actions = renderActions();

    const result = await actions.archiveThread(ref);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      expect(squashed).toBeInstanceOf(ThreadArchiveBlockedError);
    }
    expect(commandKeys()).not.toContain("thread.archive");
  });

  it("returns the archive failure verbatim", async () => {
    const ref = registerShell(makeShell("t-fail"));
    h.commandResults["thread.archive"] = () => failure("archive boom");
    const actions = renderActions();

    const result = await actions.archiveThread(ref);
    expect(result._tag).toBe("Failure");
    expect(h.refreshArchived).not.toHaveBeenCalled();
  });

  it("archives and refreshes when the thread is not the current route", async () => {
    const ref = registerShell(makeShell("t-ok"));
    const actions = renderActions();

    const result = await actions.archiveThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("thread.archive");
    expect(h.refreshArchived).toHaveBeenCalledWith(ENV);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("navigates to a fresh draft when archiving the current-route thread", async () => {
    const shell = makeShell("t-active");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    const seen: unknown[] = [];
    h.handleNewThread = (input) => {
      seen.push(input);
      return Promise.resolve();
    };
    const actions = renderActions();

    const result = await actions.archiveThread(ref);
    expect(result._tag).toBe("Success");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ environmentId: ENV, projectId: PROJECT });
    expect(h.refreshArchived).toHaveBeenCalledWith(ENV);
  });

  it("surfaces the navigation failure and skips the archived-threads refresh", async () => {
    const shell = makeShell("t-active");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    h.handleNewThread = () => Promise.reject(new Error("nav down"));
    const actions = renderActions();

    const result = await actions.archiveThread(ref);
    expect(result._tag).toBe("Failure");
    expect(h.refreshArchived).not.toHaveBeenCalled();
  });
});

describe("unarchiveThread", () => {
  it("refreshes archived threads on success", async () => {
    const ref = scopeThreadRef(ENV, ThreadId.make("t-arch"));
    const actions = renderActions();

    const result = await actions.unarchiveThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("thread.unarchive");
    expect(h.refreshArchived).toHaveBeenCalledWith(ENV);
  });

  it("does not refresh when unarchive fails", async () => {
    h.commandResults["thread.unarchive"] = () => failure("nope");
    const actions = renderActions();

    const result = await actions.unarchiveThread(scopeThreadRef(ENV, ThreadId.make("t-arch")));
    expect(result._tag).toBe("Failure");
    expect(h.refreshArchived).not.toHaveBeenCalled();
  });
});

describe("deleteThread", () => {
  it("dispatches a direct delete for a thread missing from the store", async () => {
    const actions = renderActions();
    const result = await actions.deleteThread(scopeThreadRef(ENV, ThreadId.make("archived-1")));
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toEqual(["thread.delete"]);
    expect(h.refreshArchived).toHaveBeenCalledWith(ENV);
  });

  it("returns the direct-delete failure without refreshing", async () => {
    h.commandResults["thread.delete"] = () => failure("delete boom");
    const actions = renderActions();
    const result = await actions.deleteThread(scopeThreadRef(ENV, ThreadId.make("archived-1")));
    expect(result._tag).toBe("Failure");
    expect(h.refreshArchived).not.toHaveBeenCalled();
  });

  it("stops a running session, closes the terminal, then deletes and clears state", async () => {
    const shell = makeShell("t-del", { session: makeSession({ status: "running" }) });
    const ref = registerShell(shell);
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toEqual(["thread.stopSession", "terminal.close", "thread.delete"]);
    expect(h.refreshArchived).toHaveBeenCalledWith(ENV);
    expect(h.clearDraftThread).toHaveBeenCalledWith(ref);
    expect(h.clearProjectDraftThreadById).toHaveBeenCalled();
    expect(h.clearTerminalUiState).toHaveBeenCalledWith(ref);
  });

  it("skips stopping the session when it is already stopped", async () => {
    const shell = makeShell("t-del", { session: makeSession({ status: "stopped" }) });
    const ref = registerShell(shell);
    const actions = renderActions();

    await actions.deleteThread(ref);
    expect(commandKeys()).not.toContain("thread.stopSession");
    expect(commandKeys()).toContain("terminal.close");
  });

  it("does not delete the thread or worktree when session teardown fails", async () => {
    const shell = makeShell("t-del", {
      session: makeSession({ status: "running" }),
      worktreePath: "C:/wt/x",
    });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    h.commandResults["thread.stopSession"] = () => failure("session still stopping");
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(commandKeys()).not.toContain("terminal.close");
    expect(commandKeys()).not.toContain("thread.delete");
    expect(commandKeys()).not.toContain("vcs.removeWorktree");
  });

  it("returns the delete failure after teardown", async () => {
    const ref = registerShell(makeShell("t-del"));
    h.commandResults["thread.delete"] = () => failure("cannot delete");
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(h.refreshArchived).not.toHaveBeenCalled();
  });

  it("does not delete the thread or worktree when terminal teardown fails", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    h.commandResults["terminal.close"] = () => failure("terminal still stopping");
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(commandKeys()).not.toContain("thread.delete");
    expect(commandKeys()).not.toContain("vcs.removeWorktree");
  });

  it("navigates to the fallback thread when deleting the current-route thread", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    const fallback = makeShell("t-fallback");
    registerShell(fallback);
    setCurrentRoute(ref);
    h.fallbackThreadId = fallback.id;
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(h.navigate).toHaveBeenCalledTimes(1);
    const navArg = h.navigate.mock.calls[0]![0] as { to: string; params: Record<string, string> };
    expect(navArg.to).toBe("/$environmentId/$threadId");
    expect(navArg.params).toEqual({ environmentId: ENV, threadId: fallback.id });
  });

  it("navigates to the index when the fallback thread is no longer present", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    h.fallbackThreadId = ThreadId.make("missing-fallback");
    const actions = renderActions();

    await actions.deleteThread(ref);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("navigates to the index when there is no fallback thread", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    h.fallbackThreadId = null;
    const actions = renderActions();

    await actions.deleteThread(ref);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("returns the navigation failure when routing to the index fails", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    h.navigate.mockImplementation(() => Promise.reject(new Error("route blew up")));
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
  });

  it("returns the navigation failure when routing to the fallback thread fails", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    const fallback = makeShell("t-fallback");
    registerShell(fallback);
    setCurrentRoute(ref);
    h.fallbackThreadId = fallback.id;
    h.navigate.mockImplementation(() => Promise.reject(new Error("route blew up")));
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
  });

  it("returns the navigation failure when the fallback is missing and the index route fails", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    setCurrentRoute(ref);
    h.fallbackThreadId = ThreadId.make("missing-fallback");
    h.navigate.mockImplementation(() => Promise.reject(new Error("route blew up")));
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
  });

  it("prompts, removes the orphaned worktree, and refreshes vcs status", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("vcs.removeWorktree");
    expect(commandKeys()).toContain("vcs.refreshStatus");
    expect(commandKeys().indexOf("vcs.removeWorktree")).toBeLessThan(
      commandKeys().indexOf("thread.delete"),
    );
    const removeCall = h.commandCalls.find((call) => call.key === "vcs.removeWorktree");
    expect((removeCall!.input as { input: { path: string; force: boolean } }).input.path).toBe(
      "C:/wt/x",
    );
  });

  it("tears down dependent panel threads before removing their workspace", async () => {
    const workspace = makeShell("t-workspace", {
      kind: "workspace",
      worktreePath: "C:/wt/x",
    });
    const workspaceRef = registerShell(workspace);
    const panel = makeShell("t-panel", {
      kind: "panel",
      worktreePath: "C:/wt/x",
      session: makeSession({ threadId: ThreadId.make("t-panel"), status: "running" }),
    });
    registerShell(panel);
    h.orphanedWorktreePath = "C:/wt/x";
    h.dependentPanelThreadIds = [panel.id];
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    const actions = renderActions();

    const result = await actions.deleteThread(workspaceRef);

    expect(result._tag).toBe("Success");
    const closeThreadIds = h.commandCalls
      .filter((call) => call.key === "terminal.close")
      .map((call) => (call.input as { input: { threadId: ThreadId } }).input.threadId);
    expect(closeThreadIds).toEqual([workspace.id, panel.id]);
    const deletedThreadIds = h.commandCalls
      .filter((call) => call.key === "thread.delete")
      .map((call) => (call.input as { input: { threadId: ThreadId } }).input.threadId);
    expect(deletedThreadIds).toEqual([panel.id, workspace.id]);
    expect(commandKeys().indexOf("vcs.removeWorktree")).toBeLessThan(
      commandKeys().indexOf("thread.delete"),
    );
  });

  it("does not remove the worktree when the user declines the prompt", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(false)) } };
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).not.toContain("vcs.removeWorktree");
  });

  it("returns the confirmation failure before touching the session", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.reject(new Error("dialog closed"))) } };
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(commandKeys()).not.toContain("thread.delete");
  });

  it("returns worktree removal failures for the caller to present", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    h.commandResults["vcs.removeWorktree"] = () => failure("removal failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(commandKeys()).not.toContain("thread.delete");
    expect(commandKeys()).not.toContain("vcs.refreshStatus");
    expect(h.toastAdd).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("presents post-removal refresh failures without reporting thread deletion as failed", async () => {
    const shell = makeShell("t-del", { worktreePath: "C:/wt/x" });
    const ref = registerShell(shell);
    h.orphanedWorktreePath = "C:/wt/x";
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(true)) } };
    h.commandResults["vcs.refreshStatus"] = () => failure("refresh failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const actions = renderActions();

    const result = await actions.deleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(h.toastAdd).toHaveBeenCalledTimes(1);
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Thread deleted, but VCS refresh failed",
      }),
    );
    errorSpy.mockRestore();
  });

  it("filters surviving threads from the deleted-thread key set", async () => {
    const shell = makeShell("t-del");
    const ref = registerShell(shell);
    const sibling = makeShell("t-sibling");
    registerShell(sibling);
    const actions = renderActions();

    const deletedKeys = new Set<string>([
      scopedThreadKey(scopeThreadRef(ENV, sibling.id)),
      // A key from another environment is ignored by the env filter.
      scopedThreadKey(scopeThreadRef(OTHER_ENV, ThreadId.make("elsewhere"))),
      "malformed-key-without-separator",
    ]);
    const result = await actions.deleteThread(ref, { deletedThreadKeys: deletedKeys });
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("thread.delete");
  });
});

describe("confirmAndDeleteThread", () => {
  it("deletes directly when confirmation is disabled", async () => {
    const ref = registerShell(makeShell("t-c"));
    h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: false };
    const actions = renderActions();

    const result = await actions.confirmAndDeleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("thread.delete");
  });

  it("deletes after the user confirms", async () => {
    const shell = makeShell("t-c", { title: "My thread" });
    const ref = registerShell(shell);
    h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: true };
    const confirm = vi.fn((_message: string) => Promise.resolve(true));
    h.localApi = { dialogs: { confirm } };
    const actions = renderActions();

    const result = await actions.confirmAndDeleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0]![0])).toContain('Delete thread "My thread"?');
    expect(commandKeys()).toContain("thread.delete");
  });

  it("short-circuits to success when the user cancels", async () => {
    const ref = registerShell(makeShell("t-c"));
    h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: true };
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.resolve(false)) } };
    const actions = renderActions();

    const result = await actions.confirmAndDeleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).not.toContain("thread.delete");
  });

  it("returns the confirmation failure", async () => {
    const ref = registerShell(makeShell("t-c"));
    h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: true };
    h.localApi = { dialogs: { confirm: vi.fn(() => Promise.reject(new Error("closed"))) } };
    const actions = renderActions();

    const result = await actions.confirmAndDeleteThread(ref);
    expect(result._tag).toBe("Failure");
    expect(commandKeys()).not.toContain("thread.delete");
  });

  it("falls back to a default title and deletes when no local api is present", async () => {
    const ref = registerShell(makeShell("t-c"));
    h.settings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadDelete: true };
    h.localApi = null;
    const actions = renderActions();

    const result = await actions.confirmAndDeleteThread(ref);
    expect(result._tag).toBe("Success");
    expect(commandKeys()).toContain("thread.delete");
  });
});
