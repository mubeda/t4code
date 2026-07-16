import { type VcsStatusResult, WS_METHODS } from "@t4code/contracts";
import { applyGitStatusStreamEvent } from "@t4code/shared/git";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  vcsCloneCommandConcurrency,
  vcsCommandConcurrency,
  vcsCommandScheduler,
  vcsGenerateScheduler,
} from "./vcsCommandScheduler.ts";

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-refs",
      tag: WS_METHODS.vcsListRefs,
      staleTimeMs: 5_000,
    }),
    listCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-commits",
      tag: WS_METHODS.vcsListCommits,
      staleTimeMs: 10_000,
    }),
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:status",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
        subscribe(WS_METHODS.subscribeVcsStatus, input).pipe(
          Stream.mapAccum(
            () => null as VcsStatusResult | null,
            (current, event) => {
              const next = applyGitStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:pull",
      tag: WS_METHODS.vcsPull,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:refresh-status",
      tag: WS_METHODS.vcsRefreshStatus,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    createWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-worktree",
      tag: WS_METHODS.vcsCreateWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    removeWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:remove-worktree",
      tag: WS_METHODS.vcsRemoveWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    clone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:clone",
      tag: WS_METHODS.vcsClone,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCloneCommandConcurrency,
    }),
    createRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-ref",
      tag: WS_METHODS.vcsCreateRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    switchRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:switch-ref",
      tag: WS_METHODS.vcsSwitchRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    init: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:init",
      tag: WS_METHODS.vcsInit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    generateCommitMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:generate-commit-message",
      tag: WS_METHODS.vcsGenerateCommitMessage,
      // Own lane: a slow generation must not block stage/unstage/discard/commit.
      scheduler: vcsGenerateScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    stageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:stage-files",
      tag: WS_METHODS.vcsStageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    unstageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:unstage-files",
      tag: WS_METHODS.vcsUnstageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discardFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:discard-files",
      tag: WS_METHODS.vcsDiscardFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}

export * from "./gitActions.ts";
export * from "./vcsAction.ts";
export * from "./vcsRef.ts";
export * from "./vcsStatus.ts";
