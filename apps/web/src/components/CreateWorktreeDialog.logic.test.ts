import { describe, expect, it } from "vite-plus/test";
import {
  buildSmartRows,
  detectSmartMode,
  filterRefsByQuery,
  findExactRefMatch,
  getCreateWorktreeDisabled,
  githubWorkItemBranchName,
  parseGitHubWorkItem,
  resolveWorktreeCreateInput,
  sanitizeBranchName,
  type RefLike,
} from "./CreateWorktreeDialog.logic";

describe("parseGitHubWorkItem", () => {
  it("parses a bare number", () => {
    expect(parseGitHubWorkItem("123")).toEqual({ number: 123, kind: "unknown" });
  });

  it("parses a #-prefixed number", () => {
    expect(parseGitHubWorkItem("#456")).toEqual({ number: 456, kind: "unknown" });
  });

  it("parses a github issues URL", () => {
    expect(parseGitHubWorkItem("https://github.com/acme/widgets/issues/789")).toEqual({
      number: 789,
      kind: "issue",
    });
  });

  it("parses a github pull URL", () => {
    expect(parseGitHubWorkItem("https://github.com/acme/widgets/pull/42")).toEqual({
      number: 42,
      kind: "pr",
    });
  });

  it("trims whitespace", () => {
    expect(parseGitHubWorkItem("  #7  ")).toEqual({ number: 7, kind: "unknown" });
  });

  it("returns null for non-matching input", () => {
    expect(parseGitHubWorkItem("feature/my-branch")).toBeNull();
    expect(parseGitHubWorkItem("")).toBeNull();
    expect(parseGitHubWorkItem("   ")).toBeNull();
  });

  it("rejects zero/negative-looking numbers", () => {
    expect(parseGitHubWorkItem("0")).toBeNull();
  });
});

describe("githubWorkItemBranchName", () => {
  it("derives pr-<n> for any kind", () => {
    expect(githubWorkItemBranchName({ number: 123, kind: "issue" })).toBe("pr-123");
    expect(githubWorkItemBranchName({ number: 5, kind: "pr" })).toBe("pr-5");
    expect(githubWorkItemBranchName({ number: 9, kind: "unknown" })).toBe("pr-9");
  });
});

describe("sanitizeBranchName", () => {
  it("replaces whitespace with dashes", () => {
    expect(sanitizeBranchName("my new feature")).toBe("my-new-feature");
  });

  it("strips disallowed characters", () => {
    expect(sanitizeBranchName("fix: bug#42!")).toBe("fix-bug-42");
  });

  it("collapses repeated dashes", () => {
    expect(sanitizeBranchName("a---b")).toBe("a-b");
  });

  it("trims leading/trailing separators", () => {
    expect(sanitizeBranchName("  /feature/ ")).toBe("feature");
  });

  it("preserves slashes and dots inside the name", () => {
    expect(sanitizeBranchName("feature/sub.task")).toBe("feature/sub.task");
  });
});

describe("filterRefsByQuery", () => {
  const refs: RefLike[] = [
    { name: "main" },
    { name: "origin/main" },
    { name: "feature/login" },
    { name: "feature/logout" },
  ];

  it("returns all refs for an empty query", () => {
    expect(filterRefsByQuery(refs, "")).toHaveLength(4);
  });

  it("filters case-insensitively by substring", () => {
    expect(filterRefsByQuery(refs, "LOGIN")).toEqual([{ name: "feature/login" }]);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterRefsByQuery(refs, "zzz")).toEqual([]);
  });
});

describe("findExactRefMatch", () => {
  const refs: RefLike[] = [{ name: "main" }, { name: "feature/login" }];

  it("finds an exact case-sensitive match", () => {
    expect(findExactRefMatch(refs, "main")).toEqual({ name: "main" });
  });

  it("returns null when no exact match", () => {
    expect(findExactRefMatch(refs, "Main")).toBeNull();
    expect(findExactRefMatch(refs, "feat")).toBeNull();
  });

  it("returns null for empty query", () => {
    expect(findExactRefMatch(refs, "  ")).toBeNull();
  });
});

describe("buildSmartRows", () => {
  const refs: RefLike[] = [{ name: "feature/login" }, { name: "feature/logout" }, { name: "main" }];

  it("returns empty rows for empty query", () => {
    expect(buildSmartRows({ query: "", refs })).toEqual([]);
  });

  it("pins a github row first when input parses as a work item", () => {
    const rows = buildSmartRows({ query: "#123", refs });
    expect(rows[0]).toEqual({ kind: "github", item: { number: 123, kind: "unknown" } });
  });

  it("pins a use-name row first otherwise, followed by matching branches", () => {
    const rows = buildSmartRows({ query: "feature", refs });
    expect(rows[0]).toEqual({ kind: "use-name", name: "feature" });
    expect(rows.slice(1)).toEqual([
      { kind: "branch", refName: "feature/login" },
      { kind: "branch", refName: "feature/logout" },
    ]);
  });

  it("caps branch rows at maxBranchRows", () => {
    const manyRefs: RefLike[] = Array.from({ length: 10 }, (_, i) => ({ name: `feature/${i}` }));
    const rows = buildSmartRows({ query: "feature", refs: manyRefs, maxBranchRows: 3 });
    expect(rows.filter((r) => r.kind === "branch")).toHaveLength(3);
  });
});

