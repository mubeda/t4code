import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../sourceControlPresentation";

/**
 * Commit-first primary-action model for the Source Control panel.
 *
 * This is a deliberate divergence from the chat-header `GitActionsControl`
 * cascade (`GitActionsControl.logic.ts`), which defaults a dirty tree to
 * `commit_push` / `commit_push_pr`. Here the primary button leads with the
 * staging area: staged content -> Commit, otherwise Stage All, and only a clean
 * tree walks the remote ladder (push / pull / PR). The chat-header behavior is
 * left untouched — do NOT reuse this module there.
 *
 * Two intentional divergences from Orca:
 * - Commit stays ENABLED with an empty message when there are staged changes
 *   (our auto-generate affordance fills the message server-side). Orca disables
 *   commit without a message.
 * - No stash / amend / Ctrl+Enter — those have no backing RPC (research §4/§5).
 */

export type SourceControlPrimaryActionKind =
  | "commit"
  | "stage_all"
  | "push"
  | "pull"
  | "sync_hint"
  | "publish"
  | "create_pr"
  | "open_pr"
  | "none";

export interface SourceControlPrimaryAction {
  kind: SourceControlPrimaryActionKind;
  label: string;
  disabled: boolean;
  /** Hint copy for disabled / no-op states (shown as tooltip / helper text). */
  hint?: string;
  /** Ahead / behind / staged / stageable count surfaced next to the label. */
  count?: number;
  /**
   * For stacked-action kinds (`commit`, `push`, `create_pr`) the concrete
   * `GitStackedAction` the caller dispatches through `git.runStackedAction`.
   */
  stackedAction?: GitStackedAction;
  /**
   * Commit the staged index exactly as-is. Preserves the ledger guard: a commit
   * of the staged set must carry `commitStagedIndexAsIs: true`, never
   * `filePaths: []` (contracts git.ts). Only set on the `commit` kind.
   */
  commitStagedIndexAsIs?: boolean;
}

export type SourceControlMenuItemId =
  | "commit"
  | "commit_push"
  | "commit_push_pr"
  | "push"
  | "pull"
  | "create_pr"
  | "open_pr"
  | "publish";

export interface SourceControlMenuItem {
  id: SourceControlMenuItemId;
  label: string;
  disabled: boolean;
  /** Why the item is disabled — rendered as tooltip on the disabled entry. */
  reason?: string;
  /**
   * Visual grouping: the commit-family sits above a separator, the remote
   * actions below it. The caller renders the separator between groups.
   */
  group: "commit" | "remote";
  kind: "run_stacked" | "run_pull" | "open_pr" | "open_publish";
  stackedAction?: GitStackedAction;
  commitStagedIndexAsIs?: boolean;
}

export interface SourceControlPrimaryActionInput {
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  isDefaultRef: boolean;
  hasPrimaryRemote: boolean;
  /** Files in the staged area. */
  stagedCount: number;
  /** Files in the unstaged + untracked areas (everything stage-able). */
  stageableCount: number;
}

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

const NO_STATUS_ACTION: SourceControlPrimaryAction = {
  kind: "none",
  label: "Commit",
  disabled: true,
  hint: "Git status is unavailable.",
};

/**
 * Resolve the single primary button for the Source Control panel.
 *
 * Ladder (commit-first): staged -> Commit, else stage-able -> Stage All, else
 * the clean-tree remote ladder adapted from `resolveQuickAction` with the
 * commit step stripped. When busy, the resolved action is returned disabled
 * ("previous-kind disabled") — the caller renders the spinner.
 */
export function resolveSourceControlPrimaryAction(
  input: SourceControlPrimaryActionInput,
): SourceControlPrimaryAction {
  const { gitStatus, isBusy } = input;
  if (!gitStatus) {
    return NO_STATUS_ACTION;
  }

  const decision = resolvePrimaryActionForStatus(input, gitStatus);
  return isBusy ? { ...decision, disabled: true } : decision;
}

function resolvePrimaryActionForStatus(
  input: SourceControlPrimaryActionInput,
  gitStatus: VcsStatusResult,
): SourceControlPrimaryAction {
  const { isDefaultRef, hasPrimaryRemote, stagedCount, stageableCount } = input;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  // Staged content always wins — commit the staged index as-is. Enabled even
  // with an empty message (auto-generate divergence); ordering intentionally
  // precedes the no-branch guard, so a detached HEAD with staged files can
  // still commit (faithful to the pinned ladder order).
  if (stagedCount > 0) {
    return {
      kind: "commit",
      label: "Commit",
      disabled: false,
      count: stagedCount,
      stackedAction: "commit",
      commitStagedIndexAsIs: true,
    };
  }

  if (stageableCount > 0) {
    return {
      kind: "stage_all",
      label: "Stage All Changes",
      disabled: false,
      count: stageableCount,
    };
  }

  // Clean tree: walk the remote ladder (commit stripped).
  const hasBranch = gitStatus.refName !== null;
  if (!hasBranch) {
    return {
      kind: "none",
      label: "Commit",
      disabled: true,
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        return { kind: "open_pr", label: `View ${terminology.shortLabel}`, disabled: false };
      }
      return { kind: "publish", label: "Publish repository", disabled: false };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { kind: "open_pr", label: `View ${terminology.shortLabel}`, disabled: false };
      }
      return { kind: "push", label: "Push", disabled: true, hint: "No local commits to push." };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        kind: "push",
        label: "Push",
        disabled: false,
        count: gitStatus.aheadCount,
        stackedAction: "push",
      };
    }
    return {
      kind: "create_pr",
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      stackedAction: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      kind: "sync_hint",
      label: "Sync ref",
      disabled: true,
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return { kind: "pull", label: "Pull", disabled: false, count: gitStatus.behindCount };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        kind: "push",
        label: "Push",
        disabled: false,
        count: gitStatus.aheadCount,
        stackedAction: "push",
      };
    }
    return {
      kind: "create_pr",
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      stackedAction: "create_pr",
    };
  }

  if (hasOpenPr) {
    return { kind: "open_pr", label: `View ${terminology.shortLabel}`, disabled: false };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      kind: "create_pr",
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      stackedAction: "create_pr",
    };
  }

  return {
    kind: "none",
    label: "Up to date",
    disabled: true,
    hint: "Branch is up to date. No action needed.",
  };
}

