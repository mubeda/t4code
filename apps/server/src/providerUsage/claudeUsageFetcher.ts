import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export function unavailableClaudeUsageSnapshot(now: DateTime.Utc): ServerProviderUsageSnapshot {
  return {
    provider: "claude",
    status: "unavailable",
    session: null,
    weekly: null,
    updatedAt: now,
    error: "Claude usage fetching is not configured on this server.",
    metadata: {},
  };
}

export const fetchClaudeUsageSnapshot = DateTime.now.pipe(
  Effect.map((now) => unavailableClaudeUsageSnapshot(now)),
);
