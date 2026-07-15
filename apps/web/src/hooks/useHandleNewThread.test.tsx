// @vitest-environment happy-dom

import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t4code/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedProjectRef,
} from "@t4code/contracts";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  serverConfigs: new Map<string, { settings: typeof DEFAULT_SERVER_SETTINGS }>(),
  routeParams: {} as Record<string, string | undefined>,
  router: {
    state: { matches: [{ params: {} as Record<string, string | undefined> }] },
    navigate: vi.fn(),
  },
  activeThread: null as Record<string, unknown> | null,
  shellExists: false,
  projectOrder: [] as string[],
  logicalProjectKey: "logical:project",
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => testState.router,
  useParams: (options: { select: (params: Record<string, string | undefined>) => unknown }) =>
    options.select(testState.routeParams),
}));

vi.mock("../state/entities", () => ({
  useProjects: () => testState.projects,
  useServerConfigs: () => testState.serverConfigs,
  useThread: (threadRef: unknown) => (threadRef ? testState.activeThread : null),
  readThreadShell: () => (testState.shellExists ? { status: "ready" } : null),
}));

vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => testState.logicalProjectKey,
  getProjectOrderKey: (project: { environmentId: string; id: string }) =>
    `${project.environmentId}:${project.id}`,
  selectProjectGroupingSettings: (settings: unknown) => settings,
}));

vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: (workspaceRoot: string) => `legacy:${workspaceRoot}`,
  useUiStateStore: (selector: (store: { projectOrder: string[] }) => unknown) =>
    selector({ projectOrder: testState.projectOrder }),
}));

vi.mock("./useSettings", () => ({
  useClientSettings: (selector: (settings: Record<string, unknown>) => unknown) =>
    selector({ groupProjectsBy: "folder" }),
}));

import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread, useNewThreadHandler } from "./useHandleNewThread";

const environmentId = EnvironmentId.make("local-test");
const projectId = ProjectId.make("project-test");
const projectRef = scopeProjectRef(environmentId, projectId);

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

const mountedTrees: MountedTree[] = [];

function setRoute(params: Record<string, string | undefined>): void {
  testState.routeParams = params;
  testState.router.state.matches = [{ params }];
}

function project(id: ProjectId = projectId, environment: EnvironmentId = environmentId) {
  return {
    id,
    environmentId: environment,
    workspaceRoot: `X:\\repos\\${id}`,
  };
}

function NewThreadHarness({
  target = projectRef,
  options,
}: {
  target?: ScopedProjectRef;
  options?: NewThreadOptions;
}) {
  const handleNewThread = useNewThreadHandler();
  const [status, setStatus] = useState("idle");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setStatus("running");
          void handleNewThread(target, options).then(() => setStatus("done"));
        }}
      >
        New thread
      </button>
      <output data-testid="status">{status}</output>
    </>
  );
}

function HandleSummary() {
  const state = useHandleNewThread();
  return (
    <output
      data-testid="summary"
      data-default-project={state.defaultProjectRef?.projectId ?? ""}
      data-route-thread={state.routeThreadRef?.threadId ?? ""}
      data-active-thread={state.activeThread ? "yes" : "no"}
      data-active-draft={state.activeDraftThread?.threadId ?? ""}
      data-handler={typeof state.handleNewThread}
    />
  );
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function clickNewThread(): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "New thread",
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(document.querySelector('[data-testid="status"]')?.textContent).toBe("done");
}

interface ResettableStore {
  getInitialState: () => object;
  setState: (state: object, replace?: boolean) => void;
}

