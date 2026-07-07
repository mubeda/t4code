import { describe, it } from "@effect/vitest";
import { afterEach, beforeAll, expect } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  buildWslNodeEnvPreamble,
  DesktopWslDistroListError,
  DesktopWslEnvironment,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatWslShellTransportFailureReason,
  layer as wslLayer,
  layerTest as wslLayerTest,
  parseNodePath,
  parseResolvedPath,
  parseToolchainReport,
  probeWslDistros,
} from "./DesktopWslEnvironment.ts";

const encoder = new TextEncoder();

const makeDistroListSpawner = (result: { readonly stdout?: string; readonly exitCode?: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          result.exitCode === undefined
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(result.exitCode === undefined),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

describe("probeWslDistros", () => {
  it.effect("preserves a successful empty distro list", () =>
    Effect.gen(function* () {
      const distros = yield* probeWslDistros;
      expect(distros).toEqual([]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ stdout: "", exitCode: 0 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command exits unsuccessfully", () =>
    Effect.gen(function* () {
      const error = yield* probeWslDistros.pipe(Effect.flip);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("exited with code 1");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ exitCode: 1 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command times out", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeDistroListSpawner({})),
    );
    return Effect.gen(function* () {
      const fiber = yield* probeWslDistros.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(8));
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("timed out");
    }).pipe(Effect.provide(layer));
  });
});

describe("formatNodePtyProbeFailureReason", () => {
  it("identifies a packaged build that omitted the Linux node-pty prebuild", () => {
    const reason = formatNodePtyProbeFailureReason(4);

    expect(reason).toContain("packaged Linux node-pty binary was not included");
    expect(reason).toContain("--wsl-prebuild");
  });

  it("leaves other node-pty load failures to the compatibility diagnostic", () => {
    expect(formatNodePtyProbeFailureReason(1)).toBeNull();
  });
});

describe("formatWslShellTransportFailureReason", () => {
  it("distinguishes timeouts and spawn failures from normal shell exit codes", () => {
    expect(formatWslShellTransportFailureReason("timeout")).toContain("timed out");
    expect(formatWslShellTransportFailureReason("spawn")).toContain("could not start wsl.exe");
    expect(formatWslShellTransportFailureReason("process")).toContain("lost communication");
    expect(formatWslShellTransportFailureReason(null)).toBeNull();
  });
});

describe("buildWslNodeEnvPreamble", () => {
  it("passes the required Node engine range into the shared resolver", () => {
    const preamble = buildWslNodeEnvPreamble("^22.16 || ^23.11 || >=24.10");

    expect(preamble).toContain("T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'");
    expect(preamble.indexOf("T3_NODE_ENGINE_RANGE=")).toBeLessThan(
      preamble.lastIndexOf("ensure_remote_node_path || true"),
    );
  });

  it("keeps the shared resolver permissive when no Node engine range is provided", () => {
    expect(buildWslNodeEnvPreamble()).toContain("T3_NODE_ENGINE_RANGE=''");
  });
});

describe("parseToolchainReport", () => {
  it("returns no missing tools and no node version on empty output", () => {
    expect(parseToolchainReport("")).toEqual({ missingTools: [], nodeVersion: null });
  });

  it("collects all missing: lines", () => {
    const stdout = ["missing:make", "missing:g++", "nodeVersion:24.10.0"].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["make", "g++"],
      nodeVersion: "24.10.0",
    });
  });

  it("ignores blank lines and trims whitespace", () => {
    const stdout = ["  missing:python3  ", "", "  nodeVersion:v22.16.0  "].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["python3"],
      nodeVersion: "v22.16.0",
    });
  });

  it("returns null node version when value after prefix is empty", () => {
    expect(parseToolchainReport("nodeVersion:")).toEqual({
      missingTools: [],
      nodeVersion: null,
    });
  });
});

