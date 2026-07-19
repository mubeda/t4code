import type { FileSaveFlushResult, FileSaveSettleResult } from "./fileSaveCoordinator";
import type { FilePathMutationLease, FilePathMutationRequest } from "./filePathMutationLease";

export interface ManagedFileEditingSession {
  relativePath: string;
  flush(): Promise<FileSaveFlushResult>;
  settle(): Promise<FileSaveSettleResult>;
  pauseSaving(): void;
  resumeSaving(): void;
  discardPendingSave(): void;
  rename(relativePath: string): void;
  dispose(): void;
}

function isPathAtOrUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remapPath(candidate: string, from: string, to: string): string {
  return candidate === from ? to : `${to}/${candidate.slice(`${from}/`.length)}`;
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathAtOrUnder(first, second) || isPathAtOrUnder(second, first);
}

interface ActivePathMutation<Session> {
  readonly request: FilePathMutationRequest;
  readonly scopePaths: readonly string[];
  readonly sessions: Map<string, Session>;
  readonly pausedSessions: Set<Session>;
  readonly completion: Promise<void>;
  complete(): void;
}

interface SettlingSessionClose {
  readonly phase: "settling";
  closeRequested: boolean;
  readonly settlement: Promise<FileSaveSettleResult>;
  completion: Promise<void>;
}

interface FailedSessionClose {
  readonly phase: "failed";
}

interface SettledSessionClose {
  readonly phase: "settled";
  readonly result: Exclude<FileSaveSettleResult, "failed">;
}

type SessionCloseState = SettlingSessionClose | FailedSessionClose | SettledSessionClose;

export class FileEditingSessionRegistry<
  Session extends ManagedFileEditingSession = ManagedFileEditingSession,
