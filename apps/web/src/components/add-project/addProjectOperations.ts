import type { EnvironmentId, ProjectId } from "@t4code/contracts";

import { findProjectByPath, inferProjectTitleFromPath } from "~/lib/projectPaths";
import { newProjectId } from "~/lib/utils";

export type AddProjectCommandResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly error: unknown | null };

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
      const created = await dependencies.createProject({
        environmentId: input.environmentId,
        projectId,
        title: inferProjectTitleFromPath(input.workspaceRoot),
        workspaceRoot: input.workspaceRoot,
        createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
        initializeGit: input.initializeGit,
      });
      if (created._tag === "Failure") {
        if (created.error !== null) dependencies.reportFailure(input.failureTitle, created.error);
        return false;
      }
    }
    const opened = await dependencies.openProject({
      environmentId: input.environmentId,
      projectId,
    });
    if (opened._tag === "Failure") {
      if (opened.error !== null) {
        dependencies.reportFailure("Failed to open project", opened.error);
      }
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
      const cloned = await dependencies.cloneRepository(input);
      if (cloned._tag === "Failure") {
        if (cloned.error !== null) dependencies.reportFailure("Clone failed", cloned.error);
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