describe("parseNodePath", () => {
  it("extracts the absolute node path from a nodePath: line", () => {
    const stdout = "nodePath:/home/josh/.nvm/versions/node/v22.16.0/bin/node";
    expect(parseNodePath(stdout)).toBe("/home/josh/.nvm/versions/node/v22.16.0/bin/node");
  });

  it("returns null when node was not found (empty value after prefix)", () => {
    expect(parseNodePath("nodePath:")).toBeNull();
  });

  it("returns null when there is no nodePath line at all", () => {
    expect(parseNodePath("missing:node\nnodeVersion:")).toBeNull();
  });

  it("ignores surrounding noise and trims whitespace", () => {
    const stdout = ["some preamble noise", "  nodePath:/usr/bin/node  ", "trailing"].join("\n");
    expect(parseNodePath(stdout)).toBe("/usr/bin/node");
  });
});

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });

  it("returns null when the resolved PATH is absent or empty", () => {
    expect(parseResolvedPath("nodePath:/usr/bin/node\n")).toBeNull();
    expect(parseResolvedPath("resolvedPath:\n")).toBeNull();
  });
});

describe("formatMissingToolsReason", () => {
  it("returns null when everything is present and node is in range", () => {
    expect(
      formatMissingToolsReason({ missingTools: [], nodeVersion: "24.10.0" }, "^24.10"),
    ).toBeNull();
  });

  it("returns null when range is not specified and tools are present", () => {
    expect(formatMissingToolsReason({ missingTools: [], nodeVersion: "18.0.0" }, null)).toBeNull();
  });

  it("flags missing node first", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["node", "make"], nodeVersion: null },
      "^24.10",
    );
    expect(reason).toContain("node");
    expect(reason).toContain("^24.10");
    expect(reason).toContain("make");
    expect(reason).toContain("nvm");
  });

  it("flags an out-of-range node version with the actual version surfaced", () => {
    const reason = formatMissingToolsReason(
      { missingTools: [], nodeVersion: "20.0.0" },
      "^24.10 || ^22.16",
    );
    expect(reason).toContain("node 20.0.0");
    expect(reason).toContain("requires ^24.10 || ^22.16");
  });

  it("flags missing build tools without node when node is fine", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["g++", "python3"], nodeVersion: "24.10.0" },
      "^24.10",
    );
    expect(reason).toContain("g++");
    expect(reason).toContain("python3");
    expect(reason).toContain("build-essential");
    expect(reason).not.toContain("nvm");
  });
});

// ---------------------------------------------------------------------------
// Layer + service implementation coverage
// ---------------------------------------------------------------------------

const NEVER_EXIT = Symbol("never-exit");

interface ShellHandleSpec {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | typeof NEVER_EXIT;
}

const makeHandle = (spec: ShellHandleSpec) => {
  const hangs = spec.exitCode === NEVER_EXIT;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: hangs
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode((spec.exitCode as number) ?? 0)),
    isRunning: Effect.succeed(hangs),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(spec.stdout ?? "")),
    stderr: Stream.make(encoder.encode(spec.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
};

interface WslSpawnerConfig {
  readonly distroList?: ShellHandleSpec;
  readonly wslpath?: ShellHandleSpec;
  readonly hostname?: ShellHandleSpec;
  readonly getent?: ShellHandleSpec;
  readonly preWarm?: ShellHandleSpec;
  // Consumed in order for each `bash -l -s` shell invocation.
  readonly shell?: ReadonlyArray<ShellHandleSpec | "spawn-fail">;
}

const spawnFailure = PlatformError.badArgument({
  module: "ChildProcessSpawner",
  method: "spawn",
  description: "wsl.exe could not be launched",
});

const makeWslSpawner = (config: WslSpawnerConfig) => {
  const shellQueue = [...(config.shell ?? [])];
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    const has = (needle: string) => args.some((arg) => arg === needle || arg.includes(needle));

    if (has("--list")) {
      return Effect.succeed(makeHandle(config.distroList ?? { stdout: "", exitCode: 0 }));
    }
    if (has("wslpath")) {
      return Effect.succeed(makeHandle(config.wslpath ?? { exitCode: 1 }));
    }
    if (has("hostname -I")) {
      return Effect.succeed(makeHandle(config.hostname ?? { exitCode: 1 }));
    }
    if (has("getent passwd")) {
      return Effect.succeed(makeHandle(config.getent ?? { exitCode: 1 }));
    }
    if (has("bash")) {
      const next = shellQueue.shift();
      if (next === undefined) {
        return Effect.succeed(makeHandle({ exitCode: 0 }));
      }
      if (next === "spawn-fail") {
        return Effect.fail(spawnFailure);
      }
      return Effect.succeed(makeHandle(next));
    }
    if (has("true")) {
      return Effect.succeed(makeHandle(config.preWarm ?? { exitCode: 0 }));
    }
    return Effect.succeed(makeHandle({ exitCode: 0 }));
  });
};

