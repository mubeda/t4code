import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { sanitizeTraceText } from "./observability.ts";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly client: string;
  readonly component?: string;
}

export class RelayClientTracer extends Context.Reference(
  "@t4code/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) => effect.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      }),
    ),
  );

function cleanTraceStack(rawStack: unknown, name: string, message: string): string {
  const stack = typeof rawStack === "string" ? rawStack : `${name}: ${message}`;
  const lines = stack.split("\n");
  const effectFrameIndex = lines.findIndex(
    (line, index) => index > 0 && /(?:Generator\.next|~effect\/Effect)/.test(line),
  );
  return sanitizeTraceText(
    effectFrameIndex < 0 ? stack : lines.slice(0, effectFrameIndex).join("\n"),
  );
}

const UN_SERIALIZABLE_RELAY_VALUE = "[Unserializable]";

interface TracePropertyReader {
  read: (key: PropertyKey) => unknown;
}

interface TraceSafeErrorState {
  readonly active: WeakSet<object>;
  readonly errors: WeakMap<object, SafeTraceError>;
  readonly readers: WeakMap<object, TracePropertyReader>;
  readonly strings: WeakMap<object, string>;
}

const TRACE_PROPERTY_READ_FAILED = Symbol("TracePropertyReadFailed");

const makeTracePropertyReader = (
  value: object,
  state: TraceSafeErrorState,
): TracePropertyReader => {
  const existing = state.readers.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const cache = new Map<PropertyKey, unknown>();
  const reader = {
    read(key: PropertyKey) {
      if (cache.has(key)) {
        return cache.get(key);
      }
      let property: unknown;
      try {
        property = Reflect.get(value, key);
      } catch {
        property = TRACE_PROPERTY_READ_FAILED;
      }
      cache.set(key, property);
      return property;
    },
  };
  state.readers.set(value, reader);
  return reader;
};

const traceStringValue = (value: unknown, state: TraceSafeErrorState): string => {
  const objectValue =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? (value as object)
      : undefined;
  if (objectValue !== undefined) {
    const existing = state.strings.get(objectValue);
    if (existing !== undefined) {
      return existing;
    }
  }
  let text: string;
  try {
    text = sanitizeTraceText(String(value));
  } catch {
    text = UN_SERIALIZABLE_RELAY_VALUE;
  }
  if (objectValue !== undefined) {
    state.strings.set(objectValue, text);
  }
  return text;
};

const traceStringProperty = (
  reader: TracePropertyReader,
  key: PropertyKey,
  fallback: string,
): string => {
  const property = reader.read(key);
  return typeof property === "string" ? sanitizeTraceText(property) : fallback;
};

interface TraceErrorContext {
  readonly status?: number;
  readonly statusCode?: number;
  readonly url?: string;
  readonly responseURL?: string;
  readonly host?: string;
  readonly path?: string;
}

function traceSafeErrorContext(
  reader: TracePropertyReader,
  state: TraceSafeErrorState,
): TraceErrorContext {
  const context: {
    status?: number;
    statusCode?: number;
    url?: string;
    responseURL?: string;
    host?: string;
    path?: string;
  } = {};
  for (const key of ["status", "statusCode"] as const) {
    const property = reader.read(key);
    if (property === TRACE_PROPERTY_READ_FAILED) continue;
    if (typeof property === "number" && Number.isFinite(property)) {
      context[key] = property;
    }
  }
  for (const key of ["url", "responseURL", "host", "path"] as const) {
    const property = reader.read(key);
    if (property !== undefined && property !== TRACE_PROPERTY_READ_FAILED) {
      context[key] = traceStringValue(property, state);
    }
  }
  return context;
}

function preserveTraceErrorContext(error: Error, context: TraceErrorContext): void {
  for (const [key, value] of Object.entries(context)) {
    Object.defineProperty(error, key, {
      configurable: true,
      enumerable: true,
      value,
    });
  }
}

interface SafeTraceError {
  readonly error: Error;
  readonly context: TraceErrorContext;
}

