// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as FastCheck from "fast-check";

import { OrchestrationEvent, ORCHESTRATION_WS_METHODS } from "../src/orchestration.ts";
import { WS_METHODS, WsRpcGroup } from "../src/rpc.ts";
import { DEFAULT_SERVER_SETTINGS } from "../src/settings.ts";

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema";
const requestId = "900719925474099312345";

const request = {
  _tag: "Request",
  id: requestId,
  tag: "server.getConfig",
  payload: {},
  headers: [
    ["authorization", "Bearer fixture"],
    ["x-t4code-fixture", "rpc-wire"],
  ],
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  sampled: true,
} satisfies RpcMessage.RequestEncoded;

const fixtures = {
  ack: {
    _tag: "Ack",
    requestId,
  } satisfies RpcMessage.AckEncoded,
  chunk: {
    _tag: "Chunk",
    requestId,
    values: [
      { _tag: "First", value: 1 },
      { _tag: "Second", value: "two" },
    ],
  } satisfies RpcMessage.ResponseChunkEncoded,
  "client-protocol-error": {
    _tag: "ClientProtocolError",
    error: {
      _tag: "RpcClientError",
      reason: {
        _tag: "RpcClientDefect",
        message: "fixture protocol error",
        cause: "fixture cause",
      },
    },
  },
  defect: {
    _tag: "Defect",
    defect: "fixture connection defect",
  } satisfies RpcMessage.ResponseDefectEncoded,
  eof: { _tag: "Eof" } satisfies RpcMessage.Eof,
  "exit-defect": {
    _tag: "Exit",
    requestId,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Die", defect: "fixture request defect" }],
    },
  } satisfies RpcMessage.ResponseExitEncoded,
  "exit-failure": {
    _tag: "Exit",
    requestId,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Fail", error: { _tag: "FixtureError", message: "typed failure" } }],
    },
  } satisfies RpcMessage.ResponseExitEncoded,
  "exit-interrupt": {
    _tag: "Exit",
    requestId,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Interrupt", fiberId: undefined }],
    },
  } satisfies RpcMessage.ResponseExitEncoded,
  "exit-stream-success": {
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value: undefined },
  } satisfies RpcMessage.ResponseExitEncoded,
  "exit-success": {
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value: { ready: true } },
  } satisfies RpcMessage.ResponseExitEncoded,
  interrupt: {
    _tag: "Interrupt",
    requestId,
  } satisfies RpcMessage.InterruptEncoded,
  ping: { _tag: "Ping" } satisfies RpcMessage.Ping,
  pong: { _tag: "Pong" } satisfies RpcMessage.Pong,
  request,
} as const;

const methods = [...WsRpcGroup.requests.values()]
  .map((rpc) => ({
    name: rpc._tag,
    mode:
      StreamSchemaTypeId in (rpc.successSchema as object)
        ? ("stream" as const)
        : ("unary" as const),
  }))
  .toSorted((left, right) => left.name.localeCompare(right.name));
const activeNames = new Set<string>(methods.map(({ name }) => name));
const knownNames = new Set([
  ...Object.values(WS_METHODS),
  ...Object.values(ORCHESTRATION_WS_METHODS),
]);
const staleMethodIdentifiers = [...knownNames].filter((name) => !activeNames.has(name)).toSorted();

interface UnionLikeAst {
  readonly _tag: string;
  readonly types?: ReadonlyArray<SchemaAST.AST>;
}

const countSchemaShapes = (ast: UnionLikeAst): number => {
  if (ast._tag !== "Union") return 1;
  if (ast.types === undefined) {
    throw new Error("Union schema AST did not expose its member types.");
  }
  return ast.types.length;
};

const topLevelStreamShapeCount = [...WsRpcGroup.requests.values()]
  .filter((rpc) => StreamSchemaTypeId in (rpc.successSchema as object))
  .reduce((count, rpc) => {
    const streamSchema = rpc.successSchema as unknown as {
      readonly success: { readonly ast: UnionLikeAst };
    };
    return count + countSchemaShapes(streamSchema.success.ast);
  }, 0);
const orchestrationEventShapeCount = countSchemaShapes(OrchestrationEvent.ast);

const schemaMembers = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  ast._tag === "Union" ? ast.types : [ast];

