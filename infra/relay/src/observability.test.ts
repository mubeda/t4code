import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as State from "alchemy/State";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { OtlpTracer } from "effect/unstable/observability";

import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import { makeRelayTraceLayer, RelayObservability, withSpanAttributes } from "./observability.ts";

class SensitiveTelemetryError extends Schema.TaggedErrorClass<SensitiveTelemetryError>()(
  "SensitiveTelemetryError",
  {
    accessToken: Schema.String,
    privateKey: Schema.String,
    safeDetail: Schema.String,
  },
) {}

class TelemetryValueError extends Schema.TaggedErrorClass<TelemetryValueError>()(
  "TelemetryValueError",
  {
    nullable: Schema.Null,
    text: Schema.String,
    number: Schema.Number,
    enabled: Schema.Boolean,
    bigintValue: Schema.BigInt,
    array: Schema.Array(Schema.String),
    nested: Schema.Struct({ detail: Schema.String }),
    ignored: Schema.Unknown,
  },
) {}

class NestedSensitiveTelemetryError extends Schema.TaggedErrorClass<NestedSensitiveTelemetryError>()(
  "NestedSensitiveTelemetryError",
  {
    payload: Schema.Unknown,
  },
) {}

interface ExportedRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly dataset: string | undefined;
}

const otlpAttributeValue = (value: {
  readonly stringValue?: string | null;
  readonly boolValue?: boolean | null;
  readonly intValue?: number | null;
  readonly doubleValue?: number | null;
}) => value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue;

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const startTraceCapture = Effect.gen(function* () {
  const exportedRequest = yield* Deferred.make<ExportedRequest>();
  yield* HttpServer.serveEffect(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Deferred.succeed(exportedRequest, {
        authorization: request.headers.authorization,
        body: yield* request.text,
        dataset: request.headers["x-axiom-dataset"],
      });
      return HttpServerResponse.empty({ status: 204 });
    }),
  );
  return exportedRequest;
});

const traceLayer = makeRelayTraceLayer({
  tracesEndpoint: "/v1/traces",
  tracesDatasetName: "relay-test-traces",
  ingestToken: Redacted.make("test-token"),
});

const inertAxiomProviders = Axiom.Providers.of({
  kind: "ProviderCollection",
  get: () => undefined,
  providers: {},
});

