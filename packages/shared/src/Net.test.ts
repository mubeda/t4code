import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { afterEach, vi } from "vite-plus/test";

import * as NetService from "./Net.ts";

const netMocks = vi.hoisted(() => ({
  actualCreateConnection: undefined as typeof import("node:net").createConnection | undefined,
  actualCreateServer: undefined as typeof import("node:net").createServer | undefined,
  createConnection: vi.fn<typeof import("node:net").createConnection>(),
  createServer: vi.fn<typeof import("node:net").createServer>(),
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  netMocks.actualCreateConnection = actual.createConnection;
  netMocks.actualCreateServer = actual.createServer;
  netMocks.createConnection.mockImplementation(actual.createConnection);
  netMocks.createServer.mockImplementation(actual.createServer);
  return {
    ...actual,
    createConnection: netMocks.createConnection,
    createServer: netMocks.createServer,
  };
});

type ListenOutcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Success"; readonly address: NodeNet.AddressInfo | string | null }
  | { readonly _tag: "Error"; readonly cause: unknown };

class FakeServer extends NodeEvents.EventEmitter {
  closeCalls = 0;
  closeCallbackCalls = 0;
  listenCallbackCalls = 0;
  listeningEvents = 0;
  private addressValue: NodeNet.AddressInfo | string | null = null;
  private readonly outcome: ListenOutcome;
  private readonly holdCloseCallback: boolean;
  private readonly pendingCloseCallbacks: Array<() => void> = [];
  private readonly throwOnClose: boolean;
  private transitioned = false;

  constructor(outcome: ListenOutcome, throwOnClose = false, holdCloseCallback = false) {
    super();
    this.outcome = outcome;
    this.throwOnClose = throwOnClose;
    this.holdCloseCallback = holdCloseCallback;
  }

  static pending(options?: {
    readonly holdCloseCallback?: boolean;
    readonly throwOnClose?: boolean;
  }): FakeServer {
    return new FakeServer({ _tag: "Pending" }, options?.throwOnClose, options?.holdCloseCallback);
  }

  static success(address: NodeNet.AddressInfo | string | null = null): FakeServer {
    return new FakeServer({ _tag: "Success", address });
  }

  static error(cause: unknown): FakeServer {
    return new FakeServer({ _tag: "Error", cause });
  }

  unref(): this {
    return this;
  }

  listen(...args: ReadonlyArray<unknown>): this {
    const callback = args.findLast((entry) => typeof entry === "function") as
      | (() => void)
      | undefined;
    if (callback) {
      this.once("listening", () => {
        this.listenCallbackCalls += 1;
        callback();
      });
    }
    if (this.outcome._tag !== "Pending") {
      const outcome = this.outcome;
      queueMicrotask(() => this.transition(outcome));
    }
    return this;
  }

  succeed(address: NodeNet.AddressInfo | string | null = null): void {
    this.transition({ _tag: "Success", address });
  }

  fail(cause: unknown): void {
    this.transition({ _tag: "Error", cause });
  }

  address(): NodeNet.AddressInfo | string | null {
    return this.addressValue;
  }

  close(callback?: () => void): this {
    this.closeCalls += 1;
    if (this.throwOnClose) {
      throw new Error("close failed");
    }
    const complete = () => {
      this.closeCallbackCalls += 1;
      callback?.();
    };
    if (this.holdCloseCallback) {
      this.pendingCloseCallbacks.push(complete);
    } else {
      queueMicrotask(complete);
    }
    return this;
  }

  get pendingCloseCallbackCount(): number {
    return this.pendingCloseCallbacks.length;
  }

  releaseCloseCallback(): void {
    const complete = this.pendingCloseCallbacks.shift();
    if (!complete) {
      throw new Error("No pending close callback to release");
    }
    queueMicrotask(complete);
  }

  private transition(outcome: Exclude<ListenOutcome, { readonly _tag: "Pending" }>): void {
    if (this.transitioned) {
      throw new Error("A net.Server listen attempt can only settle once");
    }
    this.transitioned = true;
    if (outcome._tag === "Error") {
      this.emit("error", outcome.cause);
      return;
    }
    this.addressValue = outcome.address;
    this.listeningEvents += 1;
    this.emit("listening");
  }
}

type SocketNotification =
  | { readonly _tag: "Connect" }
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Error"; readonly cause: unknown };

type SocketPlan =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Queued"; readonly notifications: ReadonlyArray<SocketNotification> };

class FakeSocket extends NodeEvents.EventEmitter {
  destroyCalls = 0;
  private readonly plan: SocketPlan;

  constructor(plan: SocketPlan) {
    super();
    this.plan = plan;
  }

  static pending(): FakeSocket {
    return new FakeSocket({ _tag: "Pending" });
  }

  static connect(): FakeSocket {
    return new FakeSocket({ _tag: "Queued", notifications: [{ _tag: "Connect" }] });
  }

  static timeout(late: ReadonlyArray<SocketNotification> = []): FakeSocket {
    return new FakeSocket({
      _tag: "Queued",
      notifications: [{ _tag: "Timeout" }, ...late],
    });
  }

  static error(cause: unknown): FakeSocket {
    return new FakeSocket({
      _tag: "Queued",
      notifications: [{ _tag: "Error", cause }],
    });
  }

  unref(): this {
    return this;
  }

  setTimeout(_timeout: number): this {
    if (this.plan._tag === "Queued") {
      this.queueNotifications(...this.plan.notifications);
    }
    return this;
  }

  queueNotifications(...notifications: ReadonlyArray<SocketNotification>): void {
    for (const notification of notifications) {
      queueMicrotask(() => this.notify(notification));
    }
  }

  destroy(): this {
    this.destroyCalls += 1;
    return this;
  }

  private notify(notification: SocketNotification): void {
    switch (notification._tag) {
      case "Connect":
        this.emit("connect");
        break;
      case "Timeout":
        this.emit("timeout");
        break;
      case "Error":
        this.emit("error", notification.cause);
        break;
    }
  }
}

const asServer = (server: FakeServer): NodeNet.Server => server as unknown as NodeNet.Server;
const asSocket = (socket: FakeSocket): NodeNet.Socket => socket as unknown as NodeNet.Socket;
const fakePort = (offset = 0): number => 1 + ((process.pid + offset) % 60_000);
const fakeAddress = (port: number): NodeNet.AddressInfo => ({
  address: "127.0.0.1",
  family: "IPv4",
  port,
});

afterEach(() => {
  netMocks.createConnection.mockReset();
  netMocks.createServer.mockReset();
  if (netMocks.actualCreateConnection) {
    netMocks.createConnection.mockImplementation(netMocks.actualCreateConnection);
  }
  if (netMocks.actualCreateServer) {
    netMocks.createServer.mockImplementation(netMocks.actualCreateServer);
  }
});

const closeServer = (server: NodeNet.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {
      // Ignore cleanup failures in tests.
    }
  });