const probeStdout = (nodePathValue: string, resolvedPathValue: string): string =>
  `nodePath:${nodePathValue}\nresolvedPath:${resolvedPathValue}\n`;

const originalWindir = process.env.WINDIR;
let windirWithWsl = "";
let windirWithoutWsl = "";

const buildWslLayer = (options: {
  readonly platform?: NodeJS.Platform;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) => {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-wsl-home-${process.pid}`,
    platform: options.platform ?? "win32",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: `/tmp/t3-wsl-test-${process.pid}` }),
      ),
    ),
  );

  return wslLayer.pipe(
    Layer.provideMerge(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("DesktopWslEnvironment layer", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        windirWithWsl = yield* fileSystem.makeTempDirectory({ prefix: "t3-wsl-yes-" });
        const withWslSystem32 = path.join(windirWithWsl, "System32");
        yield* fileSystem.makeDirectory(withWslSystem32, { recursive: true });
        yield* fileSystem.writeFileString(path.join(withWslSystem32, "wsl.exe"), "");

        windirWithoutWsl = yield* fileSystem.makeTempDirectory({ prefix: "t3-wsl-no-" });
        yield* fileSystem.makeDirectory(path.join(windirWithoutWsl, "System32"), {
          recursive: true,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  afterEach(() => {
    if (originalWindir === undefined) {
      delete process.env.WINDIR;
    } else {
      process.env.WINDIR = originalWindir;
    }
  });

  it.effect("reports WSL available on win32 when wsl.exe exists under WINDIR", () => {
    process.env.WINDIR = windirWithWsl;
    return Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.isAvailable).toBe(true);
    }).pipe(Effect.provide(buildWslLayer({ platform: "win32", spawner: makeWslSpawner({}) })));
  });

  it.effect("reports WSL unavailable on win32 when wsl.exe is missing", () => {
    process.env.WINDIR = windirWithoutWsl;
    return Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.isAvailable).toBe(false);
    }).pipe(Effect.provide(buildWslLayer({ platform: "win32", spawner: makeWslSpawner({}) })));
  });

  it.effect("reports WSL unavailable on non-win32 platforms without touching the filesystem", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.isAvailable).toBe(false);
    }).pipe(Effect.provide(buildWslLayer({ platform: "linux", spawner: makeWslSpawner({}) }))),
  );

  it.effect("lists and probes distros through the spawner", () => {
    const stdout = [
      "  NAME            STATE           VERSION",
      "* Ubuntu          Running         2",
      "",
    ].join("\n");
    return Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      const listed = yield* env.listDistros;
      expect(listed.map((distro) => distro.name)).toContain("Ubuntu");
      const probed = yield* env.probeDistros;
      expect(probed.map((distro) => distro.name)).toContain("Ubuntu");
    }).pipe(
      Effect.provide(
        buildWslLayer({ spawner: makeWslSpawner({ distroList: { stdout, exitCode: 0 } }) }),
      ),
    );
  });

  it.effect("returns an empty list when distro enumeration fails", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.listDistros).toEqual([]);
      const probeError = yield* env.probeDistros.pipe(Effect.flip);
      expect(probeError).toBeInstanceOf(DesktopWslDistroListError);
    }).pipe(
      Effect.provide(buildWslLayer({ spawner: makeWslSpawner({ distroList: { exitCode: 1 } }) })),
    ),
  );

  it.effect("converts a Windows path to a WSL path and normalizes backslashes", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      const converted = yield* env.windowsToWslPath("Ubuntu", "C:\\Users\\me\\repo");
      expect(converted).toStrictEqual(Option.some("/mnt/c/Users/me/repo"));
    }).pipe(
      Effect.provide(
        buildWslLayer({
          spawner: makeWslSpawner({ wslpath: { stdout: "/mnt/c/Users/me/repo\n", exitCode: 0 } }),
        }),
      ),
    ),
  );

  it.effect("returns None when wslpath exits non-zero", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.windowsToWslPath(null, "C:/x")).toStrictEqual(Option.none());
    }).pipe(
      Effect.provide(buildWslLayer({ spawner: makeWslSpawner({ wslpath: { exitCode: 1 } }) })),
    ),
  );

  it.effect("returns None when wslpath output is blank", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.windowsToWslPath(null, "C:/x")).toStrictEqual(Option.none());
    }).pipe(
      Effect.provide(
        buildWslLayer({ spawner: makeWslSpawner({ wslpath: { stdout: "   \n", exitCode: 0 } }) }),
      ),
    ),
  );

  it.effect("resolves and caches the Linux home directory per distro", () => {
    let getentCalls = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      if (args.some((arg) => arg.includes("getent passwd"))) {
        getentCalls += 1;
        return Effect.succeed(makeHandle({ stdout: "/home/josh\n", exitCode: 0 }));
      }
      return Effect.succeed(makeHandle({ exitCode: 0 }));
    });
    return Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.getUserHome("Ubuntu")).toStrictEqual(Option.some("/home/josh"));
      // Second call is served from the per-distro cache (no extra spawn).
      expect(yield* env.getUserHome("Ubuntu")).toStrictEqual(Option.some("/home/josh"));
      expect(getentCalls).toBe(1);
    }).pipe(Effect.provide(buildWslLayer({ spawner })));
  });

  it.effect("returns None for a home that is not an absolute path", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.getUserHome("Ubuntu")).toStrictEqual(Option.none());
    }).pipe(
      Effect.provide(
        buildWslLayer({ spawner: makeWslSpawner({ getent: { stdout: "not-a-path\n", exitCode: 0 } }) }),
      ),
    ),
  );

  it.effect("extracts the first IPv4 address from hostname -I", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.getDistroIp("Ubuntu")).toStrictEqual(Option.some("172.20.10.2"));
    }).pipe(
      Effect.provide(
        buildWslLayer({
          spawner: makeWslSpawner({ hostname: { stdout: "172.20.10.2 fe80::1\n", exitCode: 0 } }),
        }),
      ),
    ),
  );

  it.effect("returns None when hostname -I yields no IPv4 address", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.getDistroIp("Ubuntu")).toStrictEqual(Option.none());
    }).pipe(
      Effect.provide(
        buildWslLayer({ spawner: makeWslSpawner({ hostname: { stdout: "fe80::1\n", exitCode: 0 } }) }),
      ),
    ),
  );

  it.effect("pre-warms a distro without surfacing errors", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      yield* env.preWarm("Ubuntu");
      yield* env.preWarm(null);
    }).pipe(Effect.provide(buildWslLayer({ spawner: makeWslSpawner({ preWarm: { exitCode: 0 } }) }))),
  );

  describe("ensureNodePty", () => {
    it.effect("fails without a fatal flag when the wslpath conversion fails", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("wslpath conversion failed");
          expect(result.fatal).toBe(false);
        }
      }).pipe(
        Effect.provide(buildWslLayer({ spawner: makeWslSpawner({ wslpath: { exitCode: 1 } }) })),
      ),
    );

    it.effect("succeeds when the probe reports node and a resolved PATH", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.nodePath).toBe("/usr/bin/node");
          expect(result.resolvedPath).toBe("/usr/bin:/bin");
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [{ stdout: probeStdout("/usr/bin/node", "/usr/bin:/bin"), exitCode: 0 }],
            }),
          }),
        ),
      ),
    );

    it.effect("reports a fatal missing-node toolchain error when no node is found", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("missing required tools");
          expect(result.fatal).toBe(true);
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [
                { stdout: "resolvedPath:/usr/bin:/bin\n", exitCode: 0 },
                { stdout: "missing:node\n", exitCode: 0 },
              ],
            }),
          }),
        ),
      ),
    );

    it.effect("surfaces a retry limit when the toolchain probe transport fails", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.fatal).toBe(false);
          expect(result.retryLimit).toBeGreaterThan(0);
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [{ stdout: "resolvedPath:/usr/bin:/bin\n", exitCode: 0 }, "spawn-fail"],
            }),
          }),
        ),
      ),
    );

    it.effect("reports a fatal packaging error when server dependencies cannot load", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("server dependencies");
          expect(result.fatal).toBe(true);
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [{ stdout: probeStdout("/usr/bin/node", "/usr/bin:/bin"), exitCode: 3 }],
            }),
          }),
        ),
      ),
    );

    it.effect("reports the packaged prebuild-missing error without attempting a build", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("packaged Linux node-pty binary was not included");
          expect(result.fatal).toBe(true);
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [{ stdout: probeStdout("/usr/bin/node", "/usr/bin:/bin"), exitCode: 4 }],
            }),
          }),
        ),
      ),
    );

    it.effect("builds node-pty from source in dev mode and succeeds", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo", { allowBuild: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.nodePath).toBe("/usr/bin/node");
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [
                { stdout: probeStdout("/usr/bin/node", "/usr/bin:/bin"), exitCode: 1 },
                { stdout: "nodeVersion:24.10.0\n", exitCode: 0 },
                { stdout: "built", exitCode: 0 },
              ],
            }),
          }),
        ),
      ),
    );

    it.effect("reports a fatal build error when the node-pty compile fails", () =>
      Effect.gen(function* () {
        const env = yield* DesktopWslEnvironment;
        const result = yield* env.ensureNodePty("Ubuntu", "C:/repo", { allowBuild: true });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain("node-pty Linux build failed");
          expect(result.fatal).toBe(true);
        }
      }).pipe(
        Effect.provide(
          buildWslLayer({
            spawner: makeWslSpawner({
              wslpath: { stdout: "/mnt/c/repo\n", exitCode: 0 },
              shell: [
                { stdout: probeStdout("/usr/bin/node", "/usr/bin:/bin"), exitCode: 1 },
                { stdout: "nodeVersion:24.10.0\n", exitCode: 0 },
                { stdout: "", stderr: "gyp ERR! build error", exitCode: 5 },
              ],
            }),
          }),
        ),
      ),
    );
  });
});

describe("DesktopWslEnvironment.layerTest", () => {
  it.effect("exposes configured stub values", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.isAvailable).toBe(true);
      expect((yield* env.listDistros).map((distro) => distro.name)).toEqual(["Ubuntu"]);
      expect(yield* env.windowsToWslPath("Ubuntu", "C:/repo")).toStrictEqual(
        Option.some("/mnt/c/repo"),
      );
      expect(yield* env.getUserHome("Ubuntu")).toStrictEqual(Option.some("/home/josh"));
      expect(yield* env.getDistroIp("Ubuntu")).toStrictEqual(Option.some("172.20.10.2"));
      const ensured = yield* env.ensureNodePty("Ubuntu", "C:/repo");
      expect(ensured).toStrictEqual({ ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin" });
      yield* env.preWarm("Ubuntu");
    }).pipe(
      Effect.provide(
        wslLayerTest({
          isAvailable: true,
          distros: [{ name: "Ubuntu", version: 2, isDefault: true }],
          windowsToWslPath: () => Option.some("/mnt/c/repo"),
          getUserHome: () => Option.some("/home/josh"),
          getDistroIp: () => Option.some("172.20.10.2"),
          ensureNodePty: () => ({ ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin" }),
        }),
      ),
    ),
  );

  it.effect("falls back to safe defaults and surfaces a configured distro-list error", () =>
    Effect.gen(function* () {
      const env = yield* DesktopWslEnvironment;
      expect(yield* env.isAvailable).toBe(false);
      expect(yield* env.listDistros).toEqual([]);
      expect(yield* env.windowsToWslPath("Ubuntu", "C:/repo")).toStrictEqual(Option.none());
      expect(yield* env.getUserHome("Ubuntu")).toStrictEqual(Option.none());
      expect(yield* env.getDistroIp("Ubuntu")).toStrictEqual(Option.none());
      const ensured = yield* env.ensureNodePty("Ubuntu", "C:/repo");
      expect(ensured.ok).toBe(false);
      const listError = yield* env.probeDistros.pipe(Effect.flip);
      expect(listError).toBeInstanceOf(DesktopWslDistroListError);
    }).pipe(
      Effect.provide(
        wslLayerTest({
          distroListError: new DesktopWslDistroListError({ reason: "boom" }),
        }),
      ),
    ),
  );
});
