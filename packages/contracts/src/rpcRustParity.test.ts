// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

import { OrchestrationEvent, ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import {
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
} from "./server.ts";

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema";
const decodeProcessDiagnostics = Schema.decodeUnknownSync(ServerProcessDiagnosticsResult);
const decodeProcessResourceHistory = Schema.decodeUnknownSync(ServerProcessResourceHistoryResult);
const decodeSignalProcessInput = Schema.decodeUnknownSync(ServerSignalProcessInput);

interface Manifest {
  readonly methods: ReadonlyArray<{
    readonly name: string;
    readonly mode: "stream" | "unary";
  }>;
  readonly streamMethodCount: number;
  readonly expectedTopLevelStreamShapes: number;
  readonly expectedOrchestrationEventShapes: number;
  readonly streamShapeFixtures: ReadonlyArray<string>;
  readonly typedFailureFixtures: ReadonlyArray<string>;
  readonly schemaFingerprints: Readonly<Record<string, string>>;
  readonly staleMethodIdentifiers: ReadonlyArray<string>;
  readonly fixtures: ReadonlyArray<string>;
}

const countShapes = (ast: {
  readonly _tag: string;
  readonly types?: ReadonlyArray<unknown>;
}): number => (ast._tag === "Union" ? (ast.types?.length ?? 0) : 1);

const schemaMembers = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  ast._tag === "Union" ? ast.types : [ast];

const safeMethodName = (method: string): string => method.replaceAll(".", "__");

describe("Rust RPC fixture parity", () => {
  it("tracks attributed diagnostics and identity-bound signal wire fixtures", () => {
    const fixtureDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/rpc-wire");
    const readFixture = (name: string): unknown =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(fixtureDirectory, name), "utf8")) as unknown;
    const diagnostics = readFixture(
      "contract-shapes/server__getProcessDiagnostics-success.json",
    ) as {
      readonly exit: { readonly value: unknown };
    };
    const history = readFixture(
      "contract-shapes/server__getProcessResourceHistory-success.json",
    ) as {
      readonly exit: { readonly value: unknown };
    };
    const signal = readFixture("contract-shapes/server__signalProcess-request.json") as {
      readonly payload: unknown;
    };

    expect(diagnostics.exit.value).toMatchObject({
      totals: {
        combined: { cpuPercent: 3, rssBytes: 30, processCount: 2 },
        core: { cpuPercent: 1, rssBytes: 10, processCount: 1 },
        external: { cpuPercent: 2, rssBytes: 20, processCount: 1 },
      },
      uiCoverage: { status: "notApplicable", message: { _tag: "None" } },
      processes: [
        {
          processKey: "42:100",
          scope: "external",
          kind: "provider",
          label: "Codex",
          confidence: "exact",
        },
      ],
    });
    expect(diagnostics.exit.value).not.toHaveProperty("processCount");
    expect(diagnostics.exit.value).not.toHaveProperty("totalRssBytes");
    expect(diagnostics.exit.value).not.toHaveProperty("totalCpuPercent");
    expect(history.exit.value).toMatchObject({
      cpuSecondsApprox: { combined: 1.5, core: 1, external: 0.5 },
      uiCoverage: { status: "partial", message: { _tag: "Some" } },
      buckets: [
        {
          cpuPercent: {
            average: { combined: 3, core: 1, external: 2 },
            peak: { combined: 6, core: 2, external: 4 },
          },
          rssBytes: {
            average: { combined: 30, core: 10, external: 20 },
            peak: { combined: 60, core: 20, external: 40 },
          },
          maxProcessCount: { combined: 2, core: 1, external: 1 },
        },
      ],
      processes: [{ processKey: "42:100", scope: "external", kind: "provider" }],
    });
    expect(history.exit.value).not.toHaveProperty("totalCpuSecondsApprox");
    expect(history.exit.value).not.toHaveProperty("topProcesses");
    expect(signal.payload).toEqual({
      pid: 42,
      processKey: "42:100",
      signal: "SIGINT",
    });
  });

  it("accepts attributed diagnostics and identity-bound signal payloads", () => {
    const startedAt = DateTime.makeUnsafe("1970-01-01T00:00:00Z");
    const endedAt = DateTime.makeUnsafe("1970-01-01T00:00:01Z");
    const totals = {
      combined: { cpuPercent: 3, rssBytes: 30, processCount: 2 },
      core: { cpuPercent: 1, rssBytes: 10, processCount: 1 },
      external: { cpuPercent: 2, rssBytes: 20, processCount: 1 },
    };
    const attribution = {
      processKey: "42:100",
      scope: "external",
      kind: "provider",
      label: "Codex",
      confidence: "exact",
    };

    expect(() =>
      decodeProcessDiagnostics({
        serverPid: 1,
        readAt: startedAt,
        totals,
        uiCoverage: { status: "notApplicable", message: Option.none() },
        processes: [
          {
            pid: 42,
            ppid: 1,
            pgid: Option.none(),
            status: "Run",
            cpuPercent: 2,
            rssBytes: 20,
            elapsed: "00:00:01",
            command: "codex",
            depth: 1,
            childPids: [],
            ...attribution,
          },
        ],
        error: Option.none(),
      }),
    ).not.toThrow();

    expect(() =>
      decodeProcessResourceHistory({
        readAt: endedAt,
        windowMs: 60_000,
        bucketMs: 1_000,
        sampleIntervalMs: 500,
        retainedSampleCount: 2,
        cpuSecondsApprox: { combined: 1.5, core: 1, external: 0.5 },
        uiCoverage: { status: "partial", message: Option.some("UI coverage") },
        buckets: [
          {
            startedAt,
            endedAt,
            cpuPercent: {
              average: { combined: 3, core: 1, external: 2 },
              peak: { combined: 6, core: 2, external: 4 },
            },
            rssBytes: {
              average: { combined: 30, core: 10, external: 20 },
              peak: { combined: 60, core: 20, external: 40 },
            },
            maxProcessCount: { combined: 2, core: 1, external: 1 },
          },
        ],
        processes: [
          {
            pid: 42,
            ppid: 1,
            command: "codex",
            depth: 1,
            ...attribution,
            firstSeenAt: startedAt,
            lastSeenAt: endedAt,
            currentCpuPercent: 2,
            avgCpuPercent: 2,
            maxCpuPercent: 4,
            cpuSecondsApprox: 0.5,
            currentRssBytes: 20,
            maxRssBytes: 40,
            sampleCount: 2,
          },
        ],
        error: Option.none(),
      }),
    ).not.toThrow();

    expect(
      decodeSignalProcessInput({
        pid: 42,
        processKey: "42:100",
        signal: "SIGINT",
      }),
    ).toEqual({
      pid: 42,
      processKey: "42:100",
      signal: "SIGINT",
    });
  });

  it("tracks the executable TypeScript RPC schemas without stale manifests", () => {
    const fixtureDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/rpc-wire");
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixtureDirectory, "manifest.json"), "utf8"),
    ) as Manifest;
    const methods = [...WsRpcGroup.requests.values()]
      .map((rpc) => ({
        name: rpc._tag,
        mode:
          StreamSchemaTypeId in (rpc.successSchema as object)
            ? ("stream" as const)
            : ("unary" as const),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const topLevelStreamShapeCount = [...WsRpcGroup.requests.values()]
      .filter((rpc) => StreamSchemaTypeId in (rpc.successSchema as object))
      .reduce((count, rpc) => {
        const streamSchema = rpc.successSchema as unknown as {
          readonly success: {
            readonly ast: { readonly _tag: string; readonly types?: ReadonlyArray<unknown> };
          };
        };
        return count + countShapes(streamSchema.success.ast);
      }, 0);
    const activeNames = new Set<string>(methods.map(({ name }) => name));
    const staleMethodIdentifiers = [
      ...new Set([...Object.values(WS_METHODS), ...Object.values(ORCHESTRATION_WS_METHODS)]),
    ]
      .filter((name) => !activeNames.has(name))
      .toSorted();
    const expectedStreamFixtures: Array<string> = [];
    const expectedTypedFailureFixtures: Array<string> = [];
    const expectedSchemaFingerprints: Record<string, string> = {};
    for (const rpc of [...WsRpcGroup.requests.values()].toSorted((left, right) =>
      left._tag.localeCompare(right._tag),
    )) {
      if (StreamSchemaTypeId in (rpc.successSchema as object)) {
        const streamSchema = rpc.successSchema as unknown as {
          readonly success: { readonly ast: SchemaAST.AST };
        };
        for (const [index, member] of schemaMembers(streamSchema.success.ast).entries()) {
          const fixture = `stream-shapes/${safeMethodName(rpc._tag)}-${String(index).padStart(2, "0")}.json`;
          expectedStreamFixtures.push(fixture);
          expectedSchemaFingerprints[fixture] = NodeCrypto.createHash("sha256")
            .update(JSON.stringify(member))
            .digest("hex");
        }
      }

      for (const [index, member] of schemaMembers(rpc.errorSchema.ast).entries()) {
        try {
          Schema.toArbitrary(Schema.make(member));
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes("Unsupported AST Never")) continue;
          throw cause;
        }
        const fixture = `typed-failures/${safeMethodName(rpc._tag)}-${String(index).padStart(2, "0")}.json`;
        expectedTypedFailureFixtures.push(fixture);
        expectedSchemaFingerprints[fixture] = NodeCrypto.createHash("sha256")
          .update(JSON.stringify(member))
          .digest("hex");
      }
    }

    expect(manifest.methods).toEqual(methods);
    expect(manifest.streamMethodCount).toBe(methods.filter(({ mode }) => mode === "stream").length);
    expect(manifest.expectedTopLevelStreamShapes).toBe(topLevelStreamShapeCount);
    expect(manifest.expectedOrchestrationEventShapes).toBe(countShapes(OrchestrationEvent.ast));
    expect(manifest.streamShapeFixtures).toEqual(expectedStreamFixtures);
    expect(manifest.typedFailureFixtures).toEqual(expectedTypedFailureFixtures);
    expect(manifest.schemaFingerprints).toEqual(expectedSchemaFingerprints);
    expect(manifest.staleMethodIdentifiers).toEqual(staleMethodIdentifiers);
    expect(new Set(manifest.fixtures).size).toBe(manifest.fixtures.length);
    for (const fixture of manifest.fixtures) {
      expect(NodeFS.existsSync(NodePath.join(fixtureDirectory, fixture))).toBe(true);
    }
  });
});
