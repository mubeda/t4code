// @vitest-environment happy-dom

import { scopeProjectRef, scopeThreadRef } from "@t4code/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t4code/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  isMobile: false,
  serverThread: null as Record<string, unknown> | null,
  draftThread: null as Record<string, unknown> | null,
  draftSessionId: null as string | null,
  project: null as Record<string, unknown> | null,
  useThread: vi.fn(),
  useProject: vi.fn(),
  getDraftSession: vi.fn(),
  getDraftThreadByRef: vi.fn(),
}));

vi.mock("../state/entities", () => ({
  useThread: (threadRef: unknown) => testState.useThread(threadRef),
  useProject: (projectRef: unknown) => testState.useProject(projectRef),
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (
    selector: (store: {
      getDraftSession: (draftId: string) => Record<string, unknown> | null;
      getDraftThreadByRef: (threadRef: unknown) => Record<string, unknown> | null;
    }) => unknown,
  ) =>
    selector({
      getDraftSession: (draftId) => testState.getDraftSession(draftId),
      getDraftThreadByRef: (threadRef) => testState.getDraftThreadByRef(threadRef),
    }),
}));

vi.mock("../hooks/useMediaQuery", () => ({
  useIsMobile: () => testState.isMobile,
}));

vi.mock("./BranchToolbarEnvironmentSelector", () => ({
  BranchToolbarEnvironmentSelector: (props: {
    environmentId: string;
    availableEnvironments: ReadonlyArray<{ environmentId: string }>;
    onEnvironmentChange: (environmentId: string) => void;
    envLocked: boolean;
  }) => (
    <button
      type="button"
      data-testid="desktop-environment"
      data-environment-id={props.environmentId}
      disabled={props.envLocked}
      onClick={() => props.onEnvironmentChange(props.availableEnvironments[1]!.environmentId)}
    >
      Environment
    </button>
  ),
}));

vi.mock("./BranchToolbarEnvModeSelector", () => ({
  BranchToolbarEnvModeSelector: (props: {
    effectiveEnvMode: string;
    activeWorktreePath: string | null;
    onEnvModeChange: (mode: "local" | "worktree") => void;
    envLocked: boolean;
  }) => (
    <button
      type="button"
      data-testid="desktop-workspace"
      data-mode={props.effectiveEnvMode}
      data-path={props.activeWorktreePath ?? ""}
      disabled={props.envLocked}
      onClick={() => props.onEnvModeChange("worktree")}
    >
      Workspace
    </button>
  ),
}));

vi.mock("./BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: (props: {
    environmentId: string;
    threadId: string;
    draftId?: string;
    effectiveEnvModeOverride?: string;
    activeThreadBranchOverride?: string | null;
    onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
    onCheckoutPullRequestRequest?: (reference: string) => void;
    onComposerFocusRequest?: () => void;
  }) => (
    <div
      data-testid="branch-selector"
      data-environment-id={props.environmentId}
      data-thread-id={props.threadId}
      data-draft-id={props.draftId ?? ""}
      data-mode={props.effectiveEnvModeOverride ?? ""}
      data-branch={props.activeThreadBranchOverride ?? ""}
    >
      <button type="button" onClick={() => props.onActiveThreadBranchOverrideChange?.("next")}>
        Change branch
      </button>
      <button type="button" onClick={() => props.onCheckoutPullRequestRequest?.("#42")}>
        Checkout PR
      </button>
      <button type="button" onClick={() => props.onComposerFocusRequest?.()}>
        Focus composer
      </button>
    </div>
  ),
}));

import { BranchToolbar } from "./BranchToolbar";
import type { EnvironmentOption } from "./BranchToolbar.logic";

const environmentId = EnvironmentId.make("local-test");
const remoteEnvironmentId = EnvironmentId.make("remote-test");
const projectId = ProjectId.make("project-test");
const threadId = ThreadId.make("thread-test");
const environments: readonly EnvironmentOption[] = [
  { environmentId, projectId, label: "This device", isPrimary: true },
  {
    environmentId: remoteEnvironmentId,
    projectId: ProjectId.make("remote-project"),
    label: "Build server",
    isPrimary: false,
  },
];

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
const suiteGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations",
);
let originalGetAnimationsDescriptor: PropertyDescriptor | undefined;

function serverThread(worktreePath: string | null = null) {
  return {
    environmentId,
    projectId,
    worktreePath,
  };
}

