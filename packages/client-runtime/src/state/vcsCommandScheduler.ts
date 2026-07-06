import type { EnvironmentId } from "@t3tools/contracts";

import { createAtomCommandScheduler, type AtomCommandConcurrency } from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

/**
 * A separate scheduler instance for `generateCommitMessage`. It's a
 * read-only operation (no mutation of working tree/index), so it must not
 * queue behind — or block — stage/unstage/discard/commit on the same
 * `vcsCommandScheduler` lane. Scheduler state lives in a per-instance
 * WeakMap, so a distinct instance is sufficient to isolate the lane even
 * though the concurrency key (environmentId + cwd) is identical.
 */
export const vcsGenerateScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

// TODO(orca-port): `clone` has no pre-existing `cwd` (it targets `parentDir` + an optional
// `directoryName`, since the destination repo doesn't exist yet) — key concurrency on those
// instead, to serialize repeated clone attempts into the same destination.
export const vcsCloneCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly url: string;
    readonly parentDir: string;
    readonly directoryName?: string | undefined;
  };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) =>
    JSON.stringify([environmentId, input.parentDir, input.directoryName ?? null]),
};
