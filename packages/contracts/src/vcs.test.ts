import { DateTime, Exit, Option, SchemaIssue } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  VcsDriverCapabilities,
  VcsDriverKind,
  VcsError,
  VcsFreshness,
  VcsFreshnessSource,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsOutputDecodeError,
  VcsProcessExitError,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
  VcsRemote,
  VcsRepositoryDetectionError,
  VcsRepositoryIdentity,
  VcsUnsupportedOperationError,
} from "./vcs.ts";

const decodeDriverKind = Schema.decodeUnknownSync(VcsDriverKind);
const decodeFreshnessSource = Schema.decodeUnknownSync(VcsFreshnessSource);
const decodeFreshness = Schema.decodeUnknownSync(VcsFreshness);
const encodeFreshness = Schema.encodeSync(VcsFreshness);
const decodeCapabilities = Schema.decodeUnknownSync(VcsDriverCapabilities);
const decodeRepositoryIdentity = Schema.decodeUnknownSync(VcsRepositoryIdentity);
const decodeWorkspaceFiles = Schema.decodeUnknownSync(VcsListWorkspaceFilesResult);
const decodeRemote = Schema.decodeUnknownSync(VcsRemote);
const decodeRemotes = Schema.decodeUnknownSync(VcsListRemotesResult);
const decodeVcsError = Schema.decodeUnknownSync(VcsError);
const encodeVcsError = Schema.encodeSync(VcsError);
const decodeOutputError = Schema.decodeUnknownSync(VcsOutputDecodeError);
const encodeOutputError = Schema.encodeSync(VcsOutputDecodeError);

interface DecodeFailureExpectation {
  readonly rootTag: SchemaIssue.Issue["_tag"];
  readonly paths?: ReadonlyArray<ReadonlyArray<PropertyKey>>;
  readonly containsTag?: SchemaIssue.Issue["_tag"];
  readonly childIssueCount?: number;
}

const collectIssues = (issue: SchemaIssue.Issue): ReadonlyArray<SchemaIssue.Issue> => {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return [issue, ...collectIssues(issue.issue)];
    case "Composite":
    case "AnyOf":
      return [issue, ...issue.issues.flatMap((child) => collectIssues(child))];
    default:
      return [issue];
  }
};

const expectDecodeFailure = (
  schema: Schema.Decoder<unknown, never>,
  input: unknown,
  expected: DecodeFailureExpectation,
): void => {
  const exit = Schema.decodeUnknownExit(schema)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;

  const error = Exit.findErrorOption(exit);
  expect(Option.isSome(error)).toBe(true);
  if (!Option.isSome(error)) return;

  expect(Schema.isSchemaError(error.value)).toBe(true);
  if (!Schema.isSchemaError(error.value)) return;

  const issue = error.value.issue;
  const issues = collectIssues(issue);
  expect(issue._tag).toBe(expected.rootTag);
  for (const path of expected.paths ?? []) {
    const paths = issues.flatMap((nested) => (nested._tag === "Pointer" ? [[...nested.path]] : []));
    expect(paths).toContainEqual([...path]);
  }
  if (expected.containsTag !== undefined) {
    expect(issues.map((nested) => nested._tag)).toContain(expected.containsTag);
  }
  if (expected.childIssueCount !== undefined) {
    expect(issue._tag === "Composite" || issue._tag === "AnyOf").toBe(true);
    if (issue._tag === "Composite" || issue._tag === "AnyOf") {
      expect(issue.issues).toHaveLength(expected.childIssueCount);
    }
  }
};

const encodedFreshness = {
  source: "live-local" as const,
  observedAt: DateTime.makeUnsafe("2026-07-13T12:00:00.000Z"),
  expiresAt: Option.none<DateTime.Utc>(),
};

describe("VCS driver schemas", () => {
  it("decodes every supported driver kind", () => {
    expect(["git", "jj", "unknown"].map((kind) => decodeDriverKind(kind))).toEqual([
      "git",
      "jj",
      "unknown",
    ]);
  });

  it("decodes every freshness source and round-trips UTC timestamps with Option", () => {
    expect(
      ["live-local", "cached-local", "cached-remote", "explicit-remote"].map((source) =>
        decodeFreshnessSource(source),
      ),
    ).toEqual(["live-local", "cached-local", "cached-remote", "explicit-remote"]);

    expect(encodeFreshness(decodeFreshness(encodedFreshness))).toEqual(encodedFreshness);
  });

  it("reports structured literal and DateTime failures", () => {
    expectDecodeFailure(VcsDriverKind, "svn", { rootTag: "AnyOf", childIssueCount: 0 });
    expectDecodeFailure(
      VcsFreshness,
      { ...encodedFreshness, observedAt: "not-a-date" },
      { rootTag: "Composite", paths: [["observedAt"]], containsTag: "InvalidType" },
    );
  });
});

describe("VCS repository schemas", () => {
  it("decodes capabilities, repository identity, and workspace files", () => {
    expect(
      decodeCapabilities({
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      }),
    ).toMatchObject({ kind: "git", supportsWorktrees: true });

    expect(
      decodeRepositoryIdentity({
        kind: "jj",
        rootPath: "C:/repo",
        metadataPath: "C:/repo/.jj",
        freshness: encodedFreshness,
      }),
    ).toMatchObject({ kind: "jj", rootPath: "C:/repo", metadataPath: "C:/repo/.jj" });

    expect(
      decodeWorkspaceFiles({
        paths: ["src/main.ts", "README.md"],
        truncated: false,
        freshness: encodedFreshness,
      }).paths,
    ).toEqual(["src/main.ts", "README.md"]);
  });

  it("decodes remotes with absent and present push URLs", () => {
    const origin = decodeRemote({
      name: "origin",
      url: "https://example.com/repo.git",
      pushUrl: Option.none<string>(),
      isPrimary: true,
    });
    const mirror = decodeRemote({
      name: "mirror",
      url: "https://example.com/repo.git",
      pushUrl: Option.some("ssh://git@example.com/repo.git"),
      isPrimary: false,
    });

    expect(Option.isNone(origin.pushUrl)).toBe(true);
    expect(Option.getOrUndefined(mirror.pushUrl)).toBe("ssh://git@example.com/repo.git");
    expect(
      decodeRemotes({
        remotes: [
          {
            name: "origin",
            url: "https://example.com/repo.git",
            pushUrl: Option.none<string>(),
            isPrimary: true,
          },
        ],
        freshness: encodedFreshness,
      }).remotes,
    ).toHaveLength(1);
  });
});

