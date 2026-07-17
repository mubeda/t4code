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

export interface AddProjectOperationControl {
  readonly shouldContinue: () => boolean;
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

interface ProjectPathInput extends AddProjectOperationControl {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export function createAddProjectOperations(dependencies: AddProjectOperationsDependencies) {
  async function executeCommand<T>(
    failureTitle: string,
    shouldContinue: () => boolean,
    command: () => Promise<AddProjectCommandResult<T>>,
  ): Promise<AddProjectCommandSuccess<T> | null> {
    if (!shouldContinue()) {
      return null;
    }
    try {
      const result = await command();
      if (!shouldContinue()) {
        return null;
      }
      if (result._tag === "Failure") {
        if (result.error !== null && shouldContinue()) {
          dependencies.reportFailure(failureTitle, result.error);
        }
        return null;
      }
      return result;
    } catch (error) {
      if (shouldContinue()) {
        dependencies.reportFailure(
          failureTitle,
          error ?? new Error("Command failed unexpectedly."),
        );
      }
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
    if (!input.shouldContinue()) {
      return false;
    }
    const existing = findProjectByPath(
      dependencies.getProjects().filter((project) => project.environmentId === input.environmentId),
      input.workspaceRoot,
    );
    const projectId = existing?.id ?? newProjectId();
    if (!existing) {
      const created = await executeCommand(input.failureTitle, input.shouldContinue, () =>
        dependencies.createProject({
          environmentId: input.environmentId,
          projectId,
          title: inferProjectTitleFromPath(input.workspaceRoot),
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
          initializeGit: input.initializeGit,
        }),
      );
      if (created === null || !input.shouldContinue()) {
        return false;
      }
    }
    if (!input.shouldContinue()) {
      return false;
    }
    const opened = await executeCommand("Failed to open project", input.shouldContinue, () =>
      dependencies.openProject({
        environmentId: input.environmentId,
        projectId,
      }),
    );
    if (opened === null || !input.shouldContinue()) {
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
    clone: async (
      input: {
        readonly environmentId: EnvironmentId;
        readonly url: string;
        readonly parentDir: string;
      } & AddProjectOperationControl,
    ): Promise<boolean> => {
      if (!input.shouldContinue()) {
        return false;
      }
      const cloned = await executeCommand("Clone failed", input.shouldContinue, () =>
        dependencies.cloneRepository({
          environmentId: input.environmentId,
          url: input.url,
          parentDir: input.parentDir,
        }),
      );
      if (cloned === null || !input.shouldContinue()) {
        return false;
      }
      return registerOrOpen({
        environmentId: input.environmentId,
        workspaceRoot: cloned.value.path,
        shouldContinue: input.shouldContinue,
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
        failureTitle: "Failed to add cloned project",
      });
    },
  };
}
