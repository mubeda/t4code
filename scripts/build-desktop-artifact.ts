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
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
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

export class TauriDesktopBuildUnsafePathError extends Error {
  override readonly name = "TauriDesktopBuildUnsafePathError";
  readonly bundleDir: string;
  readonly outputDir: string;

  constructor(bundleDir: string, outputDir: string) {
    super(
      `Tauri bundle source and artifact output must be separate, non-overlapping directories: ${bundleDir} -> ${outputDir}.`,
    );
    this.bundleDir = bundleDir;
    this.outputDir = outputDir;
  }
}

export interface TauriDesktopBuildRollbackFailure {
  readonly operation:
    | "inspect-output"
    | "quarantine-output"
    | "remove-output"
    | "restore-output"
    | "remove-staging"
    | "cleanup-backup";
  readonly path: string;
  readonly cause: unknown;
}

export interface TauriDesktopBuildRecoveryPath {
  readonly kind: "backup" | "quarantine" | "staging";
  readonly path: string;
}

export class TauriDesktopBuildPublicationError extends Error {
  override readonly name = "TauriDesktopBuildPublicationError";
  readonly operation: "copy" | "validate-staging" | "swap";
  readonly outputDir: string;
  override readonly cause: unknown;
  readonly rollbackFailures: Array<TauriDesktopBuildRollbackFailure>;
  readonly recoveryPaths: Array<TauriDesktopBuildRecoveryPath>;

  constructor(
    operation: "copy" | "validate-staging" | "swap",
    outputDir: string,
    cause: unknown,
    rollbackFailures: Array<TauriDesktopBuildRollbackFailure>,
    recoveryPaths: Array<TauriDesktopBuildRecoveryPath>,
  ) {
    const baseMessage = `Failed to ${operation.replace("-", " ")} Tauri artifacts at ${outputDir}.`;
    super(baseMessage);
    this.operation = operation;
    this.outputDir = outputDir;
    this.cause = cause;
    this.rollbackFailures = rollbackFailures;
    this.recoveryPaths = recoveryPaths;
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: false,
      get: () =>
        this.recoveryPaths.length === 0
          ? baseMessage
          : `${baseMessage} Recovery artifacts retained at: ${this.recoveryPaths
              .map((recovery) => `${recovery.kind}=${recovery.path}`)
              .join(", ")}.`,
    });
  }
}

export interface TauriArtifactPublicationOptions {
  readonly transactionId?: (() => string) | undefined;
  readonly ownershipToken?: (() => string) | undefined;
  readonly copy?: FileSystem.FileSystem["copy"] | undefined;
  readonly exists?: FileSystem.FileSystem["exists"] | undefined;
  readonly makeDirectory?: FileSystem.FileSystem["makeDirectory"] | undefined;
  readonly move?: FileSystem.FileSystem["rename"] | undefined;
  readonly readFileString?: FileSystem.FileSystem["readFileString"] | undefined;
  readonly readDirectory?: FileSystem.FileSystem["readDirectory"] | undefined;
  readonly realPath?: FileSystem.FileSystem["realPath"] | undefined;
  readonly remove?: FileSystem.FileSystem["remove"] | undefined;
  readonly stat?: FileSystem.FileSystem["stat"] | undefined;
  readonly stream?: FileSystem.FileSystem["stream"] | undefined;
  readonly writeFileString?: FileSystem.FileSystem["writeFileString"] | undefined;
}

const TAURI_ARTIFACT_OWNER_FILE = ".t4code-publication-owner";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

const tryBuildConfiguration = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => cause as TauriDesktopBuildConfigurationError,
  });

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
  const parsedArch = yield* tryBuildConfiguration(() => parseTauriBuildArch(arch));
  return parsedArch as TauriBuildArch;
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
    (yield* tryBuildConfiguration(() =>
      parseTauriBuildPlatform(input.platform ?? env.T4CODE_TAURI_DESKTOP_PLATFORM),
    )) ?? detectHostTauriBuildPlatform(host.platform);
  if (!platform) {
    return yield* Effect.fail(
      new TauriDesktopBuildConfigurationError(
        `Unsupported host platform '${host.platform}'. Pass --platform on a supported host.`,
      ),
    );
  }

  const arch =
    (yield* tryBuildConfiguration(() =>
      parseTauriBuildArch(input.arch ?? env.T4CODE_TAURI_DESKTOP_ARCH),
    )) ?? (yield* resolveDefaultArch(platform, host, env));
  const target = yield* tryBuildConfiguration(() =>
    normalizeTauriBundleTarget(
      platform,
      input.target ??
        env.T4CODE_TAURI_DESKTOP_TARGET ??
        TAURI_PLATFORM_CONFIG[platform].defaultTarget,
    ),
  );
  const allowCrossPlatform =
    input.allowCrossPlatform ??
    (yield* tryBuildConfiguration(() =>
      envBoolean(env, "T4CODE_TAURI_DESKTOP_ALLOW_CROSS_PLATFORM"),
    )) ??
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
    skipBuild:
      input.skipBuild ??
      (yield* tryBuildConfiguration(() => envBoolean(env, "T4CODE_TAURI_DESKTOP_SKIP_BUILD"))) ??
      false,
    verbose:
      input.verbose ??
      (yield* tryBuildConfiguration(() => envBoolean(env, "T4CODE_TAURI_DESKTOP_VERBOSE"))) ??
      false,
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

