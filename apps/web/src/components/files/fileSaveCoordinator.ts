import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
}

export type FileSaveFlushResult = "saved" | "unchanged" | "saving" | "failed";

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private persistedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
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
    return this.timer !== null || this.saving;
  }

  /**
   * Persist any pending debounced edit immediately (explicit save). Cancels the
   * outstanding debounce timer and writes now. No-op ("unchanged") when nothing
   * is unsaved; returns "saving" when a write is already in flight — that write
   * (and its reschedule) settles the remaining edits on its own.
   */
  async flush(): Promise<FileSaveFlushResult> {
    if (this.saving) return "saving";
    if (this.latestRevision === this.persistedRevision) return "unchanged";
    this.clearTimer();
    return (await this.persistLatest()) ? "saved" : "failed";
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

  private async persistLatest(): Promise<boolean> {
    if (this.saving || this.latestRevision === this.persistedRevision) return false;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.persistedRevision = revision;
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return succeeded;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      return this.persistLatest();
    }
    this.schedule(remainingDebounce);
    return succeeded;
  }
}
