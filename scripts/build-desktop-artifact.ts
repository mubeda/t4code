#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t4code/shared/hostProcess";
import { resolveSpawnCommand } from "@t4code/shared/shell";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeUtil from "node:util";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { getDefaultBuildArch, type BuildArch } from "./lib/build-target-arch.ts";

export type TauriBuildPlatform = "mac" | "linux" | "win";
export type TauriBuildArch = Exclude<BuildArch, "universal">;

interface TauriPlatformConfig {
  readonly hostPlatform: NodeJS.Platform;
  readonly defaultTarget: string;
  readonly allowedTargets: ReadonlyArray<string>;
  readonly archChoices: ReadonlyArray<TauriBuildArch>;
}

export const TAURI_PLATFORM_CONFIG: Record<TauriBuildPlatform, TauriPlatformConfig> = {
  mac: {
    hostPlatform: "darwin",
    defaultTarget: "dmg",
    allowedTargets: ["app", "dmg"],
    archChoices: ["arm64", "x64"],
  },
  linux: {
    hostPlatform: "linux",
    defaultTarget: "appimage",
    allowedTargets: ["appimage", "deb", "rpm"],
    archChoices: ["x64", "arm64"],
  },
  win: {
    hostPlatform: "win32",
    defaultTarget: "nsis",
    allowedTargets: ["nsis", "msi"],
    archChoices: ["x64", "arm64"],
  },
};

export interface TauriBuildCliInput {
  readonly platform?: string;
  readonly target?: string;
  readonly arch?: string;
  readonly outputDir?: string;
  readonly skipBuild?: boolean;
  readonly verbose?: boolean;
  readonly allowCrossPlatform?: boolean;
}

export interface TauriBuildHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface SpawnPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface TauriBuildPlan {
  readonly platform: TauriBuildPlatform;
  readonly target: string;
  readonly bundleDirectoryName: string;
  readonly arch: TauriBuildArch;
  readonly rustTarget: string;
  readonly outputDir: string;
  readonly bundleDir: string;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
  readonly buildCommand: SpawnPlan;
}

interface MutableTauriBuildCliInput {
  platform?: string;
  target?: string;
  arch?: string;
  outputDir?: string;
  skipBuild?: boolean;
  verbose?: boolean;
  allowCrossPlatform?: boolean;
}

export class TauriDesktopBuildConfigurationError extends Error {
  override readonly name = "TauriDesktopBuildConfigurationError";
}

export class TauriDesktopBuildHostMismatchError extends Error {
  override readonly name = "TauriDesktopBuildHostMismatchError";
  readonly platform: TauriBuildPlatform;
  readonly hostPlatform: NodeJS.Platform;

  constructor(platform: TauriBuildPlatform, hostPlatform: NodeJS.Platform) {
    super(
      `Tauri ${platform} artifacts require a ${TAURI_PLATFORM_CONFIG[platform].hostPlatform} host. Current host is ${hostPlatform}.`,
    );
    this.platform = platform;
    this.hostPlatform = hostPlatform;
  }
}

export class TauriDesktopBuildDirectoryMissingError extends Error {
  override readonly name = "TauriDesktopBuildDirectoryMissingError";
  readonly bundleDir: string;

  constructor(bundleDir: string) {
    super(`Tauri build completed but no bundle directory was found at ${bundleDir}.`);
    this.bundleDir = bundleDir;
  }
}

export class TauriDesktopBuildNoArtifactsProducedError extends Error {
  override readonly name = "TauriDesktopBuildNoArtifactsProducedError";
  readonly bundleDir: string;

  constructor(bundleDir: string) {
    super(`Tauri build completed but no artifacts were produced in ${bundleDir}.`);
    this.bundleDir = bundleDir;
  }
}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

function compactEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function envBoolean(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean | undefined {
  const value = env[key]?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new TauriDesktopBuildConfigurationError(`${key} must be true/false or 1/0.`);
}

export function detectHostTauriBuildPlatform(
  hostPlatform: NodeJS.Platform,
): TauriBuildPlatform | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function parseTauriBuildPlatform(value: string | undefined): TauriBuildPlatform | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "mac" || normalized === "linux" || normalized === "win") return normalized;
  throw new TauriDesktopBuildConfigurationError(
    `Unsupported Tauri platform '${value}'. Expected mac, linux, or win.`,
  );
}

