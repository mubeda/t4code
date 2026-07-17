// @vitest-environment happy-dom

import { EnvironmentId } from "@t4code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AddProjectHostOption } from "./AddProjectDialog.logic";
import {
  createAddProjectOperations,
  type AddProjectCommandResult,
  type AddProjectOperationsDependencies,
} from "./addProjectOperations";
import type { PickAddProjectFolderResult } from "./pickAddProjectFolder";
import { useAddProjectWorkflowState, type AddProjectWorkflow } from "./useAddProjectWorkflow";

type WorkflowOperations = Pick<
  ReturnType<typeof createAddProjectOperations>,
  "addFolder" | "clone" | "create"
>;

const ENV_PRIMARY = EnvironmentId.make("primary");
const ENV_REMOTE = EnvironmentId.make("remote");
const ENV_WSL = EnvironmentId.make("wsl");

const primaryHost: AddProjectHostOption = {
  environmentId: ENV_PRIMARY,
  label: "Local",
  platform: "MacIntel",
  baseDirectory: "~/",
  isPrimary: true,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};
const remoteHost: AddProjectHostOption = {
  environmentId: ENV_REMOTE,
  label: "Remote",
  platform: "Linux",
  baseDirectory: "/srv/code/",
  isPrimary: false,
  desktopInstanceId: null,
  nativePickerAvailable: true,
};
const wslHost: AddProjectHostOption = {
  environmentId: ENV_WSL,
  label: "Ubuntu",
  platform: "Linux",
  baseDirectory: "~/",
  isPrimary: false,
  desktopInstanceId: "wsl:Ubuntu",
  nativePickerAvailable: true,
};

const testState = {
  pickResult: { _tag: "Cancelled" } as PickAddProjectFolderResult,
  pickFolder: vi.fn(async () => testState.pickResult),
  operations: {
    addFolder: vi.fn(async () => true),
    clone: vi.fn(async () => true),
    create: vi.fn(async () => true),
  },
  operationOverride: null as WorkflowOperations | null,
  onOpenChange: vi.fn(),
};

let currentWorkflow: AddProjectWorkflow;
let workflowRoot: Root | null = null;
let workflowContainer: HTMLDivElement | null = null;

function WorkflowProbe({ open }: { readonly open: boolean }) {
  currentWorkflow = useAddProjectWorkflowState({
    open,
    onOpenChange: testState.onOpenChange,
    hosts: [primaryHost, remoteHost, wslHost],
    primaryEnvironmentId: ENV_PRIMARY,
    operations: testState.operationOverride ?? testState.operations,
    pickFolder: testState.pickFolder,
  });
  return null;
}

async function mountWorkflow({ open }: { readonly open: boolean }) {
  workflowContainer = document.createElement("div");
  document.body.append(workflowContainer);
  workflowRoot = createRoot(workflowContainer);
  const rerender = async (nextOpen: boolean) => {
    await act(async () => workflowRoot?.render(<WorkflowProbe open={nextOpen} />));
  };
  await rerender(open);
  return {
    get current(): AddProjectWorkflow {
      return currentWorkflow;
    },
    rerender,
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferredResult<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolveResult!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveResult = resolve;
  });
  return { promise, resolve: resolveResult };
}

function makeIntegratedOperations() {
  const createProject = vi.fn<AddProjectOperationsDependencies["createProject"]>(async () => ({
    _tag: "Success",
    value: undefined,
  }));
  const cloneRepository = vi.fn<AddProjectOperationsDependencies["cloneRepository"]>(async () => ({
    _tag: "Success",
    value: { path: "/code/cloned" },
  }));
  const openProject = vi.fn<AddProjectOperationsDependencies["openProject"]>(async () => ({
    _tag: "Success",
    value: undefined,
  }));
  const reportFailure = vi.fn<AddProjectOperationsDependencies["reportFailure"]>();
  const operations = createAddProjectOperations({
    getProjects: () => [],
    createProject,
    cloneRepository,
    openProject,
    reportFailure,
  });
  return {
    operations,
    createProject,
    cloneRepository,
    openProject,
    reportFailure,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testState.pickResult = { _tag: "Cancelled" };
  testState.pickFolder.mockReset().mockImplementation(async () => testState.pickResult);
  testState.operations.addFolder.mockReset().mockResolvedValue(true);
  testState.operations.clone.mockReset().mockResolvedValue(true);
  testState.operations.create.mockReset().mockResolvedValue(true);
  testState.operationOverride = null;
  testState.onOpenChange.mockReset();
});

