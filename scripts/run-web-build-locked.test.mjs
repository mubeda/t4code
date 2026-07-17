import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  LOCK_POLL_MS,
  LOCK_STALE_MS,
  acquireBuildLock,
  isErrorCode,
  removeStaleLock,
  runWebBuild,
  runWebBuildLocked,
} from "./run-web-build-locked.mjs";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function childProcess() {
  const handlers = new Map();
  return {
    child: { on: (event, handler) => handlers.set(event, handler) },
    emit: (event, ...args) => handlers.get(event)?.(...args),
  };
}

describe("run-web-build-locked", () => {
  it("recognizes only matching filesystem error codes", () => {
    expect(isErrorCode(codedError("ENOENT"), "ENOENT")).toBe(true);
    expect(isErrorCode(codedError("EEXIST"), "ENOENT")).toBe(false);
    expect(isErrorCode(null, "ENOENT")).toBe(false);
    expect(isErrorCode("ENOENT", "ENOENT")).toBe(false);
  });

  it("keeps fresh locks, removes stale locks, and ignores missing locks", async () => {
    const rm = vi.fn();
    await removeStaleLock({
      lockDirectory: "/lock",
      stat: vi.fn(async () => ({ mtimeMs: 900 })),
      rm,
      now: () => 1_000,
    });
    expect(rm).not.toHaveBeenCalled();

    await removeStaleLock({
      lockDirectory: "/lock",
      stat: vi.fn(async () => ({ mtimeMs: 0 })),
      rm,
      now: () => LOCK_STALE_MS + 1,
    });
    expect(rm).toHaveBeenCalledWith("/lock", { force: true, recursive: true });

    await expect(
      removeStaleLock({ stat: vi.fn(async () => Promise.reject(codedError("ENOENT"))) }),
    ).resolves.toBeUndefined();
    await expect(
      removeStaleLock({ stat: vi.fn(async () => Promise.reject(codedError("EACCES"))) }),
    ).rejects.toMatchObject({ code: "EACCES" });

    await expect(
      removeStaleLock({
        lockDirectory: NodePath.join(NodeOS.tmpdir(), `missing-build-lock-${process.pid}`),
      }),
    ).resolves.toBeUndefined();
  });

  it("writes lock ownership and retries only lock-contention failures", async () => {
    const mkdir = vi
      .fn()
      .mockRejectedValueOnce(codedError("EEXIST"))
      .mockResolvedValueOnce(undefined);
    const writeFile = vi.fn();
    const removeStale = vi.fn();
    const sleep = vi.fn();
    await acquireBuildLock({
      lockDirectory: "/lock",
      lockOwnerFile: "/lock/owner.txt",
      webDirectory: "/repo/web",
      mkdir,
      writeFile,
      removeStaleLock: removeStale,
      sleep,
      pid: 42,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(removeStale).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(LOCK_POLL_MS);
    expect(writeFile).toHaveBeenCalledWith(
      "/lock/owner.txt",
      "pid=42\ncreatedAt=2026-01-01T00:00:00.000Z\nwebDirectory=/repo/web\n",
    );

    await expect(
      acquireBuildLock({ mkdir: vi.fn(async () => Promise.reject(codedError("EACCES"))) }),
    ).rejects.toMatchObject({ code: "EACCES" });

    const defaultLock = NodePath.join(NodeOS.tmpdir(), `build-lock-defaults-${process.pid}`);
    await NodeFSP.rm(defaultLock, { force: true, recursive: true });
    await acquireBuildLock({
      lockDirectory: defaultLock,
      lockOwnerFile: NodePath.join(defaultLock, "owner.txt"),
      webDirectory: "/repo/web",
    });
    expect(await NodeFSP.readFile(NodePath.join(defaultLock, "owner.txt"), "utf8")).toContain(
      `pid=${process.pid}`,
    );
    await NodeFSP.rm(defaultLock, { force: true, recursive: true });
  });

  it("spawns Unix and Windows builds and normalizes empty exit codes", async () => {
    const unix = childProcess();
    const unixSpawn = vi.fn(() => unix.child);
    const unixResult = runWebBuild({ spawn: unixSpawn, env: {}, webDirectory: "/web" });
    expect(unixSpawn).toHaveBeenCalledWith("vp", ["build"], {
      cwd: "/web",
      shell: false,
      stdio: "inherit",
    });
    unix.emit("close", null);
    await expect(unixResult).resolves.toBe(1);

    const windows = childProcess();
    const windowsSpawn = vi.fn(() => windows.child);
    const windowsResult = runWebBuild({
      spawn: windowsSpawn,
      env: { OS: "Windows_NT" },
      webDirectory: "/web",
    });
    expect(windowsSpawn).toHaveBeenCalledWith("vp build", {
      cwd: "/web",
      shell: true,
      stdio: "inherit",
    });
    windows.emit("close", 0);
    await expect(windowsResult).resolves.toBe(0);

    const comspec = childProcess();
    const comspecResult = runWebBuild({
      spawn: () => comspec.child,
      env: { ComSpec: "cmd.exe" },
    });
    comspec.emit("error", new Error("spawn failed"));
    await expect(comspecResult).rejects.toThrow("spawn failed");

    const defaults = childProcess();
    const defaultsResult = runWebBuild({ spawn: () => defaults.child });
    defaults.emit("close", 0);
    await expect(defaultsResult).resolves.toBe(0);
  });

  it("always removes the lock after successful and failed builds", async () => {
    const acquire = vi.fn(async () => undefined);
    const rm = vi.fn(async () => undefined);
    await expect(
      runWebBuildLocked({
        lockDirectory: "/lock",
        acquireBuildLock: acquire,
        runWebBuild: vi.fn(async () => 7),
        rm,
      }),
    ).resolves.toBe(7);
    expect(rm).toHaveBeenCalledWith("/lock", { force: true, recursive: true });

    await expect(
      runWebBuildLocked({
        lockDirectory: "/lock",
        acquireBuildLock: acquire,
        runWebBuild: vi.fn(async () => Promise.reject(new Error("build failed"))),
        rm,
      }),
    ).rejects.toThrow("build failed");
    expect(rm).toHaveBeenCalledTimes(2);

    const defaultLock = NodePath.join(NodeOS.tmpdir(), `locked-build-defaults-${process.pid}`);
    await NodeFSP.rm(defaultLock, { force: true, recursive: true });
    await expect(
      runWebBuildLocked({
        lockDirectory: defaultLock,
        lockOwnerFile: NodePath.join(defaultLock, "owner.txt"),
        runWebBuild: vi.fn(async () => 0),
      }),
    ).resolves.toBe(0);
    await expect(NodeFSP.stat(defaultLock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
