import type { ThreadShell } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export interface WorktreeDeletionPlan {
  readonly worktreePath: string;
  readonly dependentPanelThreadIds: ReadonlyArray<ThreadShell["id"]>;
}

export function getWorktreeDeletionPlanForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "kind" | "worktreePath">>,
  threadId: ThreadShell["id"],
): WorktreeDeletionPlan | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread || targetThread.kind === "panel") {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const linkedThreads = threads.filter(
    (thread) =>
      thread.id !== threadId && normalizeWorktreePath(thread.worktreePath) === targetWorktreePath,
  );
  if (linkedThreads.some((thread) => thread.kind !== "panel")) {
    return null;
  }

  return {
    worktreePath: targetWorktreePath,
    dependentPanelThreadIds: linkedThreads.map((thread) => thread.id),
  };
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "kind" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  return getWorktreeDeletionPlanForThread(threads, threadId)?.worktreePath ?? null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