afterEach(async () => {
  if (workflowRoot !== null) {
    await act(async () => workflowRoot?.unmount());
  }
  workflowContainer?.remove();
  workflowRoot = null;
  workflowContainer = null;
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useAddProjectWorkflowState", () => {
  it("selects the primary host and resets it on every open", async () => {
    const view = await mountWorkflow({ open: true });
    expect(view.current.selectedHost.environmentId).toBe(ENV_PRIMARY);

    act(() => view.current.selectHost(ENV_REMOTE));
    expect(view.current.selectedHost.environmentId).toBe(ENV_REMOTE);

    await view.rerender(false);
    await view.rerender(true);
    expect(view.current.selectedHost.environmentId).toBe(ENV_PRIMARY);
    expect(view.current.step).toBe("start");
  });

  it("uses host-path entry when the selected host is not picker-routable", async () => {
    const view = await mountWorkflow({ open: true });
    act(() => view.current.selectHost(ENV_REMOTE));
    await act(async () => view.current.browse());
    expect(view.current.step).toBe("host-path");
  });

  it("uses the native picker and adds its routed selection", async () => {
    testState.pickResult = {
      _tag: "Selected",
      environmentId: ENV_WSL,
      path: "/home/me/code",
    };
    const view = await mountWorkflow({ open: true });
    await act(async () => view.current.browse());
    expect(testState.operations.addFolder).toHaveBeenCalledWith({
      environmentId: ENV_WSL,
      workspaceRoot: "/home/me/code",
      shouldContinue: expect.any(Function),
    });
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ignores stale picker completion after the dialog closes", async () => {
    const pickerResult = deferredResult<PickAddProjectFolderResult>();
    testState.pickFolder.mockReturnValue(pickerResult.promise);
    const view = await mountWorkflow({ open: true });

    act(() => {
      void view.current.browse();
    });
    await view.rerender(false);
    pickerResult.resolve({
      _tag: "Selected",
      environmentId: ENV_PRIMARY,
      path: "/stale",
    });
    await flushPromises();

    expect(testState.operations.addFolder).not.toHaveBeenCalled();
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores stale create completion after the host changes", async () => {
    const createResult = deferredResult<boolean>();
    testState.operations.create.mockReturnValue(createResult.promise);
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    act(() => {
      void view.current.submitCreate();
    });

    act(() => view.current.selectHost(ENV_REMOTE));
    createResult.resolve(true);
    await flushPromises();

    expect(view.current.selectedHost.environmentId).toBe(ENV_REMOTE);
    expect(view.current.step).toBe("start");
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores stale create completion after Back", async () => {
    const createResult = deferredResult<boolean>();
    testState.operations.create.mockReturnValue(createResult.promise);
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    act(() => {
      void view.current.submitCreate();
    });

    act(() => view.current.back());
    createResult.resolve(true);
    await flushPromises();

    expect(view.current.step).toBe("start");
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it.each([
    { invalidation: "close", outcome: "success" },
    { invalidation: "close", outcome: "failure" },
    { invalidation: "host change", outcome: "success" },
    { invalidation: "host change", outcome: "failure" },
    { invalidation: "Back", outcome: "success" },
    { invalidation: "Back", outcome: "failure" },
  ] as const)(
    "stops stale clone side effects after $invalidation on $outcome",
    async ({ invalidation, outcome }) => {
      const harness = makeIntegratedOperations();
      const cloneResult = deferredResult<AddProjectCommandResult<{ readonly path: string }>>();
      harness.cloneRepository.mockReturnValue(cloneResult.promise);
      testState.operationOverride = harness.operations;
      const view = await mountWorkflow({ open: true });
      act(() => view.current.openClone());
      act(() => view.current.setCloneUrl("https://example.test/demo.git"));
      let submission!: Promise<void>;
      act(() => {
        submission = view.current.submitClone();
      });
      expect(harness.cloneRepository).toHaveBeenCalledTimes(1);

      if (invalidation === "close") {
        await view.rerender(false);
      } else if (invalidation === "host change") {
        act(() => view.current.selectHost(ENV_REMOTE));
      } else {
        act(() => view.current.back());
      }
      await act(async () => {
        cloneResult.resolve(
          outcome === "success"
            ? {
                _tag: "Success",
                value: { path: "/code/cloned" },
              }
            : {
                _tag: "Failure",
                error: new Error("late clone failure"),
              },
        );
        await submission;
      });

      expect(harness.createProject).not.toHaveBeenCalled();
      expect(harness.reportFailure).not.toHaveBeenCalled();
      expect(harness.openProject).not.toHaveBeenCalled();
      expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
    },
  );

  it("does not report or navigate when create fails after close", async () => {
    const harness = makeIntegratedOperations();
    const createResult = deferredResult<AddProjectCommandResult<void>>();
    harness.createProject.mockReturnValue(createResult.promise);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    let submission!: Promise<void>;
    act(() => {
      submission = view.current.submitCreate();
    });
    expect(harness.createProject).toHaveBeenCalledTimes(1);

    await view.rerender(false);
    await act(async () => {
      createResult.resolve({
        _tag: "Failure",
        error: new Error("late failure"),
      });
      await submission;
    });

    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not navigate or close when add registration completes after Back", async () => {
    const harness = makeIntegratedOperations();
    const createResult = deferredResult<AddProjectCommandResult<void>>();
    harness.createProject.mockReturnValue(createResult.promise);
    testState.operationOverride = harness.operations;
    testState.pickResult = {
      _tag: "Selected",
      environmentId: ENV_PRIMARY,
      path: "/code/demo",
    };
    const view = await mountWorkflow({ open: true });
    let submission!: Promise<void>;
    act(() => {
      submission = view.current.browse();
    });
    await flushPromises();
    expect(harness.createProject).toHaveBeenCalledTimes(1);

    act(() => view.current.back());
    await act(async () => {
      createResult.resolve({ _tag: "Success", value: undefined });
      await submission;
    });

    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("fresh reopen invalidates an older pending create", async () => {
    const harness = makeIntegratedOperations();
    const createResult = deferredResult<AddProjectCommandResult<void>>();
    harness.createProject.mockReturnValue(createResult.promise);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    let submission!: Promise<void>;
    act(() => {
      submission = view.current.submitCreate();
    });

    await view.rerender(false);
    await view.rerender(true);
    await act(async () => {
      createResult.resolve({ _tag: "Success", value: undefined });
      await submission;
    });

    expect(view.current.selectedHost.environmentId).toBe(ENV_PRIMARY);
    expect(view.current.step).toBe("start");
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("lets a current integrated create register, navigate, and close", async () => {
    const harness = makeIntegratedOperations();
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    await act(async () => view.current.submitCreate());

    expect(harness.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_PRIMARY,
        workspaceRoot: "~/demo",
        createWorkspaceRootIfMissing: true,
        initializeGit: true,
      }),
    );
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).toHaveBeenCalledTimes(1);
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps invalid clone input on the clone step", async () => {
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openClone());
    act(() => view.current.setCloneUrl("   "));
    await act(async () => view.current.submitClone());

    expect(view.current.step).toBe("clone");
    expect(view.current.error).toBe("Enter a Git URL.");
    expect(testState.operations.clone).not.toHaveBeenCalled();
  });

  it("closes only after a current successful create", async () => {
    testState.operations.create.mockResolvedValue(true);
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    await act(async () => view.current.submitCreate());

    expect(testState.operations.create).toHaveBeenCalledWith({
      environmentId: ENV_PRIMARY,
      workspaceRoot: "~/demo",
      shouldContinue: expect.any(Function),
    });
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a failed create on the create step for retry", async () => {
    testState.operations.create.mockResolvedValue(false);
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openCreate());
    act(() => view.current.setCreateName("demo"));
    await act(async () => view.current.submitCreate());

    expect(view.current.step).toBe("create");
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("retargets a clone parent selected through WSL without clearing the URL", async () => {
    testState.pickResult = {
      _tag: "Selected",
      environmentId: ENV_WSL,
      path: "/home/me/code",
    };
    const view = await mountWorkflow({ open: true });
    act(() => view.current.openClone());
    act(() => view.current.setCloneUrl("https://example.test/demo.git"));
    await act(async () => view.current.pickCloneParent());

    expect(view.current.step).toBe("clone");
    expect(view.current.selectedHost.environmentId).toBe(ENV_WSL);
    expect(view.current.cloneUrl).toBe("https://example.test/demo.git");
    expect(view.current.cloneParent).toBe("/home/me/code");
  });
});
