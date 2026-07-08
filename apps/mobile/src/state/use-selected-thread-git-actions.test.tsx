import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type {
  EnvironmentThreadShell,
  EnvironmentProject,
} from "@t3tools/client-runtime/state/shell";
import type { GitActionRequestInput } from "@t3tools/client-runtime/state/vcs";

// ── Instrumented hooks harness (see AddProjectScreen.test.tsx) ────────
// The hook is invoked directly with identity useCallback/useMemo; every
// collaborator (atom commands, branch query, selection, worktree) is mocked so
// no real React hook runs outside a renderer. Real AsyncResult/Cause drive the
// success/failure command arms.
type Respond = (input: unknown) => unknown;

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  selectedThread: null as unknown,
  selectedThreadProject: null as unknown,
  cwd: null as string | null,
  worktreePath: null as string | null,
  branchData: null as { refs: ReadonlyArray<unknown> } | null,
  branchRefreshCalls: 0,
  commandCalls: [] as Array<{ key: string; input: unknown }>,
  commandResults: {} as Record<string, Respond>,
  defaultRespond: (() => undefined) as Respond,
  trackCalls: 0,
  pendingErrors: [] as Array<string | null>,
  gitResults: [] as unknown[],
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

vi.mock("./threads", () => ({
  threadEnvironment: { updateMetadata: { key: "updateMetadata" } },
}));

vi.mock("./vcs", () => ({
  vcsEnvironment: {
    refreshStatus: { key: "refreshStatus" },
    switchRef: { key: "switchRef" },
    createRef: { key: "createRef" },
    createWorktree: { key: "createWorktree" },
    pull: { key: "pull" },
  },
  vcsActionManager: {
    runStackedAction: (_args: unknown) => ({ key: "runStackedAction" }),
    track: (_registry: unknown, _target: unknown, _meta: unknown, execute: () => unknown) => {
      h.trackCalls += 1;
      return execute();
    },
  },
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: { key?: string } | null) => (input: unknown) => {
    const key = command?.key ?? "unknown";
    h.commandCalls.push({ key, input });
    const respond = h.commandResults[key] ?? h.defaultRespond;
    return Promise.resolve(respond(input));
  },
}));

vi.mock("../state/queries", () => ({
  useBranches: (_target: unknown) => ({
    data: h.branchData,
    error: null,
    isPending: false,
    refresh: () => {
      h.branchRefreshCalls += 1;
    },
  }),
}));

vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: h.selectedThread,
    selectedThreadProject: h.selectedThreadProject,
  }),
}));

vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: h.cwd,
    selectedThreadWorktreePath: h.worktreePath,
  }),
}));

vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: (message: string | null) => {
    h.pendingErrors.push(message);
  },
}));

vi.mock("./use-vcs-action-state", () => ({
  showGitActionResult: (result: unknown) => {
    h.gitResults.push(result);
  },
}));

vi.mock("./atom-registry", () => ({
  appAtomRegistry: { get: () => undefined, set: () => undefined },
}));

vi.mock("@t3tools/shared/git", () => ({
  dedupeRemoteBranchesWithLocalMatches: (refs: ReadonlyArray<unknown>) => refs,
  sanitizeFeatureBranchName: (name: string) => `sanitized-${name}`,
}));

vi.mock("../lib/uuid", () => ({ uuidv4: () => "action-uuid" }));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

function makeThread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    branch: "main",
    worktreePath: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function makeProject(overrides: Record<string, unknown> = {}): EnvironmentProject {
  return {
    environmentId,
    workspaceRoot: "/repo",
    ...overrides,
  } as unknown as EnvironmentProject;
}

function commandCallsFor(key: string): Array<{ key: string; input: unknown }> {
  return h.commandCalls.filter((call) => call.key === key);
}

function selectConnectedThread(): void {
  h.selectedThread = makeThread();
  h.selectedThreadProject = makeProject();
  h.cwd = "/repo/worktree";
  h.worktreePath = "/repo/worktree";
}

