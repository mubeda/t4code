#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const webDirectory = NodePath.join(repoRoot, "apps", "web");
const lockDigest = NodeCrypto.createHash("sha1").update(webDirectory).digest("hex");
const lockDirectory = NodePath.join(NodeOS.tmpdir(), `t4code-web-build-${lockDigest}.lock`);
const lockOwnerFile = NodePath.join(lockDirectory, "owner.txt");

function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function removeStaleLock() {
  try {
    const stats = await NodeFSP.stat(lockDirectory);
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return;
    await NodeFSP.rm(lockDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function acquireBuildLock() {
  for (;;) {
    try {
      await NodeFSP.mkdir(lockDirectory);
      await NodeFSP.writeFile(
        lockOwnerFile,
        `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\nwebDirectory=${webDirectory}\n`,
      );
      return;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      await removeStaleLock();
      await NodeTimersPromises.setTimeout(LOCK_POLL_MS);
    }
  }
}

function runWebBuild() {
  return new Promise((resolve, reject) => {
    const isWindows = process.env.OS === "Windows_NT" || process.env.ComSpec !== undefined;
    const child = isWindows
      ? NodeChildProcess.spawn("vp build", { cwd: webDirectory, shell: true, stdio: "inherit" })
      : NodeChildProcess.spawn("vp", ["build"], {
          cwd: webDirectory,
          shell: false,
          stdio: "inherit",
        });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

await acquireBuildLock();
try {
  process.exitCode = await runWebBuild();
} finally {
  await NodeFSP.rm(lockDirectory, { force: true, recursive: true });
}