> {
  private sessions = new Map<string, Session>();
  private readonly sessionCloseStates = new Map<Session, SessionCloseState>();
  private readonly activePathMutations = new Set<ActivePathMutation<Session>>();
  private latestOpenRelativePaths: ReadonlySet<string> | null = null;
  private ownerCount = 0;
  private ownershipGeneration = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  get(relativePath: string): Session | undefined {
    return this.sessions.get(relativePath);
  }

  getOrCreate(relativePath: string, create: () => Session): Session {
    const existing = this.sessions.get(relativePath);
    if (existing) {
      this.markSessionOpen(existing);
      return existing;
    }
    const session = create();
    this.sessions.set(relativePath, session);
    for (const mutation of this.activePathMutations) {
      if (!mutation.scopePaths.some((path) => isPathAtOrUnder(relativePath, path))) continue;
      session.pauseSaving();
      mutation.sessions.set(relativePath, session);
      mutation.pausedSessions.add(session);
    }
    return session;
  }

  async beginPathMutation(request: FilePathMutationRequest): Promise<FilePathMutationLease | null> {
    const scopePaths =
      request.kind === "rename"
        ? [request.fromRelativePath, request.toRelativePath]
        : [request.relativePath];
    if (
      [...this.activePathMutations].some((mutation) =>
        mutation.scopePaths.some((activePath) =>
          scopePaths.some((scopePath) => pathsOverlap(activePath, scopePath)),
        ),
      )
    ) {
      return null;
    }

    let completeMutation!: () => void;
    const mutation: ActivePathMutation<Session> = {
      request,
      scopePaths,
      sessions: new Map(
        [...this.sessions.entries()].filter(([candidate]) =>
          scopePaths.some((scopePath) => isPathAtOrUnder(candidate, scopePath)),
        ),
      ),
      pausedSessions: new Set(),
      completion: new Promise<void>((resolve) => {
        completeMutation = resolve;
      }),
      complete: () => completeMutation(),
    };
    this.activePathMutations.add(mutation);

    let results: FileSaveSettleResult[];
    try {
      results = await Promise.all(
        [...mutation.sessions.values()].map((session) => this.settleSessionForMutation(session)),
      );
    } catch (error) {
      await this.releaseMutationAfterFailedAcquisition(mutation);
      throw error;
    }
    if (results.some((result) => result === "failed")) {
      await this.releaseMutationAfterFailedAcquisition(mutation);
      return null;
    }

    for (const session of mutation.sessions.values()) {
      if (mutation.pausedSessions.has(session)) continue;
      session.pauseSaving();
      mutation.pausedSessions.add(session);
    }

    let outcome: "pending" | "renamed" | "deleted" = "pending";
    let released = false;
    return {
      commitRename: (toRelativePath) => {
        if (released || outcome !== "pending") return;
        outcome = "renamed";
        this.remapMutation(mutation, toRelativePath);
      },
      commitDelete: () => {
        if (released || outcome !== "pending") return;
        outcome = "deleted";
        this.deleteMutation(mutation);
      },
      release: () => {
        if (released) return;
        released = true;
        void this.releaseMutation(mutation, outcome !== "deleted").catch((error: unknown) => {
          this.reportMutationCleanupError(error);
        });
      },
    };
  }

  async reconcile(openRelativePaths: readonly string[]): Promise<void> {
    const open = new Set(openRelativePaths);
    this.latestOpenRelativePaths = open;
    for (const [path, session] of this.sessions) {
      if (open.has(path)) this.markSessionOpen(session);
    }
    const leasedSessions = new Set(
      [...this.activePathMutations].flatMap((mutation) => [...mutation.sessions.values()]),
    );
    const closing = [...this.sessions.entries()]
      .filter(([path, session]) => !open.has(path) && !leasedSessions.has(session))
      .map(([, session]) => this.closeSession(session));
    await Promise.all(closing);
  }

  acquireOwnership(): () => void {
    if (this.disposed) return () => {};
    this.ownerCount += 1;
    this.ownershipGeneration += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ownerCount = Math.max(0, this.ownerCount - 1);
      const generation = ++this.ownershipGeneration;
      queueMicrotask(() => {
        if (this.ownerCount !== 0 || this.ownershipGeneration !== generation || this.disposed) {
          return;
        }
        void this.dispose().catch((error: unknown) => {
          this.reportMutationCleanupError(error);
        });
      });
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    const activeMutations = [...this.activePathMutations];
    const leasedSessions = new Set(
      activeMutations.flatMap((mutation) => [...mutation.sessions.values()]),
    );
    const sessions = [...this.sessions.entries()].filter(
      ([, session]) => !leasedSessions.has(session),
    );
    for (const [path] of sessions) this.sessions.delete(path);
    await Promise.all(sessions.map(([, session]) => this.settleAndDisposeSession(session)));
    await Promise.all(activeMutations.map((mutation) => mutation.completion));
  }

  private async settleAndDisposeSession(session: Session): Promise<void> {
    const closeState = this.sessionCloseStates.get(session);
    if (closeState?.phase === "settling") {
      await closeState.completion;
    } else if (closeState === undefined) {
      try {
        await session.settle();
      } catch (error) {
        this.reportSessionCleanupError(error);
      }
    }
    this.sessionCloseStates.delete(session);
    try {
      session.dispose();
    } catch (error) {
      this.reportSessionCleanupError(error);
    }
  }

  private closeSession(session: Session): Promise<void> {
    const existing = this.sessionCloseStates.get(session);
    if (existing?.phase === "failed") return Promise.resolve();
    if (existing?.phase === "settled") {
      this.disposeSettledSession(session);
      return Promise.resolve();
    }
    if (existing?.phase === "settling") {
      existing.closeRequested = true;
      return existing.completion;
    }

    const settlement = Promise.resolve()
      .then(() => session.settle())
      .catch((error: unknown) => {
        this.reportSessionCleanupError(error);
        return "failed" as const;
      });
    const closeState: SettlingSessionClose = {
      phase: "settling",
      closeRequested: true,
      settlement,
      completion: Promise.resolve(),
    };
    closeState.completion = settlement.then((result) => {
      this.finishClosingSession(session, closeState, result);
    });
    this.sessionCloseStates.set(session, closeState);
    return closeState.completion;
  }

  private finishClosingSession(
    session: Session,
    closeState: SettlingSessionClose,
    result: FileSaveSettleResult,
  ): void {
    if (this.sessionCloseStates.get(session) !== closeState) return;
    if (!closeState.closeRequested) {
      this.sessionCloseStates.delete(session);
      return;
    }
    if (result === "failed") {
      this.sessionCloseStates.set(session, { phase: "failed" });
      return;
    }
    if (this.disposed || this.isSessionLeased(session)) {
      this.sessionCloseStates.set(session, { phase: "settled", result });
      return;
    }
    this.disposeSettledSession(session);
  }

  private disposeSettledSession(session: Session): void {
    this.removeSessionReferences(session);
    this.sessionCloseStates.delete(session);
    try {
      session.dispose();
    } catch (error) {
      this.reportSessionCleanupError(error);
    }
  }

  private settleSessionForMutation(session: Session): Promise<FileSaveSettleResult> {
    const closeState = this.sessionCloseStates.get(session);
    if (closeState?.phase === "settling") return closeState.settlement;
    if (closeState?.phase === "failed") return Promise.resolve("failed");
    if (closeState?.phase === "settled") return Promise.resolve(closeState.result);
    return session.settle();
  }

  private markSessionOpen(session: Session): void {
    const closeState = this.sessionCloseStates.get(session);
    if (closeState?.phase === "settling") {
      closeState.closeRequested = false;
      return;
    }
    this.sessionCloseStates.delete(session);
  }

  private isSessionLeased(session: Session): boolean {
    for (const mutation of this.activePathMutations) {
      for (const candidate of mutation.sessions.values()) {
        if (candidate === session) return true;
      }
    }
    return false;
  }

  private removeSessionReferences(session: Session): void {
    for (const [path, candidate] of this.sessions) {
      if (candidate === session) this.sessions.delete(path);
    }
  }

  private remapMutation(mutation: ActivePathMutation<Session>, toRelativePath: string): void {
    const fromRelativePath =
      mutation.request.kind === "rename"
        ? mutation.request.fromRelativePath
        : mutation.request.relativePath;
    const destinationRelativePath =
      mutation.request.kind === "rename" ? mutation.request.toRelativePath : toRelativePath;
    if (this.latestOpenRelativePaths) {
      this.latestOpenRelativePaths = new Set(
        [...this.latestOpenRelativePaths].map((relativePath) =>
          isPathAtOrUnder(relativePath, fromRelativePath)
            ? remapPath(relativePath, fromRelativePath, toRelativePath)
            : relativePath,
        ),
      );
    }
    const sourceEntries = [...mutation.sessions.entries()].filter(([candidate]) =>
      isPathAtOrUnder(candidate, fromRelativePath),
    );
    const sourceSessions = new Set(sourceEntries.map(([, session]) => session));
    const displacedEntries = [...mutation.sessions.entries()].filter(
      ([candidate, session]) =>
        isPathAtOrUnder(candidate, destinationRelativePath) && !sourceSessions.has(session),
    );
    for (const [, session] of displacedEntries) {
      this.sessionCloseStates.delete(session);
      this.discardAndDisposeSession(session);
      mutation.pausedSessions.delete(session);
    }

    const nextSessions = new Map(this.sessions);
    for (const [candidate, session] of [...sourceEntries, ...displacedEntries]) {
      if (nextSessions.get(candidate) === session) nextSessions.delete(candidate);
    }
    const remapped = new Map<string, Session>();
    for (const [candidate, session] of sourceEntries) {
      const nextPath = remapPath(candidate, fromRelativePath, toRelativePath);
      session.rename(nextPath);
      nextSessions.set(nextPath, session);
      remapped.set(nextPath, session);
    }
    this.sessions = nextSessions;
    mutation.sessions.clear();
    for (const [path, session] of remapped) mutation.sessions.set(path, session);
  }

  private deleteMutation(mutation: ActivePathMutation<Session>): void {
    const relativePath =
      mutation.request.kind === "rename"
        ? mutation.request.fromRelativePath
        : mutation.request.relativePath;
    const deletedEntries = [...mutation.sessions.entries()].filter(([candidate]) =>
      isPathAtOrUnder(candidate, relativePath),
    );
    for (const [candidate] of deletedEntries) this.sessions.delete(candidate);
    for (const [, session] of deletedEntries) {
      this.sessionCloseStates.delete(session);
      this.discardAndDisposeSession(session);
      mutation.pausedSessions.delete(session);
    }
    mutation.sessions.clear();
  }

  private discardAndDisposeSession(session: Session): void {
    try {
      session.discardPendingSave();
    } catch (error) {
      this.reportSessionCleanupError(error);
    }
    try {
      session.dispose();
    } catch (error) {
      this.reportSessionCleanupError(error);
    }
  }

  private async releaseMutation(
    mutation: ActivePathMutation<Session>,
    resumeSaving = true,
  ): Promise<void> {
    this.activePathMutations.delete(mutation);
    try {
      if (resumeSaving) {
        for (const session of mutation.pausedSessions) session.resumeSaving();
      }

      if (this.disposed) {
        for (const candidate of mutation.sessions.keys()) this.sessions.delete(candidate);
        if (resumeSaving) {
          await Promise.all(
            [...mutation.sessions.values()].map((session) => this.settleAndDisposeSession(session)),
          );
        }
      } else if (this.latestOpenRelativePaths) {
        await this.reconcile([...this.latestOpenRelativePaths]);
      }
    } finally {
      mutation.complete();
    }
  }

  private async releaseMutationAfterFailedAcquisition(
    mutation: ActivePathMutation<Session>,
  ): Promise<void> {
    try {
      await this.releaseMutation(mutation);
    } catch (error) {
      this.reportMutationCleanupError(error);
    }
  }

  private reportMutationCleanupError(error: unknown): void {
    console.error("[file-editing-session-registry] mutation cleanup failed", error);
  }

  private reportSessionCleanupError(error: unknown): void {
    console.error("[file-editing-session-registry] session cleanup failed", error);
  }
}
