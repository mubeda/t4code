import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { relayResourceNameForStage } from "./deploymentConfig.ts";

const relayRecentSpansQuery = (dataset: string) =>
  [
    `['${dataset}']`,
    `| where isnotnull(span_id) or isnotnull(trace_id)`,
    `| extend requestMethod = column_ifexists('attributes.http.request.method', ''), path = column_ifexists('attributes.url.path', ''), endpoint = column_ifexists('attributes.http.route', ''), statusCode = column_ifexists('attributes.http.response.status_code', 0), customAttributes = column_ifexists('attributes.custom', dynamic({}))`,
    `| extend userId = customAttributes['user']['id']`,
    `| project _time, name, trace_id, span_id, duration, requestMethod, path, statusCode, endpoint, userId`,
    `| order by _time desc`,
    `| limit 200`,
  ].join("\n");

export const RelayObservability = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: relayResourceNameForStage("t4code-relay-traces", stage),
    kind: "otel:traces:v1",
    description: "T4Code relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const workerIngestToken = yield* Axiom.ApiToken("RelayWorkerAxiomIngestToken", {
    name: relayResourceNameForStage("t4code-relay-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const clientIngestToken = yield* Axiom.ApiToken("RelayClientAxiomIngestToken", {
    name: relayResourceNameForStage("t4code-relay-client-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for first-party relay client spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: relayResourceNameForStage("t4code-relay-recent-spans", stage),
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  return { traces, workerIngestToken, clientIngestToken } as const;
});

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

const SAFE_TELEMETRY_FIELDS = [
  "array",
  "bigintValue",
  "detail",
  "enabled",
  "environmentId",
  "nested",
  "nullable",
  "number",
  "operation",
  "reason",
  "safeDetail",
  "text",
] as const;

const SENSITIVE_TELEMETRY_FIELDS = [
  "accessToken",
  "apiSecret",
  "apiToken",
  "authorization",
  "bearerToken",
  "cause",
  "clientSecret",
  "credential",
  "credentials",
  "idToken",
  "password",
  "privateKey",
  "refreshToken",
  "secret",
  "token",
] as const;

const KNOWN_SCHEMA_ERROR_TAGS = new Set([
  "ClerkTokenVerificationFailed",
  "DpopProofReplayPersistenceError",
  "EnvironmentConnectNotAuthorized",
  "EnvironmentCredentialAuthenticatePersistenceError",
  "EnvironmentCredentialCreatePersistenceError",
  "EnvironmentCredentialRevokePersistenceError",
  "EnvironmentLinkListPersistenceError",
  "EnvironmentLinkLookupPersistenceError",
  "EnvironmentLinkProofExpired",
  "EnvironmentLinkProofInvalid",
  "EnvironmentLinkRevokePersistenceError",
  "EnvironmentLinkUpsertPersistenceError",
  "EnvironmentLinkUserListPersistenceError",
  "EnvironmentMintRequestFailed",
  "EnvironmentMintRequestTimedOut",
  "EnvironmentMintResponseInvalid",
  "EnvironmentPublicKeyListPersistenceError",
  "ManagedEndpointAllocationPersistenceError",
  "ManagedEndpointDeprovisioningFailed",
  "ManagedEndpointDnsClientError",
  "ManagedEndpointOriginNotAllowed",
  "ManagedEndpointProvisioningFailed",
  "ManagedEndpointProvisioningNotConfigured",
  "ManagedEndpointTunnelClientError",
  "RelayPublicDomainLabelTooLongError",
]);

const FALLBACK_SCHEMA_ERROR_TAG = "RelaySchemaError";
const isNativeError = (value: unknown): value is Error =>
  (Error as unknown as { isError(value: unknown): boolean }).isError(value);

const MAP_SET_BRAND_SENTINEL = {};

const unsupportedContainer = (value: object): boolean => {
  try {
    if (Array.isArray(value)) {
      return true;
    }
  } catch {
    return false;
  }
  try {
    Map.prototype.has.call(value, MAP_SET_BRAND_SENTINEL);
    return true;
  } catch {
    // Continue with the Set brand check.
  }
  try {
    Set.prototype.has.call(value, MAP_SET_BRAND_SENTINEL);
    return true;
  } catch {
    return false;
  }
};

const telemetryValue = (value: unknown, root: Error): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value === root) {
    return "[CIRCULAR]";
  }
  if (typeof value === "object" && unsupportedContainer(value)) {
    return "[UNSUPPORTED]";
  }
  return "[UNAVAILABLE]";
};

