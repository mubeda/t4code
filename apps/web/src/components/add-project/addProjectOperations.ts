import type { EnvironmentId, ProjectId } from "@t4code/contracts";

import { findProjectByPath, inferProjectTitleFromPath } from "~/lib/projectPaths";
import { newProjectId } from "~/lib/utils";

export type AddProjectCommandResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly error: unknown | null };

type AddProjectCommandSuccess<T> = Extract<
  AddProjectCommandResult<T>,
  { readonly _tag: "Success" }
>;

export interface AddProjectRecord {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface AddProjectOperationsDependencies {
  readonly getProjects: () => ReadonlyArray<AddProjectRecord>;
  readonly createProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createWorkspaceRootIfMissing: boolean;
    readonly initializeGit: boolean;
  }) => Promise<AddProjectCommandResult<void>>;
  readonly cloneRepository: (input: {
    readonly environmentId: EnvironmentId;
    readonly url: string;
    readonly parentDir: string;
  }) => Promise<AddProjectCommandResult<{ readonly path: string }>>;
  readonly openProject: (input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => Promise<AddProjectCommandResult<void>>;
  readonly reportFailure: (title: string, error: unknown) => void;
}

interface ProjectPathInput {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export function createAddProjectOperations(dependencies: AddProjectOperationsDependencies) {
  async function executeCommand<T>(
    failureTitle: string,
    command: () => Promise<AddProjectCommandResult<T>>,
  ): Promise<AddProjectCommandSuccess<T> | null> {
    try {
      const result = await command();
      if (result._tag === "Failure") {
        if (result.error !== null) {
          dependencies.reportFailure(failureTitle, result.error);
        }
        return null;
      }
      return result;
    } catch (error) {
      dependencies.reportFailure(failureTitle, error ?? new Error("Command failed unexpectedly."));
      return null;
    }
  }

  async function registerOrOpen(
    input: ProjectPathInput & {
      readonly createWorkspaceRootIfMissing: boolean;
      readonly initializeGit: boolean;
      readonly failureTitle: string;
    },
  ): Promise<boolean> {
    const existing = findProjectByPath(
      dependencies.getProjects().filter((project) => project.environmentId === input.environmentId),
      input.workspaceRoot,
    );
    const projectId = existing?.id ?? newProjectId();
    if (!existing) {
      const created = await executeCommand(input.failureTitle, () =>
        dependencies.createProject({
          environmentId: input.environmentId,
          projectId,
          title: inferProjectTitleFromPath(input.workspaceRoot),
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
          initializeGit: input.initializeGit,
        }),
      );
      if (created === null) {
        return false;
      }
    }
    const opened = await executeCommand("Failed to open project", () =>
      dependencies.openProject({
        environmentId: input.environmentId,
        projectId,
      }),
    );
    if (opened === null) {
      return false;
    }
    return true;
  }

  return {
    addFolder: (input: ProjectPathInput) =>
      registerOrOpen({
        ...input,
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
        failureTitle: "Failed to add project",
      }),
    create: (input: ProjectPathInput) =>
      registerOrOpen({
        ...input,
        createWorkspaceRootIfMissing: true,
        initializeGit: true,
        failureTitle: "Failed to create project",
      }),
    clone: async (input: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
      readonly parentDir: string;
    }): Promise<boolean> => {
      const cloned = await executeCommand("Clone failed", () =>
        dependencies.cloneRepository(input),
      );
      if (cloned === null) {
        return false;
      }
      return registerOrOpen({
        environmentId: input.environmentId,
        workspaceRoot: cloned.value.path,
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
        failureTitle: "Failed to add cloned project",
      });
    },
  };
}