interface ArtifactManifestEntry {
  readonly checksum: string;
  readonly path: string;
  readonly type: string;
  readonly size: number;
}

const pathContains = (path: Path.Path, parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !relative.startsWith("..\\") &&
      !path.isAbsolute(relative))
  );
};

const collectArtifactManifest = (
  root: string,
  readDirectory: FileSystem.FileSystem["readDirectory"],
  stat: FileSystem.FileSystem["stat"],
  stream: FileSystem.FileSystem["stream"],
  path: Path.Path,
): Effect.Effect<ReadonlyArray<ArtifactManifestEntry>, PlatformError.PlatformError> => {
  const visit = (
    relativeDir: string,
  ): Effect.Effect<Array<ArtifactManifestEntry>, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const directory = relativeDir === "" ? root : path.join(root, relativeDir);
      const entries = (yield* readDirectory(directory)).toSorted();
      const manifest: Array<ArtifactManifestEntry> = [];
      for (const entry of entries) {
        const relativePath = relativeDir === "" ? entry : path.join(relativeDir, entry);
        const info = yield* stat(path.join(root, relativePath));
        const checksum =
          info.type === "File"
            ? yield* stream(path.join(root, relativePath)).pipe(
                Stream.runFold(
                  () => NodeCrypto.createHash("sha256"),
                  (hash, chunk) => hash.update(chunk),
                ),
                Effect.map((hash) => hash.digest("hex")),
              )
            : "";
        manifest.push({
          checksum,
          path: relativePath,
          type: info.type,
          size: info.type === "File" ? Number(info.size) : 0,
        });
        if (info.type === "Directory") {
          manifest.push(...(yield* visit(relativePath)));
        }
      }
      return manifest;
    });
  return visit("");
};

const manifestsMatch = (
  source: ReadonlyArray<ArtifactManifestEntry>,
  staged: ReadonlyArray<ArtifactManifestEntry>,
): boolean =>
  source.length === staged.length &&
  source.every((entry, index) => {
    const other = staged[index];
    return (
      other?.path === entry.path &&
      other.type === entry.type &&
      other.size === entry.size &&
      other.checksum === entry.checksum
    );
  });