const getPort = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const observeFiberExit = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const observedExit = yield* Deferred.make<Exit.Exit<A, E>>();
    yield* Effect.forkChild(
      Fiber.await(fiber).pipe(Effect.flatMap((exit) => Deferred.succeed(observedExit, exit))),
    );
    yield* Effect.yieldNow;
    return observedExit;
  });

const openServer = (host: string): Effect.Effect<NodeNet.Server, NetService.NetError> =>
  Effect.callback<NodeNet.Server, NetService.NetError>((resume) => {
    const createServer = netMocks.actualCreateServer;
    if (!createServer) {
      resume(Effect.fail(new NetService.NetError({ message: "Node net module unavailable" })));
      return;
    }
    const server = createServer();
    server.once("error", (cause) => {
      resume(
        Effect.fail(new NetService.NetError({ message: "Failed to open test server", cause })),
      );
    });
    server.listen(0, host, () => resume(Effect.succeed(server)));
    return closeServer(server);
  });

it.layer(NetService.layer)("NetService", (it) => {
  describe("Net helpers", () => {
    it.effect("reserves a positive port with a real loopback smoke check", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const port = yield* net.reserveLoopbackPort();
        assert.ok(port > 0);
      }),
    );

    it.effect("reports a real occupied IPv4 loopback port as unavailable", () =>
      Effect.acquireUseRelease(
        openServer("127.0.0.1"),
        (server) =>
          Effect.gen(function* () {
            const net = yield* NetService.NetService;
            assert.equal(yield* net.isPortAvailableOnLoopback(getPort(server)), false);
          }),
        closeServer,
      ),
    );

    it.effect("models successful listen and asynchronous close as one lifecycle", () =>
      Effect.gen(function* () {
        const server = FakeServer.success();
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.canListenOnHost(0, "127.0.0.1"), true);
        assert.equal(server.listeningEvents, 1);
        assert.equal(server.closeCalls, 1);
        assert.equal(server.closeCallbackCalls, 1);
      }),
    );

    it.effect("settles a successful listen only after its held close callback", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending({ holdCloseCallback: true });
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.canListenOnHost(0, "127.0.0.1"));

        yield* Effect.yieldNow;
        server.succeed();
        yield* Effect.yieldNow;
        const observedExit = yield* observeFiberExit(fiber);
        assert.isTrue(Option.isNone(yield* Deferred.poll(observedExit)));
        assert.equal(server.closeCalls, 1);

        server.releaseCloseCallback();
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.isSuccess(exit));
        if (Exit.isSuccess(exit)) {
          assert.equal(exit.value, true);
        }
        assert.equal(server.closeCalls, 1);
        assert.equal(server.closeCallbackCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 0);
      }),
    );

    it.effect("closes once when interrupted while listen close is pending", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending({ holdCloseCallback: true });
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.canListenOnHost(0, "127.0.0.1"));

        yield* Effect.yieldNow;
        server.succeed();
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 1);
        const observedExit = yield* observeFiberExit(fiber);
        assert.isTrue(Option.isNone(yield* Deferred.poll(observedExit)));

        yield* Fiber.interrupt(fiber);
        assert.equal(server.closeCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 1);

        server.releaseCloseCallback();
        yield* Effect.yieldNow;
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.equal(server.closeCallbackCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 0);
      }),
    );

    it.effect("treats address absence as available and other listen errors as unavailable", () =>
      Effect.gen(function* () {
        const unavailable = FakeServer.error({ code: "EADDRNOTAVAIL" });
        const denied = FakeServer.error({ code: "EACCES" });
        const nonStringCode = FakeServer.error({ code: 13 });
        const nonObject = FakeServer.error(null);
        netMocks.createServer
          .mockReturnValueOnce(asServer(unavailable))
          .mockReturnValueOnce(asServer(denied))
          .mockReturnValueOnce(asServer(nonStringCode))
          .mockReturnValueOnce(asServer(nonObject));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.canListenOnHost(0, "::1"), true);
        assert.equal(yield* net.canListenOnHost(0, "127.0.0.1"), false);
        assert.equal(yield* net.canListenOnHost(0, "127.0.0.1"), false);
        assert.equal(yield* net.canListenOnHost(0, "127.0.0.1"), false);
        assert.equal(unavailable.listeningEvents, 0);
        assert.equal(unavailable.closeCalls, 0);
      }),
    );

    it.effect("ignores a valid late listening transition after cancellation", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending();
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.canListenOnHost(0, "127.0.0.1"));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        server.succeed();
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
      }),
    );

    it.effect("ignores a valid late listen error after cancellation", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending();
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.canListenOnHost(0, "127.0.0.1"));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        server.fail(new Error("queued listen failure"));
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
      }),
    );

    it.effect("ignores close failures while cancelling a pending listen", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending({ throwOnClose: true });
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.canListenOnHost(0, "127.0.0.1"));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        assert.equal(server.closeCalls, 1);
      }),
    );

    it.effect("combines IPv4 and IPv6 probe and bind outcomes", () =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;

        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.connect()))
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))));
        assert.equal(yield* net.isPortAvailableOnLoopback(0), false);

        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))))
          .mockReturnValueOnce(asSocket(FakeSocket.connect()));
        assert.equal(yield* net.isPortAvailableOnLoopback(0), false);

        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))))
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success()))
          .mockReturnValueOnce(asServer(FakeServer.error({ code: "EADDRNOTAVAIL" })));
        assert.equal(yield* net.isPortAvailableOnLoopback(0), true);

        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.timeout()))
          .mockReturnValueOnce(asSocket(FakeSocket.timeout()));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.error({ code: "EACCES" })))
          .mockReturnValueOnce(asServer(FakeServer.success()));
        assert.equal(yield* net.isPortAvailableOnLoopback(0), false);

        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))))
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success()))
          .mockReturnValueOnce(asServer(FakeServer.error({ code: "EACCES" })));
        assert.equal(yield* net.isPortAvailableOnLoopback(0), false);
      }),
    );

    it.effect("settles once when timeout is followed by a queued error notification", () =>
      Effect.gen(function* () {
        const ipv4 = FakeSocket.timeout([{ _tag: "Error", cause: new Error("queued refusal") }]);
        const ipv6 = FakeSocket.timeout();
        netMocks.createConnection
          .mockReturnValueOnce(asSocket(ipv4))
          .mockReturnValueOnce(asSocket(ipv6));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success()))
          .mockReturnValueOnce(asServer(FakeServer.success()));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.isPortAvailableOnLoopback(0), true);
        assert.equal(ipv4.destroyCalls, 1);
        assert.equal(ipv6.destroyCalls, 1);
      }),
    );

    it.effect("settles once when timeout is followed by a queued connect notification", () =>
      Effect.gen(function* () {
        const ipv4 = FakeSocket.timeout([{ _tag: "Connect" }]);
        const ipv6 = FakeSocket.timeout();
        netMocks.createConnection
          .mockReturnValueOnce(asSocket(ipv4))
          .mockReturnValueOnce(asSocket(ipv6));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success()))
          .mockReturnValueOnce(asServer(FakeServer.success()));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.isPortAvailableOnLoopback(0), true);
        assert.equal(ipv4.destroyCalls, 1);
        assert.equal(ipv6.destroyCalls, 1);
      }),
    );

    it.effect("destroys an acquired probe once after cancellation and late timeout/error", () =>
      Effect.gen(function* () {
        const socket = FakeSocket.pending();
        netMocks.createConnection.mockReturnValueOnce(asSocket(socket));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.isPortAvailableOnLoopback(0));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        socket.queueNotifications(
          { _tag: "Timeout" },
          { _tag: "Error", cause: new Error("queued refusal") },
        );
        yield* Effect.yieldNow;
        assert.equal(socket.destroyCalls, 1);
      }),
    );

    it.effect("destroys an acquired probe once after cancellation and a late connect", () =>
      Effect.gen(function* () {
        const socket = FakeSocket.pending();
        netMocks.createConnection.mockReturnValueOnce(asSocket(socket));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.isPortAvailableOnLoopback(0));

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        socket.queueNotifications({ _tag: "Connect" });
        yield* Effect.yieldNow;
        assert.equal(socket.destroyCalls, 1);
      }),
    );

    it.effect("reserves only after a successful listen transition", () =>
      Effect.gen(function* () {
        const port = fakePort();
        const server = FakeServer.success(fakeAddress(port));
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.reserveLoopbackPort(), port);
        assert.equal(server.listeningEvents, 1);
        assert.equal(server.listenCallbackCalls, 1);
        assert.equal(server.closeCallbackCalls, 1);
      }),
    );

    it.effect("settles a successful reservation only after its held close callback", () =>
      Effect.gen(function* () {
        const port = fakePort();
        const server = FakeServer.pending({ holdCloseCallback: true });
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.reserveLoopbackPort());

        yield* Effect.yieldNow;
        server.succeed(fakeAddress(port));
        yield* Effect.yieldNow;
        const observedExit = yield* observeFiberExit(fiber);
        assert.isTrue(Option.isNone(yield* Deferred.poll(observedExit)));
        assert.equal(server.closeCalls, 1);

        server.releaseCloseCallback();
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.isSuccess(exit));
        if (Exit.isSuccess(exit)) {
          assert.equal(exit.value, port);
        }
        assert.equal(server.closeCalls, 1);
        assert.equal(server.closeCallbackCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 0);
      }),
    );

    it.effect("closes once when interrupted while reservation close is pending", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending({ holdCloseCallback: true });
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.reserveLoopbackPort());

        yield* Effect.yieldNow;
        server.succeed(fakeAddress(fakePort()));
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 1);
        const observedExit = yield* observeFiberExit(fiber);
        assert.isTrue(Option.isNone(yield* Deferred.poll(observedExit)));

        yield* Fiber.interrupt(fiber);
        assert.equal(server.closeCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 1);

        server.releaseCloseCallback();
        yield* Effect.yieldNow;
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.equal(server.closeCallbackCalls, 1);
        assert.equal(server.pendingCloseCallbackCount, 0);
      }),
    );

    it.effect("fails reservation on listen error without entering the success lifecycle", () =>
      Effect.gen(function* () {
        const cause = new Error("listen failed");
        const server = FakeServer.error(cause);
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const error = yield* Effect.flip(net.reserveLoopbackPort());

        assert.equal(error.message, "Failed to reserve loopback port");
        assert.equal(error.cause, cause);
        assert.equal(server.listeningEvents, 0);
        assert.equal(server.listenCallbackCalls, 0);
        assert.equal(server.closeCalls, 0);
      }),
    );

    it.effect("rejects non-TCP reservation addresses", () =>
      Effect.gen(function* () {
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success("pipe-name")))
          .mockReturnValueOnce(asServer(FakeServer.success(null)));
        const net = yield* NetService.NetService;

        const stringError = yield* Effect.flip(net.reserveLoopbackPort());
        const nullError = yield* Effect.flip(net.reserveLoopbackPort());
        assert.equal(stringError.message, "Failed to reserve loopback port");
        assert.equal(stringError.cause, undefined);
        assert.equal(nullError.message, "Failed to reserve loopback port");
      }),
    );

    it.effect("does not re-close a reservation after cancellation wins", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending();
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.reserveLoopbackPort());

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        server.succeed(fakeAddress(fakePort()));
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
      }),
    );

    it.effect("ignores a valid late reservation error after cancellation", () =>
      Effect.gen(function* () {
        const server = FakeServer.pending();
        netMocks.createServer.mockReturnValueOnce(asServer(server));
        const net = yield* NetService.NetService;
        const fiber = yield* Effect.forkChild(net.reserveLoopbackPort());

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        server.fail(new Error("queued reservation failure"));
        yield* Effect.yieldNow;
        assert.equal(server.closeCalls, 1);
      }),
    );

    it.effect("selects the preferred port through deterministic probes", () =>
      Effect.gen(function* () {
        const preferred = fakePort();
        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))))
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))));
        netMocks.createServer
          .mockReturnValueOnce(asServer(FakeServer.success()))
          .mockReturnValueOnce(asServer(FakeServer.success()));
        const net = yield* NetService.NetService;

        assert.equal(yield* net.findAvailablePort(preferred), preferred);
      }),
    );

    it.effect("falls back to a deterministic reservation when preferred is occupied", () =>
      Effect.gen(function* () {
        const preferred = fakePort();
        const fallback = fakePort(1);
        netMocks.createConnection
          .mockReturnValueOnce(asSocket(FakeSocket.connect()))
          .mockReturnValueOnce(asSocket(FakeSocket.error(new Error("refused"))));
        netMocks.createServer.mockReturnValueOnce(
          asServer(FakeServer.success(fakeAddress(fallback))),
        );
        const net = yield* NetService.NetService;

        assert.equal(yield* net.findAvailablePort(preferred), fallback);
      }),
    );

    it.effect("reserves directly for non-positive preferences", () =>
      Effect.gen(function* () {
        const fallback = fakePort();
        netMocks.createServer.mockReturnValueOnce(
          asServer(FakeServer.success(fakeAddress(fallback))),
        );
        netMocks.createConnection.mockClear();
        const net = yield* NetService.NetService;

        assert.equal(yield* net.findAvailablePort(0), fallback);
        assert.equal(netMocks.createConnection.mock.calls.length, 0);
      }),
    );
  });
});
