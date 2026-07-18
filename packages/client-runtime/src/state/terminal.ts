import {
  type EnvironmentId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
  WS_METHODS,
} from "@t4code/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
  parseEnvironmentRpcKey,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  acquireTerminalMetadataStream,
  createTerminalTranscriptRuntimeRegistry,
  terminalTranscriptRuntimeKey,
} from "./terminalAttachAdapter.ts";
import { applyTerminalMetadataStreamEvent } from "./terminalSession.ts";
import {
  EMPTY_TERMINAL_METADATA_SNAPSHOT,
  type TerminalMetadataSnapshot,
  type TerminalTranscriptRuntime,
} from "./terminalTranscriptRuntime.ts";

export interface TerminalAttachSnapshot {
  readonly metadata: TerminalMetadataSnapshot;
  readonly transcriptRuntime: TerminalTranscriptRuntime | null;
}

export const EMPTY_TERMINAL_ATTACH_SNAPSHOT = Object.freeze<TerminalAttachSnapshot>({
  metadata: EMPTY_TERMINAL_METADATA_SNAPSHOT,
  transcriptRuntime: null,
});

export function accumulateTerminalMetadataEvents<E, R>(
  events: Stream.Stream<TerminalMetadataStreamEvent, E, R>,
) {
  return events.pipe(
    Stream.scan([] as ReadonlyArray<TerminalSummary>, applyTerminalMetadataStreamEvent),
    Stream.drop(1),
  );
}

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const transcriptRuntimes = createTerminalTranscriptRuntimeRegistry();
  const terminalThreadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.threadId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalThreadKey };
  const attachSnapshots = Atom.family((key: string) =>
    Atom.make<TerminalAttachSnapshot>(EMPTY_TERMINAL_ATTACH_SNAPSHOT).pipe(
      Atom.withLabel(`environment-data:terminal:attach-snapshot:${key}`),
    ),
  );
  const attachSnapshot = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>;
  }) => attachSnapshots(environmentRpcKey(target));
  const attachProducer = (() => {
    const family = Atom.family((key: string) => {
      const target =
        parseEnvironmentRpcKey<EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>>(key);
      const runtimeKey = terminalTranscriptRuntimeKey(target.environmentId, target.input);
      return runtime
        .atom((get) => {
          const atomRegistry = get.registry;
          const snapshotAtom = attachSnapshots(key);
          return acquireTerminalMetadataStream(
            followStreamInEnvironment(
              target.environmentId,
              subscribe(WS_METHODS.terminalAttach, target.input),
            ),
            transcriptRuntimes,
            runtimeKey,
          ).pipe(
            Stream.tap((metadata) =>
              Effect.sync(() => {
                const transcriptRuntime = transcriptRuntimes.get(runtimeKey);
                if (transcriptRuntime !== undefined) {
                  atomRegistry.set(snapshotAtom, { metadata, transcriptRuntime });
                }
              }),
            ),
            Stream.ensuring(
              Effect.sync(() => {
                atomRegistry.set(snapshotAtom, EMPTY_TERMINAL_ATTACH_SNAPSHOT);
              }),
            ),
          );
        })
        .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:terminal:attach:${key}`));
    });
    return (target: {
      readonly environmentId: EnvironmentId;
      readonly input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>;
    }) => family(environmentRpcKey(target));
  })();
  return {
    attachProducer,
    attachSnapshot,
    transcriptRuntimes,
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        accumulateTerminalMetadataEvents(subscribe(WS_METHODS.subscribeTerminalMetadata, {})),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
export * from "./terminalInput.ts";
export * from "./terminalAttachAdapter.ts";
export * from "./terminalTranscriptRuntime.ts";
export { createTerminalTranscript, type TerminalTranscript } from "./terminalTranscript.ts";
