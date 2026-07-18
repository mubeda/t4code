import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_ATTACH_SNAPSHOT,
  EMPTY_TERMINAL_METADATA_SNAPSHOT,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalAttachSnapshot,
  type TerminalSessionState,
  type TerminalTranscriptRuntime,
} from "@t4code/client-runtime/state/terminal";
import { ThreadId, type EnvironmentId, type TerminalAttachInput } from "@t4code/contracts";
import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";

import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

export interface AttachedTerminalSessionState extends TerminalSessionState {
  readonly transcriptRuntime: TerminalTranscriptRuntime | null;
}

const EMPTY_ATTACHED_TERMINAL_SESSION_STATE = Object.freeze<AttachedTerminalSessionState>({
  ...EMPTY_TERMINAL_SESSION_STATE,
  transcriptRuntime: null,
});

const EMPTY_ATTACH_SNAPSHOT_ATOM = Atom.make<TerminalAttachSnapshot>(
  EMPTY_TERMINAL_ATTACH_SNAPSHOT,
).pipe(Atom.withLabel("web-terminal-attach-snapshot:empty"));
const EMPTY_ATTACH_PRODUCER_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-terminal-attach-producer:empty"),
);

interface AttachProducerError {
  readonly atom: unknown;
  readonly error: string | null;
}

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
  /** Own the commit-scoped live attach producer for this session. */
  readonly attach?: boolean;
}): AttachedTerminalSessionState {
  const target =
    input.environmentId !== null && input.terminal !== null && input.attach !== false
      ? { environmentId: input.environmentId, input: input.terminal }
      : null;
  const attachProducer = target
    ? terminalEnvironment.attachProducer(target)
    : EMPTY_ATTACH_PRODUCER_ATOM;
  const attachSnapshotAtom = target
    ? terminalEnvironment.attachSnapshot(target)
    : EMPTY_ATTACH_SNAPSHOT_ATOM;
  const attachSnapshot = useAtomValue(attachSnapshotAtom);
  const targetKey =
    target === null
      ? null
      : JSON.stringify([
          target.environmentId,
          target.input.threadId,
          target.input.terminalId ?? null,
        ]);
  const retainedTranscriptRuntimeRef = useRef<{
    readonly targetKey: string;
    readonly runtime: TerminalTranscriptRuntime;
  } | null>(null);
  if (targetKey === null) {
    retainedTranscriptRuntimeRef.current = null;
  } else if (attachSnapshot.transcriptRuntime !== null) {
    retainedTranscriptRuntimeRef.current = {
      targetKey,
      runtime: attachSnapshot.transcriptRuntime,
    };
  } else if (retainedTranscriptRuntimeRef.current?.targetKey !== targetKey) {
    retainedTranscriptRuntimeRef.current = null;
  }
  const retainedTranscriptRuntime =
    retainedTranscriptRuntimeRef.current?.targetKey === targetKey
      ? retainedTranscriptRuntimeRef.current.runtime
      : null;
  const [producerError, setProducerError] = useState<AttachProducerError>({
    atom: null,
    error: null,
  });
  const handleProducerResult = useCallback(
    (result: AsyncResult.AsyncResult<unknown, unknown>) => {
      const error = result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
      setProducerError((previous) =>
        previous.atom === attachProducer && previous.error === error
          ? previous
          : { atom: attachProducer, error },
      );
    },
    [attachProducer],
  );
  useAtomSubscribe(attachProducer, handleProducerResult, { immediate: true });
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_ATTACHED_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = combineTerminalSessionState(summary, attachSnapshot.metadata);
    const attachError = producerError.atom === attachProducer ? producerError.error : null;
    if (attachError !== null) {
      return {
        ...state,
        error: attachError,
        status: "error",
        transcriptRuntime: attachSnapshot.transcriptRuntime ?? retainedTranscriptRuntime,
      };
    }
    return {
      ...state,
      transcriptRuntime: attachSnapshot.transcriptRuntime ?? retainedTranscriptRuntime,
    };
  }, [
    attachProducer,
    attachSnapshot,
    input.environmentId,
    input.terminal,
    metadata.data,
    producerError,
    retainedTranscriptRuntime,
  ]);
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null) {
      return [];
    }
    return (metadata.data ?? [])
      .filter((summary) => input.threadId === null || summary.threadId === input.threadId)
      .map((summary) => ({
        target: {
          environmentId: input.environmentId!,
          threadId: ThreadId.make(summary.threadId),
          terminalId: summary.terminalId,
        },
        state: combineTerminalSessionState(summary, EMPTY_TERMINAL_METADATA_SNAPSHOT),
      }))
      .sort((left, right) =>
        left.target.terminalId.localeCompare(right.target.terminalId, undefined, {
          numeric: true,
        }),
      );
  }, [input.environmentId, input.threadId, metadata.data]);
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  return selectRunningSubprocessTerminalIds(useKnownTerminalSessions(input));
}