const fixtureServerConfig = {
  environment: {
    environmentId: "fixture",
    label: "Fixture",
    platform: { os: "windows", arch: "x64" },
    serverVersion: "0.1.1",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t4code_session",
  },
  cwd: "C:\\fixture",
  keybindingsConfigPath: "C:\\fixture\\keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "C:\\fixture\\logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
} as const;
const fixtureDate = Option.getOrThrow(DateTime.make(1_767_225_600_000));
const fixturePairingLink = {
  id: "fixture-pairing-link",
  credential: "23456789ABCD",
  scopes: ["orchestration:read"],
  subject: "fixture",
  createdAt: fixtureDate,
  expiresAt: fixtureDate,
} as const;
const fixtureClientSession = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  subject: "fixture",
  scopes: ["orchestration:read"],
  method: "bearer-access-token",
  client: { deviceType: "desktop" },
  issuedAt: fixtureDate,
  expiresAt: fixtureDate,
  lastConnectedAt: null,
  connected: false,
  current: false,
} as const;

const manualStreamSamples = new Map<string, unknown>([
  ["subscribeServerConfig:0", { version: 1, type: "snapshot", config: fixtureServerConfig }],
  [
    "subscribeServerConfig:1",
    {
      version: 1,
      type: "keybindingsUpdated",
      payload: { keybindings: [], issues: [] },
    },
  ],
  [
    "subscribeServerConfig:3",
    {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: DEFAULT_SERVER_SETTINGS },
    },
  ],
  [
    "subscribeAuthAccess:0",
    {
      version: 1,
      revision: 1,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [] },
    },
  ],
  [
    "subscribeAuthAccess:1",
    {
      version: 1,
      revision: 2,
      type: "pairingLinkUpserted",
      payload: fixturePairingLink,
    },
  ],
  [
    "subscribeAuthAccess:2",
    {
      version: 1,
      revision: 3,
      type: "pairingLinkRemoved",
      payload: { id: fixturePairingLink.id },
    },
  ],
  [
    "subscribeAuthAccess:3",
    {
      version: 1,
      revision: 4,
      type: "clientUpserted",
      payload: fixtureClientSession,
    },
  ],
  [
    "subscribeAuthAccess:4",
    {
      version: 1,
      revision: 5,
      type: "clientRemoved",
      payload: { sessionId: fixtureClientSession.sessionId },
    },
  ],
]);

const stringSeed = (value: string): number => {
  let seed = 0x811c9dc5;
  for (const character of value) {
    seed ^= character.codePointAt(0) ?? 0;
    seed = Math.imul(seed, 0x01000193);
  }
  return seed | 0;
};