describe("detectSmartMode", () => {
  const refs: RefLike[] = [{ name: "feature/login" }, { name: "main" }];

  it("returns name for empty query", () => {
    expect(detectSmartMode("", refs)).toBe("name");
  });

  it("detects github pattern", () => {
    expect(detectSmartMode("#123", refs)).toBe("github");
  });

  it("detects exact ref match as branch", () => {
    expect(detectSmartMode("main", refs)).toBe("branch");
  });

  it("detects prefix ref match as branch", () => {
    expect(detectSmartMode("feature/lo", refs)).toBe("branch");
  });

  it("falls back to name when nothing matches", () => {
    expect(detectSmartMode("brand-new-thing", refs)).toBe("name");
  });
});

describe("resolveWorktreeCreateInput", () => {
  const base = {
    nameText: "",
    selectedBranchRefName: null,
    githubItem: null,
    advancedBaseBranchOverride: null,
    defaultBaseBranch: "main",
  };

  it("resolves name mode from sanitized text", () => {
    const result = resolveWorktreeCreateInput({ ...base, mode: "name", nameText: "My Feature" });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "My-Feature",
      refName: "main",
      newRefName: "My-Feature",
      baseRefName: "main",
    });
  });

  it("returns null for name mode with empty text", () => {
    expect(resolveWorktreeCreateInput({ ...base, mode: "name", nameText: "   " })).toBeNull();
  });

  it("resolves branch mode as an existing ref", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "branch",
      selectedBranchRefName: "feature--login",
      advancedBaseBranchOverride: "develop",
    });
    expect(result).toEqual({
      kind: "existing-ref",
      branchName: "feature--login",
      refName: "feature--login",
      newRefName: null,
      baseRefName: null,
    });
  });

  it("returns null for branch mode with no selection", () => {
    expect(resolveWorktreeCreateInput({ ...base, mode: "branch" })).toBeNull();
  });

  it("resolves github mode from the parsed item", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "github",
      githubItem: { number: 42, kind: "pr" },
    });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "pr-42",
      refName: "main",
      newRefName: "pr-42",
      baseRefName: "main",
    });
  });

  it("returns null for github mode with no parsed item", () => {
    expect(resolveWorktreeCreateInput({ ...base, mode: "github" })).toBeNull();
  });

  it("smart mode prefers a github item over a branch selection", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "smart",
      githubItem: { number: 7, kind: "issue" },
      selectedBranchRefName: "feature/login",
    });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "pr-7",
      refName: "main",
      newRefName: "pr-7",
      baseRefName: "main",
    });
  });

  it("smart mode falls back to an existing ref when no github item", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "smart",
      selectedBranchRefName: "feature--login",
      advancedBaseBranchOverride: "develop",
    });
    expect(result).toEqual({
      kind: "existing-ref",
      branchName: "feature--login",
      refName: "feature--login",
      newRefName: null,
      baseRefName: null,
    });
  });

  it("smart mode falls back to sanitized text when nothing else resolves", () => {
    const result = resolveWorktreeCreateInput({ ...base, mode: "smart", nameText: "brand new" });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "brand-new",
      refName: "main",
      newRefName: "brand-new",
      baseRefName: "main",
    });
  });

  it("uses HEAD as the base when no default base branch is available", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "name",
      nameText: "feature",
      defaultBaseBranch: null,
    });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "feature",
      refName: "HEAD",
      newRefName: "feature",
      baseRefName: "HEAD",
    });
  });

  it("prefers the advanced base-branch override over the default", () => {
    const result = resolveWorktreeCreateInput({
      ...base,
      mode: "name",
      nameText: "feature",
      advancedBaseBranchOverride: "develop",
    });
    expect(result).toEqual({
      kind: "new-branch",
      branchName: "feature",
      refName: "develop",
      newRefName: "feature",
      baseRefName: "develop",
    });
  });
});

describe("getCreateWorktreeDisabled", () => {
  const resolution = {
    kind: "new-branch" as const,
    branchName: "feature",
    refName: "main",
    newRefName: "feature",
    baseRefName: "main",
  };

  it("is disabled without a project", () => {
    expect(getCreateWorktreeDisabled({ hasProject: false, resolution, isSubmitting: false })).toBe(
      true,
    );
  });

  it("is disabled without a resolution", () => {
    expect(
      getCreateWorktreeDisabled({ hasProject: true, resolution: null, isSubmitting: false }),
    ).toBe(true);
  });

  it("is disabled while submitting", () => {
    expect(getCreateWorktreeDisabled({ hasProject: true, resolution, isSubmitting: true })).toBe(
      true,
    );
  });

  it("is enabled when project + resolution present and not submitting", () => {
    expect(getCreateWorktreeDisabled({ hasProject: true, resolution, isSubmitting: false })).toBe(
      false,
    );
  });
});