it.effect("exports schema error fields as span attributes", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* Deferred.make<ExportedRequest>();
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Deferred.succeed(exportedRequest, {
          authorization: request.headers.authorization,
          body: yield* request.text,
          dataset: request.headers["x-axiom-dataset"],
        });
        return HttpServerResponse.empty({ status: 204 });
      }),
    );

    yield* Effect.fail(
      new EnvironmentConnector.EnvironmentConnectNotAuthorized({
        environmentId: "environment-1",
        operation: "connect",
        reason: "managed_endpoint_allocation_not_ready",
      }),
    ).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Effect.provide(
        makeRelayTraceLayer({
          tracesEndpoint: "/v1/traces",
          tracesDatasetName: "relay-test-traces",
          ingestToken: Redacted.make("test-token"),
        }),
      ),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const payload = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = payload.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.schema_error");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(request.authorization).toBe("Bearer test-token");
    expect(request.dataset).toBe("relay-test-traces");
    expect(attributes).toMatchObject({
      "error.type": "EnvironmentConnectNotAuthorized",
      "error.environmentId": "environment-1",
      "error.operation": "connect",
      "error.reason": "managed_endpoint_allocation_not_ready",
    });
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("redacts secrets from schema error telemetry", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* Deferred.make<ExportedRequest>();
    yield* HttpServer.serveEffect(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Deferred.succeed(exportedRequest, {
          authorization: request.headers.authorization,
          body: yield* request.text,
          dataset: request.headers["x-axiom-dataset"],
        });
        return HttpServerResponse.empty({ status: 204 });
      }),
    );

    const error = new SensitiveTelemetryError({
      accessToken: "access-token-that-must-not-be-exported",
      privateKey: "private-key-that-must-not-be-exported",
      safeDetail: "request-validation-failed",
    });
    error.message = "message-secret-that-must-not-be-exported";
    error.stack = "stack-secret-that-must-not-be-exported";

    yield* Effect.fail(error).pipe(
      Effect.withSpan("relay.test.redacted_schema_error"),
      Effect.exit,
      Effect.provide(
        makeRelayTraceLayer({
          tracesEndpoint: "/v1/traces",
          tracesDatasetName: "relay-test-traces",
          ingestToken: Redacted.make("test-token"),
        }),
      ),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const payload = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = payload.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.redacted_schema_error");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );
    expect(attributes).toMatchObject({
      "error.type": "RelaySchemaError",
      "error.safeDetail": "request-validation-failed",
    });
    const exception = span?.events.find((event) => event.name === "exception");
    const exceptionAttributes = Object.fromEntries(
      (exception?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );
    expect(exceptionAttributes).toMatchObject({
      "exception.type": "RelaySchemaError",
      "exception.message": "Relay operation failed.",
      "exception.stacktrace": "RelaySchemaError: Relay operation failed.",
    });
    expect(request.body).not.toContain("access-token-that-must-not-be-exported");
    expect(request.body).not.toContain("private-key-that-must-not-be-exported");
    expect(request.body).not.toContain("message-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("stack-secret-that-must-not-be-exported");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("uses a fixed fallback identity for spoofed schema tags", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const secretTag = "TokenMaterialABC123";
    const spoofedError = new Error("spoofed-message-secret");
    Object.defineProperties(spoofedError, {
      constructor: { enumerable: true, value: Schema.Any },
      _tag: { enumerable: true, value: secretTag },
      safeDetail: { enumerable: true, value: "safe-spoof-detail" },
    });

    yield* Effect.fail(spoofedError).pipe(
      Effect.withSpan("relay.test.spoofed_schema_tag"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.spoofed_schema_tag");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );
    const exception = span?.events.find((event) => event.name === "exception");
    const exceptionAttributes = Object.fromEntries(
      (exception?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(attributes).toMatchObject({ "error.type": "RelaySchemaError" });
    expect(exceptionAttributes).toMatchObject({
      "exception.type": "RelaySchemaError",
      "exception.message": "Relay operation failed.",
      "exception.stacktrace": "RelaySchemaError: Relay operation failed.",
    });
    expect(request.body).not.toContain(secretTag);
    expect(request.body).not.toContain("spoofed-message-secret");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("does not inspect sensitive paths inside arrays and symbol keys", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const privateKeySymbol = Symbol("PRIVATE.key");
    const payload = [
      { "private.key": "dotted-private-key-secret" },
      { private__key: "underscored-private-key-secret" },
      { PrIvAtE: { KeY: "mixed-case-private-key-secret" } },
      { [privateKeySymbol]: "symbol-private-key-secret" },
      { safeDetail: "safe-array-detail" },
    ];

    yield* Effect.fail(new NestedSensitiveTelemetryError({ payload })).pipe(
      Effect.withSpan("relay.test.nested_redaction"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.nested_redaction");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(attributes).toMatchObject({ "error.payload": "[UNSUPPORTED]" });
    expect(request.body).not.toContain("private.key");
    expect(request.body).not.toContain("private__key");
    expect(request.body).not.toContain("PRIVATE.key");
    expect(request.body).not.toContain("dotted-private-key-secret");
    expect(request.body).not.toContain("underscored-private-key-secret");
    expect(request.body).not.toContain("mixed-case-private-key-secret");
    expect(request.body).not.toContain("symbol-private-key-secret");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("never serializes arbitrary property names or symbol descriptions", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const rawSymbolDescription = "symbol-description-raw-4f92";
    const anonymousSymbolValue = "anonymous-symbol-value-1b7";
    const payload: Record<PropertyKey, unknown> = {
      safeDetail: "known-safe-detail",
      "actual-token-label-7d9": "unknown-token-value",
      "secrét-label-8e1": "accented-label-value",
      "ѕecret-label-2c6": "homoglyph-label-value",
      "punctuation.!@#$-5a3": "punctuation-label-value",
      "private.key": "exact-private-key-value",
      [Symbol(rawSymbolDescription)]: "symbol-description-value",
      [Symbol()]: anonymousSymbolValue,
    };
    const payloadArray = [payload];
    Object.defineProperty(payloadArray, "01", {
      enumerable: true,
      value: "noncanonical-array-index-value",
    });
    const longDigitKey = "9".repeat(256);
    Object.defineProperty(payloadArray, longDigitKey, {
      enumerable: true,
      value: "long-array-index-value",
    });

    yield* Effect.fail(new NestedSensitiveTelemetryError({ payload: payloadArray })).pipe(
      Effect.withSpan("relay.test.safe_structural_keys"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.safe_structural_keys");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    const serializedAttributes = (span?.attributes ?? [])
      .flatMap((attribute) => [attribute.key, String(otlpAttributeValue(attribute.value))])
      .join("\n");
    expect(attributes).toMatchObject({ "error.payload": "[UNSUPPORTED]" });
    for (const rawText of [
      "actual-token-label-7d9",
      "secrét-label-8e1",
      "ѕecret-label-2c6",
      "punctuation.!@#$-5a3",
      "private.key",
      rawSymbolDescription,
      "unknown-token-value",
      "accented-label-value",
      "homoglyph-label-value",
      "punctuation-label-value",
      "exact-private-key-value",
      "symbol-description-value",
      anonymousSymbolValue,
      "01",
      longDigitKey,
      "noncanonical-array-index-value",
      "long-array-index-value",
    ]) {
      expect(serializedAttributes).not.toContain(rawText);
    }
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("redacts finite exact secret fields without inspecting benign unknown fields", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const error = new NestedSensitiveTelemetryError({ payload: null });
    Object.assign(error, {
      token: "exact-token-value",
      tokenCount: 3,
      password: "exact-password-value",
      passwordPolicy: "minimum-length-12",
      cause: "exact-cause-value",
      because: "benign-because-value",
      safeDetail: "known-safe-matcher-detail",
    });

    yield* Effect.fail(error).pipe(
      Effect.withSpan("relay.test.exact_secret_names"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.exact_secret_names");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(attributes).toMatchObject({
      "error.token": "[REDACTED]",
      "error.password": "[REDACTED]",
      "error.cause": "[REDACTED]",
      "error.safeDetail": "known-safe-matcher-detail",
      "error.payload": "[UNAVAILABLE]",
    });
    expect(attributes).not.toHaveProperty("error.tokenCount");
    expect(attributes).not.toHaveProperty("error.passwordPolicy");
    expect(attributes).not.toHaveProperty("error.because");
    expect(request.body).not.toContain("exact-token-value");
    expect(request.body).not.toContain("exact-password-value");
    expect(request.body).not.toContain("exact-cause-value");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("does not mislabel uninspected repeated references as circular", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const shared = { safeDetail: "shared-safe-detail" };
    const payload = { first: shared, second: shared };

    yield* Effect.fail(new NestedSensitiveTelemetryError({ payload })).pipe(
      Effect.withSpan("relay.test.repeated_reference"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.repeated_reference");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(attributes).toMatchObject({ "error.payload": "[UNAVAILABLE]" });
    expect(Object.values(attributes)).not.toContain("[CIRCULAR]");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("marks Map, Set, and custom iterable values as unsupported", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    let iteratorCalls = 0;
    const errors = [
      new NestedSensitiveTelemetryError({
        payload: new Map([["map-secret-key", "map-secret-value"]]),
      }),
      new NestedSensitiveTelemetryError({ payload: new Set(["set-secret-value"]) }),
      new NestedSensitiveTelemetryError({
        payload: {
          *[Symbol.iterator]() {
            iteratorCalls += 1;
            yield "iterator-secret-value";
          },
        },
      }),
    ] as const;

    yield* Effect.all(
      errors.map((error, index) =>
        Effect.fail(error).pipe(
          Effect.withSpan(`relay.test.unsupported_iterable_${index}`),
          Effect.exit,
        ),
      ),
    ).pipe(Effect.provide(traceLayer));

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const spans = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans);
    const attributesFor = (index: number) =>
      Object.fromEntries(
        (
          spans.find((span) => span.name === `relay.test.unsupported_iterable_${index}`)
            ?.attributes ?? []
        ).map((attribute) => [attribute.key, otlpAttributeValue(attribute.value)]),
      );

    expect(attributesFor(0)).toMatchObject({ "error.payload": "[UNSUPPORTED]" });
    expect(attributesFor(1)).toMatchObject({ "error.payload": "[UNSUPPORTED]" });
    expect(attributesFor(2)).toMatchObject({ "error.payload": "[UNAVAILABLE]" });
    expect(iteratorCalls).toBe(0);
    for (const secret of [
      "map-secret-key",
      "map-secret-value",
      "set-secret-value",
      "iterator-secret-value",
    ]) {
      expect(request.body).not.toContain(secret);
    }
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("bounds cyclic, deep, and wide schema error telemetry", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const cyclic: Record<string, unknown> = { safeDetail: "safe-before-cycle" };
    cyclic.self = cyclic;

    let deep: Record<string, unknown> = { terminal: "deep-value-that-must-not-be-exported" };
    for (let index = 0; index < 32; index += 1) {
      deep = { next: deep };
    }

    const wide = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`field${index}`, `safe-${index}`]),
    );
    wide.tail = "wide-tail-that-must-not-be-exported";
    const sensitiveWide = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `secret_${index}`,
        `redacted-wide-value-${index}`,
      ]),
    );
    sensitiveWide.safeTail = "sensitive-wide-tail-that-must-not-be-exported";

    const error = new NestedSensitiveTelemetryError({ payload: null });
    Object.defineProperty(error, "payload", { enumerable: true, value: error });
    Object.defineProperty(error, "array", { enumerable: true, value: error });
    Object.defineProperty(error, "nested", {
      enumerable: true,
      value: { cyclic, deep, sensitiveWide, wide },
    });
    const exit = yield* Effect.fail(error).pipe(
      Effect.withSpan("relay.test.bounded_redaction"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(1);
      const reason = exit.cause.reasons[0]!;
      expect(Cause.isFailReason(reason)).toBe(true);
      if (Cause.isFailReason(reason)) {
        expect(reason.error).toBe(error);
      }
    }

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.bounded_redaction");
    const attributes = Object.fromEntries(
      (span?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(attributes).toMatchObject({
      "error.payload": "[CIRCULAR]",
      "error.array": "[CIRCULAR]",
      "error.nested": "[UNAVAILABLE]",
    });
    expect(Object.keys(attributes).length).toBeLessThanOrEqual(4);
    expect(request.body).not.toContain("deep-value-that-must-not-be-exported");
    expect(request.body).not.toContain("redacted-wide-value-255");
    expect(request.body).not.toContain("sensitive-wide-tail-that-must-not-be-exported");
    expect(request.body).not.toContain("wide-tail-that-must-not-be-exported");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("uses finite output without inspecting wide hostile values", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    let descriptorCalls = 0;
    let getterCalls = 0;
    const trapTarget: Record<string, unknown> = {};
    for (let index = 0; index < 256; index += 1) {
      Object.defineProperty(trapTarget, `trap${index}`, {
        enumerable: true,
        configurable: true,
        value: index,
      });
    }
    const manyTraps = new Proxy(trapTarget, {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(_target, key) {
        getterCalls += 1;
        if (key === Symbol.iterator) {
          return undefined;
        }
        throw new Error("many-traps-secret-that-must-not-be-exported");
      },
    });
    const manyDepthLimits = Array.from({ length: 256 }, () => {
      let value: Record<string, unknown> = { safeDetail: "beyond-depth" };
      for (let depth = 0; depth < 32; depth += 1) {
        value = { child: value };
      }
      return value;
    });

    yield* Effect.fail(
      new NestedSensitiveTelemetryError({ payload: { manyTraps, manyDepthLimits } }),
    ).pipe(Effect.withSpan("relay.test.finite_snapshot"), Effect.exit, Effect.provide(traceLayer));

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.finite_snapshot");

    expect(span?.attributes.length).toBeLessThanOrEqual(2);
    expect(descriptorCalls + getterCalls).toBe(0);
    expect(request.body).not.toContain("many-traps-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("beyond-depth");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("does not reflect over a hostile top-level proxy", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    let trapCalls = 0;
    const recordTrap = () => {
      trapCalls += 1;
      if (trapCalls === 129) {
        throw new Error("operation-129-secret-that-must-not-be-exported");
      }
    };
    const target: Record<string, unknown> = { _tag: "HostileTopLevelError" };
    for (let index = 0; index < 256; index += 1) {
      target[`raw-top-level-field-${index}`] = index;
    }
    const hostileError = new Proxy(target, {
      ownKeys(value) {
        recordTrap();
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(value, key) {
        recordTrap();
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
      get(value, key, receiver) {
        recordTrap();
        if (key === "constructor") {
          return Schema.Any;
        }
        return Reflect.get(value, key, receiver);
      },
    });

    yield* Effect.fail(hostileError).pipe(
      Effect.withSpan("relay.test.top_level_proxy"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.top_level_proxy");
    expect(trapCalls).toBe(0);
    expect(span?.attributes).toHaveLength(0);
    expect(request.body).not.toContain("operation-129-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("raw-top-level-field-128");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("does not inspect or run a spoofed schema encoder", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    let trapCalls = 0;
    const schemaFields: Record<string, Schema.Top> = {
      _tag: Schema.Literal("HostileSchemaError"),
    };
    const target: Record<string, unknown> = { _tag: "HostileSchemaError" };
    for (let index = 0; index < 256; index += 1) {
      schemaFields[`raw-schema-field-${index}`] = Schema.Number;
      target[`raw-schema-field-${index}`] = index;
    }
    const hostileSchema = Schema.Struct(schemaFields);
    const hostileError = new Proxy(target, {
      get(value, key, receiver) {
        trapCalls += 1;
        if (trapCalls === 129) {
          throw new Error("schema-operation-129-secret-that-must-not-be-exported");
        }
        if (key === "constructor") {
          return hostileSchema;
        }
        return Reflect.get(value, key, receiver);
      },
    });

    const exit = yield* Effect.fail(hostileError).pipe(
      Effect.withSpan("relay.test.schema_proxy"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]!;
      expect(Cause.isFailReason(reason)).toBe(true);
      if (Cause.isFailReason(reason)) {
        expect(reason.error).toBe(hostileError);
      }
    }
    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    expect(trapCalls).toBe(0);
    expect(request.body).not.toContain("schema-operation-129-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("raw-schema-field-128");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("does not inspect hostile nested values or invoke accessors synchronously", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    let hostileOperations = 0;
    const trap = () => {
      hostileOperations += 1;
      throw new Error("synchronous-inspection-secret");
    };
    const proxyPayload = new Proxy(
      {},
      {
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
      },
    );
    const iteratorPayload = {};
    Object.defineProperty(iteratorPayload, Symbol.iterator, {
      get: trap,
    });
    const wideTarget = {};
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(wideTarget, `hidden${index}`, { value: index });
    }
    const widePayload = new Proxy(wideTarget, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    const accessorError = new SensitiveTelemetryError({
      accessToken: "accessor-token-secret",
      privateKey: "accessor-key-secret",
      safeDetail: "replace-with-accessor",
    });
    Object.defineProperty(accessorError, "safeDetail", {
      enumerable: true,
      get: trap,
    });
    const payloadAccessorError = new NestedSensitiveTelemetryError({ payload: null });
    Object.defineProperty(payloadAccessorError, "payload", {
      enumerable: true,
      get: trap,
    });
    const errors = [
      new NestedSensitiveTelemetryError({ payload: proxyPayload }),
      new NestedSensitiveTelemetryError({ payload: iteratorPayload }),
      new NestedSensitiveTelemetryError({ payload: widePayload }),
      accessorError,
      payloadAccessorError,
    ] as const;

    const exits = yield* Effect.all(
      errors.map((error, index) =>
        Effect.fail(error).pipe(Effect.withSpan(`relay.test.non_reflective_${index}`), Effect.exit),
      ),
    ).pipe(Effect.provide(traceLayer));

    for (let index = 0; index < exits.length; index += 1) {
      const exit = exits[index]!;
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]!;
        expect(Cause.isFailReason(reason)).toBe(true);
        if (Cause.isFailReason(reason)) {
          expect(reason.error).toBe(errors[index]);
        }
      }
    }
    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const spans = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .filter((span) => span.name.startsWith("relay.test.non_reflective_"));

    expect(hostileOperations).toBe(0);
    expect(spans).toHaveLength(5);
    for (const span of spans) {
      expect(span.attributes.length).toBeLessThanOrEqual(4);
    }
    expect(request.body).not.toContain("synchronous-inspection-secret");
    expect(request.body).not.toContain("accessor-token-secret");
    expect(request.body).not.toContain("accessor-key-secret");
    expect(request.body).not.toContain("hidden4095");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("contains hostile telemetry getters and proxies without changing request failures", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const getterPayload: Record<string, unknown> = { safeDetail: "safe-before-getter" };
    Object.defineProperty(getterPayload, "hostileValue", {
      enumerable: true,
      get() {
        throw new Error("getter-trap-secret-that-must-not-be-exported");
      },
    });
    const proxyPayload = new Proxy(
      { safeDetail: "unreachable-proxy-detail" },
      {
        ownKeys() {
          throw new Error("proxy-trap-secret-that-must-not-be-exported");
        },
      },
    );
    const descriptorPayload = new Proxy(
      { hostileDescriptor: "unreachable-descriptor-detail" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor-trap-secret-that-must-not-be-exported");
        },
      },
    );
    const revokedPayload = Proxy.revocable({}, {});
    revokedPayload.revoke();
    const iteratorPayload = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (key === Symbol.iterator) {
            throw new Error("iterator-trap-secret-that-must-not-be-exported");
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const getterError = new NestedSensitiveTelemetryError({ payload: getterPayload });
    const proxyError = new NestedSensitiveTelemetryError({ payload: proxyPayload });
    const descriptorError = new NestedSensitiveTelemetryError({ payload: descriptorPayload });
    const revokedError = new NestedSensitiveTelemetryError({ payload: revokedPayload.proxy });
    const iteratorError = new NestedSensitiveTelemetryError({ payload: iteratorPayload });

    const exits = yield* Effect.all([
      Effect.fail(getterError).pipe(Effect.withSpan("relay.test.hostile_getter"), Effect.exit),
      Effect.fail(proxyError).pipe(Effect.withSpan("relay.test.hostile_proxy"), Effect.exit),
      Effect.fail(descriptorError).pipe(
        Effect.withSpan("relay.test.hostile_descriptor"),
        Effect.exit,
      ),
      Effect.fail(revokedError).pipe(Effect.withSpan("relay.test.hostile_revoked"), Effect.exit),
      Effect.fail(iteratorError).pipe(Effect.withSpan("relay.test.hostile_iterator"), Effect.exit),
    ]).pipe(Effect.provide(traceLayer));

    for (const [exit, error] of [
      [exits[0], getterError],
      [exits[1], proxyError],
      [exits[2], descriptorError],
      [exits[3], revokedError],
      [exits[4], iteratorError],
    ] as const) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toHaveLength(1);
        const reason = exit.cause.reasons[0]!;
        expect(Cause.isFailReason(reason)).toBe(true);
        if (Cause.isFailReason(reason)) {
          expect(reason.error).toBe(error);
        }
      }
    }

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const spans = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans);
    const attributesFor = (name: string) =>
      Object.fromEntries(
        (spans.find((span) => span.name === name)?.attributes ?? []).map((attribute) => [
          attribute.key,
          otlpAttributeValue(attribute.value),
        ]),
      );

    expect(attributesFor("relay.test.hostile_getter")).toMatchObject({
      "error.payload": "[UNAVAILABLE]",
    });
    expect(attributesFor("relay.test.hostile_proxy")).toMatchObject({
      "error.payload": "[UNAVAILABLE]",
    });
    expect(attributesFor("relay.test.hostile_descriptor")).toMatchObject({
      "error.payload": "[UNAVAILABLE]",
    });
    expect(attributesFor("relay.test.hostile_revoked")).toMatchObject({
      "error.payload": "[UNAVAILABLE]",
    });
    expect(attributesFor("relay.test.hostile_iterator")).toMatchObject({
      "error.payload": "[UNAVAILABLE]",
    });
    expect(request.body).not.toContain("getter-trap-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("proxy-trap-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("descriptor-trap-secret-that-must-not-be-exported");
    expect(request.body).not.toContain("iterator-trap-secret-that-must-not-be-exported");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("contains hostile failures before schema detection", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const hostileFailure = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "constructor" || key === "message" || key === "stack") {
            throw new Error("failure-proxy-secret-that-must-not-be-exported");
          }
          return undefined;
        },
      },
    );

    const exit = yield* Effect.fail(hostileFailure).pipe(
      Effect.withSpan("relay.test.hostile_failure"),
      Effect.exit,
      Effect.provide(traceLayer),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(1);
      const reason = exit.cause.reasons[0]!;
      expect(Cause.isFailReason(reason)).toBe(true);
      if (Cause.isFailReason(reason)) {
        expect(reason.error).toBe(hostileFailure);
      }
    }

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const span = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans)
      .find((candidate) => candidate.name === "relay.test.hostile_failure");
    const exception = span?.events.find((event) => event.name === "exception");
    const exceptionAttributes = Object.fromEntries(
      (exception?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(exceptionAttributes).toMatchObject({
      "exception.type": "Error",
      "exception.message": "Relay operation failed.",
      "exception.stacktrace": "Error: Relay operation failed.",
    });
    expect(request.body).not.toContain("failure-proxy-secret-that-must-not-be-exported");
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("preserves span operations and adds scoped span attributes", () =>
  Effect.gen(function* () {
    const exportedRequest = yield* startTraceCapture;
    const identity = yield* Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const root = tracer.span({
        name: "relay.test.manual_root",
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: 1n,
        kind: "internal",
        root: true,
        sampled: true,
      });
      const child = tracer.span({
        name: "relay.test.manual_child",
        parent: Option.some(root),
        annotations: Context.empty(),
        links: [],
        startTime: 2n,
        kind: "client",
        root: false,
        sampled: true,
      });

      root.attribute("manual.attribute", "present");
      root.event("manual.event", 2n, { eventAttribute: "present" });
      root.addLinks([
        {
          span: Tracer.externalSpan({
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
          }),
          attributes: { relation: "test" },
        },
      ]);

      expect(root.name).toBe("relay.test.manual_root");
      expect(root.spanId).toHaveLength(16);
      expect(root.traceId).toHaveLength(32);
      expect(Option.isNone(root.parent)).toBe(true);
      expect(root.annotations).toBeDefined();
      expect(root.status).toMatchObject({ _tag: "Started" });
      expect(root.attributes.get("manual.attribute")).toBe("present");
      expect(root.links).toHaveLength(1);
      expect(root.sampled).toBe(true);
      expect(root.kind).toBe("internal");
      expect(Option.getOrNull(child.parent)).toBe(root);

      child.attribute("child.attribute", "present");
      child.end(3n, Exit.succeed("child"));
      root.end(4n, Exit.succeed("root"));
      const scopedAttributes = yield* Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        return span.attributes;
      }).pipe(
        withSpanAttributes({ "request.id": "request-123" }),
        Effect.withSpan("relay.test.scoped_attributes"),
      );
      expect(scopedAttributes.get("request.id")).toBe("request-123");
      return {
        rootSpanId: root.spanId,
        rootTraceId: root.traceId,
        childSpanId: child.spanId,
      };
    }).pipe(Effect.provide(traceLayer));

    const request = yield* Deferred.await(exportedRequest).pipe(Effect.timeout("1 second"));
    const exported = (yield* decodeJson(request.body)) as OtlpTracer.TraceData;
    const spans = exported.resourceSpans
      .flatMap((resourceSpan) => resourceSpan.scopeSpans)
      .flatMap((scopeSpan) => scopeSpan.spans);
    const root = spans.find((span) => span.name === "relay.test.manual_root");
    const child = spans.find((span) => span.name === "relay.test.manual_child");
    const scoped = spans.find((span) => span.name === "relay.test.scoped_attributes");
    const event = root?.events.find((candidate) => candidate.name === "manual.event");
    const eventAttributes = Object.fromEntries(
      (event?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );
    const link = root?.links[0];
    const linkAttributes = Object.fromEntries(
      (link?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );
    const scopedAttributes = Object.fromEntries(
      (scoped?.attributes ?? []).map((attribute) => [
        attribute.key,
        otlpAttributeValue(attribute.value),
      ]),
    );

    expect(root).toMatchObject({
      spanId: identity.rootSpanId,
      traceId: identity.rootTraceId,
    });
    expect(root).not.toHaveProperty("parentSpanId");
    expect(eventAttributes).toEqual({ eventAttribute: "present" });
    expect(link).toMatchObject({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
    });
    expect(linkAttributes).toEqual({ relation: "test" });
    expect(child).toMatchObject({
      spanId: identity.childSpanId,
      traceId: identity.rootTraceId,
      parentSpanId: identity.rootSpanId,
    });
    expect(scopedAttributes).toMatchObject({ "request.id": "request-123" });
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect(
  "records supported schema errors and ignores plain, defective, and interrupted exits",
  () =>
    Effect.gen(function* () {
      yield* startTraceCapture;
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const makeSpan = (name: string) =>
          tracer.span({
            name,
            parent: Option.none(),
            annotations: Context.empty(),
            links: [],
            startTime: 1n,
            kind: "internal",
            root: true,
            sampled: true,
          });
        const structured = makeSpan("relay.test.structured_error");
        structured.end(
          2n,
          Exit.fail(
            new TelemetryValueError({
              nullable: null,
              text: "text-value",
              number: 42,
              enabled: true,
              bigintValue: 1n,
              array: ["first", "second"],
              nested: { detail: "nested-value" },
              ignored: () => undefined,
            }),
          ),
        );
        expect(Object.fromEntries(structured.attributes)).toMatchObject({
          "error.type": "RelaySchemaError",
          "error.nullable": null,
          "error.text": "text-value",
          "error.number": 42,
          "error.enabled": true,
          "error.bigintValue": 1n,
          "error.array": "[UNSUPPORTED]",
          "error.nested": "[UNAVAILABLE]",
        });

        const plain = makeSpan("relay.test.plain_error");
        plain.end(2n, Exit.fail("plain-failure"));
        expect(plain.attributes.has("error.type")).toBe(false);

        const defect = makeSpan("relay.test.defect_error");
        defect.end(2n, Exit.die(new Error("plain-defect")));
        expect(defect.attributes.has("error.type")).toBe(false);

        const interrupted = makeSpan("relay.test.interrupted_error");
        interrupted.end(2n, yield* Effect.exit(Effect.interrupt));
        expect(interrupted.attributes.has("error.type")).toBe(false);

        const undecodable = makeSpan("relay.test.undecodable_schema_error");
        undecodable.end(2n, Exit.fail({ constructor: Schema.String }));
        expect(undecodable.attributes.has("error.type")).toBe(false);

        const untagged = makeSpan("relay.test.untagged_schema_error");
        untagged.end(2n, Exit.fail({ constructor: Schema.Any }));
        expect(untagged.attributes.has("error.type")).toBe(false);

        const annotationFailure = makeSpan("relay.test.annotation_failure");
        Object.defineProperty(annotationFailure.attributes, "set", {
          value() {
            throw new Error("attribute-write-failure");
          },
        });
        expect(() =>
          annotationFailure.end(
            2n,
            Exit.fail(new NestedSensitiveTelemetryError({ payload: "opaque-secret" })),
          ),
        ).not.toThrow();
      }).pipe(Effect.provide(traceLayer));
    }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
);

it.effect("constructs isolated Axiom observability resources for a stack stage", () =>
  Effect.gen(function* () {
    const stack: Omit<Alchemy.StackSpec, "output"> = {
      name: "RelayObservabilityTest",
      stage: "preview",
      resources: {},
      bindings: {},
      actions: {},
    };
    const observability = yield* RelayObservability.pipe(
      Effect.provideService(Alchemy.Stack, stack),
      Effect.provideService(Axiom.Providers, inertAxiomProviders),
    );

    expect(stack.resources).toHaveProperty("RelayTracesDataset");
    expect(stack.resources).toHaveProperty("RelayWorkerAxiomIngestToken");
    expect(stack.resources).toHaveProperty("RelayClientAxiomIngestToken");
    expect(stack.resources).toHaveProperty("RelayRecentSpansView");
    expect(observability.traces.name).toBeDefined();
    expect(observability.workerIngestToken.token).toBeDefined();
    expect(observability.clientIngestToken.token).toBeDefined();

    const traceDatasetName = "t4code-relay-traces-preview";
    const upstream = {
      [observability.traces.FQN]: { name: traceDatasetName },
    };
    const workerCapabilitiesOutput = observability.workerIngestToken.Props
      .datasetCapabilities as unknown as Output.Output<
      Record<string, { readonly ingest: ReadonlyArray<"create"> }>,
      never
    >;
    const clientCapabilitiesOutput = observability.clientIngestToken.Props
      .datasetCapabilities as unknown as Output.Output<
      Record<string, { readonly ingest: ReadonlyArray<"create"> }>,
      never
    >;
    const recentSpansView = stack.resources.RelayRecentSpansView!;
    const aplQueryOutput = recentSpansView.Props.aplQuery as Output.Output<string, never>;
    const [workerCapabilities, clientCapabilities, aplQuery] = yield* Effect.all([
      Output.evaluate(workerCapabilitiesOutput, upstream),
      Output.evaluate(clientCapabilitiesOutput, upstream),
      Output.evaluate(aplQueryOutput, upstream),
    ]).pipe(
      Effect.provideService(Axiom.Providers, inertAxiomProviders),
      Effect.provideService(State.State, State.InMemoryService({})),
    );

    expect(workerCapabilities).toEqual({
      [traceDatasetName]: { ingest: ["create"] },
    });
    expect(clientCapabilities).toEqual({
      [traceDatasetName]: { ingest: ["create"] },
    });
    expect(aplQuery).toContain(`['${traceDatasetName}']`);
  }),
);