function draftThread(worktreePath: string | null = null, envMode: "local" | "worktree" = "local") {
  return {
    environmentId,
    projectId,
    worktreePath,
    envMode,
  };
}

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof BranchToolbar>> = {},
): ReactElement {
  return (
    <BranchToolbar
      environmentId={environmentId}
      threadId={threadId}
      onEnvModeChange={vi.fn()}
      startFromOrigin={false}
      onStartFromOriginChange={vi.fn()}
      envLocked={false}
      {...overrides}
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

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  return button!;
}

function menuRadioWithText(text: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitemradio']")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(item).toBeDefined();
  return item!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalGetAnimationsDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAnimations",
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  testState.isMobile = false;
  testState.serverThread = serverThread();
  testState.draftThread = null;
  testState.draftSessionId = null;
  testState.project = { id: projectId, environmentId, workspaceRoot: "X:\\t4code" };
  testState.useThread.mockReset().mockImplementation((threadRef: unknown) => {
    const ref = threadRef as { environmentId?: string; threadId?: string } | null;
    return ref?.environmentId === environmentId && ref.threadId === threadId
      ? testState.serverThread
      : null;
  });
  testState.useProject.mockReset().mockImplementation((projectRef: unknown) => {
    const ref = projectRef as { environmentId?: string; projectId?: string } | null;
    return ref?.environmentId === testState.project?.environmentId &&
      ref?.projectId === testState.project?.id
      ? testState.project
      : null;
  });
  testState.getDraftSession
    .mockReset()
    .mockImplementation((draftId: string) =>
      draftId === testState.draftSessionId ? testState.draftThread : null,
    );
  testState.getDraftThreadByRef.mockReset().mockImplementation((threadRef: unknown) => {
    const ref = threadRef as { environmentId?: string; threadId?: string } | null;
    return ref?.environmentId === environmentId && ref.threadId === threadId
      ? testState.draftThread
      : null;
  });
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  if (originalGetAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  originalGetAnimationsDescriptor = undefined;
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations")).toEqual(
    suiteGetAnimationsDescriptor,
  );
});

