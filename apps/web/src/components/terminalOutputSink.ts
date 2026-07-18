export const DEFAULT_OUTPUT_FLUSH_THRESHOLD_BYTES = 256 * 1024;

export interface TerminalOutputSinkOptions {
  /** Writes coalesced output to xterm. */
  readonly write: (data: string) => void;
  /** Force an immediate flush once queued bytes reach this size (bounds latency + memory). */
  readonly flushThresholdBytes?: number;
  readonly scheduleFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface TerminalOutputSink {
  push(delta: string): void;
  flush(): void;
  dispose(): void;
}

interface ScheduledFrame {
  handle: number | null;
  callbackOutcome: "pending" | "succeeded" | "failed";
  callbackError: unknown;
}

export function createTerminalOutputSink(options: TerminalOutputSinkOptions): TerminalOutputSink {
  const threshold = options.flushThresholdBytes ?? DEFAULT_OUTPUT_FLUSH_THRESHOLD_BYTES;
  const scheduleFrame =
    options.scheduleFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const encoder = new TextEncoder();

  let pending: string[] = [];
  let pendingBytes = 0;
  let pendingTrailingHighSurrogate = false;
  let scheduledFrame: ScheduledFrame | null = null;
  let disposed = false;

  const clearFrame = (): void => {
    const frame = scheduledFrame;
    if (frame === null) return;

    scheduledFrame = null;
    if (frame.handle !== null) {
      cancelFrame(frame.handle);
    }
  };

  const flushPending = (): void => {
    clearFrame();
    if (pending.length === 0) return;

    const data = pending.join("");
    pending = [];
    pendingBytes = 0;
    pendingTrailingHighSurrogate = false;
    options.write(data);
  };

  const schedulePendingFrame = (): void => {
    if (scheduledFrame !== null) return;

    const frame: ScheduledFrame = {
      handle: null,
      callbackOutcome: "pending",
      callbackError: undefined,
    };
    scheduledFrame = frame;
    try {
      frame.handle = scheduleFrame(() => {
        if (scheduledFrame !== frame) {
          frame.callbackOutcome = "succeeded";
          return;
        }
        scheduledFrame = null;
        try {
          flushPending();
          frame.callbackOutcome = "succeeded";
        } catch (error) {
          frame.callbackOutcome = "failed";
          frame.callbackError = error;
          throw error;
        }
      });
      if (frame.callbackOutcome === "failed") {
        throw frame.callbackError;
      }
    } catch (error) {
      if (frame.callbackOutcome === "succeeded") return;
      if (scheduledFrame === frame) {
        scheduledFrame = null;
      }
      if (frame.callbackOutcome === "failed") {
        throw frame.callbackError;
      }
      throw error;
    }
  };

  return {
    push(delta) {
      if (disposed || delta.length === 0) return;

      pending.push(delta);
      const firstCodeUnit = delta.charCodeAt(0);
      const closesPendingSurrogatePair =
        pendingTrailingHighSurrogate && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff;
      // Separate encoding counts both isolated surrogates as three-byte replacements.
      // Across this boundary they instead form one four-byte code point: 6 - 4 = 2.
      pendingBytes += encoder.encode(delta).byteLength - (closesPendingSurrogatePair ? 2 : 0);
      const lastCodeUnit = delta.charCodeAt(delta.length - 1);
      pendingTrailingHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
      if (pendingBytes >= threshold) {
        flushPending();
        return;
      }
      schedulePendingFrame();
    },
    flush() {
      if (!disposed) {
        flushPending();
      }
    },
    dispose() {
      if (disposed) return;

      disposed = true;
      try {
        clearFrame();
      } finally {
        pending = [];
        pendingBytes = 0;
        pendingTrailingHighSurrogate = false;
      }
    },
  };
}
