import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

const successOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const stubNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const makeScannerLayer = (
  platform: NodeJS.Platform,
  run: ProcessRunner.ProcessRunner["Service"]["run"],
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        stubNet,
        Layer.succeed(HostProcessPlatform, platform),
      ),
    ),
  );
const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "PowerShell is not installed in the test environment",
        }),
      }),
    ),
});

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(TestProcessRunner, Net.layer, Layer.succeed(HostProcessPlatform, "win32")),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

effectIt.effect("scan() falls back to common-port probes when lsof fails on posix", () => {
  const layer = makeScannerLayer("linux", (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "lsof is not installed in the test environment",
        }),
      }),
    ),
  );
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    // stubNet reports every port as available (nothing listening) so the
    // common-port fallback yields an empty snapshot without opening sockets.
    const result = yield* scanner.scan();
    expect(result).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "scan() parses lsof -F output, dedupes, sorts, and attributes terminals on posix",
  () => {
    const lsof = [
      "p1000",
      "cnode",
      "n127.0.0.1:5173",
      "n*:5173", // duplicate port -> ignored
      "p2000",
      "cvite",
      "n[::1]:3000",
      "p3000",
      "cother",
      "n192.168.1.5:9999", // non-local host -> skipped
      "p-1", // invalid pid -> null
      "nlocalhost:8080",
      "", // blank line -> skipped
    ].join("\n");
    const layer = makeScannerLayer("linux", () => Effect.succeed(successOutput(lsof)));
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-x",
        terminalId: "term-1",
        processIds: [2000],
      });
      const result = yield* scanner.scan();

      expect(result.map((server) => server.port)).toEqual([3000, 5173, 8080]);
      const byPort = new Map(result.map((server) => [server.port, server]));
      expect(byPort.get(5173)).toMatchObject({
        host: "localhost",
        url: "http://localhost:5173",
        processName: "node",
        pid: 1000,
        terminal: null,
      });
      expect(byPort.get(3000)?.terminal).toEqual({ threadId: "thread-x", terminalId: "term-1" });
      expect(byPort.get(8080)).toMatchObject({ pid: null, terminal: null });
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("scan() parses Windows listener output, dedupes, and attributes terminals", () => {
  const listeners = [
    "127.0.0.1|5173|1000|node",
    "::|3000|2000|vite",
    "0.0.0.0|3000|2000|vite", // duplicate port -> ignored
    "10.0.0.1|9999|3|bad", // non-local host -> skipped
    "localhost|8080|0|zero", // pid 0 -> null
  ].join("\r\n");
  const layer = makeScannerLayer("win32", () => Effect.succeed(successOutput(listeners)));
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-win",
      terminalId: "term-2",
      processIds: [1000],
    });
    const result = yield* scanner.scan();

    expect(result.map((server) => server.port)).toEqual([3000, 5173, 8080]);
    const byPort = new Map(result.map((server) => [server.port, server]));
    expect(byPort.get(5173)).toMatchObject({
      host: "localhost",
      url: "http://localhost:5173",
      processName: "node",
      pid: 1000,
    });
    expect(byPort.get(5173)?.terminal).toEqual({ threadId: "thread-win", terminalId: "term-2" });
    expect(byPort.get(3000)?.terminal).toBe(null);
    expect(byPort.get(8080)).toMatchObject({ pid: null, terminal: null });
  }).pipe(Effect.provide(layer));
});

effectIt.effect("registerTerminalProcesses filters invalid pids and unregisters cleanly", () => {
  const lsof = ["p2000", "cvite", "nlocalhost:3000"].join("\n");
  const layer = makeScannerLayer("linux", () => Effect.succeed(successOutput(lsof)));
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;

    // Only invalid pids -> registration is dropped (size === 0 branch).
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-a",
      terminalId: "term-a",
      processIds: [0, -3],
    });
    let result = yield* scanner.scan();
    expect(result[0]?.terminal).toBe(null);

    // Valid pid -> attributed.
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-a",
      terminalId: "term-a",
      processIds: [2000, 0, -1],
    });
    result = yield* scanner.scan();
    expect(result[0]?.terminal).toEqual({ threadId: "thread-a", terminalId: "term-a" });

    // Empty processIds -> removes the registration.
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-a",
      terminalId: "term-a",
      processIds: [],
    });
    result = yield* scanner.scan();
    expect(result[0]?.terminal).toBe(null);

    // Re-register then explicitly unregister.
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-a",
      terminalId: "term-a",
      processIds: [2000],
    });
    yield* scanner.unregisterTerminal({ threadId: "thread-a", terminalId: "term-a" });
    result = yield* scanner.scan();
    expect(result[0]?.terminal).toBe(null);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "retain triggers an immediate scan and broadcasts only when the snapshot changes",
  () => {
    let stdout = "p1000\ncnode\nn127.0.0.1:5173\n";
    const layer = makeScannerLayer("linux", () => Effect.succeed(successOutput(stdout)));
    const received: ReadonlyArray<ReadonlyArray<number>> = [];
    const push = (ports: ReadonlyArray<number>) =>
      (received as Array<ReadonlyArray<number>>).push(ports);
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => push(servers.map((server) => server.port))),
      );

      yield* Effect.scoped(scanner.retain); // idle -> immediate scan -> broadcast [5173]
      stdout = "p1000\ncnode\nn127.0.0.1:3000\n";
      yield* Effect.scoped(scanner.retain); // equal length, different port -> broadcast [3000]
      yield* Effect.scoped(scanner.retain); // identical snapshot -> no broadcast

      expect(received).toEqual([[5173], [3000]]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("a nested retain does not trigger a second immediate scan", () => {
  const layer = makeScannerLayer("linux", () =>
    Effect.succeed(successOutput("p1000\ncnode\nn127.0.0.1:5173\n")),
  );
  const received: ReadonlyArray<ReadonlyArray<number>> = [];
  const push = (ports: ReadonlyArray<number>) =>
    (received as Array<ReadonlyArray<number>>).push(ports);
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.subscribe((servers) =>
      Effect.sync(() => push(servers.map((server) => server.port))),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* scanner.retain; // idle -> scans + broadcasts once
        yield* scanner.retain; // already retained -> no additional scan
      }),
    );
    expect(received).toEqual([[5173]]);
  }).pipe(Effect.provide(layer));
});
