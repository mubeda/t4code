// @effect-diagnostics nodeBuiltinImport:off - Fixture exporter tests exercise Node-only tooling boundaries directly.
import * as NodePath from "node:path";

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const io = vi.hoisted(() => ({
  directories: [] as string[],
  formatCalls: [] as Array<{
    command: string;
    args: ReadonlyArray<string>;
    options: Readonly<Record<string, unknown>>;
  }>,
  formatStatus: 0 as number | null,
  removals: [] as string[],
  writes: new Map<string, string>(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: async (path: string) => {
    io.directories.push(path);
  },
  rm: async (path: string) => {
    io.removals.push(path);
  },
  writeFile: async (path: string, contents: string) => {
    io.writes.set(path, contents);
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: (
    command: string,
    args: ReadonlyArray<string>,
    options: Readonly<Record<string, unknown>>,
  ) => {
    io.formatCalls.push({ command, args, options });
    return { status: io.formatStatus };
  },
}));

const outputDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/rpc-wire");
const manifestPath = NodePath.join(outputDirectory, "manifest.json");

interface RpcManifest {
  readonly methods: ReadonlyArray<{ readonly name: string; readonly mode: string }>;
  readonly streamMethodCount: number;
  readonly expectedTopLevelStreamShapes: number;
  readonly expectedOrchestrationEventShapes: number;
  readonly streamShapeFixtures: ReadonlyArray<string>;
  readonly typedFailureFixtures: ReadonlyArray<string>;
  readonly staleMethodIdentifiers: ReadonlyArray<string>;
  readonly schemaFingerprints: Readonly<Record<string, string>>;
  readonly fixtures: ReadonlyArray<string>;
}

async function runExporter(): Promise<void> {
  await import("./export-rust-rpc-fixtures.ts");
}

function readManifest(): RpcManifest {
  const contents = io.writes.get(manifestPath);
  if (contents === undefined) {
    throw new Error("RPC fixture exporter did not write its manifest.");
  }
  return JSON.parse(contents) as RpcManifest;
}

beforeEach(() => {
  vi.resetModules();
  io.directories = [];
  io.formatCalls = [];
  io.formatStatus = 0;
  io.removals = [];
  io.writes.clear();
});

describe("RPC wire fixture exporter", () => {
  it("writes a deterministic, complete fixture tree", async () => {
    await runExporter();

    const manifest = readManifest();
    expect(io.removals).toEqual([outputDirectory]);
    expect(io.directories).toContain(outputDirectory);
    expect(io.formatCalls).toEqual([
      {
        command: "vp",
        args: ["fmt", "--write", outputDirectory],
        options: {
          cwd: NodePath.resolve(import.meta.dirname, "../../.."),
          stdio: "inherit",
        },
      },
    ]);
    expect(manifest.methods).toHaveLength(81);
    expect(manifest.methods.filter(({ mode }) => mode === "stream")).toHaveLength(14);
    expect(manifest.streamMethodCount).toBe(14);
    expect(manifest.expectedTopLevelStreamShapes).toBe(54);
    expect(manifest.expectedOrchestrationEventShapes).toBe(22);
    expect(manifest.streamShapeFixtures).toHaveLength(54);
    expect(manifest.typedFailureFixtures).toHaveLength(125);
    expect(manifest.staleMethodIdentifiers).toEqual([
      "projects.add",
      "projects.list",
      "projects.remove",
    ]);
    expect(manifest.fixtures).toHaveLength(196);
    expect(manifest.fixtures).toEqual([...manifest.fixtures].toSorted());
    expect(Object.keys(manifest.schemaFingerprints)).toHaveLength(179);

    for (const relativePath of manifest.fixtures) {
      const contents = io.writes.get(NodePath.join(outputDirectory, relativePath));
      expect(contents, relativePath).toBeDefined();
      expect(contents, relativePath).toMatch(/\n$/);
      expect(() => JSON.parse(contents!), relativePath).not.toThrow();
    }

    const firstRun = new Map(io.writes);
    vi.resetModules();
    io.directories = [];
    io.formatCalls = [];
    io.removals = [];
    io.writes.clear();
    await runExporter();

    expect(io.writes).toEqual(firstRun);
  });

  it.each([
    [7, "7"],
    [null, "unknown"],
  ] as const)("rejects formatter status %s", async (status, message) => {
    io.formatStatus = status;

    await expect(runExporter()).rejects.toThrow(`Failed to format RPC fixtures (exit ${message}).`);
    expect(io.writes.has(manifestPath)).toBe(true);
  });
});
