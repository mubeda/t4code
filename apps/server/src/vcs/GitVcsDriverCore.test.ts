import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import {
  parseGitLogLine,
  parsePorcelainFileStatus,
  resolveNumstatNewPath,
  sliceAfterFields,
  splitNullSeparatedGitStdoutPaths,
  statusCharToWorkingTreeStatus,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

/** Git separates commit-log fields with a unit-separator (\x1f). */
const COMMIT_FIELD_SEP = "\x1f";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

describe("parsePorcelainFileStatus", () => {
  it("maps untracked, modified, added, deleted and renamed porcelain lines", () => {
    assert.deepStrictEqual(parsePorcelainFileStatus("? new-file.txt"), {
      path: "new-file.txt",
      status: "untracked",
      indexStatus: "untracked",
      worktreeStatus: "untracked",
    });
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 .M N... 100644 100644 100644 aaa bbb tracked.ts"),
      {
        path: "tracked.ts",
        status: "modified",
        indexStatus: "modified",
        worktreeStatus: "modified",
      },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 A. N... 000000 100644 100644 000 ccc added.ts"),
      {
        path: "added.ts",
        status: "added",
        indexStatus: "added",
        worktreeStatus: "modified",
      },
    );
    // Per-area status: an "AM" file is "added" in the index but "modified" in
    // the worktree — the staged and unstaged rows must not share one status.
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 AM N... 000000 100644 100644 000 ccc staged-added.ts"),
      {
        path: "staged-added.ts",
        status: "modified",
        indexStatus: "added",
        worktreeStatus: "modified",
      },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("1 .D N... 100644 100644 000000 ddd ddd gone.ts"),
      {
        path: "gone.ts",
        status: "deleted",
        indexStatus: "modified",
        worktreeStatus: "deleted",
      },
    );
    assert.equal(parsePorcelainFileStatus("! ignored.log"), null);
  });

  it("extracts the current path (before the tab) for rename, copy and unmerged records", () => {
    assert.deepStrictEqual(
      parsePorcelainFileStatus(
        "2 R. N... 100644 100644 100644 aaa bbb R100 newname.ts\toldname.ts",
      ),
      { path: "newname.ts", status: "renamed", indexStatus: "renamed", worktreeStatus: "modified" },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("2 C. N... 100644 100644 100644 aaa bbb C100 copy.ts\tsource.ts"),
      { path: "copy.ts", status: "copied", indexStatus: "copied", worktreeStatus: "modified" },
    );
    assert.deepStrictEqual(
      parsePorcelainFileStatus("u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts"),
      {
        path: "conflict.ts",
        status: "modified",
        indexStatus: "modified",
        worktreeStatus: "modified",
      },
    );
  });

  it("derives letters via statusCharToWorkingTreeStatus", () => {
    assert.equal(statusCharToWorkingTreeStatus("A"), "added");
    assert.equal(statusCharToWorkingTreeStatus("D"), "deleted");
    assert.equal(statusCharToWorkingTreeStatus("R"), "renamed");
    assert.equal(statusCharToWorkingTreeStatus("C"), "copied");
    assert.equal(statusCharToWorkingTreeStatus("M"), "modified");
    assert.equal(statusCharToWorkingTreeStatus("?"), "modified");
  });
});

describe("sliceAfterFields", () => {
  it("preserves runs of spaces inside the trailing path", () => {
    assert.equal(
      sliceAfterFields("1 .M N... 100644 100644 100644 aaa bbb a  b.txt", 8),
      "a  b.txt",
    );
    assert.equal(sliceAfterFields("a b c", 2), "c");
    assert.equal(sliceAfterFields("a b", 2), "");
  });
});

describe("resolveNumstatNewPath", () => {
  it("resolves full and brace-compacted rename forms to the new path", () => {
    assert.equal(resolveNumstatNewPath("plain.ts"), "plain.ts");
    assert.equal(resolveNumstatNewPath("a.ts => b.ts"), "b.ts");
    assert.equal(resolveNumstatNewPath("src/{a.ts => b.ts}"), "src/b.ts");
    assert.equal(resolveNumstatNewPath("{a => b}/x.ts"), "b/x.ts");
    assert.equal(resolveNumstatNewPath("a/{b => c}/x.ts"), "a/c/x.ts");
  });
});

