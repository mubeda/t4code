import type { AtomCommandResult } from "@t4code/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

export type FileSaveFlushResult = "saved" | "unchanged" | "saving" | "failed";
export type FileSaveSettleResult = "saved" | "unchanged" | "failed";

export type FileSavePhase = "clean" | "pending" | "saving" | "failed";

export interface FileSaveSnapshot {
  readonly phase: FileSavePhase;
  readonly canSave: boolean;
  readonly confirmedRevision: number;
}

const CLEAN_FILE_SAVE_SNAPSHOT: FileSaveSnapshot = {
  phase: "clean",
  canSave: false,
  confirmedRevision: 0,
};

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private persistedRevision = 0;
  private lastChangeAt = 0;
  private inFlight: Promise<boolean> | null = null;
  private disposed = false;
  private snapshot: FileSaveSnapshot = CLEAN_FILE_SAVE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  readonly getSnapshot = (): FileSaveSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.publish("pending");
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    // Only unsaved edits get a farewell write. An unconditional write here
    // resurrects the old path when the surface unmounts because the file was
    // just renamed or deleted out from under it.
    if (this.latestRevision > this.persistedRevision) void this.persistLatest();
  }

  /** True while a debounced write is scheduled or an immediate write is in flight. */
  hasPendingWork(): boolean {
    return this.timer !== null || this.inFlight !== null;
  }

  /**
   * Persist any pending debounced edit immediately (explicit save). Cancels the
   * outstanding debounce timer and writes now. No-op ("unchanged") when nothing
   * is unsaved; returns "saving" when a write is already in flight — that write
   * (and its reschedule) settles the remaining edits on its own.
   */
  async flush(): Promise<FileSaveFlushResult> {
    if (this.inFlight !== null) return "saving";
    if (this.latestRevision === this.persistedRevision) return "unchanged";
    this.clearTimer();
    return (await this.persistLatest()) ? "saved" : "failed";
  }

  async settle(): Promise<FileSaveSettleResult> {
    const hadUnsavedChanges = this.latestRevision !== this.persistedRevision;
    this.clearTimer();

    while (this.inFlight !== null) {
      await this.inFlight;
      this.clearTimer();
    }

    while (this.latestRevision !== this.persistedRevision) {
      const succeeded = await this.persistLatest();
      this.clearTimer();
      if (!succeeded && this.latestRevision !== this.persistedRevision) return "failed";
      while (this.inFlight !== null) await this.inFlight;
    }

    return hadUnsavedChanges ? "saved" : "unchanged";
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private persistLatest(): Promise<boolean> {
    if (this.inFlight !== null || this.latestRevision === this.persistedRevision) {
      return Promise.resolve(false);
    }

    const inFlight = Promise.resolve().then(() => this.persistLatestOnce());
    this.inFlight = inFlight;
    return inFlight.finally(() => {
      if (this.inFlight === inFlight) this.inFlight = null;
    });
  }

  private async persistLatestOnce(): Promise<boolean> {
    this.publish("saving");
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.persistedRevision = revision;
      this.options.onConfirmed(contents);
    }

    if (revision === this.latestRevision) {
      if (succeeded) {
        this.options.onPendingChange(false);
        this.publish("clean");
      } else {
        this.publish("failed");
      }
      return succeeded;
    }

    this.publish("pending");

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      return this.persistLatestOnce();
    }
    this.schedule(remainingDebounce);
    return succeeded;
  }

  private publish(phase: FileSavePhase): void {
    const next: FileSaveSnapshot = {
      phase,
      canSave: phase === "pending" || phase === "failed",
      confirmedRevision: this.persistedRevision,
    };
    if (
      next.phase === this.snapshot.phase &&
      next.canSave === this.snapshot.canSave &&
      next.confirmedRevision === this.snapshot.confirmedRevision
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
