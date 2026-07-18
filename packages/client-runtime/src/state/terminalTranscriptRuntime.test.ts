import { describe, expect, it } from "@effect/vitest";

import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t4code/contracts";

import {
  createTerminalTranscriptRuntime,
  type TerminalRenderSignal,
} from "./terminalTranscriptRuntime.ts";

const snapshotData = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId: "terminal-1",
  cwd: "/repo",
  worktreePath: null,
  status,
  pid: 1,
  history,
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-07-17T00:00:00.000Z",
  sequence: 1,
});

const snapshot = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalAttachStreamEvent => ({
  type: "snapshot",
  snapshot: snapshotData(history, status),
});

const restarted = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalAttachStreamEvent => ({
  type: "restarted",
  threadId: "thread-1",
  terminalId: "terminal-1",
  sequence: 2,
  snapshot: { ...snapshotData(history, status), sequence: 2 },
});

const output = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "terminal-1",
  sequence: 3,
  data,
});

describe("createTerminalTranscriptRuntime", () => {
  it("starts closed with one stable metadata object", () => {
    const runtime = createTerminalTranscriptRuntime();

    expect(runtime.metadata()).toEqual({
      status: "closed",
      error: null,
      generation: 0,
      revision: 0,
    });
    expect(runtime.metadata()).toBe(runtime.metadata());
    expect(runtime.snapshot()).toBe("");
  });

  it("attach plus live output reconstructs exactly with no gap or duplicate (C1)", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("boot\n"));
    runtime.ingest(output("a"));
    let reconstructed = "";
    const signals: TerminalRenderSignal[] = [];
    const renderer = runtime.attachRenderer((signal) => {
      signals.push(signal);
      reconstructed = signal.type === "reset" ? signal.snapshot : `${reconstructed}${signal.data}`;
    });

    expect(signals).toEqual([{ type: "reset", snapshot: "boot\na" }]);
    runtime.ingest(output("b"));
    runtime.ingest(output("c"));
    expect(reconstructed).toBe("boot\nabc");
    expect(reconstructed).toBe(runtime.snapshot());

    renderer.detach();
    renderer.detach();
    runtime.ingest(output("d"));
    expect(reconstructed).toBe("boot\nabc");
    expect(runtime.snapshot()).toBe("boot\nabcd");
  });

  it("registers before reset delivery so recursively ingested output cannot be missed", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("prompt> "));
    const signals: TerminalRenderSignal[] = [];

    runtime.attachRenderer((signal) => {
      signals.push(signal);
      if (signal.type === "reset") {
        runtime.ingest(output("nested"));
      }
    });

    expect(signals).toEqual([
      { type: "reset", snapshot: "prompt> " },
      { type: "delta", data: "nested" },
    ]);
    expect(runtime.snapshot()).toBe("prompt> nested");
  });

  it("serializes recursive ingestion so every renderer observes the same FIFO order", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const first: string[] = [];
    const second: string[] = [];
    runtime.attachRenderer((signal) => {
      if (signal.type !== "delta") return;
      first.push(signal.data);
      if (signal.data === "1") runtime.ingest(output("2"));
    });
    runtime.attachRenderer((signal) => {
      if (signal.type === "delta") second.push(signal.data);
    });

    runtime.ingest(output("1"));

    expect(first).toEqual(["1", "2"]);
    expect(second).toEqual(["1", "2"]);
    expect(runtime.snapshot()).toBe("12");
  });

  it("uses snapshot fan-out so renderer set mutation neither skips nor duplicates delivery", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const removed: TerminalRenderSignal[] = [];
    const added: TerminalRenderSignal[] = [];
    const remover: TerminalRenderSignal[] = [];
    const removedHandle = runtime.attachRenderer((signal) => removed.push(signal));
    runtime.attachRenderer((signal) => {
      remover.push(signal);
      if (signal.type === "delta" && signal.data === "x") {
        removedHandle.detach();
        runtime.attachRenderer((next) => added.push(next));
      }
    });
    removed.length = 0;
    remover.length = 0;

    runtime.ingest(output("x"));
    expect(removed).toEqual([{ type: "delta", data: "x" }]);
    expect(remover).toEqual([{ type: "delta", data: "x" }]);
    expect(added).toEqual([{ type: "reset", snapshot: "x" }]);

    runtime.ingest(output("y"));
    expect(removed).toEqual([{ type: "delta", data: "x" }]);
    expect(added).toEqual([
      { type: "reset", snapshot: "x" },
      { type: "delta", data: "y" },
    ]);
  });

  it("contains throwing renderer and metadata observers without corrupting other delivery", () => {
    const runtime = createTerminalTranscriptRuntime();
    const rendererSignals: TerminalRenderSignal[] = [];
    const metadataRevisions: number[] = [];
    runtime.attachRenderer(() => {
      throw new Error("renderer failed");
    });
    runtime.attachRenderer((signal) => rendererSignals.push(signal));
    runtime.subscribeMetadata(() => {
      throw new Error("metadata failed");
    });
    runtime.subscribeMetadata((metadata) => metadataRevisions.push(metadata.revision));
    rendererSignals.length = 0;

    expect(() => runtime.ingest(snapshot("safe"))).not.toThrow();
    expect(() => runtime.ingest(output("!"))).not.toThrow();

    expect(rendererSignals).toEqual([
      { type: "reset", snapshot: "safe" },
      { type: "delta", data: "!" },
    ]);
    expect(metadataRevisions).toEqual([1]);
    expect(runtime.snapshot()).toBe("safe!");
  });

  it("output ingests and renders without metadata allocation, revision, or emission (C2)", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const metadataEvents: unknown[] = [];
    runtime.subscribeMetadata((metadata) => metadataEvents.push(metadata));
    const before = runtime.metadata();

    runtime.ingest(output("lots of output\n"));
    runtime.ingest(output("more\n"));

    expect(runtime.metadata()).toBe(before);
    expect(runtime.metadata().revision).toBe(1);
    expect(metadataEvents).toEqual([]);
    expect(runtime.snapshot()).toBe("lots of output\nmore\n");
  });

  it("snapshot and restart replace the transcript, bump generation once, and render before metadata", () => {
    const runtime = createTerminalTranscriptRuntime();
    const order: string[] = [];
    const renderSignals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => {
      renderSignals.push(signal);
      order.push(`render:${signal.type}`);
    });
    runtime.subscribeMetadata((metadata) => order.push(`metadata:${metadata.revision}`));
    renderSignals.length = 0;
    order.length = 0;

    runtime.ingest(snapshot("old\n", "starting"));
    const firstMetadata = runtime.metadata();
    runtime.ingest(output("old-tail"));
    runtime.ingest(restarted("fresh\n", "running"));

    expect(renderSignals).toEqual([
      { type: "reset", snapshot: "old\n" },
      { type: "delta", data: "old-tail" },
      { type: "reset", snapshot: "fresh\n" },
    ]);
    expect(order).toEqual([
      "render:reset",
      "metadata:1",
      "render:delta",
      "render:reset",
      "metadata:2",
    ]);
    expect(firstMetadata).not.toBe(runtime.metadata());
    expect(runtime.metadata()).toEqual({
      status: "running",
      error: null,
      generation: 2,
      revision: 2,
    });
    expect(runtime.snapshot()).toBe("fresh\n");
  });

  it("handles cleared, exited, closed, error, and activity with exact lifecycle emissions", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("seed"));
    const renderSignals: TerminalRenderSignal[] = [];
    const metadataEvents: Array<ReturnType<typeof runtime.metadata>> = [];
    runtime.attachRenderer((signal) => renderSignals.push(signal));
    runtime.subscribeMetadata((metadata) => metadataEvents.push(metadata));
    renderSignals.length = 0;
    const beforeActivity = runtime.metadata();

    runtime.ingest({
      type: "activity",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 4,
      hasRunningSubprocess: true,
      label: "node",
    });
    expect(runtime.metadata()).toBe(beforeActivity);
    expect(metadataEvents).toEqual([]);
    expect(renderSignals).toEqual([]);

    runtime.ingest({
      type: "error",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 5,
      message: "boom",
    });
    runtime.ingest({
      type: "cleared",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 6,
    });
    runtime.ingest({
      type: "exited",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 7,
      exitCode: 1,
      exitSignal: null,
    });
    runtime.ingest({
      type: "closed",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 8,
    });

    expect(metadataEvents.map((metadata) => metadata.revision)).toEqual([2, 3, 4, 5]);
    expect(metadataEvents.map((metadata) => metadata.status)).toEqual([
      "error",
      "error",
      "exited",
      "closed",
    ]);
    expect(metadataEvents.map((metadata) => metadata.error)).toEqual(["boom", null, null, null]);
    expect(metadataEvents.every((metadata) => metadata.generation === 1)).toBe(true);
    expect(renderSignals).toEqual([{ type: "reset", snapshot: "" }]);
    expect(runtime.snapshot()).toBe("");
  });

  it("bounds reset snapshots with the configured UTF-8 transcript cap", () => {
    const runtime = createTerminalTranscriptRuntime({ maxBufferBytes: 4 });
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    signals.length = 0;

    runtime.ingest(snapshot("😀😀"));

    expect(runtime.snapshot()).toBe("😀");
    expect(signals).toEqual([{ type: "reset", snapshot: "😀" }]);
  });

  it("metadata unsubscribe is idempotent", () => {
    const runtime = createTerminalTranscriptRuntime();
    const revisions: number[] = [];
    const unsubscribe = runtime.subscribeMetadata((metadata) => revisions.push(metadata.revision));

    unsubscribe();
    unsubscribe();
    runtime.ingest(snapshot(""));

    expect(revisions).toEqual([]);
  });
});
