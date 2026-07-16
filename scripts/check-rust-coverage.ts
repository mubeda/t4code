#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This repository-level coverage gate shells out to Cargo tooling directly.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const RUST_COVERAGE_ARGS = [
  "llvm-cov",
  "--workspace",
  "--all-targets",
  "--include-build-script",
  "--fail-under-lines",
  "85",
  "--fail-under-functions",
  "85",
  "--fail-under-regions",
  "85",
  "--jobs",
  "1",
] as const;

export interface RustCoverageCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface SpawnSyncResultLike {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

export type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: NodeChildProcess.SpawnSyncOptions,
) => SpawnSyncResultLike;

export function buildRustCoverageCommand(
  options: {
    readonly platform?: NodeJS.Platform | undefined;
    readonly repoRoot?: string | undefined;
  } = {},
): RustCoverageCommand {
  // oxlint-disable-next-line t4code/no-global-process-runtime -- Standalone coverage gate targets the actual host platform when no explicit platform override is supplied.
  const platform = options.platform ?? process.platform;
  const repoRoot = options.repoRoot ?? REPOSITORY_ROOT;

  if (platform === "win32") {
    return {
      command: process.execPath,
      args: [
        NodePath.join(repoRoot, "scripts", "run-msvc-x64.mjs"),
        "cargo",
        ...RUST_COVERAGE_ARGS,
      ],
      cwd: repoRoot,
    };
  }

  return {
    command: "cargo",
    args: [...RUST_COVERAGE_ARGS],
    cwd: repoRoot,
  };
}

export function runRustCoverageCheck(
  options: {
    readonly platform?: NodeJS.Platform | undefined;
    readonly repoRoot?: string | undefined;
    readonly spawnSync?: SpawnSyncLike | undefined;
  } = {},
): number {
  const command = buildRustCoverageCommand(options);
  const spawnSync: SpawnSyncLike = options.spawnSync ?? NodeChildProcess.spawnSync;
  const result = spawnSync(command.command, [...command.args], {
    cwd: command.cwd,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw new Error(`Failed to start Rust coverage command "${command.command}".`, {
      cause: result.error,
    });
  }

  return result.status ?? 1;
}

if (import.meta.main) {
  process.exit(runRustCoverageCheck());
}
