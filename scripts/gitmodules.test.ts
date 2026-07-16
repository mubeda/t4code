// @effect-diagnostics nodeBuiltinImport:off - Repository metadata guard invokes Git directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

function gitOutput(args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
}

describe("Git submodule metadata", () => {
  it("matches every indexed gitlink with the root .gitmodules file", () => {
    const gitlinkPaths = gitOutput(["ls-files", "--stage"])
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.split("\t", 2)[1])
      .filter((path): path is string => path !== undefined)
      .toSorted();
    const mappedPaths = NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, ".gitmodules"))
      ? gitOutput(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"])
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => line.slice(line.indexOf(" ") + 1))
          .toSorted()
      : [];

    expect(mappedPaths).toEqual(gitlinkPaths);
  });

  it("passes recursive Git submodule validation", () => {
    const result = NodeChildProcess.spawnSync("git", ["submodule", "status", "--recursive"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