function parseTauriBuildArch(value: string | undefined): TauriBuildArch | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "arm64" || normalized === "x64") return normalized;
  throw new TauriDesktopBuildConfigurationError(
    `Unsupported Tauri arch '${value}'. Expected arm64 or x64.`,
  );
}

function normalizeTauriBundleTarget(platform: TauriBuildPlatform, target: string): string {
  const normalized = target.trim().toLowerCase();
  const config = TAURI_PLATFORM_CONFIG[platform];
  if (!config.allowedTargets.some((allowedTarget) => allowedTarget === normalized)) {
    throw new TauriDesktopBuildConfigurationError(
      `Unsupported Tauri ${platform} target '${target}'. Expected one of: ${config.allowedTargets.join(", ")}.`,
    );
  }
  return normalized;
}

export function resolveTauriRustTarget(platform: TauriBuildPlatform, arch: TauriBuildArch): string {
  if (platform === "mac") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

function withHostRuntime(host: TauriBuildHost, env: Readonly<Record<string, string | undefined>>) {
  return Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, host.platform),
      Layer.succeed(HostProcessArchitecture, host.arch),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) })),
    ),
  );
}

const resolveDefaultArch = Effect.fn("resolveDefaultTauriArch")(function* (
  platform: TauriBuildPlatform,
  host: TauriBuildHost,
  env: Readonly<Record<string, string | undefined>>,
) {
  const arch = yield* getDefaultBuildArch(platform, TAURI_PLATFORM_CONFIG[platform]).pipe(
    withHostRuntime(host, env),
  );
  const parsedArch = parseTauriBuildArch(arch);
  if (!parsedArch) {
    return yield* Effect.fail(
      new TauriDesktopBuildConfigurationError("Could not resolve a default Tauri build arch."),
    );
  }
  return parsedArch;
});

export const resolveTauriBuildPlan = Effect.fn("resolveTauriBuildPlan")(function* (
  input: TauriBuildCliInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  hostInput?: TauriBuildHost,
  repoRootInput?: string,
) {
  const path = yield* Path.Path;
  const repoRoot = repoRootInput ?? (yield* RepoRoot);
  const host = hostInput ?? {
    platform: yield* HostProcessPlatform,
    arch: yield* HostProcessArchitecture,
  };
  const platform =
    parseTauriBuildPlatform(input.platform ?? env.T4CODE_TAURI_DESKTOP_PLATFORM) ??
    detectHostTauriBuildPlatform(host.platform);
  if (!platform) {
    return yield* Effect.fail(
      new TauriDesktopBuildConfigurationError(
        `Unsupported host platform '${host.platform}'. Pass --platform on a supported host.`,
      ),
    );
  }

  const arch =
    parseTauriBuildArch(input.arch ?? env.T4CODE_TAURI_DESKTOP_ARCH) ??
    (yield* resolveDefaultArch(platform, host, env));
  const target = normalizeTauriBundleTarget(
    platform,
    input.target ??
      env.T4CODE_TAURI_DESKTOP_TARGET ??
      TAURI_PLATFORM_CONFIG[platform].defaultTarget,
  );
  const allowCrossPlatform =
    input.allowCrossPlatform ??
    envBoolean(env, "T4CODE_TAURI_DESKTOP_ALLOW_CROSS_PLATFORM") ??
    false;
  if (!allowCrossPlatform && host.platform !== TAURI_PLATFORM_CONFIG[platform].hostPlatform) {
    return yield* Effect.fail(new TauriDesktopBuildHostMismatchError(platform, host.platform));
  }

  const rustTarget = resolveTauriRustTarget(platform, arch);
  const outputDir = path.resolve(
    repoRoot,
    input.outputDir ??
      env.T4CODE_TAURI_DESKTOP_OUTPUT_DIR ??
      path.join("release", "desktop", `${platform}-${arch}`),
  );
  const bundleDirectoryName = target === "app" ? "macos" : target;
  const bundleDir = path.join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    rustTarget,
    "release",
    "bundle",
    bundleDirectoryName,
  );

  return {
    platform,
    target,
    bundleDirectoryName,
    arch,
    rustTarget,
    outputDir,
    bundleDir,
    skipBuild: input.skipBuild ?? envBoolean(env, "T4CODE_TAURI_DESKTOP_SKIP_BUILD") ?? false,
    verbose: input.verbose ?? envBoolean(env, "T4CODE_TAURI_DESKTOP_VERBOSE") ?? false,
    buildCommand: {
      command: "vp",
      args: [
        "run",
        "--filter",
        "@t4code/desktop",
        "build",
        "--bundles",
        target,
        "--target",
        rustTarget,
      ],
      cwd: repoRoot,
    },
  };
});

