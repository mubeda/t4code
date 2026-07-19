import { describe, expect, it, vi } from "vite-plus/test";

import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";

function fakeSession(relativePath: string) {
  return {
    relativePath,
    flush: vi.fn(async () => "saved" as const),
    settle: vi.fn<() => Promise<"saved" | "failed">>(async () => "saved"),
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

    await expect(registry.preparePathMutation("src")).resolves.toBe(true);
    expect(child.settle).toHaveBeenCalledOnce();
    expect(lookalike.settle).not.toHaveBeenCalled();
  });

  it("aborts path preparation when any session fails to settle", async () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    session.settle.mockResolvedValue("failed");

    await expect(registry.preparePathMutation("src")).resolves.toBe(false);
  });

  it("remaps descendants and disposes removed sessions", () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const session = registry.getOrCreate("src/nested/a.ts", () => fakeSession("src/nested/a.ts"));

    registry.remapUnder("src", "lib");
    expect(session.rename).toHaveBeenCalledWith("lib/nested/a.ts");
    expect(registry.get("lib/nested/a.ts")).toBe(session);

    registry.removeUnder("lib");
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

  it("disposes a remap collision and retains the renamed source session", () => {
    const registry = new FileEditingSessionRegistry<ReturnType<typeof fakeSession>>();
    const source = registry.getOrCreate("src/a.ts", () => fakeSession("src/a.ts"));
    const displaced = registry.getOrCreate("lib/a.ts", () => fakeSession("lib/a.ts"));

    registry.remapUnder("src", "lib");

    expect(displaced.dispose).toHaveBeenCalledOnce();
    expect(source.dispose).not.toHaveBeenCalled();
    expect(source.rename).toHaveBeenCalledWith("lib/a.ts");
    expect(registry.get("lib/a.ts")).toBe(source);
  });
});
