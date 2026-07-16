import type {
  VcsRef,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
} from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  buildTemporaryWorktreeBranchName,
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  detectSourceControlProviderFromGitRemoteUrl,
  isTemporaryWorktreeBranch,
  mergeGitStatusParts,
  mergeWorkingTreeFilesByPath,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

const localStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
    insertions: 1,
    deletions: 0,
  },
};

const remoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 1,
  pr: null,
};

function ref(input: Pick<VcsRef, "name"> & Partial<VcsRef>): VcsRef {
  return {
    current: false,
    isDefault: false,
    worktreePath: null,
    ...input,
  };
}

describe("branch names", () => {
  it("sanitizes branch fragments and supplies a non-empty fallback", () => {
    expect(sanitizeBranchFragment("  `Fix API!!!`  ")).toBe("fix-api");
    expect(sanitizeBranchFragment("...___///")).toBe("update");
    expect(sanitizeBranchFragment(`topic/${"a".repeat(80)}---`)).toHaveLength(64);
  });

  it("normalizes feature namespaces", () => {
    expect(sanitizeFeatureBranchName("Login screen")).toBe("feature/login-screen");
    expect(sanitizeFeatureBranchName("feature/Login Screen")).toBe("feature/login-screen");
    expect(sanitizeFeatureBranchName("team/Login Screen")).toBe("feature/team/login-screen");
  });

  it("selects the first available feature branch case-insensitively", () => {
    expect(resolveAutoFeatureBranchName([], "Release notes")).toBe("feature/release-notes");
    expect(
      resolveAutoFeatureBranchName(
        ["FEATURE/RELEASE-NOTES", "feature/release-notes-2", "feature/release-notes-3"],
        "release notes",
      ),
    ).toBe("feature/release-notes-4");
    expect(resolveAutoFeatureBranchName([], "   ")).toBe("feature/update");
    expect(resolveAutoFeatureBranchName([])).toBe("feature/update");
  });

  it("strips only a complete remote prefix", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
    expect(deriveLocalBranchNameFromRemoteRef("main")).toBe("main");
    expect(deriveLocalBranchNameFromRemoteRef("/main")).toBe("/main");
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
  });
});

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:T4Code/T4Code.git")).toBe(
      "github.com/t4code/t4code",
    );
    expect(normalizeGitRemoteUrl("https://github.com/T4Code/T4Code.git")).toBe(
      "github.com/t4code/t4code",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/T4Code/T4Code")).toBe(
      "github.com/t4code/t4code",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:T4Code/platform/T4Code.git")).toBe(
      "gitlab.com/t4code/platform/t4code",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/T4Code/platform/T4Code.git")).toBe(
      "gitlab.com/t4code/platform/t4code",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  it("preserves malformed and non-repository URL shapes", () => {
    expect(normalizeGitRemoteUrl("https://[invalid/repo.git")).toBe("https://[invalid/repo");
    expect(normalizeGitRemoteUrl("git:///owner/repo.git")).toBe("git:///owner/repo");
    expect(normalizeGitRemoteUrl("local/path/repo.git///")).toBe("local/path/repo");
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:T4Code/T4Code.git"),
    ).toBe("T4Code/T4Code");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/T4Code/T4Code.git"),
    ).toBe("T4Code/T4Code");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://git@github.com/T4Code/T4Code"),
    ).toBe("T4Code/T4Code");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git://github.com/a/b/ ")).toBe("a/b");
  });

  it("rejects missing, unrelated, and incomplete remotes", () => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(null)).toBeNull();
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("   ")).toBeNull();
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://gitlab.com/a/b.git"),
    ).toBeNull();
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/owner")).toBeNull();
  });
});

