import type { FileSaveFlushResult, FileSaveSettleResult } from "./fileSaveCoordinator";
import type { FilePathMutationLease } from "./filePathMutationLease";

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
  readonly relativePath: string;
  readonly sessions: Map<string, Session>;
  readonly pausedSessions: Set<Session>;
  readonly completion: Promise<void>;
  complete(): void;
}

export class FileEditingSessionRegistry<
  Session extends ManagedFileEditingSession = ManagedFileEditingSession,
> {
  private readonly sessions = new Map<string, Session>();
  private readonly activePathMutations = new Set<ActivePathMutation<Session>>();
  private latestOpenRelativePaths: ReadonlySet<string> | null = null;
  private disposed = false;

  get(relativePath: string): Session | undefined {
    return this.sessions.get(relativePath);
  }

  getOrCreate(relativePath: string, create: () => Session): Session {
    const existing = this.sessions.get(relativePath);
    if (existing) return existing;
    const session = create();
    this.sessions.set(relativePath, session);
    for (const mutation of this.activePathMutations) {
      if (!isPathAtOrUnder(relativePath, mutation.relativePath)) continue;
      session.pauseSaving();
      mutation.sessions.set(relativePath, session);
      mutation.pausedSessions.add(session);
    }
    return session;
  }

  async beginPathMutation(relativePath: string): Promise<FilePathMutationLease | null> {
    if (
      [...this.activePathMutations].some((mutation) =>
        pathsOverlap(mutation.relativePath, relativePath),
      )
    ) {
      return null;
    }

    let completeMutation!: () => void;
    const mutation: ActivePathMutation<Session> = {
      relativePath,
      sessions: new Map(
        [...this.sessions.entries()].filter(([candidate]) =>
          isPathAtOrUnder(candidate, relativePath),
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
        [...mutation.sessions.values()].map((session) => session.settle()),
      );
    } catch (error) {
      await this.releaseMutation(mutation);
      throw error;
    }
    if (results.some((result) => result === "failed")) {
      await this.releaseMutation(mutation);
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
        void this.releaseMutation(mutation, outcome !== "deleted");
      },
    };
  }

  async reconcile(openRelativePaths: readonly string[]): Promise<void> {
    const open = new Set(openRelativePaths);
    this.latestOpenRelativePaths = open;
    const leasedSessions = new Set(
      [...this.activePathMutations].flatMap((mutation) => [...mutation.sessions.values()]),
    );
    const removed = [...this.sessions.entries()].filter(
      ([path, session]) => !open.has(path) && !leasedSessions.has(session),
    );
    for (const [path] of removed) this.sessions.delete(path);
    await Promise.all(
      removed.map(async ([, session]) => {
        await session.settle();
        session.dispose();
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const activeMutations = [...this.activePathMutations];
    const leasedSessions = new Set(
      activeMutations.flatMap((mutation) => [...mutation.sessions.values()]),
    );
    const sessions = [...this.sessions.entries()].filter(
      ([, session]) => !leasedSessions.has(session),
    );
    for (const [path] of sessions) this.sessions.delete(path);
    await Promise.all(
      sessions.map(async ([, session]) => {
        await session.settle();
        session.dispose();
      }),
    );
    await Promise.all(activeMutations.map((mutation) => mutation.completion));
  }

  private remapMutation(mutation: ActivePathMutation<Session>, toRelativePath: string): void {
    for (const candidate of mutation.sessions.keys()) this.sessions.delete(candidate);
    const remapped = new Map<string, Session>();
    for (const [candidate, session] of mutation.sessions) {
      const nextPath = remapPath(candidate, mutation.relativePath, toRelativePath);
      const collision = this.sessions.get(nextPath);
      if (collision && collision !== session) collision.dispose();
      session.rename(nextPath);
      this.sessions.set(nextPath, session);
      remapped.set(nextPath, session);
    }
    mutation.sessions.clear();
    for (const [path, session] of remapped) mutation.sessions.set(path, session);
  }

  private deleteMutation(mutation: ActivePathMutation<Session>): void {
    for (const [candidate, session] of mutation.sessions) {
      this.sessions.delete(candidate);
      session.discardPendingSave();
      session.dispose();
    }
  }

  private async releaseMutation(
    mutation: ActivePathMutation<Session>,
    resumeSaving = true,
  ): Promise<void> {
    this.activePathMutations.delete(mutation);
    if (resumeSaving) {
      for (const session of mutation.pausedSessions) session.resumeSaving();
    }

    if (this.disposed) {
      for (const candidate of mutation.sessions.keys()) this.sessions.delete(candidate);
      if (resumeSaving) {
        await Promise.all(
          [...mutation.sessions.values()].map(async (session) => {
            await session.settle();
            session.dispose();
          }),
        );
      }
    } else if (this.latestOpenRelativePaths) {
      await this.reconcile([...this.latestOpenRelativePaths]);
    }
    mutation.complete();
  }
}
