import { describe, expect, it, vi } from "vite-plus/test";

import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";

function fakeSession(relativePath: string) {
  return {
    relativePath,
    flush: vi.fn(async () => "saved" as const),
    settle: vi.fn<() => Promise<"saved" | "failed">>(async () => "saved"),
    pauseSaving: vi.fn(),
    resumeSaving: vi.fn(),
    discardPendingSave: vi.fn(),
    rename: vi.fn(function rename(this: { relativePath: string }, next: string) {
      this.relativePath = next;
    }),
    dispose: vi.fn(),
  };
}

describe("FileEditingSessionRegistry", () => {
  it("reuses one session per exact open file", () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const create = vi.fn(() => fakeSession("src/app.ts"));

    expect(registry.getOrCreate("src/app.ts", create)).toBe(
      registry.getOrCreate("src/app.ts", create),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("settles exact and descendant paths but not prefix lookalikes", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const child = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    const lookalike = registry.getOrCreate("srcfoo/b.ts", () => fakeSession("srcfoo/b.ts"));

    const lease = await registry.beginPathMutation("src");
    expect(lease).not.toBeNull();
    expect(child.settle).toHaveBeenCalledOnce();
    expect(child.pauseSaving).toHaveBeenCalledOnce();
    expect(lookalike.settle).not.toHaveBeenCalled();
    expect(lookalike.pauseSaving).not.toHaveBeenCalled();
    lease!.release();
    expect(child.resumeSaving).toHaveBeenCalledOnce();
  });

  it("aborts path preparation when any session fails to settle", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    session.settle.mockResolvedValue("failed");

    await expect(registry.beginPathMutation("src")).resolves.toBeNull();
    expect(session.pauseSaving).not.toHaveBeenCalled();
  });

  it("remaps descendants and disposes deleted sessions through mutation leases", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/nested/a.ts", () => fakeSession("src/nested/a.ts"));

    const renameLease = await registry.beginPathMutation("src");
    renameLease!.commitRename("lib");
    renameLease!.release();
    expect(session.rename).toHaveBeenCalledWith("lib/nested/a.ts");
    expect(registry.get("lib/nested/a.ts")).toBe(session);

    const deleteLease = await registry.beginPathMutation("lib");
    deleteLease!.commitDelete();
    deleteLease!.release();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(registry.get("lib/nested/a.ts")).toBeUndefined();
  });

  it("reconciles removed sessions after settling them", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const retained = registry.getOrCreate("a.ts", () => fakeSession("a.ts"));
    const removed = registry.getOrCreate("b.ts", () => fakeSession("b.ts"));
    const calls: string[] = [];
    removed.settle.mockImplementation(async () => {
      calls.push("settle");
      return "saved";
    });
    removed.dispose.mockImplementation(() => calls.push("dispose"));

    await registry.reconcile(["a.ts"]);

    expect(registry.get("a.ts")).toBe(retained);
    expect(registry.get("b.ts")).toBeUndefined();
    expect(removed.settle).toHaveBeenCalledOnce();
    expect(removed.dispose).toHaveBeenCalledOnce();
    expect(calls).toEqual(["settle", "dispose"]);
  });

  it("disposes removed sessions and contains settle rejections during reconciliation", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
      const retained = registry.getOrCreate("a.ts", () => fakeSession("a.ts"));
      const rejected = registry.getOrCreate("b.ts", () => fakeSession("b.ts"));
      const removed = registry.getOrCreate("c.ts", () => fakeSession("c.ts"));
      rejected.settle.mockRejectedValue(new Error("save failed"));

      await expect(registry.reconcile(["a.ts"])).resolves.toBeUndefined();

      expect(registry.get("a.ts")).toBe(retained);
      expect(registry.get("b.ts")).toBeUndefined();
      expect(registry.get("c.ts")).toBeUndefined();
      expect(retained.settle).not.toHaveBeenCalled();
      expect(retained.dispose).not.toHaveBeenCalled();
      expect(rejected.dispose).toHaveBeenCalledOnce();
      expect(removed.dispose).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith(
        "[file-editing-session-registry] session cleanup failed",
        expect.objectContaining({ message: "save failed" }),
      );
    } finally {
      reportError.mockRestore();
    }
  });

  it("settles every session before disposing the registry", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const first = registry.getOrCreate("a.ts", () => fakeSession("a.ts"));
    const second = registry.getOrCreate("b.ts", () => fakeSession("b.ts"));
    const calls: string[] = [];
    for (const [name, session] of [
      ["a", first],
      ["b", second],
    ] as const) {
      session.settle.mockImplementation(async () => {
        calls.push(`settle-${name}`);
        return "saved";
      });
      session.dispose.mockImplementation(() => calls.push(`dispose-${name}`));
    }

    await registry.dispose();

    expect(first.settle).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.settle).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(calls.indexOf("settle-a")).toBeLessThan(calls.indexOf("dispose-a"));
    expect(calls.indexOf("settle-b")).toBeLessThan(calls.indexOf("dispose-b"));
  });

  it("disposes every session and contains settle rejections during registry disposal", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
      const rejected = registry.getOrCreate("a.ts", () => fakeSession("a.ts"));
      const settled = registry.getOrCreate("b.ts", () => fakeSession("b.ts"));
      rejected.settle.mockRejectedValue(new Error("save failed"));

      await expect(registry.dispose()).resolves.toBeUndefined();

      expect(rejected.dispose).toHaveBeenCalledOnce();
      expect(settled.dispose).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith(
        "[file-editing-session-registry] session cleanup failed",
        expect.objectContaining({ message: "save failed" }),
      );
    } finally {
      reportError.mockRestore();
    }
  });

  it("disposes a remap collision and retains the renamed source session", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const source = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    const displaced = registry.getOrCreate("lib/a.ts", () => fakeSession("lib/a.ts"));

    const lease = await registry.beginPathMutation("src");
    lease!.commitRename("lib");
    lease!.release();

    expect(displaced.dispose).toHaveBeenCalledOnce();
    expect(source.dispose).not.toHaveBeenCalled();
    expect(source.rename).toHaveBeenCalledWith("lib/a.ts");
    expect(registry.get("lib/a.ts")).toBe(source);
  });

  it("defers reconciliation teardown until an active mutation lease releases", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    const lease = await registry.beginPathMutation("src/a.ts");
    expect(lease).not.toBeNull();

    await registry.reconcile([]);
    expect(session.dispose).not.toHaveBeenCalled();

    lease!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.resumeSaving).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("waits to dispose a leased session until its rename outcome is known", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/old.ts", () => fakeSession("src/old.ts"));
    const lease = await registry.beginPathMutation("src/old.ts");
    expect(lease).not.toBeNull();

    let disposed = false;
    const disposal = registry.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(session.dispose).not.toHaveBeenCalled();

    lease!.commitRename("src/new.ts");
    lease!.release();
    await disposal;
    expect(session.rename).toHaveBeenCalledWith("src/new.ts");
    expect(session.resumeSaving).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("remaps the reconciled open path before releasing a rename lease", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/old.ts", () => fakeSession("src/old.ts"));
    const lookalike = registry.getOrCreate("src/old.ts.bak", () => fakeSession("src/old.ts.bak"));
    await registry.reconcile(["src/old.ts", "src/old.ts.bak"]);
    const lease = await registry.beginPathMutation("src/old.ts");

    lease!.commitRename("src/new.ts");
    lease!.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.get("src/new.ts")).toBe(session);
    expect(registry.get("src/old.ts.bak")).toBe(lookalike);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(lookalike.rename).not.toHaveBeenCalled();
  });

  it("always completes disposal and reports a rejected leased-session cleanup", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
      const session = registry.getOrCreate("src/app.ts", () => fakeSession("src/app.ts"));
      session.settle.mockResolvedValueOnce("saved").mockRejectedValueOnce(new Error("save failed"));
      const lease = await registry.beginPathMutation("src/app.ts");
      let disposalCompleted = false;
      const disposal = registry.dispose().then(() => {
        disposalCompleted = true;
      });

      lease!.release();
      await expect(disposal).resolves.toBeUndefined();
      expect(disposalCompleted).toBe(true);
      expect(reportError).toHaveBeenCalledWith(
        "[file-editing-session-registry] mutation cleanup failed",
        expect.objectContaining({ message: "save failed" }),
      );
    } finally {
      reportError.mockRestore();
    }
  });
});
