// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

/**
 * Create a symlink for escape-rejection tests, reporting whether it succeeded.
 * Windows without the symlink privilege (or Developer Mode) rejects symlink
 * creation with EPERM; those environments skip the symlink-escape assertions
 * (which still run wherever symlinks can be created, e.g. CI on Linux).
 */
const createSymlinkOrSkip = Effect.fn("createSymlinkOrSkip")(function* (
  target: string,
  linkPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.symlink(target, linkPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * Create a directory link for intermediate-symlink escape tests, reporting
 * whether it succeeded. Uses a Windows junction (`type: "junction"`), which does
 * NOT require the symlink privilege, so this exercises the realpath escape guard
 * even on locked-down Windows; off Windows the type is ignored and a directory
 * symlink is created instead.
 */
const createDirLinkOrSkip = Effect.fn("createDirLinkOrSkip")(function* (
  targetDir: string,
  linkPath: string,
) {
  return yield* Effect.tryPromise(() => NodeFSP.symlink(targetDir, linkPath, "junction")).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        const created = yield* createSymlinkOrSkip(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );
        if (!created) return;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("createEntry", () => {
    it.effect("creates an empty file, making parent directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.createEntry({
          cwd,
          relativePath: "src/nested/new.ts",
          kind: "file",
        });

        expect(result).toEqual({ relativePath: "src/nested/new.ts" });
        const contents = yield* fileSystem
          .readFileString(path.join(cwd, "src/nested/new.ts"))
          .pipe(Effect.orDie);
        expect(contents).toBe("");
      }),
    );

    it.effect("creates a directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.createEntry({
          cwd,
          relativePath: "docs/plans",
          kind: "directory",
        });

        expect(result).toEqual({ relativePath: "docs/plans" });
        const stat = yield* fileSystem.stat(path.join(cwd, "docs/plans"));
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("invalidates the workspace entry search cache after create", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "seed.ts", "export {};\n");

        const before = yield* workspaceEntries.list({ cwd });
        expect(before.entries.some((entry) => entry.path === "created.ts")).toBe(false);

        yield* workspaceFileSystem.createEntry({ cwd, relativePath: "created.ts", kind: "file" });

        const after = yield* workspaceEntries.list({ cwd });
        expect(after.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "created.ts" })]),
        );
      }),
    );

    it.effect("rejects creating an entry that already exists", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "exists.ts", "export {};\n");

        const error = yield* workspaceFileSystem
          .createEntry({ cwd, relativePath: "exists.ts", kind: "file" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryExistsError);
        expect(error).toMatchObject({ workspaceRoot: cwd, relativePath: "exists.ts" });
      }),
    );

    it.effect("rejects creating an entry outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .createEntry({ cwd, relativePath: "../escape.ts", kind: "file" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.ts",
        );
        const escapedStat = yield* fileSystem
          .stat(path.resolve(cwd, "..", "escape.ts"))
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("renameEntry", () => {
    it.effect("renames a file in place", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "old.ts", "content\n");

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          fromRelativePath: "old.ts",
          toRelativePath: "new.ts",
        });

        expect(result).toEqual({ relativePath: "new.ts" });
        const moved = yield* fileSystem.readFileString(path.join(cwd, "new.ts")).pipe(Effect.orDie);
        expect(moved).toBe("content\n");
        expect(yield* fileSystem.exists(path.join(cwd, "old.ts"))).toBe(false);
      }),
    );

    it.effect("moves a file into a new subdirectory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "top.ts", "hi\n");

        const result = yield* workspaceFileSystem.renameEntry({
          cwd,
          fromRelativePath: "top.ts",
          toRelativePath: "nested/dir/top.ts",
        });

        expect(result).toEqual({ relativePath: "nested/dir/top.ts" });
        const moved = yield* fileSystem
          .readFileString(path.join(cwd, "nested/dir/top.ts"))
          .pipe(Effect.orDie);
        expect(moved).toBe("hi\n");
      }),
    );

    it.effect("rejects renaming onto an existing destination", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");
        yield* writeTextFile(cwd, "b.ts", "b\n");

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, fromRelativePath: "a.ts", toRelativePath: "b.ts" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryExistsError);
        expect(error).toMatchObject({ workspaceRoot: cwd, relativePath: "b.ts" });
        expect(yield* fileSystem.readFileString(path.join(cwd, "a.ts")).pipe(Effect.orDie)).toBe(
          "a\n",
        );
        expect(yield* fileSystem.readFileString(path.join(cwd, "b.ts")).pipe(Effect.orDie)).toBe(
          "b\n",
        );
      }),
    );

    it.effect("rejects renaming a missing source", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, fromRelativePath: "missing.ts", toRelativePath: "new.ts" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryNotFoundError);
        expect(error).toMatchObject({ workspaceRoot: cwd, relativePath: "missing.ts" });
      }),
    );

    it.effect("rejects renaming to a destination outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a.ts", "a\n");

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, fromRelativePath: "a.ts", toRelativePath: "../escape.ts" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.ts",
        );
      }),
    );

    it.effect("rejects renaming a source that resolves outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        const created = yield* createSymlinkOrSkip(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );
        if (!created) return;

        const error = yield* workspaceFileSystem
          .renameEntry({ cwd, fromRelativePath: "linked-secret.txt", toRelativePath: "copy.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(yield* fileSystem.exists(path.join(outsideDir, "secret.txt"))).toBe(true);
      }),
    );
  });

  describe("deleteEntry", () => {
    it.effect("deletes a file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "gone.ts", "bye\n");

        const result = yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "gone.ts" });

        expect(result).toEqual({ relativePath: "gone.ts" });
        expect(yield* fileSystem.exists(path.join(cwd, "gone.ts"))).toBe(false);
      }),
    );

    it.effect("deletes a directory recursively", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "pkg/a.ts", "a\n");
        yield* writeTextFile(cwd, "pkg/nested/b.ts", "b\n");

        const result = yield* workspaceFileSystem.deleteEntry({ cwd, relativePath: "pkg" });

        expect(result).toEqual({ relativePath: "pkg" });
        expect(yield* fileSystem.exists(path.join(cwd, "pkg"))).toBe(false);
      }),
    );

    it.effect("refuses to delete the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "." })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        expect(yield* fileSystem.exists(cwd)).toBe(true);
      }),
    );

    it.effect("rejects deleting a missing entry", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "missing.ts" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceEntryNotFoundError);
      }),
    );

    it.effect("refuses to delete a path that resolves outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        const created = yield* createSymlinkOrSkip(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );
        if (!created) return;

        const error = yield* workspaceFileSystem
          .deleteEntry({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(yield* fileSystem.exists(path.join(outsideDir, "secret.txt"))).toBe(true);
      }),
    );

    it.effect(
      "refuses to delete through an intermediate symlinked directory that escapes the root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          const created = yield* createDirLinkOrSkip(outsideDir, path.join(cwd, "linkdir"));
          if (!created) return;

          // "linkdir/secret.txt" contains no ".." so it passes the lexical
          // resolveRelativePathWithinRoot check; only realpath (which follows the
          // intermediate junction) catches that it escapes the workspace root.
          const error = yield* workspaceFileSystem
            .deleteEntry({ cwd, relativePath: "linkdir/secret.txt" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fileSystem.exists(path.join(outsideDir, "secret.txt"))).toBe(true);
        }),
    );
  });

  describe("duplicateEntry", () => {
    it.effect("duplicates a file with an auto-suffixed name (copy, copy 2)", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "# notes\n");

        const first = yield* workspaceFileSystem.duplicateEntry({ cwd, relativePath: "notes.md" });
        expect(first).toEqual({ relativePath: "notes copy.md" });
        expect(
          yield* fileSystem.readFileString(path.join(cwd, "notes copy.md")).pipe(Effect.orDie),
        ).toBe("# notes\n");

        const second = yield* workspaceFileSystem.duplicateEntry({ cwd, relativePath: "notes.md" });
        expect(second).toEqual({ relativePath: "notes copy 2.md" });
      }),
    );

    it.effect("duplicates a file within its directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/util.ts", "export {};\n");

        const result = yield* workspaceFileSystem.duplicateEntry({
          cwd,
          relativePath: "src/util.ts",
        });

        expect(result).toEqual({ relativePath: "src/util copy.ts" });
        expect(
          yield* fileSystem.readFileString(path.join(cwd, "src/util copy.ts")).pipe(Effect.orDie),
        ).toBe("export {};\n");
      }),
    );

    it.effect("rejects duplicating a directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "adir"));

        const error = yield* workspaceFileSystem
          .duplicateEntry({ cwd, relativePath: "adir" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
      }),
    );

    it.effect("rejects duplicating a source that resolves outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        const created = yield* createSymlinkOrSkip(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );
        if (!created) return;

        const error = yield* workspaceFileSystem
          .duplicateEntry({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(yield* fileSystem.exists(path.join(cwd, "linked-secret copy.txt"))).toBe(false);
      }),
    );
  });
});
