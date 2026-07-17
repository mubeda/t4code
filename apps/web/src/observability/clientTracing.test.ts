import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  tracesUrl: "http://127.0.0.1:3000/api/observability/v1/traces",
  scope: { id: "scope" },
  tracerMarker: { id: "tracer-effect" },
  delegateExit: undefined as unknown,
  delegatePromise: null as Promise<unknown> | null,
  runtimes: [] as Array<{
    runSync: ReturnType<typeof vi.fn>;
    runPromiseExit: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  makeTracer: vi.fn(),
  closeScope: vi.fn(),
  warn: vi.fn(),
  delegateSpan: vi.fn(),
}));

vi.mock("effect/ManagedRuntime", () => ({
  make: () => {
    const runtime = {
      runSync: vi.fn(() => h.scope),
      runPromiseExit: vi.fn((effect: unknown) =>
        effect === h.tracerMarker
          ? (h.delegatePromise ?? Promise.resolve(h.delegateExit))
          : Promise.resolve({ _tag: "Success", value: undefined }),
      ),
      dispose: vi.fn(),
    };
    h.runtimes.push(runtime);
    return runtime;
  },
}));

vi.mock("effect/Scope", () => ({
  make: () => ({ id: "make-scope" }),
  provide: () => (effect: unknown) => effect,
  close: (...args: unknown[]) => {
    h.closeScope(...args);
    return { id: "close-effect" };
  },
}));

vi.mock("effect/unstable/observability", async () => {
  const Layer = await import("effect/Layer");
  return {
    OtlpSerialization: { layerJson: Layer.empty },
    OtlpTracer: {
      make: (options: unknown) => {
        h.makeTracer(options);
        return h.tracerMarker;
      },
    },
  };
});

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  settleAsyncResult: async (execute: () => Promise<unknown>) => {
    try {
      const exit = (await execute()) as {
        readonly _tag: "Success" | "Failure";
        readonly value?: unknown;
        readonly cause?: unknown;
      };
      return exit._tag === "Success"
        ? { _tag: "Success", value: exit.value }
        : { _tag: "Failure", cause: exit.cause };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  },
  squashAtomCommandFailure: (result: { readonly cause: unknown }) => result.cause,
}));

vi.mock("@t4code/client-runtime/errors", () => ({
  safeErrorLogAttributes: (error: unknown) => ({
    errorType: error instanceof Error ? "error" : "primitive",
  }),
}));

vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: () => h.tracesUrl,
}));

vi.mock("../environments/primary/httpLayer", async () => {
  const Layer = await import("effect/Layer");
  return { primaryEnvironmentHttpLayer: Layer.empty };
});

vi.mock("../env", () => ({ isTauri: false }));
vi.mock("~/branding", () => ({ APP_VERSION: "0.0.0-test" }));

import {
  __resetClientTracingForTests,
  ClientTracingLive,
  configureClientTracing,
} from "./clientTracing";

beforeEach(async () => {
  await __resetClientTracingForTests();
  h.delegateSpan.mockReset();
  h.delegateExit = Exit.succeed({ span: h.delegateSpan });
  h.delegatePromise = null;
  h.runtimes.length = 0;
  h.makeTracer.mockClear();
  h.closeScope.mockClear();
  h.warn.mockClear();
  vi.spyOn(console, "warn").mockImplementation(h.warn);
});

afterEach(async () => {
  await __resetClientTracingForTests();
  vi.restoreAllMocks();
});

describe("client tracing configuration", () => {
  it("configures once for the default interval and reuses the active exporter", async () => {
    await configureClientTracing();
    await configureClientTracing();
    await configureClientTracing({ exportIntervalMs: 1_000 });

    expect(h.makeTracer).toHaveBeenCalledOnce();
    expect(h.makeTracer).toHaveBeenCalledWith({
      url: h.tracesUrl,
      exportInterval: "1000 millis",
      resource: expect.objectContaining({ serviceName: "t4code-web" }),
    });
    expect(h.runtimes).toHaveLength(1);
  });

  it("clamps short intervals and disposes the previous exporter on reconfiguration", async () => {
    await configureClientTracing({ exportIntervalMs: 1 });
    await configureClientTracing({ exportIntervalMs: 25 });

    expect(h.makeTracer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ exportInterval: "10 millis" }),
    );
    expect(h.makeTracer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ exportInterval: "25 millis" }),
    );
    expect(h.runtimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(h.closeScope).toHaveBeenCalled();
  });

  it("logs exporter failures without exposing the full traces URL", async () => {
    h.tracesUrl = "https://trace-user:secret@traces.example.test:8443/private/path";
    h.delegateExit = Exit.die(new Error("exporter unavailable"));

    await configureClientTracing({ exportIntervalMs: 50 });

    expect(h.runtimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith("Failed to configure client tracing exporter", {
      scheme: "https",
      host: "traces.example.test",
      port: "8443",
      exportIntervalMs: 50,
      errorType: "primitive",
    });

    h.tracesUrl = "https://traces.example.test/another/path";
    await configureClientTracing({ exportIntervalMs: 60 });
    expect(h.warn).toHaveBeenLastCalledWith(
      "Failed to configure client tracing exporter",
      expect.objectContaining({ port: undefined }),
    );
  });

  it("disposes a completed exporter when reset makes its configuration stale", async () => {
    let resolveDelegate!: (exit: unknown) => void;
    h.delegatePromise = new Promise((resolve) => {
      resolveDelegate = resolve;
    });

    const configuring = configureClientTracing({ exportIntervalMs: 75 });
    await vi.waitFor(() => expect(h.runtimes).toHaveLength(1));
    await __resetClientTracingForTests();
    resolveDelegate(Exit.succeed({ span: vi.fn() }));
    await configuring;

    expect(h.runtimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("resets an active exporter and tolerates repeated empty resets", async () => {
    await configureClientTracing({ exportIntervalMs: 100 });

    await __resetClientTracingForTests();
    await __resetClientTracingForTests();

    expect(h.runtimes[0]?.dispose).toHaveBeenCalledOnce();
  });

  it.effect("uses a native span until an OTLP delegate is active", () =>
    Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer.pipe(Effect.provide(ClientTracingLive));
      const options = {
        name: "client-span",
        parent: Option.none<Tracer.AnySpan>(),
        annotations: Context.empty(),
        links: [],
        startTime: 1n,
        kind: "internal" as const,
        root: false,
        sampled: true,
      };

      expect(tracer.span(options)).toBeInstanceOf(Tracer.NativeSpan);

      const delegatedSpan = { id: "delegated-span" } as unknown as Tracer.Span;
      h.delegateSpan.mockReturnValue(delegatedSpan);
      yield* Effect.promise(() => configureClientTracing({ exportIntervalMs: 100 }));

      expect(tracer.span(options)).toBe(delegatedSpan);
      expect(h.delegateSpan).toHaveBeenCalledWith(options);
    }),
  );
});
