import { EnvironmentId, ProjectId } from "@t4code/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAddProjectOperations,
  type AddProjectOperationsDependencies,
  type AddProjectRecord,
} from "./addProjectOperations";

interface HarnessOptions {
  readonly projects?: ReadonlyArray<AddProjectRecord>;
  readonly clonePath?: string;
  readonly createError?: unknown;
  readonly createInterrupted?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const createProject = vi.fn(async () =>
    options.createInterrupted
      ? ({ _tag: "Failure", error: null } as const)
      : options.createError
        ? ({ _tag: "Failure", error: options.createError } as const)
        : ({ _tag: "Success", value: undefined } as const),
  );
  const cloneRepository = vi.fn(async () => ({
    _tag: "Success" as const,
    value: { path: options.clonePath ?? "/code/cloned" },
  }));
  const openProject = vi.fn(async () => ({
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
      expect.objectContaining({ workspaceRoot: "/code/demo" }),
    );
  });

  it("creates and initializes Git through project.create", async () => {
    const harness = makeHarness();
    const operations = createAddProjectOperations(harness.dependencies);

    await operations.create({
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
        environmentId: EnvironmentId.make("local"),
        workspaceRoot: "/code/demo",
      }),
    ).resolves.toBe(false);

    expect(harness.reportFailure).not.toHaveBeenCalled();
    expect(harness.openProject).not.toHaveBeenCalled();
  });
});
