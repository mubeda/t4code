// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

interface ScenarioManifest {
  readonly id: string;
  readonly latestMigrationId: number | null;
  readonly files: {
    readonly database: string;
    readonly migratedDatabase: string;
    readonly ledger: string;
    readonly pragmas: string;
    readonly schema: string;
    readonly snapshot: string;
  };
}

interface PersistenceManifest {
  readonly formatVersion: 1;
  readonly currentMigrationId: 33;
  readonly applicationTables: ReadonlyArray<string>;
  readonly scenarios: ReadonlyArray<ScenarioManifest>;
}

interface LedgerSnapshot {
  readonly present: boolean;
  readonly latestMigrationId: number | null;
  readonly entries: ReadonlyArray<{ readonly migrationId: number }>;
}

interface SchemaSnapshot {
  readonly tables: ReadonlyArray<{
    readonly name: string;
    readonly columns: ReadonlyArray<{ readonly name: string }>;
    readonly indexes: ReadonlyArray<{ readonly name: string }>;
  }>;
}

interface LogicalSnapshot {
  readonly tables: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
}

const readJson = <A>(path: string): A => JSON.parse(NodeFS.readFileSync(path, "utf8")) as A;

const listRelativeFiles = (directory: string, prefix = ""): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? listRelativeFiles(NodePath.join(directory, entry.name), relativePath)
      : [relativePath];
  });

describe("Rust persistence fixture parity", () => {
  it("validates the checked-in corpus consumed by the Rust migration tests", () => {
    const canonicalDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/persistence");
    const canonicalFiles = listRelativeFiles(canonicalDirectory).toSorted();
    expect(canonicalFiles.some((path) => path.endsWith("-shm") || path.endsWith("-wal"))).toBe(
      false,
    );

    const manifest = readJson<PersistenceManifest>(
      NodePath.join(canonicalDirectory, "manifest.json"),
    );
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.currentMigrationId).toBe(33);
    expect(manifest.applicationTables).toHaveLength(15);
    expect(
      manifest.scenarios.map(({ id, latestMigrationId }) => ({ id, latestMigrationId })),
    ).toEqual([
      { id: "empty-unmigrated", latestMigrationId: null },
      { id: "legacy-v15", latestMigrationId: 15 },
      { id: "interrupted-v27", latestMigrationId: 26 },
      { id: "current-v33", latestMigrationId: 33 },
    ]);

    for (const scenario of manifest.scenarios) {
      expect(
        NodeFS.statSync(NodePath.join(canonicalDirectory, scenario.files.database)).size,
      ).toBeGreaterThan(0);
      expect(
        NodeFS.statSync(NodePath.join(canonicalDirectory, scenario.files.migratedDatabase)).size,
      ).toBeGreaterThan(0);
      const ledger = readJson<LedgerSnapshot>(
        NodePath.join(canonicalDirectory, scenario.files.ledger),
      );
      expect(ledger.latestMigrationId).toBe(scenario.latestMigrationId);
      expect(ledger.present).toBe(scenario.latestMigrationId !== null);
      expect(ledger.entries.at(-1)?.migrationId ?? null).toBe(scenario.latestMigrationId);
    }

    const interrupted = manifest.scenarios.find(({ id }) => id === "interrupted-v27");
    expect(interrupted).toBeDefined();
    if (interrupted !== undefined) {
      const schema = readJson<SchemaSnapshot>(
        NodePath.join(canonicalDirectory, interrupted.files.schema),
      );
      const providerRuntime = schema.tables.find(({ name }) => name === "provider_session_runtime");
      expect(providerRuntime?.columns.some(({ name }) => name === "provider_instance_id")).toBe(
        true,
      );
      expect(
        providerRuntime?.indexes.some(
          ({ name }) => name === "idx_provider_session_runtime_instance",
        ),
      ).toBe(false);
    }

    const current = manifest.scenarios.find(({ id }) => id === "current-v33");
    expect(current).toBeDefined();
    if (current !== undefined) {
      const snapshot = readJson<LogicalSnapshot>(
        NodePath.join(canonicalDirectory, current.files.snapshot),
      );
      expect(Object.keys(snapshot.tables).toSorted()).toEqual(
        [...manifest.applicationTables].toSorted(),
      );
      for (const table of manifest.applicationTables) {
        expect(snapshot.tables[table]?.length).toBeGreaterThan(0);
      }
    }
  });
});
