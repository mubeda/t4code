import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  runSyncReferenceReposMain,
  isReferenceRepoSyncError,
  syncReferenceReposCommand,
  syncReferenceRepos,
} from "./sync-reference-repos.ts";

const encoder = new TextEncoder();
const effectSmol = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

function mockHandle(
  options: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly stdoutError?: PlatformError.PlatformError;
    readonly stderrError?: PlatformError.PlatformError;
    readonly exitError?: PlatformError.PlatformError;
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: options.exitError
      ? Effect.fail(options.exitError)
      : Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: options.stdoutError
      ? Stream.fail(options.stdoutError)
      : Stream.make(encoder.encode(options.stdout ?? "done\n")),
    stderr: options.stderrError
      ? Stream.fail(options.stderrError)
      : Stream.make(encoder.encode(options.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  handle = mockHandle(),
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(handle);
    }),
  );
}

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves the effect-smol tag from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
    }),
  );

  it.effect("uses the latest branch without reading package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-latest-",
      });

      assert.equal(yield* resolveReferenceRepoRef(effectSmol, rootDir, true), "main");
    }),
  );

  it.effect("preserves version source read context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-read-error-",
      });
      const sourcePath = path.join(rootDir, effectSmol.versionSourcePath);

      const error = yield* resolveReferenceRepoRef(effectSmol, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("preserves version source parse context and the schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-parse-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, "{");

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "parse");
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("reports the unresolved package path without inventing a cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-resolution-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, '{"dependencies":{}}');

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionResolutionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.deepStrictEqual(error.packageVersionPath, ["dependencies", "alchemy"]);
      assert.ok(!("cause" in error));
      assert.equal(
        error.message,
        `No version was found for reference repo "${alchemyEffect.id}" at ${sourcePath}:dependencies.alchemy.`,
      );
      assert.isTrue(isReferenceRepoSyncError(error));
    }),
  );

  it.effect("resolves the alchemy-effect tag from the relay package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-alchemy-version-",
      });
      yield* fs.makeDirectory(path.join(rootDir, "infra", "relay"), { recursive: true });
      yield* fs.writeFileString(
        path.join(rootDir, "infra", "relay", "package.json"),
        '{"dependencies":{"alchemy":"2.0.0-beta.49"}}',
      );

      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.49");
    }),
  );

  it.effect("resolves the alchemy-effect commit from a pkg.ing source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-alchemy-pkg-ing-",
      });
      yield* fs.makeDirectory(path.join(rootDir, "infra", "relay"), { recursive: true });
      yield* fs.writeFileString(
        path.join(rootDir, "infra", "relay", "package.json"),
        '{"dependencies":{"alchemy":"https://pkg.ing/alchemy/cde008ab6b77783d3edbf5dc82750fbdfd279347"}}',
      );

      assert.equal(
        yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false),
        "cde008ab6b77783d3edbf5dc82750fbdfd279347",
      );
    }),
  );

  it.effect("plans an add for a missing subtree and a pull for an existing subtree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const addPlan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(addPlan.action, "add");
      assert.deepStrictEqual(addPlan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol",
        "https://github.com/Effect-TS/effect.git",
        "effect@4.0.0-beta.73",
        "--squash",
      ]);

      yield* fs.makeDirectory(path.join(rootDir, effectSmol.prefix), { recursive: true });
      assert.equal((yield* planReferenceRepoSync(effectSmol, rootDir, false)).action, "pull");
    }),
  );

  it.effect("rejects unsafe prefixes and prune paths before filesystem planning", () =>
    Effect.gen(function* () {
      const invalidPrefixes = [
        "",
        ".repos",
        ".repos/",
        ".repos//escape",
        ".repos/./escape",
        ".repos/../escape",
        "/absolute",
        "C:/absolute",
        "//server/share",
        ".repos\\escape",
        ".repos/CON",
        ".repos/prn.txt",
        ".repos/AuX.log",
        ".repos/NUL",
        ".repos/com1.json",
        ".repos/COM9",
        ".repos/lpt1.cache",
        ".repos/LPT9",
        ".repos/trailing.",
        ".repos/trailing ",
        ".repos/data:stream",
        ".repos/control\u0001name",
        ".repos/delete\u007fname",
        ".repos/less<than",
        ".repos/greater>than",
        '.repos/double"quote',
        ".repos/pipe|name",
        ".repos/question?mark",
        ".repos/star*name",
      ];
      const invalidPrunePaths = [
        "",
        ".",
        "..",
        "nested/../escape",
        "nested//escape",
        "nested/./escape",
        "nested/",
        "/absolute",
        "C:/absolute",
        "//server/share",
        "nested\\escape",
        ".repos/another-subtree",
        "CON",
        "nested/prn.txt",
        "AuX.log",
        "NUL",
        "com1.json",
        "COM9",
        "lpt1.cache",
        "LPT9",
        "nested/trailing.",
        "nested/trailing ",
        "nested/data:stream",
        "nested/control\u0001name",
        "nested/delete\u007fname",
        "nested/less<than",
        "nested/greater>than",
        'nested/double"quote',
        "nested/pipe|name",
        "nested/question?mark",
        "nested/star*name",
      ];
      let existsCalled = false;
      const rejectingFileSystem = FileSystem.makeNoop({
        exists: () => {
          existsCalled = true;
          return Effect.succeed(false);
        },
      });

      for (const prefix of invalidPrefixes) {
        const error = yield* planReferenceRepoSync({ ...effectSmol, prefix }, "/repo", true).pipe(
          Effect.provideService(FileSystem.FileSystem, rejectingFileSystem),
          Effect.flip,
        );
        if (error._tag !== "ReferenceRepoPathValidationError") {
          assert.fail(`Expected ReferenceRepoPathValidationError, got ${error._tag}`);
        }
        assert.equal(error.field, "prefix");
        assert.equal(error.value, prefix);
        assert.include(error.message, `unsafe prefix path "${prefix}"`);
      }

      for (const prunePath of invalidPrunePaths) {
        const error = yield* planReferenceRepoSync(
          { ...effectSmol, prunePaths: [prunePath] },
          "/repo",
          true,
        ).pipe(Effect.provideService(FileSystem.FileSystem, rejectingFileSystem), Effect.flip);
        if (error._tag !== "ReferenceRepoPathValidationError") {
          assert.fail(`Expected ReferenceRepoPathValidationError, got ${error._tag}`);
        }
        assert.equal(error.field, "prunePath");
        assert.equal(error.value, prunePath);
      }

      assert.isFalse(existsCalled);
    }),
  );

  it.effect("accepts normalized dotted and hyphenated subtree paths", () =>
    Effect.gen(function* () {
      const plan = yield* planReferenceRepoSync(
        {
          ...effectSmol,
          prefix: ".repos/effect-smol.v2",
          prunePaths: ["docs.v2/read-me", "packages/effect-core"],
        },
        "/repo",
        true,
      ).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
        ),
      );

      assert.deepStrictEqual(plan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol.v2",
        effectSmol.repository,
        effectSmol.latestRef,
        "--squash",
      ]);
    }),
  );

  it.effect("runs the planned git subtree command through the process service", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-run-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );

      assert.deepStrictEqual(commands, [
        {
          command: "git",
          args: [
            "subtree",
            "add",
            "--prefix=.repos/effect-smol",
            "https://github.com/Effect-TS/effect.git",
            "effect@4.0.0-beta.73",
            "--squash",
          ],
        },
      ]);
    });
  });

  it.effect("prunes the nested Alchemy submodule after syncing alchemy-effect", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-prune-",
      });
      const versionSourcePath = path.join(rootDir, "infra", "relay", "package.json");
      yield* fs.makeDirectory(path.dirname(versionSourcePath), { recursive: true });
      yield* fs.writeFileString(versionSourcePath, '{"dependencies":{"alchemy":"2.0.0-beta.49"}}');

      yield* syncReferenceRepos({ rootDir, repoId: "alchemy-effect" }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );

      assert.deepStrictEqual(commands, [
        {
          command: "git",
          args: [
            "subtree",
            "add",
            "--prefix=.repos/alchemy-effect",
            "https://github.com/alchemy-run/alchemy-effect.git",
            "v2.0.0-beta.49",
            "--squash",
          ],
        },
        {
          command: "git",
          args: [
            "rm",
            "-rf",
            "--ignore-unmatch",
            "--",
            ".repos/alchemy-effect/.gitmodules",
            ".repos/alchemy-effect/.vendor/alchemy",
          ],
        },
      ]);
    });
  });

  it.effect("rejects unknown repo selectors", () =>
    Effect.gen(function* () {
      const error = yield* syncReferenceRepos({
        repoId: "missing",
        dryRun: true,
      }).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoSelectionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, "missing");
      assert.deepStrictEqual(error.expectedRepoIds, ["effect-smol", "alchemy-effect"]);
      assert.ok(!("cause" in error));
      assert.equal(
        error.message,
        'Unknown reference repo "missing". Expected one of: effect-smol, alchemy-effect.',
      );
      assert.isTrue(isReferenceRepoSyncError(error));
    }),
  );

  it.effect("reports non-zero git exits without retaining process output", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-exit-error-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const error = yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            commands,
            mockHandle({ exitCode: 23, stderr: "subtree failed secret-token-value\n" }),
          ),
        ),
        Effect.flip,
      );

      if (error._tag !== "ReferenceRepoGitSubtreeError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "exit");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.action, "add");
      assert.equal(error.repository, effectSmol.repository);
      assert.equal(error.ref, "effect@4.0.0-beta.73");
      assert.equal(error.rootDir, rootDir);
      assert.equal(error.argumentCount, commands[0]?.args.length);
      assert.equal(error.exitCode, 23);
      assert.equal(error.stdoutLength, 5);
      assert.equal(error.stderrLength, 34);
      assert.notProperty(error, "args");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "secret-token-value");
      assert.ok(!("cause" in error));
      assert.equal(
        error.message,
        'Git subtree add for reference repo "effect-smol" failed during "exit".',
      );
    });
  });

  it.effect("dry-runs every configured repository from latest refs without spawning git", () => {
    let spawned = false;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "sync-all-dry-" });
      const plans = yield* syncReferenceRepos({ rootDir, latest: true, dryRun: true }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              spawned = true;
              return Effect.die("dry run spawned git");
            }),
          ),
        ),
      );

      assert.isFalse(spawned);
      assert.deepStrictEqual(
        plans.map(({ repo, ref }) => [repo.id, ref]),
        [
          ["effect-smol", "main"],
          ["alchemy-effect", "main"],
        ],
      );
    });
  });

  it.effect("maps public CLI flags into a dry-run sync plan", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "sync-cli-" });
      yield* Command.runWith(syncReferenceReposCommand, { version: "0.0.0" })([
        "--repo",
        "effect-smol",
        "--latest",
        "--root",
        rootDir,
        "--dry-run",
      ]);
      assert.isFalse(yield* fs.exists(path.join(rootDir, effectSmol.prefix)));
    }),
  );

  it.effect("uses process.cwd defaults and suppresses empty git stdout", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const plans = yield* syncReferenceRepos({ repoId: "effect-smol", latest: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands, mockHandle({ stdout: "   \n" }))),
      );
      assert.lengthOf(plans, 1);
      assert.equal(commands[0]?.command, "git");
    });
  });

  it.effect("maps git spawn and communication failures with safe context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "sync-errors-" });
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
      });
      const spawnError = yield* syncReferenceRepos({
        rootDir,
        repoId: "effect-smol",
        latest: true,
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.fail(cause)),
          ),
        ),
        Effect.flip,
      );
      assert.equal(spawnError._tag, "ReferenceRepoGitSubtreeError");
      if (spawnError._tag !== "ReferenceRepoGitSubtreeError") {
        return assert.fail(`Unexpected error: ${spawnError._tag}`);
      }
      assert.equal(spawnError.operation, "spawn");
      assert.strictEqual(spawnError.cause, cause);

      for (const handle of [
        mockHandle({ stdoutError: cause }),
        mockHandle({ stderrError: cause }),
        mockHandle({ exitError: cause }),
      ]) {
        const communicateError = yield* syncReferenceRepos({
          rootDir,
          repoId: "effect-smol",
          latest: true,
        }).pipe(Effect.provide(mockSpawnerLayer([], handle)), Effect.flip);
        assert.equal(communicateError._tag, "ReferenceRepoGitSubtreeError");
        if (communicateError._tag !== "ReferenceRepoGitSubtreeError") {
          return assert.fail(`Unexpected error: ${communicateError._tag}`);
        }
        assert.equal(communicateError.operation, "communicate");
        assert.strictEqual(communicateError.cause, cause);
      }
    }),
  );

  it.effect("rejects missing, null, non-string, and empty nested package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "sync-version-shapes-" });
      const repo = {
        ...alchemyEffect,
        versionSourcePath: "version.json",
        packageVersionPath: ["outer", "version"],
      };
      const sourcePath = path.join(rootDir, repo.versionSourcePath);

      for (const source of [
        "{}",
        '{"outer":null}',
        '{"outer":{"version":7}}',
        '{"outer":{"version":""}}',
      ]) {
        yield* fs.writeFileString(sourcePath, source);
        const error = yield* resolveReferenceRepoRef(repo, rootDir, false).pipe(Effect.flip);
        assert.equal(error._tag, "ReferenceRepoVersionResolutionError");
        assert.equal(
          error.message,
          `No version was found for reference repo "${repo.id}" at ${sourcePath}:outer.version.`,
        );
        assert.isTrue(isReferenceRepoSyncError(error));
      }
    }),
  );
});

it("does not launch on import and launches once for direct execution", () => {
  const programs: Array<object> = [];
  const launch = <E, A>(program: Effect.Effect<A, E, never>) => programs.push(program);
  assert.isFalse(runSyncReferenceReposMain(false, launch));
  assert.isTrue(runSyncReferenceReposMain(true, launch));
  assert.lengthOf(programs, 1);
});
