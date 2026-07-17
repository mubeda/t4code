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

const outputDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/auth-http");
const manifestPath = NodePath.join(outputDirectory, "manifest.json");

interface AuthRouteManifest {
  readonly name: string;
  readonly requestContentTypes: ReadonlyArray<string>;
  readonly payloads: ReadonlyArray<{
    readonly contentType: string;
    readonly schema: string;
    readonly fingerprint: string;
  }>;
  readonly successes: ReadonlyArray<{
    readonly status: number;
    readonly contentType: string;
    readonly schema: string;
    readonly fingerprint: string;
  }>;
  readonly errors: ReadonlyArray<{
    readonly status: number;
    readonly contentType: string;
    readonly schema: string;
    readonly fingerprint: string;
  }>;
}

interface AuthManifest {
  readonly formatVersion: number;
  readonly routes: ReadonlyArray<AuthRouteManifest>;
  readonly errors: ReadonlyArray<{
    readonly schema: string;
    readonly status: number;
    readonly fixture: string;
  }>;
  readonly samples: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly schemaFingerprints: Readonly<Record<string, string>>;
  readonly fixtures: ReadonlyArray<string>;
}

async function runExporter(): Promise<void> {
  await import("./export-rust-auth-fixtures.ts");
}

function readManifest(): AuthManifest {
  const contents = io.writes.get(manifestPath);
  if (contents === undefined) {
    throw new Error("Auth fixture exporter did not write its manifest.");
  }
  return JSON.parse(contents) as AuthManifest;
}

beforeEach(() => {
  vi.resetModules();
  io.directories = [];
  io.formatCalls = [];
  io.formatStatus = 0;
  io.removals = [];
  io.writes.clear();
});

describe("auth HTTP fixture exporter", () => {
  it("writes a deterministic route and schema fixture tree", async () => {
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
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.routes.map(({ name }) => name)).toEqual([
      "session",
      "browserSession",
      "token",
      "webSocketTicket",
      "pairingCredential",
      "pairingLinks",
      "revokePairingLink",
      "clients",
      "revokeClient",
      "revokeOtherClients",
    ]);
    expect(manifest.errors).toHaveLength(5);
    expect(manifest.errors.map(({ fixture }) => fixture)).toEqual([
      "errors/request-invalid.json",
      "errors/auth-invalid.json",
      "errors/scope-required.json",
      "errors/operation-forbidden.json",
      "errors/internal.json",
    ]);
    expect(manifest.fixtures).toHaveLength(21);
    expect(manifest.fixtures).toEqual([...manifest.fixtures].toSorted());
    expect(Object.keys(manifest.schemaFingerprints)).toHaveLength(24);

    for (const route of manifest.routes) {
      const payloadKeys = route.payloads.map(
        ({ contentType, schema, fingerprint }) => `${contentType}:${schema}:${fingerprint}`,
      );
      const responseKeys = [...route.successes, ...route.errors].map(
        ({ status, contentType, fingerprint }) => `${status}:${contentType}:${fingerprint}`,
      );
      expect(new Set(payloadKeys).size, `${route.name} payloads`).toBe(payloadKeys.length);
      expect(new Set(responseKeys).size, `${route.name} responses`).toBe(responseKeys.length);
      expect(route.requestContentTypes).toEqual([...route.requestContentTypes].toSorted());
    }

    for (const relativePath of manifest.fixtures) {
      const contents = io.writes.get(NodePath.join(outputDirectory, relativePath));
      expect(contents, relativePath).toBeDefined();
      expect(contents, relativePath).toMatch(/\n$/);
      if (relativePath.endsWith(".json")) {
        expect(() => JSON.parse(contents!), relativePath).not.toThrow();
      }
    }

    const tokenForm = io.writes.get(NodePath.join(outputDirectory, "requests/token-form.txt"));
    const tokenFields = new URLSearchParams(tokenForm);
    expect(tokenFields.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(tokenFields.get("client_label")).toBe("Fixture CLI");
    expect(manifest.samples.token).toEqual({
      request: "requests/token-form.txt",
      success: "responses/token.json",
    });

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
    [9, "9"],
    [null, "unknown"],
  ] as const)("rejects formatter status %s", async (status, message) => {
    io.formatStatus = status;

    await expect(runExporter()).rejects.toThrow(
      `Failed to format auth HTTP fixtures (exit ${message}).`,
    );
    expect(io.writes.has(manifestPath)).toBe(true);
  });
});
