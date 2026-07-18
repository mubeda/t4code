import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createTerminalOutputSink,
  DEFAULT_OUTPUT_FLUSH_THRESHOLD_BYTES,
} from "./terminalOutputSink.ts";

function createFrameHarness() {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const scheduleFrame = vi.fn((callback: () => void) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancelFrame = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });

  return {
    cancelFrame,
    callback(handle: number): () => void {
      const callback = callbacks.get(handle);
      if (!callback) throw new Error(`Missing frame callback for handle ${handle}`);
      return callback;
    },
    run(handle: number): void {
      const callback = callbacks.get(handle);
      if (!callback) throw new Error(`Missing frame callback for handle ${handle}`);
      callbacks.delete(handle);
      callback();
    },
    scheduleFrame,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createTerminalOutputSink", () => {
  it("exports the 256 KiB default flush threshold", () => {
    expect(DEFAULT_OUTPUT_FLUSH_THRESHOLD_BYTES).toBe(256 * 1024);
  });

  it("coalesces same-turn pushes into one write per frame", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("a");
    sink.push("b");
    sink.push("c");

    expect(write).not.toHaveBeenCalled();
    expect(frames.scheduleFrame).toHaveBeenCalledTimes(1);

    frames.run(1);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("abc");
    expect(frames.cancelFrame).not.toHaveBeenCalled();
  });

  it("flushes at the exact accumulated UTF-8 threshold and encodes only each new delta", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const sink = createTerminalOutputSink({
      write,
      flushThresholdBytes: 4,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("é");
    expect(write).not.toHaveBeenCalled();
    sink.push("é");

    expect(encode.mock.calls.map(([delta]) => delta)).toEqual(["é", "é"]);
    expect(write).toHaveBeenCalledExactlyOnceWith("éé");
    expect(frames.cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("flushes a single multibyte delta beyond the byte threshold without scheduling a frame", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      flushThresholdBytes: 4,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("😀a");

    expect(write).toHaveBeenCalledExactlyOnceWith("😀a");
    expect(frames.scheduleFrame).not.toHaveBeenCalled();
    expect(frames.cancelFrame).not.toHaveBeenCalled();
  });

  it("counts a surrogate pair split across pushes as its joined UTF-8 byte length", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      flushThresholdBytes: 5,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("\ud83d");
    sink.push("\ude00");

    expect(write).not.toHaveBeenCalled();
    expect(frames.scheduleFrame).toHaveBeenCalledTimes(1);

    frames.run(1);
    expect(write).toHaveBeenCalledExactlyOnceWith("😀");
  });

  it("counts unmatched surrogates exactly and resets boundary state after a flush", () => {
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      flushThresholdBytes: 3,
      scheduleFrame: () => 1,
      cancelFrame: vi.fn(),
    });

    sink.push("\ud83d");
    sink.push("\ude00");

    expect(write.mock.calls).toEqual([["\ud83d"], ["\ude00"]]);
  });

  it("ignores empty pushes", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("");

    expect(encode).not.toHaveBeenCalled();
    expect(frames.scheduleFrame).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("manually flushes queued output, cancels its frame, and makes an empty flush inert", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("manual");
    sink.flush();
    sink.flush();

    expect(frames.cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(write).toHaveBeenCalledExactlyOnceWith("manual");
  });

  it("keeps stale canceled callbacks from flushing or clearing a newer frame", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("old");
    const staleCallback = frames.callback(1);
    sink.flush();
    sink.push("new");

    staleCallback();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith("old");
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1);

    frames.run(2);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith("new");
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1);
  });

  it("disposes idempotently, cancels and drops pending output, and ignores later operations", () => {
    const frames = createFrameHarness();
    const write = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("pending");
    const staleCallback = frames.callback(1);
    sink.dispose();
    sink.dispose();
    staleCallback();
    sink.push("ignored");
    sink.flush();

    expect(frames.cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(frames.scheduleFrame).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("uses the browser frame scheduler and canceller by default", () => {
    const write = vi.fn();
    const frame: { callback: FrameRequestCallback | null } = { callback: null };
    const requestAnimationFrame = vi.fn((nextCallback: FrameRequestCallback) => {
      frame.callback = nextCallback;
      return 41;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });
    const sink = createTerminalOutputSink({ write });

    sink.push("default");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    sink.flush();

    expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(41);
    expect(write).toHaveBeenCalledExactlyOnceWith("default");

    frame.callback?.(0);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves queued output when scheduling throws and invalidates a leaked callback", () => {
    const write = vi.fn();
    const scheduleError = new Error("schedule failed");
    const frames: {
      leakedCallback: (() => void) | null;
      currentCallback: (() => void) | null;
    } = {
      leakedCallback: null,
      currentCallback: null,
    };
    const scheduleFrame = vi
      .fn<(callback: () => void) => number>()
      .mockImplementationOnce((callback) => {
        frames.leakedCallback = callback;
        throw scheduleError;
      })
      .mockImplementationOnce((callback) => {
        frames.currentCallback = callback;
        return 2;
      });
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame,
      cancelFrame: vi.fn(),
    });

    expect(() => sink.push("a")).toThrow(scheduleError);
    sink.push("b");
    frames.leakedCallback?.();

    expect(write).not.toHaveBeenCalled();

    frames.currentCallback?.();
    expect(write).toHaveBeenCalledExactlyOnceWith("ab");
  });

  it("does not retain a stale handle when the injected scheduler invokes synchronously", () => {
    const write = vi.fn();
    const cancelFrame = vi.fn();
    const scheduleFrame = vi.fn((callback: () => void) => {
      callback();
      return 17;
    });
    const sink = createTerminalOutputSink({ write, scheduleFrame, cancelFrame });

    sink.push("a");
    sink.push("b");
    sink.dispose();

    expect(scheduleFrame).toHaveBeenCalledTimes(2);
    expect(write.mock.calls).toEqual([["a"], ["b"]]);
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it("allows a scheduler to trigger a reentrant manual flush before returning its handle", () => {
    const write = vi.fn();
    const cancelFrame = vi.fn();
    let sink: ReturnType<typeof createTerminalOutputSink>;
    const scheduleFrame = vi.fn(() => {
      sink.flush();
      return 23;
    });
    sink = createTerminalOutputSink({ write, scheduleFrame, cancelFrame });

    sink.push("reentrant");

    expect(write).toHaveBeenCalledExactlyOnceWith("reentrant");
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it("recovers when a synchronous scheduled callback propagates a write failure", () => {
    const writeError = new Error("write failed");
    const write = vi.fn((data: string) => {
      if (data === "first") throw writeError;
    });
    const cancelFrame = vi.fn();
    const scheduleFrame = vi.fn((callback: () => void) => {
      callback();
      return 29;
    });
    const sink = createTerminalOutputSink({ write, scheduleFrame, cancelFrame });

    expect(() => sink.push("first")).toThrow(writeError);
    sink.push("second");

    expect(write.mock.calls).toEqual([["first"], ["second"]]);
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it("contains a scheduler throw that occurs after its callback delivered output", () => {
    const write = vi.fn();
    const scheduleError = new Error("post-callback schedule failure");
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: (callback) => {
        callback();
        throw scheduleError;
      },
      cancelFrame: vi.fn(),
    });

    expect(() => sink.push("once")).not.toThrow();
    sink.flush();

    expect(write).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("preserves a callback write failure when the scheduler replaces the thrown error", () => {
    const writeError = new Error("write failed");
    const scheduleError = new Error("scheduler replaced callback failure");
    const write = vi.fn(() => {
      throw writeError;
    });
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: (callback) => {
        try {
          callback();
        } catch {
          throw scheduleError;
        }
        return 37;
      },
      cancelFrame: vi.fn(),
    });

    expect(() => sink.push("once")).toThrow(writeError);
    sink.flush();

    expect(write).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("propagates a callback write failure swallowed by a synchronous scheduler", () => {
    const writeError = new Error("write failed");
    const write = vi.fn(() => {
      throw writeError;
    });
    const cancelFrame = vi.fn();
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: (callback) => {
        try {
          callback();
        } catch {
          // Deliberately model a scheduler that contains callback exceptions.
        }
        return 43;
      },
      cancelFrame,
    });

    expect(() => sink.push("once")).toThrow(writeError);
    sink.flush();

    expect(write).toHaveBeenCalledExactlyOnceWith("once");
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it("drops a failed write, propagates its error, and remains usable", () => {
    const frames = createFrameHarness();
    const writeError = new Error("write failed");
    const write = vi.fn((data: string) => {
      if (data === "first") throw writeError;
    });
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: frames.scheduleFrame,
      cancelFrame: frames.cancelFrame,
    });

    sink.push("first");
    expect(() => frames.run(1)).toThrow(writeError);

    sink.push("second");
    frames.run(2);

    expect(write.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("preserves queued output when frame cancellation throws so a later flush can recover", () => {
    const write = vi.fn();
    const cancelError = new Error("cancel failed");
    const cancelFrame = vi.fn(() => {
      throw cancelError;
    });
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: () => 1,
      cancelFrame,
    });

    sink.push("pending");
    expect(() => sink.flush()).toThrow(cancelError);
    sink.flush();

    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledExactlyOnceWith("pending");
  });

  it("drops pending output and stays disposed even when frame cancellation throws", () => {
    const write = vi.fn();
    const cancelError = new Error("cancel failed");
    const frame: { callback: (() => void) | null } = { callback: null };
    const sink = createTerminalOutputSink({
      write,
      scheduleFrame: (callback) => {
        frame.callback = callback;
        return 1;
      },
      cancelFrame: () => {
        throw cancelError;
      },
    });

    sink.push("pending");
    expect(() => sink.dispose()).toThrow(cancelError);
    frame.callback?.();
    sink.push("ignored");
    sink.flush();
    sink.dispose();

    expect(write).not.toHaveBeenCalled();
  });
});