export const copyTauriBundleArtifacts = Effect.fn("copyTauriBundleArtifacts")(function* (
  plan: Pick<TauriBuildPlan, "bundleDir" | "outputDir">,
  options: TauriArtifactPublicationOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const copy = options.copy ?? fs.copy;
  const exists = options.exists ?? fs.exists;
  const makeDirectory = options.makeDirectory ?? fs.makeDirectory;
  const move = options.move ?? fs.rename;
  const readFileString = options.readFileString ?? fs.readFileString;
  const readDirectory = options.readDirectory ?? fs.readDirectory;
  const realPath = options.realPath ?? fs.realPath;
  const remove = options.remove ?? fs.remove;
  const stat = options.stat ?? fs.stat;
  const stream = options.stream ?? fs.stream;
  const writeFileString = options.writeFileString ?? fs.writeFileString;
  const bundleDir = path.resolve(plan.bundleDir);
  const outputDir = path.resolve(plan.outputDir);
  const bundleExists = yield* exists(bundleDir);
  if (!bundleExists) {
    return yield* Effect.fail(new TauriDesktopBuildDirectoryMissingError(bundleDir));
  }

  const outputExists = yield* exists(outputDir);
  const canonicalBundleDir = yield* realPath(bundleDir);
  const canonicalOutputDir = outputExists ? yield* realPath(outputDir) : outputDir;
  if (
    pathContains(path, canonicalBundleDir, canonicalOutputDir) ||
    pathContains(path, canonicalOutputDir, canonicalBundleDir)
  ) {
    return yield* Effect.fail(new TauriDesktopBuildUnsafePathError(bundleDir, outputDir));
  }

  const entries = (yield* readDirectory(bundleDir)).toSorted();
  if (entries.length === 0) {
    return yield* Effect.fail(new TauriDesktopBuildNoArtifactsProducedError(bundleDir));
  }

  const transactionId = options.transactionId?.() ?? NodeCrypto.randomUUID();
  const ownershipToken = options.ownershipToken?.() ?? NodeCrypto.randomUUID();
  const outputParent = path.dirname(outputDir);
  const outputName = path.basename(outputDir);
  const stagingDir = path.join(outputParent, `.${outputName}.t4code-${transactionId}.stage`);
  const backupDir = path.join(outputParent, `.${outputName}.t4code-${transactionId}.backup`);
  const quarantineDir = path.join(
    outputParent,
    `.${outputName}.t4code-${transactionId}.quarantine`,
  );
  const ownerMarker = (directory: string) => path.join(directory, TAURI_ARTIFACT_OWNER_FILE);
  const rollbackFailures: Array<TauriDesktopBuildRollbackFailure> = [];
  const recoveryPaths: Array<TauriDesktopBuildRecoveryPath> = [];
  const state = {
    committed: false,
    stagingAttempted: false,
    backupReady: false,
    replacementAttempted: false,
  };

  const recordCleanup = (
    operation: TauriDesktopBuildRollbackFailure["operation"],
    target: string,
    effect: Effect.Effect<void, PlatformError.PlatformError>,
  ) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          rollbackFailures.push({ operation, path: target, cause });
        }),
      ),
    );

  const isOwnedQuarantine = readFileString(ownerMarker(quarantineDir)).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: (owner) => owner === ownershipToken,
    }),
  );

  const reportRecoveryPath = (kind: TauriDesktopBuildRecoveryPath["kind"], target: string) =>
    exists(target).pipe(
      Effect.match({
        onFailure: () => true,
        onSuccess: (present) => present,
      }),
      Effect.tap((present) =>
        Effect.sync(() => {
          if (present && !recoveryPaths.some((recovery) => recovery.path === target)) {
            recoveryPaths.push({ kind, path: target });
          }
        }),
      ),
      Effect.asVoid,
    );

  const auditRecoveryPaths = Effect.gen(function* () {
    yield* reportRecoveryPath("backup", backupDir);
    yield* reportRecoveryPath("quarantine", quarantineDir);
    yield* reportRecoveryPath("staging", stagingDir);
  });

  const inspectOutput = (assumePresent: boolean) =>
    exists(outputDir).pipe(
      Effect.match({
        onFailure: (cause) => {
          rollbackFailures.push({ operation: "inspect-output", path: outputDir, cause });
          return assumePresent;
        },
        onSuccess: (present) => present,
      }),
    );

  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* makeDirectory(outputParent, { recursive: true });
        yield* makeDirectory(stagingDir).pipe(
          Effect.mapError(
            (cause) =>
              new TauriDesktopBuildPublicationError(
                "copy",
                outputDir,
                cause,
                rollbackFailures,
                recoveryPaths,
              ),
          ),
        );
        state.stagingAttempted = true;

        for (const entry of entries) {
          yield* copy(path.join(bundleDir, entry), path.join(stagingDir, entry)).pipe(
            Effect.mapError(
              (cause) =>
                new TauriDesktopBuildPublicationError(
                  "copy",
                  outputDir,
                  cause,
                  rollbackFailures,
                  recoveryPaths,
                ),
            ),
          );
        }

        const sourceManifest = yield* collectArtifactManifest(
          bundleDir,
          readDirectory,
          stat,
          stream,
          path,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TauriDesktopBuildPublicationError(
                "validate-staging",
                outputDir,
                cause,
                rollbackFailures,
                recoveryPaths,
              ),
          ),
        );
        const stagedManifest = yield* collectArtifactManifest(
          stagingDir,
          readDirectory,
          stat,
          stream,
          path,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TauriDesktopBuildPublicationError(
                "validate-staging",
                outputDir,
                cause,
                rollbackFailures,
                recoveryPaths,
              ),
          ),
        );
        if (!manifestsMatch(sourceManifest, stagedManifest)) {
          return yield* Effect.fail(
            new TauriDesktopBuildPublicationError(
              "validate-staging",
              outputDir,
              new Error("Staged artifact manifest does not match the source bundle."),
              rollbackFailures,
              recoveryPaths,
            ),
          );
        }

        yield* writeFileString(ownerMarker(stagingDir), ownershipToken).pipe(
          Effect.mapError(
            (cause) =>
              new TauriDesktopBuildPublicationError(
                "swap",
                outputDir,
                cause,
                rollbackFailures,
                recoveryPaths,
              ),
          ),
        );

        if (outputExists) {
          yield* move(outputDir, backupDir).pipe(
            Effect.mapError(
              (cause) =>
                new TauriDesktopBuildPublicationError(
                  "swap",
                  outputDir,
                  cause,
                  rollbackFailures,
                  recoveryPaths,
                ),
            ),
          );
          state.backupReady = true;
        }
        state.replacementAttempted = true;
        yield* move(stagingDir, outputDir).pipe(
          Effect.mapError(
            (cause) =>
              new TauriDesktopBuildPublicationError(
                "swap",
                outputDir,
                cause,
                rollbackFailures,
                recoveryPaths,
              ),
          ),
        );
        state.stagingAttempted = false;
        state.committed = true;
        return entries.map((entry) => path.join(outputDir, entry));
      }),
    () =>
      Effect.gen(function* () {
        let committedBackupCleanupFailure: { readonly cause: unknown } | undefined;
        if (!state.committed && state.replacementAttempted) {
          if (yield* inspectOutput(false)) {
            const quarantineSucceeded = yield* move(outputDir, quarantineDir).pipe(
              Effect.match({
                onFailure: (cause) => {
                  rollbackFailures.push({
                    operation: "quarantine-output",
                    path: outputDir,
                    cause,
                  });
                  return false;
                },
                onSuccess: () => true,
              }),
            );
            if (quarantineSucceeded) {
              if (yield* isOwnedQuarantine) {
                yield* recordCleanup(
                  "remove-output",
                  quarantineDir,
                  remove(quarantineDir, { recursive: true, force: true }),
                );
              } else if (!(yield* inspectOutput(true))) {
                yield* recordCleanup("restore-output", outputDir, move(quarantineDir, outputDir));
              }
            }
          }
          if (state.backupReady && !(yield* inspectOutput(true))) {
            yield* move(backupDir, outputDir).pipe(
              Effect.match({
                onFailure: (cause) => {
                  rollbackFailures.push({
                    operation: "restore-output",
                    path: outputDir,
                    cause,
                  });
                },
                onSuccess: () => {
                  state.backupReady = false;
                },
              }),
            );
          }
        }
        if (state.stagingAttempted) {
          yield* recordCleanup(
            "remove-staging",
            stagingDir,
            remove(stagingDir, { recursive: true, force: true }),
          );
        }
        if (state.backupReady && state.committed) {
          yield* remove(backupDir, { recursive: true, force: true }).pipe(
            Effect.match({
              onFailure: (cause) => {
                rollbackFailures.push({ operation: "cleanup-backup", path: backupDir, cause });
                committedBackupCleanupFailure = { cause };
              },
              onSuccess: () => {
                state.backupReady = false;
              },
            }),
          );
        }
        if (committedBackupCleanupFailure) {
          return yield* Effect.fail(
            new TauriDesktopBuildPublicationError(
              "swap",
              outputDir,
              committedBackupCleanupFailure.cause,
              rollbackFailures,
              recoveryPaths,
            ),
          );
        }
      }).pipe(Effect.ensuring(auditRecoveryPaths)),
  );
});

