import type { FileSaveFlushResult, FileSaveSettleResult } from "./fileSaveCoordinator";

export interface ManagedFileEditingSession {
  relativePath: string;
  flush(): Promise<FileSaveFlushResult>;
  settle(): Promise<FileSaveSettleResult>;
  rename(relativePath: string): void;
  dispose(): void;
}

function isPathAtOrUnder(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function remapPath(candidate: string, from: string, to: string): string {
  return candidate === from ? to : `${to}/${candidate.slice(`${from}/`.length)}`;
}

export class FileEditingSessionRegistry<
  Session extends ManagedFileEditingSession = ManagedFileEditingSession,
> {
  private readonly sessions = new Map<string, Session>();

  get(relativePath: string): Session | undefined {
    return this.sessions.get(relativePath);
  }

  getOrCreate(relativePath: string, create: () => Session): Session {
    const existing = this.sessions.get(relativePath);
    if (existing) return existing;
    const session = create();
    this.sessions.set(relativePath, session);
    return session;
  }

  async preparePathMutation(relativePath: string): Promise<boolean> {
    const matches = [...this.sessions.entries()]
      .filter(([candidate]) => isPathAtOrUnder(candidate, relativePath))
      .map(([, session]) => session);
    const results = await Promise.all(matches.map((session) => session.settle()));
    return results.every((result) => result !== "failed");
  }

  remapUnder(from: string, to: string): void {
    const matches = [...this.sessions.entries()].filter(([candidate]) =>
      isPathAtOrUnder(candidate, from),
    );
    for (const [candidate] of matches) this.sessions.delete(candidate);
    for (const [candidate, session] of matches) {
      const nextPath = remapPath(candidate, from, to);
      const collision = this.sessions.get(nextPath);
      if (collision && collision !== session) collision.dispose();
      session.rename(nextPath);
      this.sessions.set(nextPath, session);
    }
  }

  removeUnder(relativePath: string): void {
    for (const [candidate, session] of this.sessions) {
      if (!isPathAtOrUnder(candidate, relativePath)) continue;
      this.sessions.delete(candidate);
      session.dispose();
    }
  }

  async reconcile(openRelativePaths: readonly string[]): Promise<void> {
    const open = new Set(openRelativePaths);
    const removed = [...this.sessions.entries()].filter(([path]) => !open.has(path));
    for (const [path] of removed) this.sessions.delete(path);
    await Promise.all(
      removed.map(async ([, session]) => {
        await session.settle();
        session.dispose();
      }),
    );
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.settle();
        session.dispose();
      }),
    );
  }
}
