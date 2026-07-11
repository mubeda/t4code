// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

import { OrchestrationEvent, ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema";

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
