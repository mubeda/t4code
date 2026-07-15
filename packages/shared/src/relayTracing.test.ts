import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/unstable/http";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext";
import { vi } from "vite-plus/test";

import {
  makeNonInterferingRelayTracer,
  makeRelayClientTracingLayer,
  RelayClientTracer,
  withRelayClientTracing,
} from "./relayTracing.ts";

const decodeJsonUnknown = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

describe("withRelayClientTracing", () => {
  it("forwards the delegate tracer context callback", () => {
    const base = collectingTracer([]);
    const context = (<X>() => "delegate-context" as X) satisfies NonNullable<
      Tracer.Tracer["context"]
    >;
    const delegate = Tracer.make({
      span: base.span.bind(base),
      context,
    });

    expect(makeNonInterferingRelayTracer(delegate).context).toBe(context);
  });

  it.effect("uses the product tracer only for relay operations", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);
      const productTracer = collectingTracer(productSpans);

      yield* Effect.void.pipe(Effect.withSpan("user.operation"), Effect.withTracer(userTracer));
      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["user.operation"]);
      expect(productSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("preserves the active tracer when product tracing is disabled", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const userTracer = collectingTracer(userSpans);

      yield* Effect.void.pipe(
        Effect.withSpan("relay.operation"),
        withRelayClientTracing,
        Effect.withTracer(userTracer),
      );

      expect(userSpans).toEqual(["relay.operation"]);
    }),
  );

  it.effect("installs an explicitly disabled relay tracer layer", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(null, {
      serviceName: "relay-disabled",
      runtime: "test",
      client: "test",
    }).pipe(Layer.provide(httpClientLayer));

    return RelayClientTracer.pipe(
      Effect.provide(tracingLayer),
      Effect.map((tracer) => {
        expect(Option.isNone(tracer)).toBe(true);
        expect(fetchFn).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect("exports configured resources and valid nested W3C parentage", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://collector.test/v1/traces",
        tracesDataset: "relay-dataset",
        tracesToken: "relay-ingest-token",
      },
      {
        serviceName: "relay-client-test",
        serviceVersion: "1.2.3",
        runtime: "browser",
        client: "web",
        component: "connection-supervisor",
      },
    ).pipe(Layer.provide(httpClientLayer));
    const parent = HttpTraceContext.fromHeaders(
      Headers.fromRecordUnsafe({
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        tracestate: "vendor=value",
        baggage: "credential=private",
      }),
    );
    const unsampledParent = HttpTraceContext.fromHeaders(
      Headers.fromRecordUnsafe({
        traceparent: "00-fedcba9876543210fedcba9876543210-fedcba9876543210-00",
      }),
    );
    expect(Option.isSome(parent)).toBe(true);
    expect(Option.isSome(unsampledParent)).toBe(true);
    expect(HttpTraceContext.fromHeaders(Headers.empty)).toEqual(Option.none());
    expect(
      HttpTraceContext.fromHeaders(Headers.fromRecordUnsafe({ traceparent: "malformed" })),
    ).toEqual(Option.none());
    if (Option.isNone(parent) || Option.isNone(unsampledParent)) return Effect.void;

    const tracedApplication = Layer.effectDiscard(
      Effect.void.pipe(
        Effect.withSpan("relay.child"),
        Effect.withSpan("relay.parent", { parent: parent.value, kind: "client" }),
        Effect.andThen(
          Effect.void.pipe(Effect.withSpan("relay.unsampled", { parent: unsampledParent.value })),
        ),
        withRelayClientTracing,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          expect(fetchFn).toHaveBeenCalledOnce();
          expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://collector.test/v1/traces");
          const headers = new globalThis.Headers(fetchFn.mock.calls[0]?.[1]?.headers);
          expect(headers.get("authorization")).toBe("Bearer relay-ingest-token");
          expect(headers.get("x-axiom-dataset")).toBe("relay-dataset");
          const payloadText = new TextDecoder().decode(
            fetchFn.mock.calls[0]?.[1]?.body as Uint8Array,
          );
          expect(payloadText).not.toContain("relay-ingest-token");
          expect(payloadText).not.toContain("credential=private");
          expect(payloadText).not.toContain("vendor=value");
          const payload = decodeJsonUnknown(payloadText) as {
            resourceSpans: Array<{
              resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
              scopeSpans: Array<{
                spans: Array<{
                  name: string;
                  traceId: string;
                  spanId: string;
                  parentSpanId?: string;
                }>;
              }>;
            }>;
          };
          const resourceAttributes = Object.fromEntries(
            payload.resourceSpans[0]?.resource.attributes.map((entry) => [
              entry.key,
              entry.value.stringValue,
            ]) ?? [],
          );
          expect(resourceAttributes).toMatchObject({
            "service.name": "relay-client-test",
            "service.version": "1.2.3",
            "service.runtime": "browser",
            "service.component": "connection-supervisor",
            "t4code.client.surface": "web",
          });
          const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
          expect(spans.map((span) => span.name).sort()).toEqual(["relay.child", "relay.parent"]);
          const root = spans.find((span) => span.name === "relay.parent");
          const child = spans.find((span) => span.name === "relay.child");
          expect(root?.traceId).toBe(parent.value.traceId);
          expect(root?.parentSpanId).toBe(parent.value.spanId);
          expect(child?.traceId).toBe(parent.value.traceId);
          expect(child?.parentSpanId).toBe(root?.spanId);
        }),
      ),
    );
  });

  it.effect("sanitizes every relay exit without changing application outcomes", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      {
        serviceName: "relay-test",
        runtime: "test",
        client: "test",
      },
    ).pipe(Layer.provide(httpClientLayer));
    const noStack = new Error("failure without stack");
    Object.defineProperty(noStack, "stack", { value: undefined });
    const trimmed = new Error("trimmed failure");
    trimmed.stack = [
      "Error: trimmed failure",
      "    at user-code.ts:1:1",
      "    at Generator.next",
      "    at secret=must-not-export",
    ].join("\n");
    const cyclic: { message: string; cause?: unknown } = { message: "cyclic failure" };
    cyclic.cause = cyclic;
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile failure inspection");
        },
      },
    );
    const hostileString = {
      toString() {
        throw new Error("hostile toString");
      },
    };
    const outcomes: Array<Exit.Exit<unknown, unknown>> = [];
    const tracedApplication = Layer.effectDiscard(
      Effect.gen(function* () {
        outcomes.push(
          yield* Effect.void.pipe(Effect.withSpan("relay.success"), Effect.exit),
          yield* Effect.fail(noStack).pipe(Effect.withSpan("relay.no-stack"), Effect.exit),
          yield* Effect.fail(trimmed).pipe(Effect.withSpan("relay.trimmed"), Effect.exit),
          yield* Effect.fail({
            name: "StructuredFailure",
            message: "structured failure",
            cause: 42,
          }).pipe(Effect.withSpan("relay.structured"), Effect.exit),
          yield* Effect.fail({ message: 123 }).pipe(
            Effect.withSpan("relay.non-string-message"),
            Effect.exit,
          ),
          yield* Effect.fail(cyclic).pipe(Effect.withSpan("relay.cyclic"), Effect.exit),
          yield* Effect.die(42).pipe(Effect.withSpan("relay.defect"), Effect.exit),
          yield* Effect.interrupt.pipe(Effect.withSpan("relay.interrupted"), Effect.exit),
          yield* Effect.fail(hostile).pipe(Effect.withSpan("relay.hostile"), Effect.exit),
          yield* Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason({ message: "first combined", status: 409 }),
              Cause.makeFailReason({ message: "second combined", status: 410 }),
              Cause.makeDieReason({ message: "combined defect", status: 500 }),
            ]),
          ).pipe(Effect.withSpan("relay.combined"), Effect.exit),
          yield* Effect.fail(hostileString).pipe(
            Effect.withSpan("relay.hostile-string"),
            Effect.exit,
          ),
        );
      }).pipe(withRelayClientTracing),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          expect(outcomes).toHaveLength(11);
          expect(Exit.isSuccess(outcomes[0]!)).toBe(true);
          expect(outcomes.slice(1).every(Exit.isFailure)).toBe(true);
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(payload).toContain("StructuredFailure");
          expect(payload).toContain("cyclic failure");
          expect(payload).toContain("relay.interrupted");
          expect(payload).not.toContain("must-not-export");
          expect(payload).toContain("relay.hostile");
          expect(payload).toContain("[Unserializable]");
        }),
      ),
    );
  });

  it.effect("preserves nested error causes in exported relay spans", () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      {
        serviceName: "relay-test",
        runtime: "test",
        client: "test",
      },
    ).pipe(Layer.provide(httpClientLayer));
    const rootCause = new Error("relay socket closed");
    const failure = new Error("relay request failed", { cause: rootCause });
    const tracedApplication = Layer.effectDiscard(
      Effect.fail(failure).pipe(
        Effect.withSpan("relay.failed-operation"),
        withRelayClientTracing,
        Effect.exit,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          expect(fetchFn).toHaveBeenCalledOnce();
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(payload).toContain("relay request failed");
          expect(payload).toContain("relay socket closed");
        }),
      ),
    );
  });

  it.effect("redacts credentials and prompt payloads from exported relay failures", () => {
    const secrets = [
      "relay-private-value",
      "relay-url-password",
      "relay-access-token",
      "relay-refresh-token",
      "relay-id-token",
      "relay-cookie-value",
      "relay-second-cookie-value",
      "relay-set-cookie-value",
    ] as const;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const httpClientLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    );
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      {
        serviceName: "relay-test",
        runtime: "test",
        client: "test",
      },
    ).pipe(Layer.provide(httpClientLayer));
    const cause = new Error(
      `refresh failed https://relay.test/token?refresh_token=${secrets[3]}&safe=cause-visible`,
    );
    const failure = new Error(
      `relay failed status=503, cOoKiE=session=${secrets[5]}; refresh=${secrets[6]}, token=${secrets[0]} prompt=${secrets[0]} https://reader:${secrets[1]}@relay.test/status?access-token=${secrets[2]}&ID_TOKEN=${secrets[4]}&safe=visible`,
      { cause },
    );
    failure.name = "RelayHttpError";
    failure.stack = [
      `${failure.name}: ${failure.message}`,
      `cOoKiE: session=${secrets[5]}; refresh=${secrets[6]}; theme=dark`,
      `SET-COOKIE: response=${secrets[7]}; secondary=${secrets[6]}; Path=/; HttpOnly`,
      "status-context=preserved",
    ].join("\n");
    const tracedApplication = Layer.effectDiscard(
      Effect.fail(failure).pipe(
        Effect.withSpan("relay.redacted-failure"),
        withRelayClientTracing,
        Effect.exit,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          for (const secret of secrets) {
            expect(payload).not.toContain(secret);
          }
          expect(payload).toContain("token=[REDACTED]");
          expect(payload).toContain("prompt=[REDACTED]");
          expect(payload).toContain("RelayHttpError");
          expect(payload).toContain("status=503");
          expect(payload).toContain("relay.test/status");
          expect(payload).toContain("safe=visible");
          expect(payload).toContain("relay.test/token");
          expect(payload).toContain("safe=cause-visible");
          expect(payload).toContain("status-context=preserved");
          expect(payload).not.toContain("theme=dark");
        }),
      ),
    );
  });

  it.effect(
    "exports sanitized structured relay error context that is absent from message text",
    () => {
      const urlPassword = "property-url-password";
      const accessToken = "property-access-token";
      const responseToken = "property-response-token";
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
      const httpClientLayer = FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
      );
      const tracingLayer = makeRelayClientTracingLayer(
        {
          tracesUrl: "https://api.axiom.test/v1/traces",
          tracesDataset: "relay-traces",
          tracesToken: "public-ingest-token",
        },
        {
          serviceName: "relay-test",
          runtime: "test",
          client: "test",
        },
      ).pipe(Layer.provide(httpClientLayer));
      const failure = Object.assign(new Error("property-only relay failure"), {
        name: "RelayPropertyError",
        status: 429,
        statusCode: 503,
        url: `https://reader:${urlPassword}@relay.test/property?access_token=${accessToken}&safe=visible`,
        responseURL: `https://relay.test/response?refresh_token=${responseToken}&result=retry`,
        host: "relay.test",
        path: `/property?access_token=${accessToken}&safe=path-visible`,
      });
      const tracedApplication = Layer.effectDiscard(
        Effect.fail(failure).pipe(
          Effect.withSpan("relay.structured-context"),
          withRelayClientTracing,
          Effect.exit,
        ),
      ).pipe(Layer.provide(tracingLayer));

      return Layer.build(tracedApplication).pipe(
        Effect.scoped,
        Effect.andThen(
          Effect.sync(() => {
            const payloadText = new TextDecoder().decode(
              fetchFn.mock.calls[0]?.[1]?.body as Uint8Array,
            );
            const payload = decodeJsonUnknown(payloadText) as {
              resourceSpans: Array<{
                scopeSpans: Array<{
                  spans: Array<{
                    name: string;
                    attributes: Array<{
                      key: string;
                      value: { intValue?: number | string; stringValue?: string };
                    }>;
                  }>;
                }>;
              }>;
            };
            const span = payload.resourceSpans[0]?.scopeSpans[0]?.spans.find(
              (candidate) => candidate.name === "relay.structured-context",
            );
            const attributes = Object.fromEntries(
              span?.attributes.map((attribute) => [attribute.key, attribute.value]) ?? [],
            );

            expect(attributes["error.status"]?.intValue).toBe(429);
            expect(attributes["error.status_code"]?.intValue).toBe(503);
            expect(attributes["error.url"]?.stringValue).toContain("relay.test/property");
            expect(attributes["error.url"]?.stringValue).toContain("safe=visible");
            expect(attributes["error.response_url"]?.stringValue).toContain("relay.test/response");
            expect(attributes["error.response_url"]?.stringValue).toContain("result=retry");
            expect(attributes["error.host"]?.stringValue).toBe("relay.test");
            expect(attributes["error.path"]?.stringValue).toContain("safe=path-visible");
            expect(payloadText).toContain("RelayPropertyError");
            expect(payloadText).toContain("property-only relay failure");
            expect(payloadText).not.toContain(urlPassword);
            expect(payloadText).not.toContain(accessToken);
            expect(payloadText).not.toContain(responseToken);
          }),
        ),
      );
    },
  );

  it.effect("reads relay error getters once and skips toString when message is present", () => {
    const reads = new Map<string, number>();
    const count = (key: string): void => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
    };
    let parentToStringCalls = 0;
    let causeToStringCalls = 0;
    let throwingToStringCalls = 0;
    const throwingMessage = new Error("initial message");
    Object.defineProperty(throwingMessage, "message", {
      get() {
        count("throwing.message");
        throw new Error("hostile message getter");
      },
    });
    Object.defineProperty(throwingMessage, "toString", {
      value() {
        throwingToStringCalls += 1;
        return "must not call Error toString after message getter failure";
      },
    });
    const cause = {
      get message() {
        count("cause.message");
        return undefined;
      },
      get status() {
        count("cause.status");
        throw new Error("hostile nested status getter");
      },
      get cause() {
        count("cause.cause");
        return throwingMessage;
      },
      toString() {
        causeToStringCalls += 1;
        return "nested cause visible";
      },
    };
    const failure: Record<string, unknown> = {
      toString() {
        parentToStringCalls += 1;
        return "parent toString must not run";
      },
    };
    for (const [key, value] of Object.entries({
      message: "getter-backed relay failure",
      name: "GetterRelayError",
      stack: "GetterRelayError: getter-backed relay failure\n    at relay.test",
      cause,
      status: 429,
      statusCode: 503,
      url: "https://user:password@relay.test/getter?access_token=private&safe=visible",
      host: "relay.test",
      path: "/getter?refresh_token=private&safe=path",
    })) {
      Object.defineProperty(failure, key, {
        enumerable: true,
        get() {
          count(key);
          return value;
        },
      });
    }
    Object.defineProperty(failure, "responseURL", {
      enumerable: true,
      get() {
        count("responseURL");
        throw new Error("hostile response URL getter");
      },
    });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      { serviceName: "relay-test", runtime: "test", client: "test" },
    ).pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    );
    const tracedApplication = Layer.effectDiscard(
      Effect.fail(failure).pipe(
        Effect.withSpan("relay.getter-counts"),
        withRelayClientTracing,
        Effect.exit,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          for (const key of [
            "message",
            "name",
            "stack",
            "cause",
            "status",
            "statusCode",
            "url",
            "responseURL",
            "host",
            "path",
            "cause.message",
            "cause.status",
            "cause.cause",
            "throwing.message",
          ]) {
            expect(reads.get(key), key).toBe(1);
          }
          expect(parentToStringCalls).toBe(0);
          expect(causeToStringCalls).toBe(1);
          expect(throwingToStringCalls).toBe(0);
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(payload).toContain("getter-backed relay failure");
          expect(payload).toContain("nested cause visible");
          expect(payload).toContain("safe=visible");
          expect(payload).not.toContain("password");
          expect(payload).not.toContain("private");
        }),
      ),
    );
  });

  it.effect("caches repeated and cyclic relay error reads across the complete Cause", () => {
    const reads = new Map<string, number>();
    const count = (key: string): void => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
    };
    let toStringCalls = 0;
    const repeated: Record<string, unknown> = {};
    Object.defineProperties(repeated, {
      message: {
        enumerable: true,
        get() {
          count("message");
          return undefined;
        },
      },
      name: {
        enumerable: true,
        get() {
          count("name");
          return "RepeatedRelayError";
        },
      },
      stack: {
        enumerable: true,
        get() {
          count("stack");
          return undefined;
        },
      },
      status: {
        enumerable: true,
        get() {
          count("status");
          return 502;
        },
      },
      cause: {
        enumerable: true,
        get() {
          count("cause");
          return repeated;
        },
      },
      toString: {
        get() {
          count("toString.get");
          return () => {
            toStringCalls += 1;
            return "repeated relay failure";
          };
        },
      },
    });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const tracingLayer = makeRelayClientTracingLayer(
      {
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "relay-traces",
        tracesToken: "public-ingest-token",
      },
      { serviceName: "relay-test", runtime: "test", client: "test" },
    ).pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    );
    const combined = Cause.fromReasons([
      Cause.makeFailReason(repeated),
      Cause.makeDieReason(repeated),
      Cause.makeFailReason(repeated),
    ]);
    const tracedApplication = Layer.effectDiscard(
      Effect.failCause(combined).pipe(
        Effect.withSpan("relay.repeated-cause"),
        withRelayClientTracing,
        Effect.exit,
      ),
    ).pipe(Layer.provide(tracingLayer));

    return Layer.build(tracedApplication).pipe(
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          for (const key of ["message", "name", "stack", "status", "cause", "toString.get"]) {
            expect(reads.get(key), key).toBe(1);
          }
          expect(toStringCalls).toBe(1);
          const payload = new TextDecoder().decode(fetchFn.mock.calls[0]?.[1]?.body as Uint8Array);
          expect(payload).toContain("repeated relay failure");
          expect(payload).toContain("RepeatedRelayError");
          expect(payload).toContain("502");
        }),
      ),
    );
  });
});
