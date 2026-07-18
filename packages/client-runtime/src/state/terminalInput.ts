export interface TerminalInputSendResult {
  readonly ok: boolean;
  readonly error?: unknown;
}

export interface TerminalInputSchedulerOptions {
  /** Sends one payload to the PTY. Resolves ok:false or rejects to signal failure. */
  readonly send: (data: string) => Promise<TerminalInputSendResult>;
  /**
   * Invoked once when a current-generation write fails, after dependent input is
   * dropped. Observer exceptions are isolated from the scheduler.
   */
  readonly onWriteError?: (error: unknown) => void;
  /** Maximum UTF-16 length of a single RPC frame. */
  readonly maxFrameLength?: number;
}

export interface TerminalInputScheduler {
  /** Appends input in arrival order and schedules a drain. Empty strings are ignored. */
  enqueue(data: string): void;
  /** Drops pending input and invalidates in-flight results for the old generation. */
  reset(): void;
  pendingLength(): number;
  isDraining(): boolean;
}

export const DEFAULT_MAX_INPUT_FRAME_LENGTH = 16 * 1024;

export function createTerminalInputScheduler(
  options: TerminalInputSchedulerOptions,
): TerminalInputScheduler {
  const requestedMaxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_INPUT_FRAME_LENGTH;
  const maxFrameLength = Number.isFinite(requestedMaxFrameLength)
    ? Math.max(1, Math.floor(requestedMaxFrameLength))
    : DEFAULT_MAX_INPUT_FRAME_LENGTH;
  let pending = "";
  let draining = false;
  let scheduled = false;
  let generation = 0;

  const takeFrame = (): string => {
    if (pending.length <= maxFrameLength) {
      const frame = pending;
      pending = "";
      return frame;
    }

    let end = maxFrameLength;
    const last = pending.charCodeAt(end - 1);
    const next = pending.charCodeAt(end);
    const splitsSurrogatePair =
      last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    if (splitsSurrogatePair) {
      // A one-unit limit cannot contain a surrogate pair. Keep the pair intact
      // and allow this frame to exceed that limit by one unit so draining
      // always makes progress.
      end = end === 1 ? 2 : end - 1;
    }

    const frame = pending.slice(0, end);
    pending = pending.slice(end);
    return frame;
  };

  const notifyWriteError = (error: unknown): void => {
    try {
      options.onWriteError?.(error);
    } catch {
      // Error observers are isolated from the scheduler lifecycle.
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const frameGeneration = generation;
        const frame = takeFrame();
        let result: TerminalInputSendResult;
        try {
          result = await options.send(frame);
        } catch (error) {
          if (frameGeneration !== generation) continue;
          pending = "";
          notifyWriteError(error);
          return;
        }
        if (frameGeneration !== generation) continue;
        if (!result.ok) {
          pending = "";
          notifyWriteError(result.error);
          return;
        }
      }
    } finally {
      draining = false;
      if (pending.length > 0) scheduleDrain();
    }
  };

  const scheduleDrain = () => {
    if (scheduled || draining) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void drain();
    });
  };

  return {
    enqueue(data) {
      if (data.length === 0) return;
      pending += data;
      scheduleDrain();
    },
    reset() {
      generation += 1;
      pending = "";
    },
    pendingLength() {
      return pending.length;
    },
    isDraining() {
      return draining;
    },
  };
}

export interface TerminalInputSchedulerRegistry {
  /** Returns the scheduler for `key`, creating it with `factory` on first use. */
  acquire(key: string, factory: () => TerminalInputScheduler): TerminalInputScheduler;
  /** Resets and removes the scheduler for `key`. Call when the terminal session is closed. */
  release(key: string): void;
  size(): number;
}

export function createTerminalInputSchedulerRegistry(): TerminalInputSchedulerRegistry {
  const schedulers = new Map<string, TerminalInputScheduler>();

  return {
    acquire(key, factory) {
      const existing = schedulers.get(key);
      if (existing !== undefined) return existing;

      const created = factory();
      schedulers.set(key, created);
      return created;
    },
    release(key) {
      schedulers.get(key)?.reset();
      schedulers.delete(key);
    },
    size() {
      return schedulers.size;
    },
  };
}

// Key derivation only: JSON tuples keep component boundaries collision-safe.
export function terminalInputKey(
  environmentId: string,
  threadId: string,
  terminalId: string,
): string {
  return JSON.stringify([environmentId, threadId, terminalId]);
}
