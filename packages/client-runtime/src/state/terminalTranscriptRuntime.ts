import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t4code/contracts";

import {
  createTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
} from "./terminalTranscript.ts";

export type TerminalRenderSignal =
  | { readonly type: "reset"; readonly snapshot: string }
  | { readonly type: "delta"; readonly data: string };

export interface TerminalMetadataSnapshot {
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  /** Bumps whenever a server snapshot replaces the transcript. */
  readonly generation: number;
  /** Bumps for lifecycle metadata changes, never for output or activity. */
  readonly revision: number;
}

export const EMPTY_TERMINAL_METADATA_SNAPSHOT = Object.freeze<TerminalMetadataSnapshot>({
  status: "closed",
  error: null,
  generation: 0,
  revision: 0,
});

export interface TerminalTranscriptRuntime {
  ingest(event: TerminalAttachStreamEvent): void;
  attachRenderer(sink: (signal: TerminalRenderSignal) => void): { detach(): void };
  snapshot(): string;
  metadata(): TerminalMetadataSnapshot;
  subscribeMetadata(listener: (metadata: TerminalMetadataSnapshot) => void): () => void;
}

export function createTerminalTranscriptRuntime(
  options: { readonly maxBufferBytes?: number } = {},
): TerminalTranscriptRuntime {
  const transcript = createTerminalTranscript(
    options.maxBufferBytes ?? DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  );
  const rendererSet = new Set<(signal: TerminalRenderSignal) => void>();
  const metadataListeners = new Set<(metadata: TerminalMetadataSnapshot) => void>();
  const pendingEvents: Array<TerminalAttachStreamEvent> = [];
  let pendingHead = 0;
  let processingEvents = false;
  let metadata = EMPTY_TERMINAL_METADATA_SNAPSHOT;
  let renderers: ReadonlyArray<(signal: TerminalRenderSignal) => void> = [];

  const fanRender = (signal: TerminalRenderSignal) => {
    const currentRenderers = renderers;
    for (const sink of currentRenderers) {
      try {
        sink(signal);
      } catch {
        // Renderer failures are isolated from transcript ingestion and other renderers.
      }
    }
  };

  const notifyMetadata = () => {
    for (const listener of Array.from(metadataListeners)) {
      try {
        listener(metadata);
      } catch {
        // A faulty observer must not prevent other observers from receiving lifecycle state.
      }
    }
  };

  const updateMetadata = (
    next: Pick<TerminalMetadataSnapshot, "status" | "error">,
    newGeneration: boolean,
  ) => {
    metadata = Object.freeze({
      status: next.status,
      error: next.error,
      generation: metadata.generation + (newGeneration ? 1 : 0),
      revision: metadata.revision + 1,
    });
  };

  const resetTranscript = (history: string, status: TerminalMetadataSnapshot["status"]) => {
    transcript.clear();
    transcript.append(history);
    updateMetadata({ status, error: null }, true);
    fanRender({ type: "reset", snapshot: transcript.snapshot() });
    notifyMetadata();
  };

  const processEvent = (event: TerminalAttachStreamEvent) => {
    switch (event.type) {
      case "snapshot":
      case "restarted":
        resetTranscript(event.snapshot.history, event.snapshot.status);
        return;
      case "output":
        transcript.append(event.data);
        fanRender({ type: "delta", data: event.data });
        return;
      case "cleared":
        transcript.clear();
        updateMetadata({ status: metadata.status, error: null }, false);
        fanRender({ type: "reset", snapshot: "" });
        notifyMetadata();
        return;
      case "exited":
        updateMetadata({ status: "exited", error: null }, false);
        notifyMetadata();
        return;
      case "closed":
        updateMetadata({ status: "closed", error: null }, false);
        notifyMetadata();
        return;
      case "error":
        updateMetadata({ status: "error", error: event.message }, false);
        notifyMetadata();
        return;
      case "activity":
        return;
    }
  };

  return {
    ingest(event) {
      pendingEvents.push(event);
      if (processingEvents) return;

      processingEvents = true;
      try {
        while (pendingHead < pendingEvents.length) {
          processEvent(pendingEvents[pendingHead]!);
          pendingHead += 1;
        }
      } finally {
        pendingEvents.length = 0;
        pendingHead = 0;
        processingEvents = false;
      }
    },
    attachRenderer(sink) {
      let attached = true;
      rendererSet.add(sink);
      renderers = Array.from(rendererSet);
      try {
        sink({ type: "reset", snapshot: transcript.snapshot() });
      } catch {
        // Initial hydration obeys the same observer isolation as live fan-out.
      }
      return {
        detach() {
          if (!attached) return;
          attached = false;
          rendererSet.delete(sink);
          renderers = Array.from(rendererSet);
        },
      };
    },
    snapshot() {
      return transcript.snapshot();
    },
    metadata() {
      return metadata;
    },
    subscribeMetadata(listener) {
      let subscribed = true;
      metadataListeners.add(listener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        metadataListeners.delete(listener);
      };
    },
  };
}