describe("parseGitLogLine", () => {
  it("parses a full field-separated log line and converts seconds to millis", () => {
    const line = ["abcdef0", "abcdef", "the subject", "Ada Lovelace", "1700000000"].join(
      COMMIT_FIELD_SEP,
    );
    assert.deepStrictEqual(parseGitLogLine(line), {
      sha: "abcdef0",
      shortSha: "abcdef",
      subject: "the subject",
      authorName: "Ada Lovelace",
      authoredAtMs: 1_700_000_000_000,
    });
  });

  it("returns null for blank lines and lines missing the sha or short sha", () => {
    assert.equal(parseGitLogLine(""), null);
    assert.equal(parseGitLogLine("   \t  "), null);
    // A single field (no separators) has no short sha.
    assert.equal(parseGitLogLine("onlySha"), null);
    // Present sha but empty short sha field.
    assert.equal(parseGitLogLine(`abc${COMMIT_FIELD_SEP}`), null);
  });

  it("defaults missing trailing fields and coerces a non-numeric timestamp to 0", () => {
    // sha + short sha only: subject/author default to "", timestamp defaults to 0.
    assert.deepStrictEqual(parseGitLogLine(`abc${COMMIT_FIELD_SEP}def`), {
      sha: "abc",
      shortSha: "def",
      subject: "",
      authorName: "",
      authoredAtMs: 0,
    });
    const nonNumeric = ["abc", "def", "s", "a", "not-a-number"].join(COMMIT_FIELD_SEP);
    assert.equal(parseGitLogLine(nonNumeric)?.authoredAtMs, 0);
  });
});

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const missingWorktree = pathService.join(cwd, "missing-worktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver
          .removeWorktree({ cwd, path: missingWorktree })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 3,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports per-file working-tree status letters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "tracked.ts"]);
        yield* git(cwd, ["commit", "-m", "add tracked"]);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 2;\n");
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
        const byPath = new Map(status.workingTree.files.map((file) => [file.path, file.status]));

        assert.equal(byPath.get("tracked.ts"), "modified");
        assert.equal(byPath.get("untracked.txt"), "untracked");
      }),
    );

    it.effect("splits staged and unstaged changes into areas and stages selected files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "tracked.ts"]);
        yield* git(cwd, ["commit", "-m", "add tracked"]);
        // one staged edit, one unstaged edit, one untracked file
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 2;\n");
        yield* git(cwd, ["add", "tracked.ts"]);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 3;\n");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const before = yield* driver.statusDetails(cwd);
        const areas = new Set(before.workingTree.files.map((file) => file.area));
        assert.isTrue(areas.has("staged"));
        assert.isTrue(areas.has("unstaged"));
        assert.isTrue(areas.has("untracked"));

        // a file changed in both index and worktree produces TWO entries
        const trackedEntries = before.workingTree.files.filter(
          (file) => file.path === "tracked.ts",
        );
        assert.equal(trackedEntries.length, 2);
        assert.isTrue(trackedEntries.some((entry) => entry.area === "staged"));
        assert.isTrue(trackedEntries.some((entry) => entry.area === "unstaged"));

        // stage the untracked file, then confirm it moves to the staged area
        yield* driver.stageFiles({ cwd, filePaths: ["untracked.txt"] });
        const after = yield* driver.statusDetails(cwd);
        const untrackedEntry = after.workingTree.files.find(
          (file) => file.path === "untracked.txt",
        );
        assert.equal(untrackedEntry?.area, "staged");
      }),
    );

    it.effect("reports index status for staged entries and worktree status for unstaged", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        // A brand-new file staged, then edited again in the worktree -> "AM":
        // added in the index, modified in the worktree.
        yield* writeTextFile(cwd, "added.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "added.ts"]);
        yield* writeTextFile(cwd, "added.ts", "export const a = 2;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
        const entries = status.workingTree.files.filter((file) => file.path === "added.ts");
        const staged = entries.find((entry) => entry.area === "staged");
        const unstaged = entries.find((entry) => entry.area === "unstaged");
        assert.equal(staged?.status, "added", "staged entry reflects the index (X) status");
        assert.equal(
          unstaged?.status,
          "modified",
          "unstaged entry reflects the worktree (Y) status",
        );
      }),
    );

    it.effect("discarding an unstaged edit preserves the staged snapshot", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "file.ts", "committed\n");
        yield* git(cwd, ["add", "file.ts"]);
        yield* git(cwd, ["commit", "-m", "add file"]);
        // Stage version A, then edit the worktree to B without staging.
        yield* writeTextFile(cwd, "file.ts", "A\n");
        yield* git(cwd, ["add", "file.ts"]);
        yield* writeTextFile(cwd, "file.ts", "B\n");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.discardFiles({ cwd, filePaths: ["file.ts"] });

        // The index must still hold the STAGED version A (not wiped to HEAD)…
        const indexContent = yield* git(cwd, ["show", ":file.ts"]);
        assert.equal(indexContent, "A");
        const stagedDiff = yield* git(cwd, ["diff", "--cached", "--name-only"]);
        assert.isTrue(
          stagedDiff.includes("file.ts"),
          "staged snapshot must not be wiped by discarding the unstaged edit",
        );
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const contents = yield* fs.readFileString(pathService.join(cwd, "file.ts"));
        // `git restore` re-checks-out through core.autocrlf, so normalize EOLs.
        assert.equal(contents.replace(/\r\n/g, "\n"), "A\n");
      }),
    );

    it.effect("unstageFiles works on an unborn HEAD (fresh repo, no commits)", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "new.txt", "hello\n");
        yield* git(cwd, ["add", "new.txt"]);

        yield* driver.unstageFiles({ cwd, filePaths: ["new.txt"] });

        const porcelain = yield* git(cwd, ["status", "--porcelain"]);
        assert.isTrue(
          porcelain.startsWith("??"),
          `expected new.txt untracked after unstage, got: ${porcelain}`,
        );
      }),
    );

    it.effect("reports line counts for untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "untracked.txt", "one\ntwo\nthree\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
        const entry = status.workingTree.files.find((file) => file.path === "untracked.txt");
        assert.equal(entry?.area, "untracked");
        assert.equal(entry?.insertions, 3);
      }),
    );

    it.effect("listCommits returns empty history for an unborn HEAD instead of failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const result = yield* driver.listCommits({ cwd, limit: 10 });
        assert.deepStrictEqual(result, { commits: [], nextCursor: null });
      }),
    );

    it.effect("resolves brace-compacted staged rename paths to the new path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "src/old-name.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "src/old-name.ts"]);
        yield* git(cwd, ["commit", "-m", "add file to rename"]);
        // Staged rename within a shared prefix -> numstat emits the compacted
        // form "src/{old-name.ts => new-name.ts}".
        yield* git(cwd, ["mv", "src/old-name.ts", "src/new-name.ts"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
        const paths = status.workingTree.files.map((file) => file.path);
        assert.isTrue(
          paths.includes("src/new-name.ts"),
          `expected the resolved rename path, got ${paths.join(", ")}`,
        );
        assert.isFalse(
          paths.some((p) => p.includes("}")),
          "brace-compacted rename path must be resolved, not left as 'new-name.ts}'",
        );
      }),
    );

    it.effect("discardFiles([]) is a no-op and does NOT clean untracked files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "keep-untracked.txt", "keep\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.discardFiles({ cwd, filePaths: [] });
        const status = yield* driver.statusDetails(cwd);
        assert.isTrue(
          status.workingTree.files.some((file) => file.path === "keep-untracked.txt"),
          "empty filePaths must not delete untracked files",
        );
      }),
    );

    it.effect(
      "discardFiles removes listed untracked files and reverts listed tracked changes",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(cwd, "tracked.ts", "1\n");
          yield* git(cwd, ["add", "tracked.ts"]);
          yield* git(cwd, ["commit", "-m", "add tracked"]);
          yield* writeTextFile(cwd, "tracked.ts", "2\n");
          yield* writeTextFile(cwd, "junk.txt", "junk\n");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.discardFiles({ cwd, filePaths: ["tracked.ts", "junk.txt"] });
          const status = yield* driver.statusDetails(cwd);
          assert.equal(status.workingTree.files.length, 0);
        }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "GCM_INTERACTIVE=%s\\n" "${GCM_INTERACTIVE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS=%s\\n" "${SSH_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS_REQUIRE=%s\\n" "${SSH_ASKPASS_REQUIRE:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );
  });

  describe("commit history", () => {
    it.effect("lists recent commits with subject and author", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "second.txt", "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, [
          "-c",
          "user.name=Ada",
          "-c",
          "user.email=ada@example.com",
          "commit",
          "-m",
          "second commit",
        ]);

        const result = yield* (yield* GitVcsDriver.GitVcsDriver).listCommits({ cwd, limit: 10 });
        assert.isAtLeast(result.commits.length, 2);
        assert.equal(result.commits[0]?.subject, "second commit");
        assert.equal(result.commits[0]?.authorName, "Ada");
        assert.isTrue(result.commits[0]!.authoredAtMs > 0);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({ cwd, remoteName: "origin" });

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.gh-merge-base"),
          initialBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });

  describe("execute output limits and stdin", () => {
    it.effect("truncates and marks output past maxOutputBytes when marking is enabled", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // `git --version` prints well over 5 bytes; with the marker enabled the
        // output is capped rather than failing.
        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.truncateMarked",
          cwd,
          args: ["--version"],
          maxOutputBytes: 5,
          appendTruncationMarker: true,
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });

        assert.isTrue(result.stdoutTruncated);
        assert.isAtMost(result.stdout.length, 5);
      }),
    );

    it.effect("fails when output exceeds maxOutputBytes and marking is disabled", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.truncateFail",
            cwd,
            args: ["--version"],
            maxOutputBytes: 5,
            timeoutMs: 10_000,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "GitCommandError");
        assert.include(error.detail ?? "", "exceeded");
      }),
    );

    it.effect("writes provided stdin to the git process", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const result = yield* driver.execute({
          operation: "GitVcsDriver.test.hashObject",
          cwd,
          args: ["hash-object", "--stdin"],
          stdin: "hello\n",
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });

        // git hash-object of "hello\n" is a stable, known object id.
        assert.equal(result.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
      }),
    );
  });

  describe("commit context and messages", () => {
    it.effect("reports staged changes as the commit message context", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "tracked.ts"]);
        yield* git(cwd, ["commit", "-m", "add tracked"]);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 2;\n");
        yield* git(cwd, ["add", "tracked.ts"]);

        const context = yield* (yield* GitVcsDriver.GitVcsDriver).readCommitMessageContext(cwd);
        assert.isTrue(context.hasChanges);
        assert.include(context.summary, "tracked.ts");
        assert.include(context.patch, "export const a = 2;");
      }),
    );

    it.effect("falls back to the worktree diff when nothing is staged", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 1;\n");
        yield* git(cwd, ["add", "tracked.ts"]);
        yield* git(cwd, ["commit", "-m", "add tracked"]);
        // Modify without staging: no cached diff, but `diff HEAD` shows it.
        yield* writeTextFile(cwd, "tracked.ts", "export const a = 99;\n");

        const context = yield* (yield* GitVcsDriver.GitVcsDriver).readCommitMessageContext(cwd);
        assert.isTrue(context.hasChanges);
        assert.include(context.summary, "tracked.ts");
        assert.include(context.patch, "export const a = 99;");
      }),
    );

    it.effect("includes untracked-only files via no-index diffs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "brand-new.txt", "line-one\nline-two\n");

        const context = yield* (yield* GitVcsDriver.GitVcsDriver).readCommitMessageContext(cwd);
        assert.isTrue(context.hasChanges);
        assert.include(context.summary, "A\tbrand-new.txt");
        assert.include(context.patch, "line-one");
      }),
    );

    it.effect("reports no changes for a clean tree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);

        const context = yield* (yield* GitVcsDriver.GitVcsDriver).readCommitMessageContext(cwd);
        assert.deepStrictEqual(context, { hasChanges: false, summary: "", patch: "" });
      }),
    );

    it.effect("streams commit output through the progress callback", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "note.txt", "note\n");
        yield* driver.prepareCommitContext(cwd);

        const linesRef = yield* Ref.make<ReadonlyArray<string>>([]);
        const result = yield* driver.commit(cwd, "Add note", "", {
          progress: {
            onOutputLine: ({ text }) => Ref.update(linesRef, (lines) => [...lines, text]),
          },
        });

        assert.match(result.commitSha, /^[a-f0-9]{40}$/);
        const lines = yield* Ref.get(linesRef);
        assert.isAbove(lines.length, 0);
      }),
    );

    it.effect("surfaces git hook progress through the trace2 monitor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // A pre-commit hook makes git emit a trace2 "hook" child event, which the
        // trace2 monitor decodes into an onHookStarted progress callback.
        const hookPath = pathService.join(cwd, ".git", "hooks", "pre-commit");
        yield* fs.writeFileString(hookPath, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(hookPath, 0o755);

        yield* writeTextFile(cwd, "hooked.txt", "hooked\n");
        yield* driver.prepareCommitContext(cwd);

        const startedRef = yield* Ref.make<ReadonlyArray<string>>([]);
        const finishedRef = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* driver.commit(cwd, "Add hooked", "", {
          progress: {
            onHookStarted: (hookName) =>
              Ref.update(startedRef, (names) => [...names, hookName]),
            onHookFinished: ({ hookName }) =>
              Ref.update(finishedRef, (names) => [...names, hookName]),
          },
        });

        const started = yield* Ref.get(startedRef);
        assert.include([...started], "pre-commit");
      }),
    );
  });

  describe("range and review context", () => {
    it.effect("summarizes commits and diffs across a base range", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature/range"]);
        yield* writeTextFile(cwd, "range.ts", "export const value = 1;\n");
        yield* git(cwd, ["add", "range.ts"]);
        yield* git(cwd, ["commit", "-m", "range change"]);

        const context = yield* (yield* GitVcsDriver.GitVcsDriver).readRangeContext(
          cwd,
          initialBranch,
        );
        assert.include(context.commitSummary, "range change");
        assert.include(context.diffSummary, "range.ts");
        assert.include(context.diffPatch, "export const value = 1;");
      }),
    );

    it.effect("returns no sources for a non-repository review preview", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();

        const preview = yield* (yield* GitVcsDriver.GitVcsDriver).getReviewDiffPreview({
          cwd,
          ignoreWhitespace: false,
        });
        assert.deepStrictEqual(preview.sources, []);
      }),
    );

    it.effect("includes untracked file content in the dirty worktree preview", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "untracked-preview.txt", "brand new content\n");

        const preview = yield* (yield* GitVcsDriver.GitVcsDriver).getReviewDiffPreview({
          cwd,
          ignoreWhitespace: false,
        });
        const worktree = preview.sources.find((source) => source.kind === "working-tree");
        assert.include(worktree?.diff ?? "", "brand new content");
      }),
    );
  });

  describe("pull operations", () => {
    it.effect("fails to push from a detached HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", headSha]);

        const error = yield* (yield* GitVcsDriver.GitVcsDriver)
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.include(error.detail ?? "", "detached HEAD");
      }),
    );

    it.effect("fails to pull from a detached HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", headSha]);

        const error = yield* (yield* GitVcsDriver.GitVcsDriver).pullCurrentBranch(cwd).pipe(
          Effect.flip,
        );
        assert.equal(error._tag, "GitCommandError");
        assert.include(error.detail ?? "", "detached HEAD");
      }),
    );

    it.effect("fails to pull when the branch has no upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);

        const error = yield* (yield* GitVcsDriver.GitVcsDriver).pullCurrentBranch(cwd).pipe(
          Effect.flip,
        );
        assert.equal(error._tag, "GitCommandError");
        assert.include(error.detail ?? "", "no upstream");
      }),
    );

    it.effect("skips when up to date, then fast-forwards a real upstream change", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const peer = yield* makeTmpDir("git-vcs-driver-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const upToDate = yield* driver.pullCurrentBranch(cwd);
        assert.equal(upToDate.status, "skipped_up_to_date");
        assert.equal(upToDate.refName, initialBranch);

        // A peer advances the remote branch.
        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "peer@test.com"]);
        yield* git(peer, ["config", "user.name", "Peer"]);
        yield* writeTextFile(peer, "peer.txt", "peer\n");
        yield* git(peer, ["add", "peer.txt"]);
        yield* git(peer, ["commit", "-m", "peer commit"]);
        yield* git(peer, ["push", "origin", initialBranch]);

        const pulled = yield* driver.pullCurrentBranch(cwd);
        assert.equal(pulled.status, "pulled");
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        assert.isTrue(yield* fs.exists(pathService.join(cwd, "peer.txt")));
      }),
    );
  });

  describe("remote name resolution", () => {
    it.effect("prefers origin, falls back to the first remote, else errors", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // No remotes yet: resolving the primary remote fails.
        const noRemoteError = yield* driver.resolvePrimaryRemoteName(cwd).pipe(Effect.flip);
        assert.equal(noRemoteError._tag, "GitCommandError");
        assert.include(noRemoteError.detail ?? "", "No git remote");

        // Only a non-origin remote: it is chosen as primary.
        yield* git(cwd, ["remote", "add", "upstream", "https://example.invalid/u.git"]);
        assert.equal(yield* driver.resolvePrimaryRemoteName(cwd), "upstream");

        // Once origin exists it wins.
        yield* git(cwd, ["remote", "add", "origin", "https://example.invalid/o.git"]);
        assert.equal(yield* driver.resolvePrimaryRemoteName(cwd), "origin");
      }),
    );

    it.effect("ensureRemote reuses a matching url, adds new, and de-collides names", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // Adds a brand-new remote under the preferred name.
        const added = yield* driver.ensureRemote({
          cwd,
          preferredName: "fork",
          url: "https://example.invalid/org/repo.git",
        });
        assert.equal(added, "fork");

        // A normalized-equal url (case + trailing slash + no .git) reuses it.
        const reused = yield* driver.ensureRemote({
          cwd,
          preferredName: "other",
          url: "https://Example.invalid/Org/Repo/",
        });
        assert.equal(reused, "fork");

        // The preferred name is taken by a different url -> a suffix is appended.
        const collided = yield* driver.ensureRemote({
          cwd,
          preferredName: "fork",
          url: "https://example.invalid/org/other.git",
        });
        assert.equal(collided, "fork-1");
      }),
    );

    it.effect("listLocalBranchNames returns every local branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "feature/a"]);
        yield* git(cwd, ["branch", "feature/b"]);

        const names = yield* (yield* GitVcsDriver.GitVcsDriver).listLocalBranchNames(cwd);
        assert.includeMembers([...names], [initialBranch, "feature/a", "feature/b"]);
      }),
    );

    it.effect("status summarizes repository state with a null pull request", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "dirty.txt", "dirty\n");

        const summary = yield* (yield* GitVcsDriver.GitVcsDriver).status({ cwd });
        assert.equal(summary.isRepo, true);
        assert.equal(summary.refName, initialBranch);
        assert.equal(summary.hasWorkingTreeChanges, true);
        assert.equal(summary.pr, null);
      }),
    );
  });

  describe("clone and remote branch materialization", () => {
    it.effect("clones with an explicit and a derived directory name", () =>
      Effect.gen(function* () {
        const source = yield* makeTmpDir("git-clone-source-");
        const { initialBranch } = yield* initRepoWithCommit(source);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;

        const explicitParent = yield* makeTmpDir("git-clone-explicit-");
        const explicit = yield* driver.clone({
          parentDir: explicitParent,
          url: source,
          directoryName: "explicit-name",
        });
        assert.equal(explicit.path, pathService.join(explicitParent, "explicit-name"));
        assert.equal(
          yield* git(explicit.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
          initialBranch,
        );

        // Derived name comes from the last url path segment ("repo.git" -> "repo").
        const derivedSourceParent = yield* makeTmpDir("git-clone-derived-src-");
        const derivedSource = pathService.join(derivedSourceParent, "repo.git");
        yield* fs.makeDirectory(derivedSource, { recursive: true });
        yield* git(derivedSource, ["clone", "--bare", source, "."]);
        const derivedParent = yield* makeTmpDir("git-clone-derived-");
        const derived = yield* driver.clone({ parentDir: derivedParent, url: derivedSource });
        assert.equal(derived.path, pathService.join(derivedParent, "repo"));
        assert.isTrue(yield* fs.exists(pathService.join(derived.path, ".git")));
      }),
    );

    it.effect("fetchRemoteBranch materializes a local branch, then force-updates it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-mat"]);
        yield* writeTextFile(cwd, "remote-mat.txt", "one\n");
        yield* git(cwd, ["add", "remote-mat.txt"]);
        yield* git(cwd, ["commit", "-m", "remote feature"]);
        yield* git(cwd, ["push", "origin", "feature/remote-mat"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["branch", "-D", "feature/remote-mat"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // First materialization creates the local branch (no prior local branch).
        yield* driver.fetchRemoteBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: "feature/remote-mat",
          localBranch: "feature/remote-mat",
        });
        assert.equal(
          yield* git(cwd, ["show-ref", "--verify", "--quiet", "refs/heads/feature/remote-mat"]).pipe(
            Effect.as("exists"),
          ),
          "exists",
        );

        // Second call takes the force-update path (local branch already exists).
        yield* driver.fetchRemoteBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: "feature/remote-mat",
          localBranch: "feature/remote-mat",
        });
        const localSha = yield* git(cwd, ["rev-parse", "feature/remote-mat"]);
        const remoteSha = yield* git(cwd, ["rev-parse", "refs/remotes/origin/feature/remote-mat"]);
        assert.equal(localSha, remoteSha);
      }),
    );

    it.effect("fetchRemoteTrackingBranch and setBranchUpstream wire up tracking", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // Drop the remote-tracking ref so fetchRemoteTrackingBranch must recreate it.
        yield* git(cwd, [
          "update-ref",
          "-d",
          `refs/remotes/origin/${initialBranch}`,
        ]).pipe(Effect.ignore);
        yield* driver.fetchRemoteTrackingBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: initialBranch,
        });
        assert.equal(
          yield* git(cwd, [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${initialBranch}`,
          ]).pipe(Effect.as("ok")),
          "ok",
        );

        yield* driver.setBranchUpstream({
          cwd,
          branch: initialBranch,
          remoteName: "origin",
          remoteBranch: initialBranch,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", `${initialBranch}@{upstream}`]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("fetchPullRequestBranch fetches a pull ref into a local branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        // Publish an extra commit under a pull-request ref on the remote.
        yield* writeTextFile(cwd, "pr.txt", "pr\n");
        yield* git(cwd, ["add", "pr.txt"]);
        yield* git(cwd, ["commit", "-m", "pr commit"]);
        const prSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/pull/7/head"]);
        yield* git(cwd, ["reset", "--hard", "HEAD~1"]);

        yield* (yield* GitVcsDriver.GitVcsDriver).fetchPullRequestBranch({
          cwd,
          prNumber: 7,
          branch: "pr-7",
        });
        assert.equal(yield* git(cwd, ["rev-parse", "pr-7"]), prSha);
      }),
    );
  });

  describe("switching to remote-tracking refs", () => {
    it.effect("tracks a remote ref, then reuses the local tracking branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/track"]);
        yield* writeTextFile(cwd, "track.txt", "track\n");
        yield* git(cwd, ["add", "track.txt"]);
        yield* git(cwd, ["commit", "-m", "track commit"]);
        yield* git(cwd, ["push", "origin", "feature/track"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["branch", "-D", "feature/track"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // No local branch yet -> checkout --track creates one named after the ref.
        const tracked = yield* driver.switchRef({ cwd, refName: "origin/feature/track" });
        assert.equal(tracked.refName, "feature/track");
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/track@{upstream}"]),
          "origin/feature/track",
        );

        // Switch away, then switching to the remote ref again reuses the tracking branch.
        yield* git(cwd, ["checkout", initialBranch]);
        const reused = yield* driver.switchRef({ cwd, refName: "origin/feature/track" });
        assert.equal(reused.refName, "feature/track");
      }),
    );
  });
});