beforeEach(() => {
  h.effects.length = 0;
  h.selectedThread = null;
  h.selectedThreadProject = null;
  h.cwd = null;
  h.worktreePath = null;
  h.branchData = null;
  h.branchRefreshCalls = 0;
  h.commandCalls.length = 0;
  h.commandResults = {};
  h.defaultRespond = () => AsyncResult.success(undefined);
  h.trackCalls = 0;
  h.pendingErrors.length = 0;
  h.gitResults.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshSelectedThreadGitStatus", () => {
  it("returns null when no thread is selected", async () => {
    const actions = useSelectedThreadGitActions();
    expect(await actions.refreshSelectedThreadGitStatus()).toBeNull();
    // Mount effect is a no-op without a thread.
    for (const effect of h.effects) effect();
    expect(h.commandCalls).toHaveLength(0);
  });

  it("returns null when there is no working directory", async () => {
    h.selectedThread = makeThread();
    h.selectedThreadProject = makeProject();
    h.cwd = null;
    const actions = useSelectedThreadGitActions();
    expect(await actions.refreshSelectedThreadGitStatus()).toBeNull();
  });

  it("refreshes through the action tracker and clears pending errors", async () => {
    selectConnectedThread();
    h.commandResults.refreshStatus = () => AsyncResult.success({ isRepo: true });

    const actions = useSelectedThreadGitActions();
    const result = await actions.refreshSelectedThreadGitStatus();

    expect(result).toEqual({ isRepo: true });
    expect(commandCallsFor("refreshStatus")).toHaveLength(1);
    expect(h.trackCalls).toBe(1);
    expect(h.pendingErrors).toContain(null);
  });

  it("bypasses the tracker for a quiet refresh", async () => {
    selectConnectedThread();
    h.commandResults.refreshStatus = () => AsyncResult.success({ isRepo: true });

    const actions = useSelectedThreadGitActions();
    await actions.refreshSelectedThreadGitStatus({ quiet: true });

    expect(commandCallsFor("refreshStatus")).toHaveLength(1);
    expect(h.trackCalls).toBe(0);
  });

  it("reports the error message when a refresh fails", async () => {
    selectConnectedThread();
    h.commandResults.refreshStatus = () => AsyncResult.failure(Cause.fail(new Error("git down")));

    const actions = useSelectedThreadGitActions();
    expect(await actions.refreshSelectedThreadGitStatus()).toBeNull();
    expect(h.pendingErrors).toContain("git down");
  });

  it("uses a fallback message for a non-error refresh failure", async () => {
    selectConnectedThread();
    h.commandResults.refreshStatus = () => AsyncResult.failure(Cause.fail("weird"));

    const actions = useSelectedThreadGitActions();
    expect(await actions.refreshSelectedThreadGitStatus()).toBeNull();
    expect(h.pendingErrors).toContain("Failed to refresh git status.");
  });

  it("runs a quiet refresh from the mount effect", () => {
    selectConnectedThread();
    useSelectedThreadGitActions();
    for (const effect of h.effects) effect();
    expect(commandCallsFor("refreshStatus")).toHaveLength(1);
  });
});

