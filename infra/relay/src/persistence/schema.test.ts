import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import snapshot from "../../migrations/postgres/20260714060000_environment_operation_serialization/snapshot.json" with { type: "json" };

import * as RelaySchema from "./schema.ts";
import {
  relayDpopProofs,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayEnvironmentOperations,
  relayManagedEndpointAllocations,
} from "./schema.ts";

class EmbeddedSqlError extends Schema.TaggedErrorClass<EmbeddedSqlError>()("EmbeddedSqlError", {
  cause: Schema.Defect(),
}) {}

describe("relay persistence schema", () => {
  it.effect("keeps the latest Drizzle snapshot aligned with the current schema", () =>
    Effect.gen(function* () {
      const current = yield* Effect.promise(() => generateDrizzleJson(RelaySchema));
      const drift = yield* Effect.promise(() =>
        generateMigration(snapshot as typeof current, current),
      );
      const tables = snapshot.ddl
        .filter((entry) => entry.entityType === "tables")
        .map((entry) => entry.name);

      expect(drift).toEqual([]);
      expect(tables).toContain("relay_environment_operations");
      expect(tables).not.toContain("relay_mobile_devices");
      expect(tables).not.toContain("relay_live_activities");
      expect(tables).not.toContain("relay_agent_activity_rows");
      expect(tables).not.toContain("relay_delivery_attempts");
    }),
  );

  it("enforces one active credential per environment key", () => {
    const config = getTableConfig(relayEnvironmentCredentials);
    const activeCredential = config.indexes.find(
      (candidate) =>
        candidate.config.name === "idx_relay_environment_credentials_active_environment_key",
    );

    expect(activeCredential?.config.unique).toBe(true);
    expect(
      activeCredential?.config.columns.map((column) => "name" in column && column.name),
    ).toEqual(["environment_id", "environment_public_key"]);
    expect(activeCredential?.config.where).toBeDefined();
  });

  it("persists operation ownership and allocation generations", () => {
    const operations = getTableConfig(relayEnvironmentOperations);
    const allocations = getTableConfig(relayManagedEndpointAllocations);

    expect(operations.name).toBe("relay_environment_operations");
    expect(operations.primaryKeys).toHaveLength(1);
    expect(operations.columns.map((column) => column.name)).toEqual([
      "environment_id",
      "generation",
      "owner_token",
      "owner_user_id",
      "operation_kind",
      "lease_expires_at",
      "created_at",
      "updated_at",
    ]);
    expect(allocations.columns.map((column) => column.name)).toContain("operation_generation");
    expect(allocations.columns.map((column) => column.name)).toContain("operation_owner_token");
  });

  it("materializes every table callback", () => {
    expect(getTableConfig(relayEnvironmentLinks).primaryKeys).toHaveLength(1);
    expect(getTableConfig(relayDpopProofs).primaryKeys).toHaveLength(1);
  });

  it.effect(
    "enforces credential uniqueness and operation CAS constraints through Drizzle SQL",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const client = new NodeSqlite.DatabaseSync(":memory:");
          client.exec(`
          create table relay_environment_credentials (
            credential_id text primary key,
            environment_id text not null,
            environment_public_key text not null,
            credential_hash text not null,
            revoked_at text,
            created_at text not null,
            updated_at text not null
          );
          create unique index idx_relay_environment_credentials_active_environment_key
            on relay_environment_credentials (environment_id, environment_public_key)
            where revoked_at is null;
          create table relay_environment_operations (
            environment_id text primary key,
            generation integer not null,
            owner_token text,
            owner_user_id text,
            operation_kind text,
            lease_expires_at text,
            created_at text not null,
            updated_at text not null
          );
        `);
          return { client, db: drizzle({ client }) };
        }),
        ({ client, db }) =>
          Effect.gen(function* () {
            const runAfterBarrier = <A>(
              left: Effect.Effect<A, EmbeddedSqlError>,
              right: Effect.Effect<A, EmbeddedSqlError>,
            ) =>
              Effect.gen(function* () {
                const arrivals = yield* Ref.make(0);
                const ready = yield* Deferred.make<void>();
                const start = Ref.updateAndGet(arrivals, (count) => count + 1).pipe(
                  Effect.tap((count) =>
                    count === 2 ? Deferred.succeed(ready, undefined) : Effect.void,
                  ),
                  Effect.andThen(Deferred.await(ready)),
                );
                return yield* Effect.all(
                  [start.pipe(Effect.andThen(left)), start.pipe(Effect.andThen(right))].map(
                    Effect.result,
                  ),
                  { concurrency: "unbounded" },
                );
              });
            const run = (query: { readonly run: () => unknown }) =>
              Effect.try({
                try: () => query.run(),
                catch: (cause) => new EmbeddedSqlError({ cause }),
              });
            const now = "2026-07-14T00:00:00.000Z";
            const insertCredential = (credentialId: string, environmentId: string) =>
              run(
                db.insert(relayEnvironmentCredentials as never).values({
                  credentialId,
                  environmentId,
                  environmentPublicKey: "key-race",
                  credentialHash: `hash-${credentialId}`,
                  revokedAt: null,
                  createdAt: now,
                  updatedAt: now,
                } as never) as unknown as { readonly run: () => unknown },
              );
            for (let iteration = 0; iteration < 8; iteration++) {
              const credentialResults = yield* runAfterBarrier(
                insertCredential(`credential-${iteration}-a`, `env-race-${iteration}`),
                insertCredential(`credential-${iteration}-b`, `env-race-${iteration}`),
              );
              expect(credentialResults.filter((result) => result._tag === "Success")).toHaveLength(
                1,
              );
            }
            expect(
              client
                .prepare(
                  "select count(*) as count from relay_environment_credentials where revoked_at is null",
                )
                .get(),
            ).toMatchObject({ count: 8 });

            const insertOperation = (environmentId: string, ownerToken: string) =>
              run(
                db.insert(relayEnvironmentOperations as never).values({
                  environmentId,
                  generation: 1,
                  ownerToken,
                  ownerUserId: "user-1",
                  operationKind: "link",
                  leaseExpiresAt: "2026-07-14T00:05:00.000Z",
                  createdAt: now,
                  updatedAt: now,
                } as never) as unknown as { readonly run: () => unknown },
              );
            for (let iteration = 0; iteration < 8; iteration++) {
              const sameKey = yield* runAfterBarrier(
                insertOperation(`env-same-${iteration}`, "owner-a"),
                insertOperation(`env-same-${iteration}`, "owner-b"),
              );
              const distinctKeys = yield* runAfterBarrier(
                insertOperation(`env-left-${iteration}`, "owner-left"),
                insertOperation(`env-right-${iteration}`, "owner-right"),
              );
              expect(sameKey.filter((result) => result._tag === "Success")).toHaveLength(1);
              expect(distinctKeys.every((result) => result._tag === "Success")).toBe(true);
            }

            const staleRelease = db
              .update(relayEnvironmentOperations as never)
              .set({ ownerToken: null, leaseExpiresAt: null } as never)
              .where(
                and(
                  eq(relayEnvironmentOperations.environmentId, "env-same-7"),
                  eq(relayEnvironmentOperations.generation, 0),
                  eq(relayEnvironmentOperations.ownerToken, "stale-owner"),
                ) as never,
              ) as unknown as { readonly run: () => { readonly changes: number } };
            expect(staleRelease.run().changes).toBe(0);
            expect(
              client
                .prepare(
                  "select owner_token as ownerToken from relay_environment_operations where environment_id = ?",
                )
                .get("env-same-7"),
            ).toMatchObject({ ownerToken: expect.stringMatching(/^owner-/u) });
          }),
        ({ client }) => Effect.sync(() => client.close()),
      ),
  );
});