describe("remote branch deduplication", () => {
  it("hides origin refs with local matches while preserving order and other remotes", () => {
    const refs = [
      ref({ name: "feature/demo", isRemote: false }),
      ref({ name: "origin/feature/demo", isRemote: true, remoteName: "origin" }),
      ref({ name: "upstream/feature/demo", isRemote: true, remoteName: "upstream" }),
      ref({ name: "origin/feature/other", isRemote: true, remoteName: "origin" }),
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(refs).map((entry) => entry.name)).toEqual([
      "feature/demo",
      "upstream/feature/demo",
      "origin/feature/other",
    ]);
  });

  it("retains malformed-but-typed remote names that have no local candidate", () => {
    const refs = [
      ref({ name: "main" }),
      ref({ name: "origin/", isRemote: true, remoteName: "origin" }),
      ref({ name: "upstream/other", isRemote: true, remoteName: "origin" }),
    ];
    expect(dedupeRemoteBranchesWithLocalMatches(refs)).toEqual(refs);
  });
});

describe("source control provider delegation", () => {
  it("detects providers through the git-facing API", () => {
    expect(
      detectSourceControlProviderFromGitRemoteUrl("https://github.com/t4code/t4code.git")?.kind,
    ).toBe("github");
    expect(detectSourceControlProviderFromGitRemoteUrl("invalid")).toBeNull();
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("applies snapshots and defaults a missing remote status", () => {
    expect(
      applyGitStatusStreamEvent(null, { _tag: "snapshot", local: localStatus, remote: null }),
    ).toEqual({
      ...localStatus,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    });
    expect(mergeGitStatusParts(localStatus, remoteStatus)).toEqual({
      ...localStatus,
      ...remoteStatus,
    });
  });

  it("applies local updates while preserving current remote-only fields", () => {
    const current: VcsStatusResult = {
      ...localStatus,
      ...remoteStatus,
      aheadOfDefaultCount: 7,
    };
    const nextLocal = { ...localStatus, refName: "feature/next" };
    expect(applyGitStatusStreamEvent(current, { _tag: "localUpdated", local: nextLocal })).toEqual({
      ...nextLocal,
      ...remoteStatus,
      aheadOfDefaultCount: 7,
    });

    const withoutAheadOfDefault = { ...current };
    delete withoutAheadOfDefault.aheadOfDefaultCount;
    expect(
      Object.hasOwn(
        applyGitStatusStreamEvent(withoutAheadOfDefault, {
          _tag: "localUpdated",
          local: nextLocal,
        }),
        "aheadOfDefaultCount",
      ),
    ).toBe(false);
  });

  it("defaults remote fields for a local update without current state", () => {
    expect(applyGitStatusStreamEvent(null, { _tag: "localUpdated", local: localStatus })).toEqual({
      ...localStatus,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    });
  });

  it("omits an absent source-control provider when rebuilding local state", () => {
    const current: VcsStatusResult = { ...localStatus, ...remoteStatus };
    const updated = applyGitStatusStreamEvent(current, {
      _tag: "remoteUpdated",
      remote: { ...remoteStatus, aheadCount: 9 },
    });
    expect(updated.aheadCount).toBe(9);
    expect(Object.hasOwn(updated, "sourceControlProvider")).toBe(false);
  });
});

describe("mergeWorkingTreeFilesByPath", () => {
  it("merges entries sharing a path, summing counts and keeping the first status", () => {
    const merged = mergeWorkingTreeFilesByPath([
      { path: "src/a.ts", insertions: 3, deletions: 1, status: "modified", area: "staged" },
      { path: "src/b.ts", insertions: 5, deletions: 0, status: "added", area: "unstaged" },
      { path: "src/a.ts", insertions: 2, deletions: 4, status: "deleted", area: "unstaged" },
    ]);

    expect(merged).toEqual([
      { path: "src/a.ts", insertions: 5, deletions: 5, status: "modified" },
      { path: "src/b.ts", insertions: 5, deletions: 0, status: "added" },
    ]);
  });

  it("omits status when the first entry for a path has none, and always drops area", () => {
    const merged = mergeWorkingTreeFilesByPath([
      { path: "src/c.ts", insertions: 1, deletions: 0 },
      { path: "src/c.ts", insertions: 1, deletions: 1, status: "modified", area: "staged" },
    ]);

    expect(merged).toEqual([{ path: "src/c.ts", insertions: 2, deletions: 1 }]);
    expect(Object.hasOwn(merged[0]!, "status")).toBe(false);
    expect(Object.hasOwn(merged[0]!, "area")).toBe(false);
  });
});
