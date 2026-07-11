import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  copyTauriBundleArtifacts,
  detectHostTauriBuildPlatform,
  parseTauriArtifactCliArgs,
  resolveTauriBuildPlan,
  resolveTauriRustTarget,
  TauriDesktopBuildDirectoryMissingError,
  TauriDesktopBuildHostMismatchError,
} from "./build-desktop-artifact.ts";

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
        path.join(
          repoRoot,
          "apps",
          "desktop",
          "src-tauri",
          "target",
          "x86_64-pc-windows-msvc",
          "release",
          "bundle",
          "nsis",
        ),
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
  });

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
});
