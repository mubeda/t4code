import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitManagerError,
  GitManagerServiceError,
  VcsCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitPullRequestMaterializationError,
  GitRunStackedActionResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  TextGenerationError,
} from "./git.ts";
import { SourceControlProviderError } from "./sourceControl.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(VcsCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeManagerServiceError = Schema.decodeUnknownSync(GitManagerServiceError);
const encodeManagerServiceError = Schema.encodeUnknownSync(GitManagerServiceError);

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts explicit null refs for existing-ref worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      newRefName: null,
      baseRefName: null,
      path: null,
    });

    expect(parsed.newRefName).toBeNull();
    expect(parsed.baseRefName).toBeNull();
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitRunStackedActionInput", () => {
  it("accepts explicit stacked actions and requires a client-provided actionId", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "create_pr",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("create_pr");
  });
});

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });
});

describe("git errors", () => {
  const errors = [
    new GitCommandError({
      operation: "status",
      command: "git status --short",
      cwd: "/repo",
      argumentCount: 2,
      exitCode: 128,
      stderrLength: 20,
      detail: "not a repository",
    }),
    new TextGenerationError({
      operation: "commit message",
      detail: "model unavailable",
    }),
    new GitManagerError({
      operation: "refresh",
      cwd: "/repo",
      detail: "repository state unavailable",
      cause: "io failure",
    }),
    new GitPullRequestMaterializationError({
      cwd: "/repo",
      pullRequestNumber: 42,
      headRepository: null,
      headBranch: "feature/pr",
      localBranch: "codex/pr-42",
      cause: "fetch failed",
    }),
  ] as const;

  it("constructs every git tagged error and preserves optional diagnostics", () => {
    expect(errors.map((error) => error.message)).toEqual([
      "Git command failed in status (/repo): not a repository",
      "Text generation failed in commit message: model unavailable",
      "Git manager failed in refresh: repository state unavailable",
      "Failed to materialize pull request #42 branch feature/pr as codex/pr-42.",
    ]);
    expect(errors[0].argumentCount).toBe(2);
    expect(errors[0].outputLength).toBeUndefined();
    expect(errors[1].cause).toBeUndefined();
  });

  it("round-trips every manager service error alternative", () => {
    const sourceControlError = new SourceControlProviderError({
      provider: "github",
      operation: "resolve",
      cwd: "/repo",
      detail: "not found",
    });
    for (const error of [...errors, sourceControlError]) {
      const encoded = encodeManagerServiceError(error);
      const decoded = decodeManagerServiceError(encoded);
      expect(decoded._tag).toBe(error._tag);
    }
  });

  it("reports invalid pull request numbers on decode and encode", () => {
    const invalid = {
      _tag: "GitPullRequestMaterializationError",
      cwd: "/repo",
      pullRequestNumber: 0,
      headRepository: null,
      headBranch: "feature/pr",
      localBranch: "codex/pr-0",
      cause: "fetch failed",
    };
    const expectedPath = {
      paths: [["pullRequestNumber"]],
      containsTag: "InvalidValue" as const,
    };
    const decodeExpected = {
      ...expectedPath,
      rootTag: "Encoding" as const,
    };
    const encodeExpected = { ...expectedPath, rootTag: "Composite" as const };
    expectDecodeFailure(GitPullRequestMaterializationError, invalid, decodeExpected);
    expectEncodeFailure(
      GitPullRequestMaterializationError,
      makeInvalidClassInstance(GitPullRequestMaterializationError.prototype, invalid),
      encodeExpected,
    );
  });

  it("reports invalid worktree paths on decode and encode", () => {
    const invalid = { cwd: "/repo", refName: "main", path: "" };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["path"]],
      containsTag: "InvalidValue" as const,
    };
    expectDecodeFailure(VcsCreateWorktreeInput, invalid, expected);
    expectEncodeFailure(VcsCreateWorktreeInput, invalid, expected);
  });
});