const encodeSchemaSample = (
  ast: SchemaAST.AST,
  fixtureKey: string,
  manualValue?: unknown,
): unknown => {
  const codec = Schema.make(ast) as Schema.Codec<unknown, unknown, never, never>;
  const encodeAndValidate = (value: unknown): unknown => {
    const encoded = Schema.encodeUnknownSync(codec)(value);
    const jsonRoundTrip = JSON.parse(
      JSON.stringify(encoded, (_key, item: unknown) => {
        if (typeof item === "number" && !Number.isFinite(item)) return 0;
        if (typeof item === "string" && /^-?\d{5,}-\d{2}-\d{2}T/.test(item)) {
          return "2026-01-01T00:00:00.000Z";
        }
        return item;
      }),
    ) as unknown;
    return jsonRoundTrip;
  };
  if (manualValue !== undefined) {
    return encodeAndValidate(manualValue);
  }
  const arbitrary = Schema.toArbitrary(codec);
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [sample] = FastCheck.sample(arbitrary, {
      numRuns: 1,
      seed: stringSeed(`${fixtureKey}:${attempt}`),
    });
    try {
      return encodeAndValidate(sample);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not generate schema fixture ${fixtureKey}.`, { cause: lastError });
};

const jsonParser = RpcSerialization.json.makeUnsafe();
const serializeWireFixture = (message: unknown): unknown => {
  const encoded = jsonParser.encode(message);
  if (typeof encoded !== "string") {
    throw new Error("JSON RPC serializer did not produce a string.");
  }
  return JSON.parse(encoded) as unknown;
};

const dynamicFixtures = new Map<string, unknown>();
const schemaFingerprints: Record<string, string> = {};
const streamShapeFixtures: Array<string> = [];
const typedFailureFixtures: Array<string> = [];
for (const rpc of [...WsRpcGroup.requests.values()].toSorted((left, right) =>
  left._tag.localeCompare(right._tag),
)) {
  const safeMethodName = rpc._tag.replaceAll(".", "__");
  if (StreamSchemaTypeId in (rpc.successSchema as object)) {
    const streamSchema = rpc.successSchema as unknown as {
      readonly success: { readonly ast: SchemaAST.AST };
    };
    for (const [index, member] of schemaMembers(streamSchema.success.ast).entries()) {
      const fixtureKey = `${rpc._tag}:${index}`;
      const relativePath = `stream-shapes/${safeMethodName}-${String(index).padStart(2, "0")}.json`;
      const value = encodeSchemaSample(member, fixtureKey, manualStreamSamples.get(fixtureKey));
      dynamicFixtures.set(
        relativePath,
        serializeWireFixture({
          _tag: "Chunk",
          requestId,
          values: [value],
        } satisfies RpcMessage.ResponseChunkEncoded),
      );
      schemaFingerprints[relativePath] = NodeCrypto.createHash("sha256")
        .update(JSON.stringify(member))
        .digest("hex");
      streamShapeFixtures.push(relativePath);
    }
  }

  for (const [index, member] of schemaMembers(rpc.errorSchema.ast).entries()) {
    if (member._tag === "Never") continue;
    const fixtureKey = `${rpc._tag}:error:${index}`;
    const relativePath = `typed-failures/${safeMethodName}-${String(index).padStart(2, "0")}.json`;
    let error: unknown;
    try {
      error = encodeSchemaSample(member, fixtureKey);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("Unsupported AST Never")) {
        continue;
      }
      throw cause;
    }
    dynamicFixtures.set(
      relativePath,
      serializeWireFixture({
        _tag: "Exit",
        requestId,
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Fail", error }],
        },
      } satisfies RpcMessage.ResponseExitEncoded),
    );
    schemaFingerprints[relativePath] = NodeCrypto.createHash("sha256")
      .update(JSON.stringify(member))
      .digest("hex");
    typedFailureFixtures.push(relativePath);
  }
}

if (methods.length !== 80) {
  throw new Error(`Expected 80 active RPC methods, found ${methods.length}.`);
}
const streamMethodCount = methods.filter(({ mode }) => mode === "stream").length;
if (streamMethodCount !== 14) {
  throw new Error(`Expected 14 streaming RPC methods, found ${streamMethodCount}.`);
}
if (topLevelStreamShapeCount !== 54) {
  throw new Error(
    `Expected 54 top-level streaming item shapes, found ${topLevelStreamShapeCount}.`,
  );
}
if (streamShapeFixtures.length !== topLevelStreamShapeCount) {
  throw new Error(
    `Exported ${streamShapeFixtures.length} stream shape fixtures, expected ${topLevelStreamShapeCount}.`,
  );
}
if (typedFailureFixtures.length !== 122) {
  throw new Error(`Expected 122 typed failure fixtures, found ${typedFailureFixtures.length}.`);
}
if (orchestrationEventShapeCount !== 22) {
  throw new Error(`Expected 22 orchestration event shapes, found ${orchestrationEventShapeCount}.`);
}
const expectedStale = ["projects.add", "projects.list", "projects.remove"];
if (JSON.stringify(staleMethodIdentifiers) !== JSON.stringify(expectedStale)) {
  throw new Error(`Unexpected stale RPC identifiers: ${staleMethodIdentifiers.join(", ")}`);
}

const outputDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/rpc-wire");
await NodeFSP.rm(outputDirectory, { force: true, recursive: true });
await NodeFSP.mkdir(outputDirectory, { recursive: true });
for (const [name, fixture] of Object.entries(fixtures)) {
  const outputPath = NodePath.join(outputDirectory, `${name}.json`);
  await NodeFSP.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
}
for (const [relativePath, fixture] of dynamicFixtures) {
  const outputPath = NodePath.join(outputDirectory, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  await NodeFSP.writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
}
const manifestPath = NodePath.join(outputDirectory, "manifest.json");
await NodeFSP.writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      protocolVersion: "effect-4.0.0-beta.78",
      methods,
      streamMethodCount,
      expectedTopLevelStreamShapes: topLevelStreamShapeCount,
      expectedOrchestrationEventShapes: orchestrationEventShapeCount,
      streamShapeFixtures,
      typedFailureFixtures,
      schemaFingerprints,
      staleMethodIdentifiers,
      fixtures: [
        ...Object.keys(fixtures).map((name) => `${name}.json`),
        ...dynamicFixtures.keys(),
      ].toSorted(),
    },
    null,
    2,
  )}\n`,
);

const formatResult = NodeChildProcess.spawnSync("vp", ["fmt", "--write", outputDirectory], {
  cwd: NodePath.resolve(import.meta.dirname, "../../.."),
  stdio: "inherit",
});
if (formatResult.status !== 0) {
  throw new Error(`Failed to format RPC fixtures (exit ${formatResult.status ?? "unknown"}).`);
}