const resettableDraftStore = useComposerDraftStore as unknown as ResettableStore;
const pristineDraftState = { ...resettableDraftStore.getInitialState() };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resettableDraftStore.setState({ ...pristineDraftState }, true);
  testState.projects = [];
  testState.serverConfigs = new Map();
  testState.router.navigate.mockReset().mockResolvedValue(undefined);
  testState.activeThread = null;
  testState.shellExists = false;
  testState.projectOrder = [];
  testState.logicalProjectKey = "logical:project";
  setRoute({});
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  resettableDraftStore.setState({ ...pristineDraftState }, true);
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useNewThreadHandler", () => {
  it("creates and navigates to a fresh draft with default environment settings", async () => {
    await mount(<NewThreadHarness />);
    await clickNewThread();

    const draft = useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef);
    expect(draft).not.toBeNull();
    expect(draft).toMatchObject({
      environmentId,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
    });
    expect(testState.router.navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: draft!.draftId },
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draft!.draftId)).toBeNull();
  });

  it("uses project grouping, server configuration, and every explicit option", async () => {
    testState.projects = [project()];
    testState.serverConfigs.set(environmentId, {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultThreadEnvMode: "local",
        newWorktreesStartFromOrigin: false,
      },
    });
    await mount(
      <NewThreadHarness
        options={{
          branch: "feature/coverage",
          worktreePath: "X:\\worktrees\\coverage",
          envMode: "worktree",
          startFromOrigin: true,
        }}
      />,
    );
    await clickNewThread();

    const draft = useComposerDraftStore
      .getState()
      .getDraftSessionByLogicalProjectKey(testState.logicalProjectKey);
    expect(draft).toMatchObject({
      branch: "feature/coverage",
      worktreePath: "X:\\worktrees\\coverage",
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("reuses a stored draft in place and updates only supplied context", async () => {
    const draftId = "draft-stored" as never;
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId: ThreadId.make("thread-stored"),
        branch: "main",
        envMode: "local",
      });
    setRoute({ draftId });
    await mount(
      <NewThreadHarness options={{ branch: null, worktreePath: "X:\\worktrees\\stored" }} />,
    );
    await clickNewThread();

    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      branch: null,
      worktreePath: "X:\\worktrees\\stored",
      envMode: "worktree",
    });
  });

  it("navigates back to a reusable stored draft from another route", async () => {
    const storedDraftId = "draft-stored" as never;
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, storedDraftId, {
        threadId: ThreadId.make("thread-stored"),
      });
    setRoute({ draftId: "draft-other" });
    await mount(<NewThreadHarness />);
    await clickNewThread();

    expect(testState.router.navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: storedDraftId },
    });
  });

  it("reuses the active draft when its logical-project pointer is temporarily absent", async () => {
    const draftId = "draft-active" as never;
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId: ThreadId.make("thread-active"),
        envMode: "local",
      });
    useComposerDraftStore.setState({
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    setRoute({ draftId });
    await mount(<NewThreadHarness options={{ envMode: "worktree", startFromOrigin: false }} />);
    await clickNewThread();

    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      startFromOrigin: false,
    });
    expect(
      useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(scopedProjectKey(projectRef))?.draftId,
    ).toBe(draftId);
  });

  it("marks a server-backed stored draft promoted before creating a replacement", async () => {
    const storedDraftId = "draft-promoted" as never;
    const storedThreadId = ThreadId.make("thread-promoted");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, storedDraftId, {
        threadId: storedThreadId,
      });
    testState.shellExists = true;
    await mount(<NewThreadHarness />);
    await clickNewThread();

    const replacement = useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef);
    expect(replacement?.draftId).not.toBe(storedDraftId);
    expect(useComposerDraftStore.getState().getDraftSession(storedDraftId)?.promotedTo).toEqual(
      scopeThreadRef(environmentId, storedThreadId),
    );
    expect(testState.router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { draftId: replacement!.draftId } }),
    );
  });
});

describe("useHandleNewThread", () => {
  it("orders the default project and reports an idle route", async () => {
    const secondProjectId = ProjectId.make("project-second");
    testState.projects = [project(), project(secondProjectId)];
    testState.projectOrder = [`${environmentId}:${secondProjectId}`];
    await mount(<HandleSummary />);

    const summary = document.querySelector<HTMLOutputElement>('[data-testid="summary"]')!;
    expect(summary.dataset.defaultProject).toBe(secondProjectId);
    expect(summary.dataset.routeThread).toBe("");
    expect(summary.dataset.activeThread).toBe("no");
    expect(summary.dataset.activeDraft).toBe("");
    expect(summary.dataset.handler).toBe("function");
  });

  it("reports server route, server entity, and matching promoted draft state", async () => {
    const routeThreadId = ThreadId.make("route-thread");
    const routeRef = scopeThreadRef(environmentId, routeThreadId);
    const draftId = "draft-server-route" as never;
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId: routeThreadId,
      });
    testState.activeThread = { id: routeThreadId };
    setRoute({ environmentId, threadId: routeThreadId });
    await mount(<HandleSummary />);

    const summary = document.querySelector<HTMLOutputElement>('[data-testid="summary"]')!;
    expect(summary.dataset.routeThread).toBe(routeRef.threadId);
    expect(summary.dataset.activeThread).toBe("yes");
    expect(summary.dataset.activeDraft).toBe(routeThreadId);
  });

  it("reports draft route state without a server thread", async () => {
    const draftId = "draft-route" as never;
    const draftThreadId = ThreadId.make("draft-route-thread");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId: draftThreadId,
      });
    setRoute({ draftId });
    await mount(<HandleSummary />);

    const summary = document.querySelector<HTMLOutputElement>('[data-testid="summary"]')!;
    expect(summary.dataset.routeThread).toBe("");
    expect(summary.dataset.activeThread).toBe("no");
    expect(summary.dataset.activeDraft).toBe(draftThreadId);
  });
});