export const buildTauriDesktopArtifact = Effect.fn("buildTauriDesktopArtifact")(function* (
  input: TauriBuildCliInput,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly write?: (text: string) => void;
    readonly host?: TauriBuildHost;
    readonly repoRoot?: string;
  } = {},
) {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const plan = yield* resolveTauriBuildPlan(input, env, options.host, options.repoRoot);
  if (!plan.skipBuild) {
    write(
      `[desktop-artifact] Building ${plan.platform}/${plan.target} (${plan.arch}, ${plan.rustTarget})...\n`,
    );
    yield* runSpawnPlan(plan.buildCommand, env);
  }

  const artifacts = yield* copyTauriBundleArtifacts(plan);
  write(`[desktop-artifact] Artifacts copied to ${plan.outputDir}\n`);
  if (plan.verbose) {
    for (const artifact of artifacts) {
      write(` - ${artifact}\n`);
    }
  }
  return artifacts;
});

const cliRuntimeLayer = Layer.mergeAll(NodeServices.layer);

type MainLauncher = <E, A>(effect: Effect.Effect<A, E, never>) => void;

export function runBuildTauriDesktopArtifactMain(
  isMain: boolean,
  argv: ReadonlyArray<string> = process.argv.slice(2),
  launch: MainLauncher = NodeRuntime.runMain,
): boolean {
  if (!isMain) return false;
  launch(
    buildTauriDesktopArtifact(parseTauriArtifactCliArgs(argv)).pipe(
      Effect.scoped,
      Effect.provide(cliRuntimeLayer),
    ),
  );
  return true;
}

runBuildTauriDesktopArtifactMain(import.meta.main);