export function parseTauriArtifactCliArgs(argv: ReadonlyArray<string>): TauriBuildCliInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      platform: { type: "string" },
      target: { type: "string" },
      arch: { type: "string" },
      "output-dir": { type: "string" },
      "skip-build": { type: "boolean" },
      verbose: { type: "boolean" },
      "allow-cross-platform": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const input: MutableTauriBuildCliInput = {};
  if (typeof values.platform === "string") input.platform = values.platform;
  if (typeof values.target === "string") input.target = values.target;
  if (typeof values.arch === "string") input.arch = values.arch;
  if (typeof values["output-dir"] === "string") input.outputDir = values["output-dir"];
  if (typeof values["skip-build"] === "boolean") input.skipBuild = values["skip-build"];
  if (typeof values.verbose === "boolean") input.verbose = values.verbose;
  if (typeof values["allow-cross-platform"] === "boolean") {
    input.allowCrossPlatform = values["allow-cross-platform"];
  }
  return input;
}

const runSpawnPlan = Effect.fn("runTauriSpawnPlan")(function* (
  plan: SpawnPlan,
  env: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(plan.command, plan.args, { env });
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: plan.cwd,
      env,
      shell: spawnCommand.shell,
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new TauriDesktopBuildConfigurationError(`Tauri build command exited with code ${exitCode}.`),
    );
  }
});

export const copyTauriBundleArtifacts = Effect.fn("copyTauriBundleArtifacts")(function* (
  plan: Pick<TauriBuildPlan, "bundleDir" | "outputDir">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundleExists = yield* fs.exists(plan.bundleDir);
  if (!bundleExists) {
    return yield* Effect.fail(new TauriDesktopBuildDirectoryMissingError(plan.bundleDir));
  }

  const entries = yield* fs.readDirectory(plan.bundleDir);
  if (entries.length === 0) {
    return yield* Effect.fail(new TauriDesktopBuildNoArtifactsProducedError(plan.bundleDir));
  }

  yield* fs.makeDirectory(plan.outputDir, { recursive: true });
  const copiedArtifacts: Array<string> = [];
  for (const entry of entries) {
    const from = path.join(plan.bundleDir, entry);
    const to = path.join(plan.outputDir, entry);
    yield* fs.remove(to, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fs.copy(from, to);
    copiedArtifacts.push(to);
  }

  return copiedArtifacts;
});

export const buildTauriDesktopArtifact = Effect.fn("buildTauriDesktopArtifact")(function* (
  input: TauriBuildCliInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const plan = yield* resolveTauriBuildPlan(input, env);
  if (!plan.skipBuild) {
    process.stdout.write(
      `[desktop-artifact] Building ${plan.platform}/${plan.target} (${plan.arch}, ${plan.rustTarget})...\n`,
    );
    yield* runSpawnPlan(plan.buildCommand, env);
  }

  const artifacts = yield* copyTauriBundleArtifacts(plan);
  process.stdout.write(`[desktop-artifact] Artifacts copied to ${plan.outputDir}\n`);
  if (plan.verbose) {
    for (const artifact of artifacts) {
      process.stdout.write(` - ${artifact}\n`);
    }
  }
  return artifacts;
});

const cliRuntimeLayer = Layer.mergeAll(NodeServices.layer);

if (import.meta.main) {
  buildTauriDesktopArtifact(parseTauriArtifactCliArgs(process.argv.slice(2))).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
