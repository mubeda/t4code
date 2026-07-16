import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  EnvironmentLinks.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

const proof = {
  environmentId: "env-1",
  descriptor: {
    environmentId: "env-1",
    label: "Environment One",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: true },
  },
  environmentPublicKey: "public-key-1",
} as never;

const endpoint = {
  httpBaseUrl: "https://env-1.example.test/",
  wsBaseUrl: "wss://env-1.example.test/ws",
  providerKind: "cloudflare_tunnel",
} as const;

describe("EnvironmentLinks", () => {
  it("formats each persistence error without exposing key material", () => {
    const cause = new Error("sensitive-key-material");
    const errors = [
      new EnvironmentLinks.EnvironmentLinkUpsertPersistenceError({
        userId: "user-1",
        environmentId: "env-1",
        cause,
      }),
      new EnvironmentLinks.EnvironmentLinkUserListPersistenceError({
        operation: "list-users",
        environmentId: "env-1",
        cause,
      }),
      new EnvironmentLinks.EnvironmentPublicKeyListPersistenceError({
        environmentId: "env-1",
        cause,
      }),
      new EnvironmentLinks.EnvironmentLinkListPersistenceError({ userId: "user-1", cause }),
      new EnvironmentLinks.EnvironmentLinkLookupPersistenceError({
        userId: "user-1",
        environmentId: "env-1",
        cause,
      }),
      new EnvironmentLinks.EnvironmentLinkRevokePersistenceError({
        userId: "user-1",
        environmentId: "env-1",
        cause,
      }),
    ];

    expect(errors.map((error) => error.message)).toEqual([
      "Failed to persist environment link for user 'user-1', environment 'env-1'",
      "Environment link user query 'list-users' failed for environment 'env-1'",
      "Failed to list public keys for environment 'env-1'",
      "Failed to list environment links for user 'user-1'",
      "Failed to look up environment link for user 'user-1', environment 'env-1'",
      "Failed to revoke environment link for user 'user-1', environment 'env-1'",
    ]);
    for (const error of errors) {
      expect(JSON.stringify(error)).not.toContain("sensitive-key-material");
    }
  });

  it.effect("upserts link identity, endpoint, and reactivation state", () => {
    let inserted: Record<string, unknown> | undefined;
    let conflict: Record<string, unknown> | undefined;
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          values: (values: Record<string, unknown>) => {
            inserted = values;
            return {
              onConflictDoUpdate: (input: { readonly set: Record<string, unknown> }) => {
                conflict = input.set;
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.upsert({
        userId: "user-1",
        request: { proof: "redacted", managedTunnelsEnabled: true },
        proof,
        endpoint,
      });

      expect(inserted).toMatchObject({
        userId: "user-1",
        environmentId: "env-1",
        environmentLabel: "Environment One",
        environmentPublicKey: "public-key-1",
        endpointHttpBaseUrl: endpoint.httpBaseUrl,
        endpointWsBaseUrl: endpoint.wsBaseUrl,
        endpointProviderKind: endpoint.providerKind,
        managedTunnelsEnabled: true,
        revokedAt: null,
      });
      expect(inserted?.createdAt).toBe(inserted?.updatedAt);
      expect(conflict).toMatchObject({
        environmentPublicKey: "public-key-1",
        environmentLabel: "Environment One",
        managedTunnelsEnabled: true,
        revokedAt: null,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("maps upsert persistence failures to structured identity", () => {
    const cause = new Error("insert failed");
    const fakeDb = {
      insert: () => ({
        values: () => ({ onConflictDoUpdate: () => Effect.fail(cause) }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.upsert({
          userId: "user-1",
          request: { proof: "redacted", managedTunnelsEnabled: false },
          proof,
          endpoint,
        }),
      );
      expect(error).toMatchObject({ userId: "user-1", environmentId: "env-1", cause });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
  it.effect("retains link lookup failures with user and environment identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayEnvironmentLinks);
          return {
            where: () => ({
              limit: () => Effect.fail(cause),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.getForUser({ userId: "user-1", environmentId: "env-1" }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkLookupPersistenceError",
        userId: "user-1",
        environmentId: "env-1",
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("identifies user-list failures without retaining key material", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayEnvironmentLinks);
          return {
            where: () => Effect.fail(cause),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(links.listUsersForEnvironment({ environmentId: "env-1" }));

      expect(error).toMatchObject({
        _tag: "EnvironmentLinkUserListPersistenceError",
        operation: "list-users",
        environmentId: "env-1",
      });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("environmentPublicKey");
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("selects active linked users for an environment", () => {
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      select: (selection: unknown) => {
        expect(selection).toBeDefined();
        return {
          from: (table: unknown) => {
            expect(table).toBe(relayEnvironmentLinks);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return Effect.succeed([{ userId: "user-1" }]);
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.listUsersForEnvironment({ environmentId: "env-1" })).toEqual(["user-1"]);
      expect(whereConditions).toHaveLength(1);

      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).not.toContain("notifications_enabled");
      expect(query.sql).not.toContain("live_activities_enabled");
      expect(query.params).toEqual(["env-1"]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("deduplicates non-empty active environment public keys", () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Effect.succeed([
              { environmentPublicKey: "key-a" },
              { environmentPublicKey: "" },
              { environmentPublicKey: "key-a" },
              { environmentPublicKey: "key-b" },
            ]),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.listPublicKeysForEnvironment({ environmentId: "env-1" })).toEqual([
        "key-a",
        "key-b",
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("maps public-key and user link-list failures", () => {
    const publicKeyCause = new Error("public key query failed");
    const listCause = new Error("user list failed");
    let calls = 0;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Effect.fail(calls++ === 0 ? publicKeyCause : listCause),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const publicKeyError = yield* Effect.flip(
        links.listPublicKeysForEnvironment({ environmentId: "env-1" }),
      );
      const listError = yield* Effect.flip(links.listForUser({ userId: "user-1" }));
      expect(publicKeyError).toMatchObject({ environmentId: "env-1", cause: publicKeyCause });
      expect(listError).toMatchObject({ userId: "user-1", cause: listCause });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("lists and looks up links with stable label fallbacks", () => {
    let call = 0;
    const rows = [
      {
        environmentId: "env-1",
        environmentLabel: "Environment One",
        environmentPublicKey: "key-1",
        endpointHttpBaseUrl: endpoint.httpBaseUrl,
        endpointWsBaseUrl: endpoint.wsBaseUrl,
        endpointProviderKind: endpoint.providerKind,
        managedTunnelsEnabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        environmentId: "env-2",
        environmentLabel: "   ",
        environmentPublicKey: "key-2",
        endpointHttpBaseUrl: "https://env-2.example.test/",
        endpointWsBaseUrl: "wss://env-2.example.test/ws",
        endpointProviderKind: "manual",
        managedTunnelsEnabled: false,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => {
            if (call++ === 0) return Effect.succeed(rows);
            return {
              limit: () => Effect.succeed(call === 2 ? [rows[1]] : call === 3 ? [rows[0]] : []),
            };
          },
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const listed = yield* links.listForUser({ userId: "user-1" });
      const found = yield* links.getForUser({ userId: "user-1", environmentId: "env-2" });
      const named = yield* links.getForUser({ userId: "user-1", environmentId: "env-1" });
      const missing = yield* links.getForUser({ userId: "user-1", environmentId: "missing" });

      expect(listed.map((record) => record.label)).toEqual(["Environment One", "env-2"]);
      expect(found).toMatchObject({ label: "env-2", environmentPublicKey: "key-2" });
      expect(named).toMatchObject({ label: "Environment One", environmentPublicKey: "key-1" });
      expect(named?.managedTunnelsEnabled).toBe(true);
      expect(missing).toBeNull();
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("restores the exact prior active link snapshot", () => {
    const restored: Array<Record<string, unknown>> = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          values: (values: Record<string, unknown>) => {
            restored.push(values);
            return {
              onConflictDoUpdate: (conflict: { readonly set: Record<string, unknown> }) => {
                restored.push(conflict.set);
                return Effect.void;
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.restoreForUser({
        userId: "user-1",
        record: {
          environmentId: "env-1" as EnvironmentLinks.RelayLinkedEnvironmentRecord["environmentId"],
          label: "Environment One",
          environmentPublicKey: "public-key",
          endpoint,
          managedTunnelsEnabled: true,
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      });

      expect(restored[0]).toMatchObject({
        userId: "user-1",
        environmentId: "env-1",
        environmentLabel: "Environment One",
        environmentPublicKey: "public-key",
        managedTunnelsEnabled: true,
        revokedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(restored[1]).toMatchObject({
        environmentLabel: "Environment One",
        environmentPublicKey: "public-key",
        managedTunnelsEnabled: true,
        revokedAt: null,
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("maps prior-link restore persistence failures", () => {
    const cause = new Error("restore unavailable");
    const fakeDb = {
      insert: () => ({
        values: () => ({ onConflictDoUpdate: () => Effect.fail(cause) }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const error = yield* Effect.flip(
        links.restoreForUser({
          userId: "user-1",
          record: {
            environmentId:
              "env-1" as EnvironmentLinks.RelayLinkedEnvironmentRecord["environmentId"],
            label: "Environment One",
            environmentPublicKey: "public-key",
            endpoint,
            managedTunnelsEnabled: true,
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      );
      expect(error).toMatchObject({ userId: "user-1", environmentId: "env-1", cause });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("revokes only the active link owned by the requesting user", () => {
    const updateValues: Array<Record<string, unknown>> = [];
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayEnvironmentLinks);
        return {
          set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return {
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
                    return Effect.succeed([{ environmentId: "env-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const revoked = yield* links.revokeForUser({
        userId: "user-1",
        environmentId: "env-1",
      });

      expect(revoked).toBe(true);
      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.revokedAt).toEqual(updateValues[0]?.updatedAt);
      expect(typeof updateValues[0]?.revokedAt).toBe("string");
      expect(whereConditions).toHaveLength(1);

      const dialect = new PgDialect();
      const query = dialect.sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_links"."user_id" = $1');
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $2');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.params).toEqual(["user-1", "env-1"]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("returns false for an already revoked link and maps revoke failures", () => {
    const cause = new Error("revoke failed");
    let calls = 0;
    const fakeDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => (calls++ === 0 ? Effect.succeed([]) : Effect.fail(cause)),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.revokeForUser({ userId: "user-1", environmentId: "env-1" })).toBe(false);
      const error = yield* Effect.flip(
        links.revokeForUser({ userId: "user-1", environmentId: "env-1" }),
      );
      expect(error).toMatchObject({ userId: "user-1", environmentId: "env-1", cause });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
