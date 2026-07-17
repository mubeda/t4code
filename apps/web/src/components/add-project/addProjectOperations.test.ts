import { EnvironmentId, ProjectId } from "@t4code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AddProjectCommandResult,
  createAddProjectOperations,
  type AddProjectOperationsDependencies,
  type AddProjectRecord,
} from "./addProjectOperations";

const CURRENT_OPERATION = {
  shouldContinue: () => true,
} as const;

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

interface HarnessOptions {
  readonly projects?: ReadonlyArray<AddProjectRecord>;
  readonly clonePath?: string;
  readonly cloneError?: unknown;
  readonly createError?: unknown;
  readonly createInterrupted?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const createProject = vi.fn<AddProjectOperationsDependencies["createProject"]>(async () =>
    options.createInterrupted
      ? ({ _tag: "Failure", error: null } as const)
      : options.createError
        ? ({ _tag: "Failure", error: options.createError } as const)
        : ({ _tag: "Success", value: undefined } as const),
  );
  const cloneRepository = vi.fn<AddProjectOperationsDependencies["cloneRepository"]>(async () =>
    options.cloneError
      ? ({ _tag: "Failure", error: options.cloneError } as const)
      : ({
          _tag: "Success" as const,
          value: { path: options.clonePath ?? "/code/cloned" },
        } as const),
  );
  const openProject = vi.fn<AddProjectOperationsDependencies["openProject"]>(async () => ({
    _tag: "Success" as const,
    value: undefined,
  }));
  const reportFailure = vi.fn();
  return {
    createProject,
    cloneRepository,
    openProject,
    reportFailure,
    dependencies: {
      getProjects: () => options.projects ?? [],
      createProject,
      cloneRepository,
      openProject,
      reportFailure,
    } satisfies AddProjectOperationsDependencies,
  };
}

describe("add project operations", () => {
  it("opens an existing environment-and-path match without creating", async () => {
    const harness = makeHarness({
      projects: [
        {
          id: ProjectId.make("existing"),
          environmentId: EnvironmentId.make("local"),
          workspaceRoot: "/code/demo",
        },
      ],
    });
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.addFolder({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo/",
      }),
    ).resolves.toBe(true);

    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.openProject).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("existing"),
    });
  });

  it("registers an existing folder without creating or initializing it", async () => {
    const harness = makeHarness();
    const operations = createAddProjectOperations(harness.dependencies);

    await operations.addFolder({
      ...CURRENT_OPERATION,
      environmentId: EnvironmentId.make("local"),
      workspaceRoot: "/code/demo",
    });

    expect(harness.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
        workspaceRoot: "/code/demo",
      }),
    );
  });

  it("clones before registering the returned path", async () => {
    const harness = makeHarness({ clonePath: "/code/demo" });
    const operations = createAddProjectOperations(harness.dependencies);

    await operations.clone({
      ...CURRENT_OPERATION,
      environmentId: EnvironmentId.make("local"),
      url: "https://example.test/demo.git",
      parentDir: "/code",
    });

    expect(harness.cloneRepository).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("local"),
      url: "https://example.test/demo.git",
      parentDir: "/code",
    });
    expect(harness.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/code/demo",
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
      }),
    );
    expect(harness.openProject).toHaveBeenCalledTimes(1);
  });

  it("reports a failed clone and does not register or navigate", async () => {
    const error = new Error("clone denied");
    const harness = makeHarness({ cloneError: error });
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.clone({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        url: "https://example.test/demo.git",
        parentDir: "/code",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).toHaveBeenCalledWith("Clone failed", error);
    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("creates and initializes Git through project.create", async () => {
    const harness = makeHarness();
    const operations = createAddProjectOperations(harness.dependencies);

    await operations.create({
      ...CURRENT_OPERATION,
      environmentId: EnvironmentId.make("local"),
      workspaceRoot: "/code/demo",
    });

    expect(harness.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        createWorkspaceRootIfMissing: true,
        initializeGit: true,
      }),
    );
  });

  it("reports command failure and does not navigate", async () => {
    const harness = makeHarness({ createError: new Error("disk full") });
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.create({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).toHaveBeenCalledWith(
      "Failed to create project",
      new Error("disk full"),
    );
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("suppresses reporting for interrupted commands", async () => {
    const harness = makeHarness({ createInterrupted: true });
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.create({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("reports a rejected create command and does not navigate", async () => {
    const error = new Error("disk disconnected");
    const harness = makeHarness();
    harness.createProject.mockRejectedValue(error);
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.create({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).toHaveBeenCalledWith("Failed to create project", error);
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("reports a rejected clone command and does not register or navigate", async () => {
    const error = new Error("network disconnected");
    const harness = makeHarness();
    harness.cloneRepository.mockRejectedValue(error);
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.clone({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        url: "https://example.test/demo.git",
        parentDir: "/code",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).toHaveBeenCalledWith("Clone failed", error);
    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("reports a rejected open command", async () => {
    const error = new Error("navigation unavailable");
    const harness = makeHarness({
      projects: [
        {
          id: ProjectId.make("existing"),
          environmentId: EnvironmentId.make("local"),
          workspaceRoot: "/code/demo",
        },
      ],
    });
    harness.openProject.mockRejectedValue(error);
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.addFolder({
        ...CURRENT_OPERATION,
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
      }),
    ).resolves.toBe(false);

    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.reportFailure).toHaveBeenCalledWith("Failed to open project", error);
  });

  it("does not begin an operation when its continuation is already stale", async () => {
    const harness = makeHarness();
    const operations = createAddProjectOperations(harness.dependencies);

    await expect(
      operations.create({
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
        shouldContinue: () => false,
      }),
    ).resolves.toBe(false);

    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("does not register or navigate when a clone becomes stale while pending", async () => {
    const harness = makeHarness();
    const cloneResult = deferredResult<AddProjectCommandResult<{ readonly path: string }>>();
    harness.cloneRepository.mockReturnValue(cloneResult.promise);
    let current = true;
    const operations = createAddProjectOperations(harness.dependencies);

    const result = operations.clone({
      environmentId: EnvironmentId.make("local"),
      url: "https://example.test/demo.git",
      parentDir: "/code",
      shouldContinue: () => current,
    });
    current = false;
    cloneResult.resolve({
      _tag: "Success",
      value: { path: "/code/demo" },
    });

    await expect(result).resolves.toBe(false);
    expect(harness.createProject).not.toHaveBeenCalled();
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("does not report a create failure that completes after becoming stale", async () => {
    const harness = makeHarness();
    const createResult = deferredResult<AddProjectCommandResult<void>>();
    harness.createProject.mockReturnValue(createResult.promise);
    let current = true;
    const operations = createAddProjectOperations(harness.dependencies);

    const result = operations.create({
      environmentId: EnvironmentId.make("local"),
      workspaceRoot: "/code/demo",
      shouldContinue: () => current,
    });
    current = false;
    createResult.resolve({
      _tag: "Failure",
      error: new Error("late failure"),
    });

    await expect(result).resolves.toBe(false);
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });

  it("does not navigate when add registration completes after becoming stale", async () => {
    const harness = makeHarness();
    const createResult = deferredResult<AddProjectCommandResult<void>>();
    harness.createProject.mockReturnValue(createResult.promise);
    let current = true;
    const operations = createAddProjectOperations(harness.dependencies);

    const result = operations.addFolder({
      environmentId: EnvironmentId.make("local"),
      workspaceRoot: "/code/demo",
      shouldContinue: () => current,
    });
    current = false;
    createResult.resolve({ _tag: "Success", value: undefined });

    await expect(result).resolves.toBe(false);
    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });
});