describe("branch mutations", () => {
  it("no-ops handlers when no thread is selected", async () => {
    const actions = useSelectedThreadGitActions();
    await actions.onPullSelectedThreadBranch();
    await actions.onCheckoutSelectedThreadBranch("feature");
    expect(h.commandCalls).toHaveLength(0);
    expect(h.gitResults).toHaveLength(0);
  });

  it("checks out a branch and syncs thread state", async () => {
    selectConnectedThread();
    h.commandResults.switchRef = () => AsyncResult.success({ refName: "feature" });

    const actions = useSelectedThreadGitActions();
    await actions.onCheckoutSelectedThreadBranch("feature");

    const switchCall = commandCallsFor("switchRef")[0]!.input as {
      environmentId: EnvironmentId;
      input: { cwd: string; refName: string };
    };
    expect(switchCall.input).toEqual({ cwd: "/repo/worktree", refName: "feature" });
    const updateCall = commandCallsFor("updateMetadata")[0]!.input as {
      input: { threadId: ThreadId; branch: string; worktreePath: string | null };
    };
    expect(updateCall.input.branch).toBe("feature");
    expect(updateCall.input.worktreePath).toBe("/repo/worktree");
    expect(h.branchRefreshCalls).toBeGreaterThanOrEqual(1);
    expect(h.gitResults).toHaveLength(0);
  });

  it("falls back to the thread branch when switchRef omits a ref name", async () => {
    selectConnectedThread();
    h.selectedThread = makeThread({ branch: "existing" });
    h.commandResults.switchRef = () => AsyncResult.success({ refName: null });

    const actions = useSelectedThreadGitActions();
    await actions.onCheckoutSelectedThreadBranch("feature");

    const updateCall = commandCallsFor("updateMetadata")[0]!.input as {
      input: { branch: string };
    };
    expect(updateCall.input.branch).toBe("existing");
  });

  it("reports a checkout failure and skips the sync", async () => {
    selectConnectedThread();
    h.commandResults.switchRef = () => AsyncResult.failure(Cause.fail(new Error("checkout boom")));

    const actions = useSelectedThreadGitActions();
    await actions.onCheckoutSelectedThreadBranch("feature");

    expect(commandCallsFor("updateMetadata")).toHaveLength(0);
    expect(h.pendingErrors).toContain("checkout boom");
    expect(h.gitResults).toEqual([
      { type: "error", title: "Git action failed", description: "checkout boom" },
    ]);
  });

  it("surfaces a sync failure after a successful checkout", async () => {
    selectConnectedThread();
    h.commandResults.switchRef = () => AsyncResult.success({ refName: "feature" });
    h.commandResults.updateMetadata = () => AsyncResult.failure(Cause.fail(new Error("meta boom")));

    const actions = useSelectedThreadGitActions();
    await actions.onCheckoutSelectedThreadBranch("feature");

    expect(h.gitResults).toEqual([
      { type: "error", title: "Git action failed", description: "meta boom" },
    ]);
  });

  it("creates a branch with switchRef and syncs", async () => {
    selectConnectedThread();
    h.commandResults.createRef = () => AsyncResult.success({ refName: "new-branch" });

    const actions = useSelectedThreadGitActions();
    await actions.onCreateSelectedThreadBranch("new-branch");

    const createCall = commandCallsFor("createRef")[0]!.input as {
      input: { cwd: string; refName: string; switchRef: boolean };
    };
    expect(createCall.input).toEqual({
      cwd: "/repo/worktree",
      refName: "new-branch",
      switchRef: true,
    });
    expect(commandCallsFor("updateMetadata")[0]!.input).toBeDefined();
  });

  it("reports a create-branch failure", async () => {
    selectConnectedThread();
    h.commandResults.createRef = () => AsyncResult.failure(Cause.fail(new Error("create boom")));

    const actions = useSelectedThreadGitActions();
    await actions.onCreateSelectedThreadBranch("new-branch");

    expect(commandCallsFor("updateMetadata")).toHaveLength(0);
    expect(h.pendingErrors).toContain("create boom");
  });

  it("creates a worktree with a sanitized branch name and syncs", async () => {
    selectConnectedThread();
    h.commandResults.createWorktree = () =>
      AsyncResult.success({ worktree: { path: "/repo/wt", refName: "feature-wt" } });

    const actions = useSelectedThreadGitActions();
    await actions.onCreateSelectedThreadWorktree({ baseBranch: "main", newBranch: "feat" });

    const createCall = commandCallsFor("createWorktree")[0]!.input as {
      input: { cwd: string; refName: string; newRefName: string; path: string | null };
    };
    expect(createCall.input.cwd).toBe("/repo");
    expect(createCall.input.refName).toBe("main");
    expect(createCall.input.newRefName).toBe("sanitized-feat");
    const updateCall = commandCallsFor("updateMetadata")[0]!.input as {
      input: { branch: string; worktreePath: string };
    };
    expect(updateCall.input.branch).toBe("feature-wt");
    expect(updateCall.input.worktreePath).toBe("/repo/wt");
  });

  it("reports a worktree creation failure", async () => {
    selectConnectedThread();
    h.commandResults.createWorktree = () =>
      AsyncResult.failure(Cause.fail(new Error("worktree boom")));

    const actions = useSelectedThreadGitActions();
    await actions.onCreateSelectedThreadWorktree({ baseBranch: "main", newBranch: "feat" });

    expect(h.pendingErrors).toContain("worktree boom");
    expect(commandCallsFor("updateMetadata")).toHaveLength(0);
  });
});

describe("pull", () => {
  it("pulls and shows the pulled-latest toast", async () => {
    selectConnectedThread();
    h.commandResults.pull = () => AsyncResult.success({ status: "pulled", refName: "main" });

    const actions = useSelectedThreadGitActions();
    await actions.onPullSelectedThreadBranch();

    expect(h.gitResults).toEqual([{ type: "success", title: "Pulled latest on main" }]);
    expect(commandCallsFor("refreshStatus")).toHaveLength(1);
  });

  it("shows the up-to-date toast when the pull is skipped", async () => {
    selectConnectedThread();
    h.commandResults.pull = () =>
      AsyncResult.success({ status: "skipped_up_to_date", refName: "main" });

    const actions = useSelectedThreadGitActions();
    await actions.onPullSelectedThreadBranch();

    expect(h.gitResults).toEqual([{ type: "success", title: "Already up to date" }]);
  });

  it("reports a pull failure", async () => {
    selectConnectedThread();
    h.commandResults.pull = () => AsyncResult.failure(Cause.fail(new Error("pull boom")));

    const actions = useSelectedThreadGitActions();
    await actions.onPullSelectedThreadBranch();

    expect(h.pendingErrors).toContain("pull boom");
    expect(h.gitResults).toEqual([
      { type: "error", title: "Git action failed", description: "pull boom" },
    ]);
  });
});