function traceSafeError(value: unknown, state: TraceSafeErrorState): SafeTraceError {
  const objectValue =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? (value as object)
      : undefined;
  if (objectValue !== undefined) {
    const existing = state.errors.get(objectValue);
    if (existing !== undefined) {
      return existing;
    }
  }
  const reader =
    objectValue === undefined ? undefined : makeTracePropertyReader(objectValue, state);
  const messageProperty = reader?.read("message");
  const message =
    messageProperty === TRACE_PROPERTY_READ_FAILED
      ? UN_SERIALIZABLE_RELAY_VALUE
      : typeof messageProperty === "string"
        ? sanitizeTraceText(messageProperty)
        : traceStringValue(value, state);

  let safeCause: SafeTraceError | undefined;
  const cyclic = objectValue !== undefined && state.active.has(objectValue);
  if (reader !== undefined && objectValue !== undefined && !cyclic) {
    state.active.add(objectValue);
    const causeValue = reader.read("cause");
    if (causeValue !== undefined && causeValue !== TRACE_PROPERTY_READ_FAILED) {
      safeCause = traceSafeError(causeValue, state);
    }
    state.active.delete(objectValue);
  }

  const error = new Error(message, safeCause ? { cause: safeCause.error } : undefined);
  const context = reader === undefined ? {} : traceSafeErrorContext(reader, state);
  preserveTraceErrorContext(error, context);
  if (reader !== undefined) {
    error.name = traceStringProperty(reader, "name", value instanceof Error ? "Error" : error.name);
    error.stack = cleanTraceStack(
      messageProperty === TRACE_PROPERTY_READ_FAILED ? undefined : reader.read("stack"),
      error.name,
      traceStringProperty(reader, "message", message),
    );
  } else {
    error.stack = `${error.name}: ${message}`;
  }
  if (safeCause) {
    error.stack = `${error.stack}\nCaused by: ${safeCause.error.stack}`;
  }
  const safe = { error, context };
  if (objectValue !== undefined && !cyclic) {
    state.errors.set(objectValue, safe);
  }
  return safe;
}

function annotateTraceErrorContext(span: Tracer.Span, context: TraceErrorContext): void {
  const attributeNames = {
    status: "error.status",
    statusCode: "error.status_code",
    url: "error.url",
    responseURL: "error.response_url",
    host: "error.host",
    path: "error.path",
  } as const;
  const entries = Object.entries(context) as Array<[keyof TraceErrorContext, string | number]>;
  for (const [key, entryValue] of entries) {
    span.attribute(attributeNames[key], entryValue);
  }
}

interface SafeTraceExit {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly context: TraceErrorContext;
}

function traceSafeExit(exit: Exit.Exit<unknown, unknown>): SafeTraceExit {
  if (Exit.isSuccess(exit)) {
    return { exit, context: {} };
  }
  const reasons: Array<Cause.Reason<unknown>> = [];
  let context: TraceErrorContext = {};
  const state: TraceSafeErrorState = {
    active: new WeakSet(),
    errors: new WeakMap(),
    readers: new WeakMap(),
    strings: new WeakMap(),
  };
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const safe = traceSafeError(reason.error, state);
      reasons.push(Cause.makeFailReason(safe.error));
      if (Object.keys(context).length === 0) context = safe.context;
    } else if (Cause.isDieReason(reason)) {
      const safe = traceSafeError(reason.defect, state);
      reasons.push(Cause.makeDieReason(safe.error));
      if (Object.keys(context).length === 0) context = safe.context;
    } else {
      reasons.push(reason);
    }
  }
  return { exit: Exit.failCause(Cause.fromReasons(reasons)), context };
}

export function makeNonInterferingRelayTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        try {
          const safe = traceSafeExit(exit);
          annotateTraceErrorContext(span, safe.context);
          end(endTime, safe.exit);
        } catch {
          // Telemetry is best-effort and must never change application behavior.
        }
      };
      return span;
    },
    ...(delegate.context === undefined ? {} : { context: delegate.context }),
  });
}

export function makeRelayClientTracingLayer(
  config: RelayClientTracingConfig | null,
  resource: RelayClientTracingResource,
): Layer.Layer<never, never, HttpClient.HttpClient> {
  if (config === null) {
    return Layer.succeed(RelayClientTracer, Option.none());
  }

  const tracerLayer = OtlpTracer.layer({
    url: config.tracesUrl,
    headers: {
      Authorization: `Bearer ${config.tracesToken}`,
      "X-Axiom-Dataset": config.tracesDataset,
    },
    resource: {
      serviceName: resource.serviceName,
      serviceVersion: resource.serviceVersion,
      attributes: {
        "service.runtime": resource.runtime,
        "service.component": resource.component ?? "relay-client",
        "t4code.client.surface": resource.client,
      },
    },
  }).pipe(Layer.provide(OtlpSerialization.layerJson));

  return Layer.effect(
    RelayClientTracer,
    Tracer.Tracer.pipe(Effect.map(makeNonInterferingRelayTracer), Effect.map(Option.some)),
  ).pipe(Layer.provide(tracerLayer));
}
