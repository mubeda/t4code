import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t4code/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import {
  copyTauriBundleArtifacts,
  buildTauriDesktopArtifact,
  detectHostTauriBuildPlatform,
  parseTauriArtifactCliArgs,
  resolveTauriBuildPlan,
  resolveTauriRustTarget,
  runBuildTauriDesktopArtifactMain,
  TauriDesktopBuildConfigurationError,
  TauriDesktopBuildDirectoryMissingError,
  TauriDesktopBuildHostMismatchError,
  TauriDesktopBuildNoArtifactsProducedError,
  TauriDesktopBuildPublicationError,
  TauriDesktopBuildUnsafePathError,
} from "./build-desktop-artifact.ts";

const processHandle = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(7),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("detects the supported Tauri build platform for the host OS", () => {
    assert.equal(detectHostTauriBuildPlatform("darwin"), "mac");
    assert.equal(detectHostTauriBuildPlatform("linux"), "linux");
    assert.equal(detectHostTauriBuildPlatform("win32"), "win");
    assert.equal(detectHostTauriBuildPlatform("freebsd"), undefined);
  });

  it("maps Tauri platform and architecture pairs to Rust target triples", () => {
    assert.equal(resolveTauriRustTarget("mac", "arm64"), "aarch64-apple-darwin");
    assert.equal(resolveTauriRustTarget("mac", "x64"), "x86_64-apple-darwin");
    assert.equal(resolveTauriRustTarget("linux", "arm64"), "aarch64-unknown-linux-gnu");
    assert.equal(resolveTauriRustTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
    assert.equal(resolveTauriRustTarget("win", "arm64"), "aarch64-pc-windows-msvc");
    assert.equal(resolveTauriRustTarget("win", "x64"), "x86_64-pc-windows-msvc");
  });

  it.effect("plans a Windows NSIS build through the canonical desktop package", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve("X:/repo");
      const plan = yield* resolveTauriBuildPlan(
        {
          platform: "win",
          target: "nsis",
          arch: "x64",
          outputDir: "artifacts/tauri-win",
        },
        {},
        { platform: "win32", arch: "x64" },
        repoRoot,
      );

      assert.equal(plan.platform, "win");
      assert.equal(plan.target, "nsis");
      assert.equal(plan.bundleDirectoryName, "nsis");
      assert.equal(plan.arch, "x64");
      assert.equal(plan.rustTarget, "x86_64-pc-windows-msvc");
      assert.equal(plan.outputDir, path.join(repoRoot, "artifacts", "tauri-win"));
      assert.equal(
        plan.bundleDir,
        path.join(repoRoot, "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis"),
      );
      assert.deepStrictEqual(plan.buildCommand, {
        command: "vp",
        cwd: repoRoot,
        args: [
          "run",
          "--filter",
          "@t4code/desktop",
          "build",
          "--bundles",
          "nsis",
          "--target",
          "x86_64-pc-windows-msvc",
        ],
      });
    }),
  );

  it.effect("uses Tauri-specific environment defaults", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve("X:/repo");
      const plan = yield* resolveTauriBuildPlan(
        {},
        {
          T4CODE_TAURI_DESKTOP_PLATFORM: "linux",
          T4CODE_TAURI_DESKTOP_TARGET: "deb",
          T4CODE_TAURI_DESKTOP_ARCH: "arm64",
          T4CODE_TAURI_DESKTOP_OUTPUT_DIR: "release/custom-tauri",
          T4CODE_TAURI_DESKTOP_SKIP_BUILD: "1",
          T4CODE_TAURI_DESKTOP_VERBOSE: "true",
        },
        { platform: "linux", arch: "x64" },
        repoRoot,
      );

      assert.equal(plan.platform, "linux");
      assert.equal(plan.target, "deb");
      assert.equal(plan.arch, "arm64");
      assert.equal(plan.rustTarget, "aarch64-unknown-linux-gnu");
      assert.equal(plan.skipBuild, true);
      assert.equal(plan.verbose, true);
      assert.equal(plan.outputDir, path.join(repoRoot, "release", "custom-tauri"));
    }),
  );

  it.effect("rejects cross-platform builds unless explicitly allowed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const error = yield* resolveTauriBuildPlan(
        { platform: "mac", arch: "arm64" },
        {},
        { platform: "win32", arch: "x64" },
        path.resolve("X:/repo"),
      ).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildHostMismatchError);
    }),
  );

  it("parses CLI flags into a typed Tauri artifact input", () => {
    assert.deepStrictEqual(
      parseTauriArtifactCliArgs([
        "--platform",
        "win",
        "--target",
        "msi",
        "--arch",
        "arm64",
        "--output-dir",
        "release/tauri",
        "--skip-build",
        "--verbose",
        "--allow-cross-platform",
      ]),
      {
        platform: "win",
        target: "msi",
        arch: "arm64",
        outputDir: "release/tauri",
        skipBuild: true,
        verbose: true,
        allowCrossPlatform: true,
      },
    );
    assert.deepStrictEqual(parseTauriArtifactCliArgs([]), {});
  });

  it.effect("resolves repository and architecture defaults from the host", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const plan = yield* resolveTauriBuildPlan(
        { skipBuild: true },
        { UNUSED: undefined, T4CODE_TAURI_DESKTOP_VERBOSE: "no" },
        { platform: "linux", arch: "arm64" },
      );

      assert.equal(plan.platform, "linux");
      assert.equal(plan.arch, "arm64");
      assert.equal(plan.target, "appimage");
      assert.equal(plan.bundleDirectoryName, "appimage");
      assert.equal(plan.verbose, false);
      assert.equal(plan.outputDir, path.join(repoRoot, "release", "desktop", "linux-arm64"));
    }),
  );

  it.effect("uses host services and maps macOS app bundles to the macos directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve("X:/repo");
      const plan = yield* resolveTauriBuildPlan(
        { platform: "mac", target: "app", allowCrossPlatform: true },
        {},
        undefined,
        repoRoot,
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessArchitecture, "x64"),
      );

      assert.equal(plan.arch, "x64");
      assert.equal(plan.bundleDirectoryName, "macos");
      assert.include(plan.bundleDir, path.join("bundle", "macos"));
    }),
  );

  it.effect("copies Tauri bundle outputs into the artifact directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t4-tauri-artifact-",
      });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "out");
      yield* fs.makeDirectory(path.join(bundleDir, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(bundleDir, "installer.exe"), "installer");
      yield* fs.writeFileString(path.join(bundleDir, "nested", "manifest.json"), "{}");

      const artifacts = yield* copyTauriBundleArtifacts({ bundleDir, outputDir });

      assert.deepStrictEqual(
        artifacts.toSorted(),
        [path.join(outputDir, "installer.exe"), path.join(outputDir, "nested")].toSorted(),
      );
      assert.equal(yield* fs.readFileString(path.join(outputDir, "installer.exe")), "installer");
      assert.equal(yield* fs.readFileString(path.join(outputDir, "nested", "manifest.json")), "{}");
    }),
  );

  it.effect("reports a missing Tauri bundle directory with structural context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t4-missing-tauri-bundle-",
      });
      const bundleDir = path.join(tempDir, "missing");
      const error = yield* copyTauriBundleArtifacts({
        bundleDir,
        outputDir: path.join(tempDir, "unused-output"),
      }).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildDirectoryMissingError);
      assert.equal(error.bundleDir, bundleDir);
    }),
  );

  it.effect("rejects empty bundle directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-empty-tauri-bundle-" });
      const bundleDir = path.join(tempDir, "bundle");
      yield* fs.makeDirectory(bundleDir);

      const error = yield* copyTauriBundleArtifacts({
        bundleDir,
        outputDir: path.join(tempDir, "output"),
      }).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildNoArtifactsProducedError);
      assert.equal(error.bundleDir, bundleDir);
    }),
  );

  it.effect("overwrites existing artifact entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-overwrite-tauri-bundle-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");

      yield* copyTauriBundleArtifacts({ bundleDir, outputDir });

      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "new");
    }),
  );

  it.effect("rejects identical and overlapping source/output publication paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-unsafe-publication-" });
      const bundleDir = path.join(tempDir, "bundle");
      yield* fs.makeDirectory(path.join(bundleDir, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "artifact");

      for (const outputDir of [bundleDir, path.join(bundleDir, "nested"), tempDir]) {
        const error = yield* copyTauriBundleArtifacts({ bundleDir, outputDir }).pipe(Effect.flip);
        assert.instanceOf(error, TauriDesktopBuildUnsafePathError);
        assert.equal(error.bundleDir, bundleDir);
        assert.equal(error.outputDir, outputDir);
      }

      assert.equal(yield* fs.readFileString(path.join(bundleDir, "artifact.txt")), "artifact");
    }),
  );

  it.effect("keeps prior output and cleans staging when copying or validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-publication-failures-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");

      const copyCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "copy",
        pathOrDescriptor: bundleDir,
      });
      const copyError = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "copy-failure",
          copy: () => Effect.fail(copyCause),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(copyError, TauriDesktopBuildPublicationError);
      assert.equal(copyError.operation, "copy");
      assert.strictEqual(copyError.cause, copyCause);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "old");
      assert.isFalse(yield* fs.exists(path.join(tempDir, ".output.t4code-copy-failure.stage")));

      const validationError = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "validation-failure",
          stat: (target) =>
            fs
              .stat(target)
              .pipe(
                Effect.map((info) =>
                  target.includes(".t4code-validation-failure.stage") && info.type === "File"
                    ? { ...info, size: FileSystem.Size(Number(info.size) + 1) }
                    : info,
                ),
              ),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(validationError, TauriDesktopBuildPublicationError);
      assert.equal(validationError.operation, "validate-staging");
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "old");
      assert.isFalse(
        yield* fs.exists(path.join(tempDir, ".output.t4code-validation-failure.stage")),
      );

      const checksumError = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "checksum-failure",
          stream: (target, options) =>
            target.includes(".t4code-checksum-failure.stage")
              ? Stream.make(new TextEncoder().encode("bad"))
              : fs.stream(target, options),
        },
      ).pipe(Effect.flip);
      assert.instanceOf(checksumError, TauriDesktopBuildPublicationError);
      assert.equal(checksumError.operation, "validate-staging");
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "old");
      assert.isFalse(yield* fs.exists(path.join(tempDir, ".output.t4code-checksum-failure.stage")));
    }),
  );

  it.effect("rolls back the prior output when the atomic publication swap fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-publication-rollback-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-swap-failure.stage");
      const backupDir = path.join(tempDir, ".output.t4code-swap-failure.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");

      const swapCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: stageDir,
      });
      const moves: string[] = [];
      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "swap-failure",
          move: (source, target) => {
            moves.push(`${source} -> ${target}`);
            return source === stageDir && target === outputDir
              ? Effect.fail(swapCause)
              : fs.rename(source, target);
          },
        },
      ).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildPublicationError);
      assert.equal(error.operation, "swap");
      assert.strictEqual(error.cause, swapCause);
      assert.deepStrictEqual(error.rollbackFailures, []);
      assert.deepStrictEqual(error.recoveryPaths, []);
      assert.notInclude(error.message, "Recovery artifacts retained");
      assert.include(moves, `${outputDir} -> ${backupDir}`);
      assert.include(moves, `${backupDir} -> ${outputDir}`);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "old");
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );

  it.effect("removes a first publication when failure occurs after the output swap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-first-publish-failure-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-first-failure.stage");
      const backupDir = path.join(tempDir, ".output.t4code-first-failure.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "post-swap",
        pathOrDescriptor: outputDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "first-failure",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? fs.rename(source, target).pipe(Effect.flatMap(() => Effect.fail(cause)))
              : fs.rename(source, target),
        },
      ).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildPublicationError);
      assert.isFalse(yield* fs.exists(outputDir));
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );

  it.effect("removes a first publication when interrupted after the output swap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-first-publish-interrupt-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-first-interrupt.stage");
      const backupDir = path.join(tempDir, ".output.t4code-first-interrupt.backup");
      const swapped = yield* Deferred.make<void>();
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");

      const publication = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "first-interrupt",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? fs.rename(source, target).pipe(
                  Effect.tap(() => Deferred.succeed(swapped, undefined)),
                  Effect.andThen(Effect.never),
                )
              : fs.rename(source, target),
        },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(swapped);
      assert.isTrue(yield* fs.exists(outputDir));
      yield* Fiber.interrupt(publication);

      assert.isFalse(yield* fs.exists(outputDir));
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );

  it.effect("does not delete a competitor that replaces output after ownership is read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-owner-read-race-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-owner-read-race.stage");
      const capturedDir = path.join(tempDir, "captured-publication");
      const ownerFile = ".t4code-publication-owner";
      const outputOwner = path.join(outputDir, ownerFile);
      const stageOwner = path.join(stageDir, ownerFile);
      const quarantineOwner = path.join(
        tempDir,
        ".output.t4code-owner-read-race.quarantine",
        ownerFile,
      );
      let ownershipReads = 0;
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const postSwapCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "post-swap",
        pathOrDescriptor: outputDir,
      });

      yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "owner-read-race",
          ownershipToken: () => "ours",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? fs.rename(source, target).pipe(Effect.flatMap(() => Effect.fail(postSwapCause)))
              : fs.rename(source, target),
          readFileString: (target) => {
            const read = fs.readFileString(target);
            if (target !== outputOwner && target !== stageOwner && target !== quarantineOwner)
              return read;
            return read.pipe(
              Effect.flatMap((owner) =>
                Effect.gen(function* () {
                  ownershipReads += 1;
                  if (target === outputOwner) {
                    yield* fs.rename(outputDir, capturedDir);
                  }
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "competitor");
                  yield* fs.writeFileString(path.join(outputDir, ownerFile), "competitor");
                  return owner;
                }),
              ),
            );
          },
        },
      ).pipe(Effect.flip);

      assert.equal(ownershipReads, 1);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "competitor");
      assert.equal(yield* fs.readFileString(path.join(outputDir, ownerFile)), "competitor");
      assert.isFalse(yield* fs.exists(stageDir));
    }),
  );

  it.effect("preserves a competing publication when the output swap loses the race", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-competing-publish-fail-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-race-failure.stage");
      const backupDir = path.join(tempDir, ".output.t4code-race-failure.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const raceCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "race-failure",
          ownershipToken: () => "ours",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? Effect.gen(function* () {
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "competitor");
                  yield* fs.writeFileString(
                    path.join(outputDir, ".t4code-publication-owner"),
                    "competitor",
                  );
                  return yield* raceCause;
                })
              : fs.rename(source, target),
        },
      ).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildPublicationError);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "competitor");
      assert.equal(
        yield* fs.readFileString(path.join(outputDir, ".t4code-publication-owner")),
        "competitor",
      );
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );

  it.effect("preserves a competing publication when its ownership marker is unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-competing-no-owner-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-race-no-owner.stage");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const raceCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });

      yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "race-no-owner",
          ownershipToken: () => "ours",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? Effect.gen(function* () {
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "competitor");
                  return yield* raceCause;
                })
              : fs.rename(source, target),
        },
      ).pipe(Effect.flip);

      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "competitor");
      assert.isFalse(yield* fs.exists(stageDir));
    }),
  );

  it.effect("reports quarantined foreign output when a newer publication appears", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-foreign-quarantine-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-foreign-quarantine.stage");
      const quarantineDir = path.join(tempDir, ".output.t4code-foreign-quarantine.quarantine");
      const ownerFile = ".t4code-publication-owner";
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const raceCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "foreign-quarantine",
          ownershipToken: () => "ours",
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? Effect.gen(function* () {
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "foreign");
                  yield* fs.writeFileString(path.join(outputDir, ownerFile), "foreign");
                  return yield* raceCause;
                })
              : fs.rename(source, target),
          readFileString: (target) =>
            target === path.join(quarantineDir, ownerFile)
              ? fs.readFileString(target).pipe(
                  Effect.flatMap((owner) =>
                    Effect.gen(function* () {
                      yield* fs.makeDirectory(outputDir);
                      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "newer");
                      yield* fs.writeFileString(path.join(outputDir, ownerFile), "newer");
                      return owner;
                    }),
                  ),
                )
              : fs.readFileString(target),
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "newer");
      assert.equal(yield* fs.readFileString(path.join(quarantineDir, "artifact.txt")), "foreign");
      assert.isFalse(yield* fs.exists(stageDir));
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "quarantine", path: quarantineDir }]);
      assert.include(error.message, quarantineDir);
    }),
  );

  it.effect("preserves a competing publication when interrupted during the losing swap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-competing-publish-stop-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-race-interrupt.stage");
      const backupDir = path.join(tempDir, ".output.t4code-race-interrupt.backup");
      const rollbackCheckingOutput = yield* Deferred.make<void>();
      const releaseRollbackCheck = yield* Deferred.make<void>();
      let outputExistsChecks = 0;
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const raceCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });

      const publication = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "race-interrupt",
          ownershipToken: () => "ours",
          exists: (target) => {
            if (target !== outputDir) return fs.exists(target);
            outputExistsChecks += 1;
            return outputExistsChecks === 2
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(rollbackCheckingOutput, undefined);
                  yield* Deferred.await(releaseRollbackCheck);
                  return yield* fs.exists(target);
                })
              : fs.exists(target);
          },
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? Effect.gen(function* () {
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "competitor");
                  yield* fs.writeFileString(
                    path.join(outputDir, ".t4code-publication-owner"),
                    "competitor",
                  );
                  return yield* raceCause;
                })
              : fs.rename(source, target),
        },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(rollbackCheckingOutput);
      const interruption = yield* Fiber.interrupt(publication).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseRollbackCheck, undefined);
      yield* Fiber.join(interruption);

      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "competitor");
      assert.equal(
        yield* fs.readFileString(path.join(outputDir, ".t4code-publication-owner")),
        "competitor",
      );
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );

  it.effect("preserves output across staging, manifest, and backup phase failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const failureCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "publication",
      });

      for (const phase of [
        "stage",
        "source-manifest",
        "staged-manifest",
        "owner-marker",
        "backup",
      ] as const) {
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: `t4-${phase}-failure-` });
        const bundleDir = path.join(tempDir, "bundle");
        const outputDir = path.join(tempDir, "output");
        const stageDir = path.join(tempDir, `.output.t4code-${phase}.stage`);
        yield* fs.makeDirectory(bundleDir);
        yield* fs.makeDirectory(outputDir);
        yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
        yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");
        let bundleReads = 0;

        const error = yield* copyTauriBundleArtifacts(
          { bundleDir, outputDir },
          {
            transactionId: () => phase,
            makeDirectory: (target, options) =>
              phase === "stage" && target === stageDir
                ? Effect.fail(failureCause)
                : fs.makeDirectory(target, options),
            readDirectory: (target, options) => {
              if (target === bundleDir) bundleReads += 1;
              if (phase === "source-manifest" && target === bundleDir && bundleReads === 2) {
                return Effect.fail(failureCause);
              }
              if (phase === "staged-manifest" && target === stageDir) {
                return Effect.fail(failureCause);
              }
              return fs.readDirectory(target, options);
            },
            move: (source, target) =>
              phase === "backup" && source === outputDir
                ? Effect.fail(failureCause)
                : fs.rename(source, target),
            writeFileString: (target, value, options) =>
              phase === "owner-marker" && target.endsWith(".t4code-publication-owner")
                ? Effect.fail(failureCause)
                : fs.writeFileString(target, value, options),
          },
        ).pipe(Effect.flip);

        assert.instanceOf(error, TauriDesktopBuildPublicationError);
        assert.equal(
          error.operation,
          phase === "stage"
            ? "copy"
            : phase === "backup" || phase === "owner-marker"
              ? "swap"
              : "validate-staging",
        );
        assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "old");
        assert.isFalse(yield* fs.exists(stageDir));
      }
    }),
  );

  it.effect("reports a pre-existing staging directory on transaction-id collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-stage-collision-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-collision.stage");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(stageDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(stageDir, "owner.txt"), "pre-existing");

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        { transactionId: () => "collision" },
      ).pipe(Effect.flip);

      assert.instanceOf(error, TauriDesktopBuildPublicationError);
      assert.equal(yield* fs.readFileString(path.join(stageDir, "owner.txt")), "pre-existing");
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "staging", path: stageDir }]);
      assert.include(error.message, stageDir);
    }),
  );

  it.effect("preserves the publication error when initial or backup restore probes fail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const [probeName, failedProbe] of [
        ["initial", 2],
        ["backup-restore", 3],
      ] as const) {
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: `t4-${probeName}-probe-` });
        const bundleDir = path.join(tempDir, "bundle");
        const outputDir = path.join(tempDir, "output");
        const stageDir = path.join(tempDir, `.output.t4code-${probeName}.stage`);
        const backupDir = path.join(tempDir, `.output.t4code-${probeName}.backup`);
        yield* fs.makeDirectory(bundleDir);
        yield* fs.makeDirectory(outputDir);
        yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
        yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");
        const publicationCause = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "post-swap",
          pathOrDescriptor: outputDir,
        });
        const probeCause = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "exists",
          pathOrDescriptor: outputDir,
        });
        let outputProbes = 0;

        const error = yield* copyTauriBundleArtifacts(
          { bundleDir, outputDir },
          {
            transactionId: () => probeName,
            exists: (target) => {
              if (target !== outputDir) return fs.exists(target);
              outputProbes += 1;
              return outputProbes === failedProbe ? Effect.fail(probeCause) : fs.exists(target);
            },
            move: (source, target) =>
              source === stageDir && target === outputDir
                ? fs
                    .rename(source, target)
                    .pipe(Effect.flatMap(() => Effect.fail(publicationCause)))
                : fs.rename(source, target),
          },
        ).pipe(Effect.flip);

        if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
        assert.strictEqual(error.cause, publicationCause);
        assert.include(
          error.rollbackFailures.map((failure) => failure.operation),
          "inspect-output",
        );
        assert.strictEqual(
          error.rollbackFailures.find((failure) => failure.operation === "inspect-output")?.cause,
          probeCause,
        );
        assert.equal(yield* fs.readFileString(path.join(backupDir, "artifact.txt")), "old");
        assert.deepStrictEqual(error.recoveryPaths, [{ kind: "backup", path: backupDir }]);
        assert.include(error.message, backupDir);
      }
    }),
  );

  it.effect("reports quarantine when the foreign restore output probe fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-foreign-probe-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-foreign-probe.stage");
      const quarantineDir = path.join(tempDir, ".output.t4code-foreign-probe.quarantine");
      const ownerFile = ".t4code-publication-owner";
      yield* fs.makeDirectory(bundleDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "ours");
      const publicationCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });
      const probeCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "exists",
        pathOrDescriptor: outputDir,
      });
      let outputProbes = 0;

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "foreign-probe",
          ownershipToken: () => "ours",
          exists: (target) => {
            if (target !== outputDir) return fs.exists(target);
            outputProbes += 1;
            return outputProbes === 3 ? Effect.fail(probeCause) : fs.exists(target);
          },
          move: (source, target) =>
            source === stageDir && target === outputDir
              ? Effect.gen(function* () {
                  yield* fs.makeDirectory(outputDir);
                  yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "foreign");
                  yield* fs.writeFileString(path.join(outputDir, ownerFile), "foreign");
                  return yield* publicationCause;
                })
              : fs.rename(source, target),
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.strictEqual(error.cause, publicationCause);
      assert.include(
        error.rollbackFailures.map((failure) => failure.operation),
        "inspect-output",
      );
      assert.strictEqual(
        error.rollbackFailures.find((failure) => failure.operation === "inspect-output")?.cause,
        probeCause,
      );
      assert.equal(yield* fs.readFileString(path.join(quarantineDir, "artifact.txt")), "foreign");
      assert.isFalse(yield* fs.exists(stageDir));
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "quarantine", path: quarantineDir }]);
      assert.include(error.message, quarantineDir);
    }),
  );

  it.effect("fails a committed publication when retained backup cleanup fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-committed-backup-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const backupDir = path.join(tempDir, ".output.t4code-committed-backup.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "published");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "prior");
      const cleanupCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: backupDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "committed-backup",
          remove: (target, options) =>
            target === backupDir ? Effect.fail(cleanupCause) : fs.remove(target, options),
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.equal(error.operation, "swap");
      assert.strictEqual(error.cause, cleanupCause);
      assert.deepStrictEqual(error.rollbackFailures, [
        { operation: "cleanup-backup", path: backupDir, cause: cleanupCause },
      ]);
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "backup", path: backupDir }]);
      assert.include(error.message, backupDir);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "published");
      assert.equal(yield* fs.readFileString(path.join(backupDir, "artifact.txt")), "prior");
    }),
  );

  it.effect("preserves and reports backup when atomic restoration fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-rollback-fallback-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-rollback-fallback.stage");
      const backupDir = path.join(tempDir, ".output.t4code-rollback-fallback.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");
      const swapCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: stageDir,
      });
      const restoreCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: backupDir,
      });
      const recoveryAuditCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "exists",
        pathOrDescriptor: backupDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "rollback-fallback",
          copy: (source, target, options) => fs.copy(source, target, options),
          exists: (target) =>
            target === backupDir ? Effect.fail(recoveryAuditCause) : fs.exists(target),
          move: (source, target) => {
            if (source === stageDir && target === outputDir) {
              return fs.rename(source, target).pipe(Effect.flatMap(() => Effect.fail(swapCause)));
            }
            if (source === backupDir && target === outputDir) return Effect.fail(restoreCause);
            return fs.rename(source, target);
          },
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.strictEqual(error.cause, swapCause);
      assert.isFalse(yield* fs.exists(outputDir));
      assert.isFalse(yield* fs.exists(stageDir));
      assert.equal(yield* fs.readFileString(path.join(backupDir, "artifact.txt")), "old");
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "backup", path: backupDir }]);
      assert.include(error.message, backupDir);
    }),
  );

  it.effect("keeps competitor output isolated when atomic backup restoration loses a race", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-restore-race-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-restore-race.stage");
      const backupDir = path.join(tempDir, ".output.t4code-restore-race.backup");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "new-artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "prior-artifact.txt"), "prior");
      const postSwapCause = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "post-swap",
        pathOrDescriptor: outputDir,
      });
      const restoreCause = PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: outputDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "restore-race",
          move: (source, target) => {
            if (source === stageDir && target === outputDir) {
              return fs
                .rename(source, target)
                .pipe(Effect.flatMap(() => Effect.fail(postSwapCause)));
            }
            if (source === backupDir && target === outputDir) {
              return Effect.gen(function* () {
                yield* fs.makeDirectory(outputDir);
                yield* fs.writeFileString(path.join(outputDir, "competitor.txt"), "competitor");
                return yield* restoreCause;
              });
            }
            return fs.rename(source, target);
          },
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.deepStrictEqual(yield* fs.readDirectory(outputDir), ["competitor.txt"]);
      assert.equal(yield* fs.readFileString(path.join(outputDir, "competitor.txt")), "competitor");
      assert.deepStrictEqual(yield* fs.readDirectory(backupDir), ["prior-artifact.txt"]);
      assert.equal(yield* fs.readFileString(path.join(backupDir, "prior-artifact.txt")), "prior");
      assert.deepStrictEqual(error.recoveryPaths, [{ kind: "backup", path: backupDir }]);
      assert.include(error.message, backupDir);
      assert.notInclude(
        error.rollbackFailures.map((failure) => failure.operation),
        "copy-output",
      );
    }),
  );

  it.effect("retains the valid backup when every rollback primitive fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const removeBeforeFailure of [true, false]) {
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-rollback-exhausted-" });
        const bundleDir = path.join(tempDir, "bundle");
        const outputDir = path.join(tempDir, "output");
        const stageDir = path.join(tempDir, ".output.t4code-exhausted.stage");
        const backupDir = path.join(tempDir, ".output.t4code-exhausted.backup");
        const quarantineDir = path.join(tempDir, ".output.t4code-exhausted.quarantine");
        yield* fs.makeDirectory(bundleDir);
        yield* fs.makeDirectory(outputDir);
        yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
        yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");
        const cause = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rollback",
        });

        const error = yield* copyTauriBundleArtifacts(
          { bundleDir, outputDir },
          {
            transactionId: () => "exhausted",
            move: (source, target) => {
              if (source === stageDir && target === outputDir) {
                return fs.rename(source, target).pipe(Effect.flatMap(() => Effect.fail(cause)));
              }
              if (source === backupDir && target === outputDir) {
                return Effect.fail(cause);
              }
              return fs.rename(source, target);
            },
            remove: (target, options) =>
              target === quarantineDir
                ? (removeBeforeFailure ? fs.remove(target, options) : Effect.void).pipe(
                    Effect.flatMap(() => Effect.fail(cause)),
                  )
                : fs.remove(target, options),
          },
        ).pipe(Effect.flip);

        if (!(error instanceof TauriDesktopBuildPublicationError)) {
          throw error;
        }
        assert.include(
          error.rollbackFailures.map((failure) => failure.operation),
          "remove-output",
        );
        assert.include(
          error.rollbackFailures.map((failure) => failure.operation),
          "restore-output",
        );
        assert.equal(yield* fs.readFileString(path.join(backupDir, "artifact.txt")), "old");
        assert.isFalse(yield* fs.exists(stageDir));
        assert.isFalse(yield* fs.exists(outputDir));
        assert.equal(yield* fs.exists(quarantineDir), !removeBeforeFailure);
        assert.deepStrictEqual(
          error.recoveryPaths,
          removeBeforeFailure
            ? [{ kind: "backup", path: backupDir }]
            : [
                { kind: "backup", path: backupDir },
                { kind: "quarantine", path: quarantineDir },
              ],
        );
        assert.include(error.message, backupDir);
        if (!removeBeforeFailure) assert.include(error.message, quarantineDir);
      }
    }),
  );

  it.effect("leaves output untouched when atomic rollback quarantine fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t4-quarantine-failure-" });
      const bundleDir = path.join(tempDir, "bundle");
      const outputDir = path.join(tempDir, "output");
      const stageDir = path.join(tempDir, ".output.t4code-quarantine-failure.stage");
      const backupDir = path.join(tempDir, ".output.t4code-quarantine-failure.backup");
      const quarantineDir = path.join(tempDir, ".output.t4code-quarantine-failure.quarantine");
      yield* fs.makeDirectory(bundleDir);
      yield* fs.makeDirectory(outputDir);
      yield* fs.writeFileString(path.join(bundleDir, "artifact.txt"), "new");
      yield* fs.writeFileString(path.join(outputDir, "artifact.txt"), "old");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: quarantineDir,
      });

      const error = yield* copyTauriBundleArtifacts(
        { bundleDir, outputDir },
        {
          transactionId: () => "quarantine-failure",
          move: (source, target) => {
            if (source === stageDir && target === outputDir) {
              return fs.rename(source, target).pipe(Effect.flatMap(() => Effect.fail(cause)));
            }
            return source === outputDir && target === quarantineDir
              ? Effect.fail(cause)
              : fs.rename(source, target);
          },
        },
      ).pipe(Effect.flip);

      if (!(error instanceof TauriDesktopBuildPublicationError)) throw error;
      assert.include(
        error.rollbackFailures.map((failure) => failure.operation),
        "quarantine-output",
      );
      assert.equal(yield* fs.readFileString(path.join(outputDir, "artifact.txt")), "new");
      assert.equal(yield* fs.readFileString(path.join(backupDir, "artifact.txt")), "old");
      assert.isFalse(yield* fs.exists(stageDir));
      assert.isFalse(yield* fs.exists(quarantineDir));
    }),
  );

  it.effect("validates platform, architecture, target, host, and boolean configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve("X:/repo");
      const invalidInputs = [
        [{ platform: "android" }, {}, "Unsupported Tauri platform"],
        [{ platform: "win", arch: "x86" }, {}, "Unsupported Tauri arch"],
        [{ platform: "linux", target: "dmg", arch: "x64" }, {}, "Unsupported Tauri linux target"],
        [
          { platform: "win", arch: "x64" },
          { T4CODE_TAURI_DESKTOP_VERBOSE: "maybe" },
          "must be true/false",
        ],
      ] as const;

      for (const [input, env, message] of invalidInputs) {
        const error = yield* resolveTauriBuildPlan(
          input,
          env,
          { platform: "win32", arch: "x64" },
          repoRoot,
        ).pipe(Effect.flip);
        assert.instanceOf(error, TauriDesktopBuildConfigurationError);
        assert.include(error.message, message);
      }

      const unsupportedHost = yield* resolveTauriBuildPlan(
        {},
        {},
        { platform: "freebsd", arch: "x64" },
        repoRoot,
      ).pipe(Effect.flip);
      assert.instanceOf(unsupportedHost, TauriDesktopBuildConfigurationError);
      assert.include(unsupportedHost.message, "Unsupported host platform");
    }),
  );

  it.effect("builds, copies, and reports artifacts through injected process services", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t4-build-tauri-artifact-" });
      const plan = yield* resolveTauriBuildPlan(
        { platform: "win", arch: "x64", target: "nsis", outputDir: "out", verbose: true },
        {},
        { platform: "win32", arch: "x64" },
        repoRoot,
      );
      yield* fs.makeDirectory(plan.bundleDir, { recursive: true });
      yield* fs.writeFileString(path.join(plan.bundleDir, "installer.exe"), "binary");
      const writes: string[] = [];
      const spawnPlans: unknown[] = [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          spawnPlans.push(command);
          return Effect.succeed(processHandle(0));
        }),
      );

      const artifacts = yield* buildTauriDesktopArtifact(
        { platform: "win", arch: "x64", target: "nsis", outputDir: "out", verbose: true },
        {},
        { write: (text) => writes.push(text), host: { platform: "win32", arch: "x64" }, repoRoot },
      ).pipe(Effect.provide(spawnerLayer));

      assert.equal(spawnPlans.length, 1);
      const spawned = spawnPlans[0] as {
        readonly options: { readonly stdout?: unknown; readonly stderr?: unknown };
      };
      assert.equal(spawned.options.stdout, "inherit");
      assert.equal(spawned.options.stderr, "inherit");
      assert.deepStrictEqual(artifacts, [path.join(repoRoot, "out", "installer.exe")]);
      assert.include(writes.join(""), "Building win/nsis");
      assert.include(writes.join(""), "Artifacts copied");
      assert.include(writes.join(""), "installer.exe");

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        yield* buildTauriDesktopArtifact(
          { platform: "win", arch: "x64", target: "nsis", outputDir: "out", skipBuild: true },
          {},
          { host: { platform: "win32", arch: "x64" }, repoRoot },
        ).pipe(Effect.provide(spawnerLayer));
        assert.equal(stdout.mock.calls.length, 1);
      } finally {
        stdout.mockRestore();
      }
    }),
  );

  it.effect("reports nonzero build exits and skips spawning when requested", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t4-build-exit-" });
      const plan = yield* resolveTauriBuildPlan(
        { platform: "win", arch: "x64", target: "nsis" },
        {},
        { platform: "win32", arch: "x64" },
        repoRoot,
      );
      yield* fs.makeDirectory(plan.bundleDir, { recursive: true });
      yield* fs.writeFileString(path.join(plan.bundleDir, "installer.exe"), "binary");
      let spawnCount = 0;
      const failingSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(processHandle(9));
        }),
      );

      const error = yield* buildTauriDesktopArtifact(
        { platform: "win", arch: "x64", target: "nsis" },
        {},
        { write: () => undefined, host: { platform: "win32", arch: "x64" }, repoRoot },
      ).pipe(Effect.provide(failingSpawner), Effect.flip);
      assert.instanceOf(error, TauriDesktopBuildConfigurationError);
      assert.include(error.message, "code 9");

      const artifacts = yield* buildTauriDesktopArtifact(
        { platform: "win", arch: "x64", target: "nsis", skipBuild: true },
        {},
        { write: () => undefined, host: { platform: "win32", arch: "x64" }, repoRoot },
      ).pipe(Effect.provide(failingSpawner));
      assert.equal(spawnCount, 1);
      assert.equal(artifacts.length, 1);
    }),
  );

  it("launches only when used as the CLI entrypoint", () => {
    const launched: unknown[] = [];
    assert.equal(
      runBuildTauriDesktopArtifactMain(false, [], (effect) => launched.push(effect)),
      false,
    );
    assert.equal(
      runBuildTauriDesktopArtifactMain(true, ["--skip-build"], (effect) => launched.push(effect)),
      true,
    );
    assert.equal(launched.length, 1);
  });
});