const BUSY_REASON = "Git action in progress.";

/**
 * Build the primary-action dropdown for the Source Control panel.
 *
 * Orca's always-rendered-disabled pattern: every item is always present in a
 * fixed order (Commit / Commit & Push / Commit & Push & PR / — / Push / Pull /
 * Create-or-View PR / Publish-when-applicable) and carries `disabled` + a
 * `reason` when inapplicable rather than being hidden.
 *
 * Fetch / Force-push / Rebase / Sync menu items are intentionally omitted:
 * there is no backing RPC for any of them (research §2/§4).
 */
export function buildSourceControlMenuItems(
  input: SourceControlPrimaryActionInput,
): SourceControlMenuItem[] {
  const { gitStatus, isBusy, hasPrimaryRemote, stagedCount } = input;
  if (!gitStatus) {
    return [];
  }

  const terminology = resolveChangeRequestTerminology(gitStatus);
  const hasStaged = stagedCount > 0;
  const hasBranch = gitStatus.refName !== null;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const hasPushTarget = gitStatus.hasUpstream || canPushWithoutUpstream;

  // Returns disabled/reason from the first blocking reason, or enabled.
  const gate = (reason: string | undefined): { disabled: boolean; reason?: string } => {
    if (isBusy) return { disabled: true, reason: BUSY_REASON };
    return reason === undefined ? { disabled: false } : { disabled: true, reason };
  };

  const noBranchReason = hasBranch ? undefined : "Create and checkout a ref first.";
  const noPushTargetReason = hasPushTarget ? undefined : "No remote configured to push to.";
  const behindReason = isDiverged
    ? "Branch has diverged from upstream. Rebase/merge first."
    : isBehind
      ? "Pull upstream changes before pushing."
      : undefined;
  const commitReason = hasStaged ? undefined : "No staged changes to commit.";

  const commitPushReason =
    commitReason ?? noBranchReason ?? noPushTargetReason ?? behindReason ?? undefined;
  const commitPushPrReason =
    commitPushReason ?? (hasOpenPr ? `A ${terminology.singular} is already open.` : undefined);

  const items: SourceControlMenuItem[] = [
    {
      id: "commit",
      label: "Commit",
      group: "commit",
      kind: "run_stacked",
      stackedAction: "commit",
      commitStagedIndexAsIs: true,
      ...gate(commitReason),
    },
    {
      id: "commit_push",
      label: "Commit & Push",
      group: "commit",
      kind: "run_stacked",
      stackedAction: "commit_push",
      commitStagedIndexAsIs: true,
      ...gate(commitPushReason),
    },
    {
      id: "commit_push_pr",
      label: `Commit, Push & ${terminology.shortLabel}`,
      group: "commit",
      kind: "run_stacked",
      stackedAction: "commit_push_pr",
      commitStagedIndexAsIs: true,
      ...gate(commitPushPrReason),
    },
    {
      id: "push",
      label: "Push",
      group: "remote",
      kind: "run_stacked",
      stackedAction: "push",
      ...gate(
        noBranchReason ??
          noPushTargetReason ??
          behindReason ??
          (isAhead ? undefined : "No local commits to push."),
      ),
    },
    {
      id: "pull",
      label: "Pull",
      group: "remote",
      kind: "run_pull",
      ...gate(
        noBranchReason ??
          (!gitStatus.hasUpstream
            ? "No upstream to pull from."
            : isBehind
              ? undefined
              : "Already up to date."),
      ),
    },
    hasOpenPr
      ? {
          id: "open_pr",
          label: `View ${terminology.shortLabel}`,
          group: "remote",
          kind: "open_pr",
          ...gate(undefined),
        }
      : {
          id: "create_pr",
          label: `Create ${terminology.shortLabel}`,
          group: "remote",
          kind: "run_stacked",
          stackedAction: "create_pr",
          // No isDefaultRef gate — creating a PR from the default ref is
          // allowed-but-confirmed (SC-C's default-branch dialog), matching the
          // chat-header buildMenuItems. Requires commits ahead of default only.
          ...gate(
            noBranchReason ??
              noPushTargetReason ??
              behindReason ??
              (hasDefaultBranchDelta
                ? undefined
                : `No commits to open a ${terminology.singular} for.`),
          ),
        },
  ];

  // Publish is only meaningful before a primary remote exists (research §5).
  if (!hasPrimaryRemote) {
    items.push({
      id: "publish",
      label: "Publish repository",
      group: "remote",
      kind: "open_publish",
      ...gate(noBranchReason),
    });
  }

  return items;
}