const opaqueTelemetryValue = (value: unknown, root: Error): string => {
  if (value === root) {
    return "[CIRCULAR]";
  }
  if (typeof value === "object" && value !== null && unsupportedContainer(value)) {
    return "[UNSUPPORTED]";
  }
  return "[UNAVAILABLE]";
};

const ownDataDescriptor = (error: Error, key: string): PropertyDescriptor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor : undefined;
};

const annotateSchemaErrorValue = (span: Tracer.Span, error: unknown): string | undefined => {
  if (!isNativeError(error)) {
    return undefined;
  }
  try {
    const tagDescriptor = ownDataDescriptor(error, "_tag");
    if (tagDescriptor === undefined || typeof tagDescriptor.value !== "string") {
      return undefined;
    }
    const rawTag = tagDescriptor.value;
    const telemetryTag =
      rawTag.length <= 64 && KNOWN_SCHEMA_ERROR_TAGS.has(rawTag)
        ? rawTag
        : FALLBACK_SCHEMA_ERROR_TAG;
    span.attribute("error.type", telemetryTag);
    for (const field of SAFE_TELEMETRY_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(error, field);
      if (descriptor !== undefined) {
        span.attribute(
          `error.${field}`,
          "value" in descriptor ? telemetryValue(descriptor.value, error) : "[UNAVAILABLE]",
        );
      }
    }
    for (const field of SENSITIVE_TELEMETRY_FIELDS) {
      if (Object.getOwnPropertyDescriptor(error, field) !== undefined) {
        span.attribute(`error.${field}`, "[REDACTED]");
      }
    }
    const payload = Object.getOwnPropertyDescriptor(error, "payload");
    if (payload !== undefined) {
      span.attribute(
        "error.payload",
        "value" in payload ? opaqueTelemetryValue(payload.value, error) : "[UNAVAILABLE]",
      );
    }
    return telemetryTag;
  } catch {
    return undefined;
  }
};

const annotateSchemaError = (
  span: Tracer.Span,
  exit: Exit.Exit<unknown, unknown>,
): string | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  for (const reason of exit.cause.reasons) {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    const tag = annotateSchemaErrorValue(span, error);
    if (tag !== undefined) {
      return tag;
    }
  }
  return undefined;
};

const safeTelemetryExit = (
  exit: Exit.Exit<unknown, unknown>,
  schemaErrorTag: string | undefined,
): Exit.Exit<unknown, unknown> => {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return exit;
  }
  const safeTag =
    schemaErrorTag !== undefined && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(schemaErrorTag)
      ? schemaErrorTag
      : "Error";
  const error = new Error("Relay operation failed.");
  error.name = safeTag;
  error.stack = `${safeTag}: Relay operation failed.`;
  return Exit.fail(error);
};

class RelayTraceSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly delegate: Tracer.Span;

  constructor(delegate: Tracer.Span) {
    this.delegate = delegate;
  }

  get name() {
    return this.delegate.name;
  }
  get spanId() {
    return this.delegate.spanId;
  }
  get traceId() {
    return this.delegate.traceId;
  }
  get parent() {
    return this.delegate.parent;
  }
  get annotations() {
    return this.delegate.annotations;
  }
  get status() {
    return this.delegate.status;
  }
  get attributes() {
    return this.delegate.attributes;
  }
  get links() {
    return this.delegate.links;
  }
  get sampled() {
    return this.delegate.sampled;
  }
  get kind() {
    return this.delegate.kind;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const schemaErrorTag = annotateSchemaError(this.delegate, exit);
    this.delegate.end(endTime, safeTelemetryExit(exit, schemaErrorTag));
  }

  attribute(key: string, value: unknown): void {
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(links);
  }
}

const withSchemaErrorAttributes = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => new RelayTraceSpan(delegate.span(options)),
  });

export const makeRelayTraceLayer = (input: {
  readonly tracesEndpoint: string;
  readonly tracesDatasetName: string;
  readonly ingestToken: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    Tracer.Tracer,
    OtlpTracer.make({
      url: input.tracesEndpoint,
      resource: {
        serviceName: "t4code-relay-worker",
        attributes: {
          "service.runtime": "cloudflare-worker",
          "service.component": "relay",
        },
      },
      headers: {
        Authorization: `Bearer ${Redacted.value(input.ingestToken)}`,
        "X-Axiom-Dataset": input.tracesDatasetName,
      },
      exportInterval: "1 second",
    }).pipe(Effect.map(withSchemaErrorAttributes)),
  ).pipe(Layer.provide(OtlpSerialization.layerJson));
