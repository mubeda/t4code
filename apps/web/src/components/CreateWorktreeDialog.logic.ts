/**
 * Pure helpers for `CreateWorktreeDialog`. Kept side-effect free so the
 * Smart/GitHub/Branch/Name parsing + resolution rules can be unit tested
 * without rendering React or touching the network.
 */

export type WorktreeNameMode = "smart" | "github" | "branch" | "name";

export interface GitHubWorkItemRef {
  readonly number: number;
  /** "unknown" when the input was a bare number/#-number with no URL to disambiguate. */
  readonly kind: "issue" | "pr" | "unknown";
}

const GITHUB_URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/(issues|pull)\/(\d+)/i;
const BARE_NUMBER_RE = /^#?(\d+)$/;

/**
 * Parses `#123`, `123`, or a `github.com/<owner>/<repo>/(issues|pull)/<n>`
 * URL into a work-item reference. Returns `null` for anything else.
 */
export function parseGitHubWorkItem(input: string): GitHubWorkItemRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const urlMatch = GITHUB_URL_RE.exec(trimmed);
  if (urlMatch) {
    const kindSegment = urlMatch[1];
    const numberText = urlMatch[2];
    const number = numberText ? Number.parseInt(numberText, 10) : Number.NaN;
    if (!Number.isFinite(number) || number <= 0) return null;
    return { number, kind: kindSegment === "pull" ? "pr" : "issue" };
  }

  const bareMatch = BARE_NUMBER_RE.exec(trimmed);
  if (bareMatch) {
    const numberText = bareMatch[1];
    const number = numberText ? Number.parseInt(numberText, 10) : Number.NaN;
    if (!Number.isFinite(number) || number <= 0) return null;
    return { number, kind: "unknown" };
  }

  return null;
}

/** Server-side PR checkout wiring lands later (see plan pinned item 6 note); for now this only seeds the branch name. */
export function githubWorkItemBranchName(item: GitHubWorkItemRef): string {
  return `pr-${item.number}`;
}

/** Sanitizes free text into a git-ref-safe branch/worktree name. */
export function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "");
}

export interface RefLike {
  readonly name: string;
  readonly isRemote?: boolean | undefined;
  readonly current?: boolean | undefined;
  readonly worktreePath?: string | null | undefined;
}

/** Client-side substring filter for the Branch tab result list. */
export function filterRefsByQuery<T extends RefLike>(refs: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return [...refs];
  return refs.filter((ref) => ref.name.toLowerCase().includes(trimmed));
}

/** True when `query` exactly matches a known ref name (case-sensitive, git refs are). */
export function findExactRefMatch<T extends RefLike>(
  refs: ReadonlyArray<T>,
  query: string,
): T | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  return refs.find((ref) => ref.name === trimmed) ?? null;
}

export type SmartRow =
  | { readonly kind: "use-name"; readonly name: string }
  | { readonly kind: "branch"; readonly refName: string }
  | { readonly kind: "github"; readonly item: GitHubWorkItemRef };

const SMART_MAX_BRANCH_ROWS = 5;

/**
 * Builds the Smart-tab row list, Orca-style: a pinned "use as name" row
 * (or a "github work item" row when the input parses as one), followed by
 * matching branch rows.
 */
export function buildSmartRows(input: {
  readonly query: string;
  readonly refs: ReadonlyArray<RefLike>;
  readonly maxBranchRows?: number;
}): SmartRow[] {
  const trimmed = input.query.trim();
  if (trimmed.length === 0) return [];

  const rows: SmartRow[] = [];
  const githubItem = parseGitHubWorkItem(trimmed);
  if (githubItem) {
    rows.push({ kind: "github", item: githubItem });
  } else {
    rows.push({ kind: "use-name", name: trimmed });
  }

  const maxBranchRows = input.maxBranchRows ?? SMART_MAX_BRANCH_ROWS;
  const matches = filterRefsByQuery(input.refs, trimmed).slice(0, maxBranchRows);
  for (const match of matches) {
    rows.push({ kind: "branch", refName: match.name });
  }

  return rows;
}

/**
 * Auto-detects the effective mode for Smart-tab input: a GitHub pattern
 * wins first, an exact/prefix ref match resolves to "branch", otherwise
 * it's treated as a plain name.
 */
export function detectSmartMode(
  query: string,
  refs: ReadonlyArray<RefLike>,
): "github" | "branch" | "name" {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "name";
  if (parseGitHubWorkItem(trimmed)) return "github";
  const exact = findExactRefMatch(refs, trimmed);
  if (exact) return "branch";
  const lower = trimmed.toLowerCase();
  const hasPrefixMatch = refs.some((ref) => ref.name.toLowerCase().startsWith(lower));
  return hasPrefixMatch ? "branch" : "name";
}

export type WorktreeCreateResolution =
  | {
      readonly kind: "existing-ref";
      readonly branchName: string;
      readonly refName: string;
      readonly newRefName: null;
      readonly baseRefName: null;
    }
  | {
      readonly kind: "new-branch";
      readonly branchName: string;
      readonly refName: string;
      readonly newRefName: string;
      readonly baseRefName: string;
    };

/**
 * Resolves the final worktree creation intent from the current tab/selection
 * state. Returns `null` when nothing resolvable yet (submit should stay
 * disabled).
 */
export function resolveWorktreeCreateInput(input: {
  readonly mode: WorktreeNameMode;
  readonly nameText: string;
  readonly selectedBranchRefName: string | null;
  readonly githubItem: GitHubWorkItemRef | null;
  readonly advancedBaseBranchOverride: string | null;
  readonly defaultBaseBranch: string | null;
}): WorktreeCreateResolution | null {
  const existingRef = (refName: string): WorktreeCreateResolution => ({
    kind: "existing-ref",
    branchName: refName,
    refName,
    newRefName: null,
    baseRefName: null,
  });
  const newBranch = (branchName: string): WorktreeCreateResolution => {
    const baseRefName =
      (input.advancedBaseBranchOverride?.trim() || null) ?? input.defaultBaseBranch ?? "HEAD";
    return {
      kind: "new-branch",
      branchName,
      refName: baseRefName,
      newRefName: branchName,
      baseRefName,
    };
  };

  if (input.mode === "branch") {
    return input.selectedBranchRefName ? existingRef(input.selectedBranchRefName) : null;
  }

  if (input.mode === "github") {
    return input.githubItem ? newBranch(githubWorkItemBranchName(input.githubItem)) : null;
  }

  if (input.mode === "smart") {
    if (input.githubItem) return newBranch(githubWorkItemBranchName(input.githubItem));
    if (input.selectedBranchRefName) return existingRef(input.selectedBranchRefName);
  }

  // "name" mode, or Smart falling back to plain text.
  const branchName = sanitizeBranchName(input.nameText);
  return branchName.length > 0 ? newBranch(branchName) : null;
}

/** Gate for the primary "Create worktree" button. */
export function getCreateWorktreeDisabled(input: {
  readonly hasProject: boolean;
  readonly resolution: WorktreeCreateResolution | null;
  readonly isSubmitting: boolean;
}): boolean {
  return !input.hasProject || input.resolution === null || input.isSubmitting;
}
