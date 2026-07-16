// @effect-diagnostics nodeBuiltinImport:off - Repository identity guard scans Git-owned files directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const SELF = "scripts/t4code-identity.test.ts";
const TEXT_EXTENSIONS = new Set([
  "",
  ".css",
  ".csv",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const removedIdentityPatterns = [
  new RegExp(["t", "3", "code"].join(""), "i"),
  new RegExp(["t", "3", "\\s+code"].join(""), "i"),
  new RegExp(["@t", "3", "tools"].join(""), "i"),
  new RegExp(["t", "3", "tools"].join(""), "i"),
  new RegExp(["(?<![A-Za-z0-9])t", "3", "(?![A-Za-z0-9])"].join(""), "i"),
  new RegExp(["t", "3", "_"].join(""), "i"),
  new RegExp(["t", "3", "env"].join(""), "i"),
  new RegExp(["urn:t", "3"].join(""), "i"),
  new RegExp(["%3At", "3", "%3A"].join(""), "i"),
];

function projectFiles(): string[] {
  return NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((path) => path !== SELF)
    .filter((path) => !path.startsWith(".repos/"))
    .filter((path) => !path.startsWith(".tmp/"))
    .filter((path) => {
      const absolutePath = NodePath.join(REPOSITORY_ROOT, path);
      return NodeFS.existsSync(absolutePath) && NodeFS.statSync(absolutePath).isFile();
    });
}

function firstMatch(value: string): string | null {
  return removedIdentityPatterns.find((pattern) => pattern.test(value))?.source ?? null;
}

describe("T4Code identity", () => {
  it("contains no removed T3 identity in project-owned paths or text", () => {
    const findings: string[] = [];
    for (const path of projectFiles()) {
      const normalizedPath = path.replaceAll("\\", "/");
      const pathMatch = firstMatch(normalizedPath);
      if (pathMatch) {
        findings.push(`${normalizedPath}: path matches /${pathMatch}/i`);
      }

      const extension = NodePath.extname(path).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const absolutePath = NodePath.join(REPOSITORY_ROOT, path);
      const content = NodeFS.readFileSync(absolutePath, "utf8");
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        const contentMatch = firstMatch(line);
        if (contentMatch) {
          findings.push(`${normalizedPath}:${String(index + 1)} matches /${contentMatch}/i`);
        }
      }
    }

    expect(findings, findings.slice(0, 200).join("\n")).toEqual([]);
  });
});