describe("VCS process errors", () => {
  it("constructs a spawn failure from process context", () => {
    const cause = new Error("ENOENT");
    const error = VcsProcessSpawnError.fromProcessSpawnError(
      { operation: "status", command: "git", cwd: "C:/repo", argumentCount: 2 },
      { cause },
    );

    expect(error.cause).toBe(cause);
    expect(error.message).toBe("VCS process failed to spawn in status: git (C:/repo)");
  });

  it("classifies every process-exit detail branch", () => {
    const make = (
      command: string,
      failureKind: "authentication" | "not-found" | "command-failed",
    ) =>
      VcsProcessExitError.fromProcessExit(
        { operation: "inspect", command, cwd: "C:/repo" },
        { exitCode: 1, stderr: "fatal output", stderrTruncated: false },
        failureKind,
      );
    const cases = [
      [make("git", "authentication"), "Authentication failed."],
      [make("glab", "not-found"), "Merge request not found."],
      [make("gh", "not-found"), "Pull request not found."],
      [make("az", "not-found"), "Pull request not found."],
      [make("git", "not-found"), "VCS resource not found."],
      [make("git", "command-failed"), "Process exited with a non-zero status."],
    ] as const;

    for (const [error, detail] of cases) {
      expect(error.detail).toBe(detail);
      expect(error.stderrLength).toBe(12);
      expect(error.stderrTruncated).toBe(false);
      expect(error.message).toBe(
        `VCS process failed in inspect: ${error.command} (C:/repo) exited with 1 - ${detail}`,
      );
    }
  });

  it("constructs a timeout failure from process context", () => {
    const error = VcsProcessTimeoutError.fromProcessTimeoutError(
      { operation: "fetch", command: "git", cwd: "C:/repo" },
      { timeoutMs: 30_000 },
    );

    expect(error.timeoutMs).toBe(30_000);
    expect(error.message).toBe("VCS process timed out in fetch: git (C:/repo) after 30000ms");
  });

  it("constructs and round-trips every process boundary failure", () => {
    const cause = new Error("stream failure");
    const boundary = { operation: "diff", command: "git", cwd: "C:/repo", argumentCount: 3 };
    const errors = [
      new VcsProcessStdinWriteError({ ...boundary, stdinBytes: 64, cause }),
      new VcsProcessOutputReadError({ ...boundary, stream: "stdout", cause }),
      new VcsProcessOutputLimitError({
        ...boundary,
        stream: "stderr",
        maxBytes: 1024,
        observedBytes: 2048,
      }),
      new VcsProcessMissingExitCodeError(boundary),
    ];
    const messages = [
      "VCS process failed to write 64 bytes to stdin in diff: git (C:/repo)",
      "VCS process failed to read stdout in diff: git (C:/repo)",
      "VCS process stderr produced 2048 bytes in diff: git (C:/repo), exceeding the 1024 byte limit",
      "VCS process completed without an exit code in diff: git (C:/repo)",
    ];

    errors.forEach((error, index) => {
      expect(error.message).toBe(messages[index]);
      const decoded = decodeOutputError(encodeOutputError(error));
      expect(decoded._tag).toBe(error._tag);
      expect(decoded.message).toBe(messages[index]);
    });
  });
});

describe("VcsError", () => {
  it("round-trips every public error alternative with its message", () => {
    const cause = new Error("VCS failure");
    const boundary = { operation: "status", command: "git", cwd: "C:/repo" };
    const errors = [
      VcsProcessSpawnError.fromProcessSpawnError(boundary, { cause }),
      VcsProcessExitError.fromProcessExit(
        boundary,
        { exitCode: 2, stderr: "fatal", stderrTruncated: true },
        "command-failed",
      ),
      VcsProcessTimeoutError.fromProcessTimeoutError(boundary, { timeoutMs: 5000 }),
      new VcsProcessStdinWriteError({ ...boundary, stdinBytes: 2, cause }),
      new VcsProcessOutputReadError({ ...boundary, stream: "exitCode", cause }),
      new VcsProcessOutputLimitError({
        ...boundary,
        stream: "stdout",
        maxBytes: 10,
        observedBytes: 11,
      }),
      new VcsProcessMissingExitCodeError(boundary),
      new VcsRepositoryDetectionError({
        operation: "detect",
        cwd: "C:/repo",
        detail: "No repository metadata found.",
        cause,
      }),
      new VcsUnsupportedOperationError({
        operation: "worktree.create",
        kind: "jj",
        detail: "Driver cannot create worktrees.",
      }),
    ];

    expect(errors[7]?.message).toBe(
      "VCS repository detection failed in detect: C:/repo - No repository metadata found.",
    );
    expect(errors[8]?.message).toBe(
      "VCS operation is unsupported for jj in worktree.create: Driver cannot create worktrees.",
    );

    for (const error of errors) {
      const decoded = decodeVcsError(encodeVcsError(error));
      expect(decoded._tag).toBe(error._tag);
      expect(decoded.message).toBe(error.message);
    }
  });
});