describe("BranchToolbar mounted behavior", () => {
  it("renders nothing until both a thread and its project are available", async () => {
    const wrongThreadId = ThreadId.make("wrong-thread");
    const mounted = await mount(renderToolbar({ threadId: wrongThreadId }));
    expect(mounted.container.textContent).toBe("");
    expect(testState.useThread).toHaveBeenCalledWith(scopeThreadRef(environmentId, wrongThreadId));

    testState.serverThread = null;
    await act(async () => mounted.root.render(renderToolbar()));
    expect(mounted.container.textContent).toBe("");

    testState.serverThread = serverThread();
    testState.project = null;
    await act(async () => mounted.root.render(renderToolbar()));
    expect(mounted.container.textContent).toBe("");
  });

  it("wires the desktop environment, workspace, and branch controls", async () => {
    const onEnvironmentChange = vi.fn();
    const onEnvModeChange = vi.fn();
    const onBranchChange = vi.fn();
    const onCheckout = vi.fn();
    const onFocus = vi.fn();
    await mount(
      renderToolbar({
        availableEnvironments: environments,
        onEnvironmentChange,
        onEnvModeChange,
        effectiveEnvModeOverride: "local",
        activeThreadBranchOverride: "main",
        onActiveThreadBranchOverrideChange: onBranchChange,
        onCheckoutPullRequestRequest: onCheckout,
        onComposerFocusRequest: onFocus,
      }),
    );

    const environment = document.querySelector<HTMLButtonElement>(
      '[data-testid="desktop-environment"]',
    )!;
    const workspace = document.querySelector<HTMLButtonElement>(
      '[data-testid="desktop-workspace"]',
    )!;
    const branch = document.querySelector<HTMLElement>('[data-testid="branch-selector"]')!;
    expect(environment.dataset.environmentId).toBe(environmentId);
    expect(workspace.dataset.mode).toBe("local");
    expect(branch.dataset.branch).toBe("main");
    expect(testState.useThread).toHaveBeenCalledWith(scopeThreadRef(environmentId, threadId));
    expect(testState.getDraftThreadByRef).toHaveBeenCalledWith(
      scopeThreadRef(environmentId, threadId),
    );
    expect(testState.useProject).toHaveBeenCalledWith(scopeProjectRef(environmentId, projectId));

    await click(environment);
    await click(workspace);
    await click(buttonWithText("Change branch"));
    await click(buttonWithText("Checkout PR"));
    await click(buttonWithText("Focus composer"));
    expect(onEnvironmentChange).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(onEnvModeChange).toHaveBeenCalledWith("worktree");
    expect(onBranchChange).toHaveBeenCalledWith("next");
    expect(onCheckout).toHaveBeenCalledWith("#42");
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("uses draft context and forwards optional overrides without a server thread", async () => {
    testState.serverThread = null;
    testState.draftThread = draftThread(null, "worktree");
    testState.draftSessionId = "draft-toolbar";
    await mount(
      renderToolbar({
        draftId: "draft-toolbar" as never,
        effectiveEnvModeOverride: "worktree",
        activeThreadBranchOverride: null,
        envLocked: true,
      }),
    );

    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="desktop-workspace"]')?.disabled,
    ).toBe(true);
    const branch = document.querySelector<HTMLElement>('[data-testid="branch-selector"]')!;
    expect(branch.dataset.draftId).toBe("draft-toolbar");
    expect(branch.dataset.mode).toBe("worktree");
    expect(testState.getDraftSession).toHaveBeenCalledWith("draft-toolbar");
    expect(testState.getDraftThreadByRef).not.toHaveBeenCalled();
    expect(testState.useProject).toHaveBeenCalledWith(scopeProjectRef(environmentId, projectId));
  });

  it("renders a locked mobile context for a server worktree", async () => {
    testState.isMobile = true;
    testState.serverThread = serverThread("X:\\worktrees\\feature");
    const onEnvironmentChange = vi.fn();
    const onEnvModeChange = vi.fn();
    await mount(
      renderToolbar({
        availableEnvironments: environments,
        onEnvironmentChange,
        onEnvModeChange,
        envLocked: true,
      }),
    );

    expect(document.body.textContent).toContain("This device");
    expect(document.querySelector('[data-testid="desktop-workspace"]')).toBeNull();
    expect(document.querySelector('button[class*="md:hidden"]')).toBeNull();
    expect(document.querySelector("[role='menuitemradio']")).toBeNull();
    const lockedContext = document.querySelector<HTMLElement>('span[class*="md:hidden"]');
    expect(lockedContext).not.toBeNull();
    await click(lockedContext!);
    lockedContext!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onEnvironmentChange).not.toHaveBeenCalled();
    expect(onEnvModeChange).not.toHaveBeenCalled();
    expect(buttonWithText("Change branch")).toBeDefined();
  });

  it("changes workspace from the unlocked mobile menu", async () => {
    testState.isMobile = true;
    const onEnvModeChange = vi.fn();
    await mount(renderToolbar({ onEnvModeChange }));

    await click(buttonWithText("Current checkout"));
    await click(menuRadioWithText("New worktree"));
    expect(onEnvModeChange).toHaveBeenCalledWith("worktree");
  });

  it("changes environment from the combined mobile menu", async () => {
    testState.isMobile = true;
    testState.serverThread = null;
    testState.draftThread = draftThread("X:\\worktrees\\existing", "local");
    testState.draftSessionId = "draft-mobile";
    const onEnvironmentChange = vi.fn();
    await mount(
      renderToolbar({
        draftId: "draft-mobile" as never,
        availableEnvironments: environments,
        onEnvironmentChange,
      }),
    );

    await click(buttonWithText("This device"));
    await click(menuRadioWithText("Build server"));
    expect(onEnvironmentChange).toHaveBeenCalledWith(remoteEnvironmentId);
  });

  it("changes the current-worktree mode from the combined mobile menu", async () => {
    testState.isMobile = true;
    testState.serverThread = null;
    testState.draftThread = draftThread("X:\\worktrees\\existing", "local");
    testState.draftSessionId = "draft-mobile";
    const onEnvModeChange = vi.fn();
    await mount(
      renderToolbar({
        draftId: "draft-mobile" as never,
        availableEnvironments: environments,
        onEnvironmentChange: vi.fn(),
        onEnvModeChange,
      }),
    );

    await click(buttonWithText("This device"));
    await click(menuRadioWithText("Current worktree"));
    expect(onEnvModeChange).toHaveBeenCalledWith("local");
  });

  it("falls back to a generic mobile label when the active environment is absent", async () => {
    testState.isMobile = true;
    await mount(
      renderToolbar({
        availableEnvironments: [
          environments[1]!,
          {
            environmentId: EnvironmentId.make("another"),
            projectId: ProjectId.make("another-project"),
            label: "Another server",
            isPrimary: false,
          },
        ],
        onEnvironmentChange: vi.fn(),
      }),
    );

    expect(buttonWithText("Run on")).toBeDefined();
  });
});
