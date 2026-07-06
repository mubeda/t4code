// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectDuplicateEntryInput,
  ProjectDuplicateEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const DUPLICATE_ENTRY_MAX_ATTEMPTS = 1000;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "exists",
      "make-directory",
      "write-file",
      "rename",
      "remove",
      "copy-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceEntryExistsError extends Schema.TaggedErrorClass<WorkspaceEntryExistsError>()(
  "WorkspaceEntryExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace entry '${this.relativePath}' already exists in '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspaceEntryNotFoundError extends Schema.TaggedErrorClass<WorkspaceEntryNotFoundError>()(
  "WorkspaceEntryNotFoundError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace entry '${this.relativePath}' was not found in '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceEntryExistsError,
  WorkspaceEntryNotFoundError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Create a new file or directory relative to the workspace root.
     *
     * Creates parent directories as needed and fails if the target already
     * exists.
     */
    readonly createEntry: (
      input: ProjectCreateEntryInput,
    ) => Effect.Effect<
      ProjectCreateEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Rename (or move) an entry within the workspace root.
     *
     * Fails if the destination already exists; doubles as a move when the
     * destination lives in a different directory.
     */
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<
      ProjectRenameEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Delete an entry within the workspace root.
     *
     * Removes directories recursively and refuses to delete the workspace root
     * itself.
     */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Duplicate a file within the workspace root, auto-suffixing the copy name
     * (`name copy.ext`, `name copy 2.ext`, …). Files only.
     */
    readonly duplicateEntry: (
      input: ProjectDuplicateEntryInput,
    ) => Effect.Effect<
      ProjectDuplicateEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  /**
   * Resolve the real (symlink-followed) path of an existing target and reject it
   * if it escapes the workspace root. Guards against intermediate symlinked
   * directories that pass the lexical `resolveRelativePathWithinRoot` check but
   * point outside the root once the filesystem resolves them.
   */
  const resolveRealPathWithinRoot = Effect.fn("WorkspaceFileSystem.resolveRealPathWithinRoot")(
    function* (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly absolutePath: string;
    }) {
      const realWorkspaceRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.cwd),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: input.cwd,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: input.absolutePath,
            operation: "realpath-target",
            cause,
          }),
      });
      const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
      if (
        relativeRealPath.startsWith(`..${path.sep}`) ||
        relativeRealPath === ".." ||
        path.isAbsolute(relativeRealPath)
      ) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: realTargetPath,
        });
      }
      return realTargetPath;
    },
  );

  const entryExists = (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly absolutePath: string;
  }) =>
    fileSystem.exists(input.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: input.absolutePath,
            operation: "exists",
            cause,
          }),
      ),
    );

  const makeParentDirectory = (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly absolutePath: string;
  }) =>
    fileSystem.makeDirectory(path.dirname(input.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: path.dirname(input.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realTargetPath = yield* resolveRealPathWithinRoot({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* makeParentDirectory({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createEntry: WorkspaceFileSystem["Service"]["createEntry"] = Effect.fn(
    "WorkspaceFileSystem.createEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const exists = yield* entryExists({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    if (exists) {
      return yield* new WorkspaceEntryExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
      });
    }

    if (input.kind === "directory") {
      yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: target.absolutePath,
              operation: "make-directory",
              cause,
            }),
        ),
      );
    } else {
      yield* makeParentDirectory({
        cwd: input.cwd,
        relativePath: input.relativePath,
        absolutePath: target.absolutePath,
      });
      yield* fileSystem.writeFileString(target.absolutePath, "").pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: target.absolutePath,
              operation: "write-file",
              cause,
            }),
        ),
      );
    }

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const from = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.fromRelativePath,
    });
    const to = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.toRelativePath,
    });

    const fromExists = yield* entryExists({
      cwd: input.cwd,
      relativePath: input.fromRelativePath,
      absolutePath: from.absolutePath,
    });
    if (!fromExists) {
      return yield* new WorkspaceEntryNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: input.fromRelativePath,
        resolvedPath: from.absolutePath,
      });
    }
    // Existing source: reject intermediate-symlink escapes before moving it.
    yield* resolveRealPathWithinRoot({
      cwd: input.cwd,
      relativePath: input.fromRelativePath,
      absolutePath: from.absolutePath,
    });

    const toExists = yield* entryExists({
      cwd: input.cwd,
      relativePath: input.toRelativePath,
      absolutePath: to.absolutePath,
    });
    if (toExists) {
      return yield* new WorkspaceEntryExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.toRelativePath,
        resolvedPath: to.absolutePath,
      });
    }

    yield* makeParentDirectory({
      cwd: input.cwd,
      relativePath: input.toRelativePath,
      absolutePath: to.absolutePath,
    });
    yield* fileSystem.rename(from.absolutePath, to.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.fromRelativePath,
            resolvedPath: to.absolutePath,
            operationPath: from.absolutePath,
            operation: "rename",
            cause,
          }),
      ),
    );

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: to.relativePath };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    // `resolveRelativePathWithinRoot` rejects "." / "" (and traversal), so the
    // workspace root itself can never be targeted for deletion.
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const exists = yield* entryExists({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    if (!exists) {
      return yield* new WorkspaceEntryNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
      });
    }
    // Existing target: reject intermediate-symlink escapes before removing it.
    yield* resolveRealPathWithinRoot({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });

    yield* fileSystem.remove(target.absolutePath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "remove",
            cause,
          }),
      ),
    );

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const findDuplicateTarget = (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly parentRelativePath: string;
    readonly stem: string;
    readonly extension: string;
    readonly attempt: number;
  }): Effect.Effect<
    { absolutePath: string; relativePath: string },
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  > =>
    Effect.gen(function* () {
      const suffix = input.attempt === 1 ? "copy" : `copy ${input.attempt}`;
      const candidateName = `${input.stem} ${suffix}${input.extension}`;
      const candidateRelative =
        input.parentRelativePath === "."
          ? candidateName
          : path.join(input.parentRelativePath, candidateName);
      const candidate = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: candidateRelative,
      });
      const taken = yield* entryExists({
        cwd: input.cwd,
        relativePath: candidateRelative,
        absolutePath: candidate.absolutePath,
      });
      if (!taken) {
        return candidate;
      }
      if (input.attempt >= DUPLICATE_ENTRY_MAX_ATTEMPTS) {
        return yield* new WorkspaceEntryExistsError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: candidate.absolutePath,
        });
      }
      return yield* findDuplicateTarget({ ...input, attempt: input.attempt + 1 });
    });

  const duplicateEntry: WorkspaceFileSystem["Service"]["duplicateEntry"] = Effect.fn(
    "WorkspaceFileSystem.duplicateEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const exists = yield* entryExists({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: source.absolutePath,
    });
    if (!exists) {
      return yield* new WorkspaceEntryNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: source.absolutePath,
      });
    }
    // Duplicate copies the source contents through the path — reject escapes.
    const realSourcePath = yield* resolveRealPathWithinRoot({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: source.absolutePath,
    });

    const sourceStat = yield* fileSystem.stat(realSourcePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realSourcePath,
            operationPath: realSourcePath,
            operation: "stat",
            cause,
          }),
      ),
    );
    if (sourceStat.type !== "File") {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realSourcePath,
      });
    }

    const extension = path.extname(source.relativePath);
    const stem = path.basename(source.relativePath, extension);
    const parentRelativePath = path.dirname(source.relativePath);
    const duplicate = yield* findDuplicateTarget({
      cwd: input.cwd,
      relativePath: input.relativePath,
      parentRelativePath,
      stem,
      extension,
      attempt: 1,
    });

    yield* fileSystem.copyFile(source.absolutePath, duplicate.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: duplicate.absolutePath,
            operationPath: source.absolutePath,
            operation: "copy-file",
            cause,
          }),
      ),
    );

    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: duplicate.relativePath };
  });

  return WorkspaceFileSystem.of({
    readFile,
    writeFile,
    createEntry,
    renameEntry,
    deleteEntry,
    duplicateEntry,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
