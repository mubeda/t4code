import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export interface MissingRouteThreadRedirectInput {
  /** Shell sync status for the route's environment; null when no shell state loaded yet. */
  readonly shellStatus: EnvironmentShellStatus | null;
  /** True when the route thread resolves as a server thread or a local draft. */
  readonly routeThreadExists: boolean;
  /** Server threads only — client-persisted drafts must not count. */
  readonly environmentHasServerThreads: boolean;
}

/**
 * A thread route may bounce to the index only when a LIVE snapshot from the
 * currently-connected server authoritatively lacks the thread. During backend
 * restarts/reconnects the shell serves a cached snapshot ("cached"/
 * "synchronizing"), and the first live snapshot after an auth handshake can be
 * empty or partial — navigating on those windows yanks the user off a thread
 * that still exists. Draft threads are client-persisted and survive server
 * flaps, so they say nothing about the server's thread list.
 */
export function shouldRedirectMissingRouteThread(input: MissingRouteThreadRedirectInput): boolean {
  return (
    input.shellStatus === "live" && !input.routeThreadExists && input.environmentHasServerThreads
  );
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}
