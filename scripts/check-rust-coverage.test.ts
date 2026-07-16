// @effect-diagnostics nodeBuiltinImport:off - Coverage runner tests inspect the tooling script on disk and stub process execution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const SCRIPT_PATH = NodePath.join(REPOSITORY_ROOT, "scripts", "check-rust-coverage.ts");

async function importModule() {
  return import("./check-rust-coverage.ts");
}

function spawnResult(status: number | null) {
  return {
    status,
  };
}

describe("Rust coverage runner", () => {
  it("exists as repository tooling", () => {
    expect(NodeFS.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("constructs the enforced cargo-llvm-cov command on non-Windows hosts", async () => {
    const { buildRustCoverageCommand } = await importModule();

    expect(
      buildRustCoverageCommand({
        platform: "linux",
        repoRoot: "/repo",
      }),
    ).toEqual({
      command: "cargo",
      args: [
        "llvm-cov",
        "--workspace",
        "--all-targets",
        "--include-build-script",
        "--fail-under-lines",
        "74",
        "--fail-under-functions",
        "74",
        "--fail-under-regions",
        "74",
        "--jobs",
        "1",
      ],
      cwd: "/repo",
    });
  });

  it("routes Windows coverage through the MSVC bootstrap helper", async () => {
    const { buildRustCoverageCommand } = await importModule();

    expect(
      buildRustCoverageCommand({
        platform: "win32",
        repoRoot: "X:/t4code",
      }),
    ).toEqual({
      command: process.execPath,
      args: [
        NodePath.join("X:/t4code", "scripts", "run-msvc-x64.mjs"),
        "cargo",
        "llvm-cov",
        "--workspace",
        "--all-targets",
        "--include-build-script",
        "--fail-under-lines",
        "74",
        "--fail-under-functions",
        "74",
        "--fail-under-regions",
        "74",
        "--jobs",
        "1",
      ],
      cwd: "X:/t4code",
    });
  });

  it("propagates the underlying process exit code", async () => {
    const { runRustCoverageCheck } = await importModule();

    const exitCode = runRustCoverageCheck({
      platform: "linux",
      repoRoot: "/repo",
      spawnSync: () => spawnResult(7),
    });

    expect(exitCode).toBe(7);
  });

  it("maps null process status to a failing exit code", async () => {
    const { runRustCoverageCheck } = await importModule();

    const exitCode = runRustCoverageCheck({
      platform: "linux",
      repoRoot: "/repo",
      spawnSync: () => spawnResult(null),
    });

    expect(exitCode).toBe(1);
  });

  it("surfaces spawnSync.error when the coverage child cannot start", async () => {
    const { runRustCoverageCheck } = await importModule();
    const spawnError = Object.assign(new Error("spawn cargo ENOENT"), {
      code: "ENOENT",
    });

    expect(() =>
      runRustCoverageCheck({
        platform: "linux",
        repoRoot: "/repo",
        spawnSync: () => ({
          status: null,
          error: spawnError,
        }),
      }),
    ).toThrowError(/Failed to start Rust coverage command "cargo"/);
  });
});