describe("onRunSelectedThreadGitAction", () => {
  const request: GitActionRequestInput = {
    action: "commit_and_push",
    commitMessage: "msg",
    featureBranch: "feat",
    filePaths: ["a.ts", "b.ts"],
  } as unknown as GitActionRequestInput;

  it("runs the stacked action, opens the PR toast, and syncs a created branch", async () => {
    selectConnectedThread();
    h.commandResults.runStackedAction = () =>
      AsyncResult.success({
        toast: {
          title: "Pushed",
          description: "Opened PR",
          cta: { kind: "open_pr", url: "https://example.com/pr/1" },
        },
        branch: { status: "created", name: "feat-x" },
      });

    const actions = useSelectedThreadGitActions();
    const result = await actions.onRunSelectedThreadGitAction(request);

    expect(result).not.toBeNull();
    // managedExternally means the run bypasses the tracker.
    expect(h.trackCalls).toBe(0);
    const actionInput = commandCallsFor("runStackedAction")[0]!.input as {
      actionId: string;
      action: string;
      commitMessage?: string;
      featureBranch?: string;
      filePaths?: ReadonlyArray<string>;
    };
    expect(actionInput.actionId).toBe("action-uuid");
    expect(actionInput.commitMessage).toBe("msg");
    expect(actionInput.featureBranch).toBe("feat");
    expect(actionInput.filePaths).toEqual(["a.ts", "b.ts"]);
    expect(h.gitResults).toEqual([
      {
        type: "success",
        title: "Pushed",
        description: "Opened PR",
        prUrl: "https://example.com/pr/1",
      },
    ]);
    expect(commandCallsFor("updateMetadata")[0]!.input).toBeDefined();
  });

  it("refreshes status when the action does not create a branch", async () => {
    selectConnectedThread();
    h.commandResults.runStackedAction = () =>
      AsyncResult.success({
        toast: { title: "Committed", description: "done", cta: { kind: "none" } },
        branch: { status: "unchanged", name: null },
      });

    const actions = useSelectedThreadGitActions();
    await actions.onRunSelectedThreadGitAction({
      action: "commit",
    } as unknown as GitActionRequestInput);

    const actionInput = commandCallsFor("runStackedAction")[0]!.input as {
      commitMessage?: string;
      filePaths?: ReadonlyArray<string>;
    };
    expect(actionInput.commitMessage).toBeUndefined();
    expect(actionInput.filePaths).toBeUndefined();
    expect(h.gitResults[0]).toEqual({ type: "success", title: "Committed", description: "done" });
    expect(commandCallsFor("updateMetadata")).toHaveLength(0);
    expect(commandCallsFor("refreshStatus")).toHaveLength(1);
  });

  it("returns null when the stacked action fails", async () => {
    selectConnectedThread();
    h.commandResults.runStackedAction = () =>
      AsyncResult.failure(Cause.fail(new Error("action boom")));

    const actions = useSelectedThreadGitActions();
    expect(await actions.onRunSelectedThreadGitAction(request)).toBeNull();
    expect(h.pendingErrors).toContain("action boom");
  });

  it("surfaces a sync failure after a created branch", async () => {
    selectConnectedThread();
    h.commandResults.runStackedAction = () =>
      AsyncResult.success({
        toast: { title: "Pushed", description: "", cta: { kind: "none" } },
        branch: { status: "created", name: "feat-x" },
      });
    h.commandResults.updateMetadata = () => AsyncResult.failure(Cause.fail(new Error("sync boom")));

    const actions = useSelectedThreadGitActions();
    expect(await actions.onRunSelectedThreadGitAction(request)).toBeNull();
    expect(h.pendingErrors).toContain("sync boom");
  });
});

describe("refreshSelectedThreadBranches", () => {
  it("refreshes and drops remote branches", async () => {
    selectConnectedThread();
    h.branchData = {
      refs: [
        { name: "main", isRemote: false },
        { name: "origin/main", isRemote: true },
      ],
    };

    const actions = useSelectedThreadGitActions();
    const branches = await actions.refreshSelectedThreadBranches();

    expect(h.branchRefreshCalls).toBeGreaterThanOrEqual(1);
    expect(branches).toEqual([{ name: "main", isRemote: false }]);
  });

  it("returns an empty list when branch data is missing", async () => {
    selectConnectedThread();
    h.branchData = null;

    const actions = useSelectedThreadGitActions();
    expect(await actions.refreshSelectedThreadBranches()).toEqual([]);
  });
});
