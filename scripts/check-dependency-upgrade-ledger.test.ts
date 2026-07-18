// @effect-diagnostics nodeBuiltinImport:off - Repository ledger tests create isolated manifest fixtures directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  discoverDependencyInventory,
  type DependencyInventory,
  type DependencyLedger,
  validateDependencyLedger,
} from "./check-dependency-upgrade-ledger.ts";

function writeFixture(root: string, relativePath: string, contents: string): void {
  const filePath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, contents);
}

function createRepositoryFixture(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-dependency-ledger-"));
  writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture",
      private: true,
      engines: { node: "24.13.1" },
      packageManager: "pnpm@10.24.0",
      devDependencies: {
        effect: "catalog:",
        "vite-plus": "catalog:",
      },
    }),
  );
  writeFixture(
    root,
    "pnpm-workspace.yaml",
    [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  effect: "4.0.0-beta.78"',
      '  vite: "npm:@voidzero-dev/vite-plus-core@0.2.1"',
      '  vite-plus: "0.2.1"',
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    "apps/web/package.json",
    JSON.stringify({
      name: "@t4code/web",
      dependencies: {
        "@base-ui/react": "^1.4.1",
        "@t4code/contracts": "workspace:*",
        effect: "catalog:",
      },
    }),
  );
  writeFixture(
    root,
    "apps/desktop/package.json",
    JSON.stringify({
      name: "@t4code/desktop",
      scripts: {
        build: "pnpm dlx @tauri-apps/cli@2.11.4 build",
      },
    }),
  );
  writeFixture(
    root,
    "Cargo.toml",
    [
      "[workspace]",
      'members = ["apps/server"]',
      "",
      "[workspace.package]",
      'rust-version = "1.88"',
      "",
      "[workspace.dependencies]",
      'serde = { version = "1", features = ["derive"] }',
      't4code-server = { path = "apps/server" }',
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    "apps/server/Cargo.toml",
    [
      "[package]",
      'name = "t4code-server"',
      'version = "0.0.0"',
      "",
      "[dependencies]",
      "serde.workspace = true",
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    "apps/server/tests/fixtures/demo/Cargo.toml",
    [
      "[package]",
      'name = "fixture-crate"',
      'version = "0.0.0"',
      "",
      "[workspace]",
      "",
      "[dependencies]",
      'serde = "1"',
      'xpty = "0.3.6"',
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".github/workflows/ci.yml",
    [
      "name: CI",
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/checkout@v6",
      "      - uses: ./.github/actions/setup",
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".devcontainer/devcontainer.json",
    JSON.stringify({
      features: {
        "ghcr.io/devcontainers-extra/features/bun:1": { version: "1.3.11" },
        "ghcr.io/devcontainers/features/node:1": { version: "24.13.1" },
      },
    }),
  );
  return root;
}

function completeLedger(inventory: DependencyInventory): DependencyLedger {
  return {
    schemaVersion: 1,
    auditDate: "2026-07-17",
    baseline: {
      originMainSha: "a".repeat(40),
      implementationHead: "b".repeat(40),
      tools: {
        node: "v24.13.1",
        pnpm: "10.24.0",
        rust: "rustc 1.88.0",
        vitePlus: "0.2.1",
      },
      commands: [
        { command: "vp check", durationSeconds: 1, result: "passed" },
        { command: "vp run typecheck", durationSeconds: 1, result: "passed" },
        { command: "vp test", durationSeconds: 1, result: "passed" },
        { command: "vp run test", durationSeconds: 1, result: "passed" },
        {
          command: "cargo test --workspace --all-targets -j 2",
          durationSeconds: 1,
          result: "passed",
        },
      ],
      warnings: [],
    },
    dependencies: inventory.entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      current: entry.current,
      target: entry.current,
      channel: "stable",
      source: "https://example.com/dependency",
      cohort: "fixture",
      platforms: ["linux", "macos", "windows"],
      status: "current",
    })),
  };
}

describe("dependency upgrade ledger discovery", () => {
  it("discovers external JavaScript dependencies and excludes workspace links", () => {
    const root = createRepositoryFixture();
    const inventory = discoverDependencyInventory(root);

    expect(inventory.entries.map((entry) => entry.key)).toContain("js:apps/web:@base-ui/react");
    expect(inventory.entries.map((entry) => entry.key)).toContain("js:catalog:effect");
    expect(inventory.entries.some((entry) => entry.name === "@t4code/contracts")).toBe(false);
    expect(inventory.entries.find((entry) => entry.key === "js:catalog:effect")?.locations).toEqual(
      ["apps/web/package.json", "package.json", "pnpm-workspace.yaml"],
    );
  });

  it("discovers registry crates, fixture-only crates, and the local path crate", () => {
    const root = createRepositoryFixture();
    const inventory = discoverDependencyInventory(root);
    const keys = inventory.entries.map((entry) => entry.key);

    expect(keys).toContain("rust:workspace:serde");
    expect(keys).toContain("rust:workspace:t4code-server");
    expect(keys).toContain("rust:apps/server/tests/fixtures/demo:xpty");
    expect(inventory.summary.rustRegistry).toBe(2);
    expect(inventory.summary.rustPath).toBe(1);
  });

  it("discovers external workflow actions but ignores local actions", () => {
    const root = createRepositoryFixture();
    const inventory = discoverDependencyInventory(root);

    expect(inventory.entries.map((entry) => entry.key)).toContain("action:actions/checkout");
    expect(inventory.entries.some((entry) => entry.name === "./.github/actions/setup")).toBe(false);
  });

  it("discovers Node, pnpm, Rust, Vite+, Tauri CLI, and devcontainer pins", () => {
    const root = createRepositoryFixture();
    const inventory = discoverDependencyInventory(root);
    const keys = inventory.entries.map((entry) => entry.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        "toolchain:node",
        "toolchain:pnpm",
        "toolchain:rust",
        "toolchain:vite-core",
        "toolchain:vite-plus",
        "toolchain:tauri-cli",
        "toolchain:devcontainer:bun",
        "toolchain:devcontainer:node",
      ]),
    );
  });
});

describe("dependency upgrade ledger validation", () => {
  it("rejects duplicate keys and missing required fields", () => {
    const inventory = discoverDependencyInventory(createRepositoryFixture());
    const ledger = completeLedger(inventory);
    const firstDependency = ledger.dependencies[0];
    if (firstDependency === undefined) throw new Error("fixture inventory must not be empty");
    const duplicate: Partial<typeof firstDependency> = structuredClone(firstDependency);
    delete duplicate.target;
    ledger.dependencies.push(duplicate as typeof firstDependency);

    const errors = validateDependencyLedger(inventory, ledger);

    expect(errors.some((error) => error.includes("duplicate ledger key"))).toBe(true);
    expect(errors.some((error) => error.includes("missing target"))).toBe(true);
  });

  it("rejects missing, stale, and invalid-status entries", () => {
    const inventory = discoverDependencyInventory(createRepositoryFixture());
    const ledger = completeLedger(inventory);
    const removed = ledger.dependencies.shift();
    if (removed === undefined) throw new Error("fixture inventory must not be empty");
    const firstDependency = ledger.dependencies[0];
    if (firstDependency === undefined) throw new Error("fixture inventory must contain two rows");
    firstDependency.status = "finished";
    ledger.dependencies.push({
      key: "js:apps/removed:stale",
      name: "stale",
      current: "1.0.0",
      target: "2.0.0",
      channel: "stable",
      source: "https://example.com/stale",
      cohort: "fixture",
      platforms: ["linux"],
      status: "current",
    });

    const errors = validateDependencyLedger(inventory, ledger);

    expect(errors.some((error) => error.includes(`missing ledger entry ${removed.key}`))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes("invalid status"))).toBe(true);
    expect(errors.some((error) => error.includes("no longer declared"))).toBe(true);
  });

  it("requires a completely green synchronized baseline before progress", () => {
    const inventory = discoverDependencyInventory(createRepositoryFixture());
    const ledger = completeLedger(inventory);
    const firstCommand = ledger.baseline.commands[0];
    const firstDependency = ledger.dependencies[0];
    if (firstCommand === undefined || firstDependency === undefined) {
      throw new Error("fixture ledger must contain baseline evidence and dependencies");
    }
    firstCommand.result = "failed";
    firstDependency.status = "green";

    expect(validateDependencyLedger(inventory, ledger)).toContain(
      "baseline command vp check did not pass before dependency progress",
    );
  });

  it("accounts for every dependency in the synchronized repository", () => {
    const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
    const inventory = discoverDependencyInventory(repositoryRoot);
    const ledger = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(repositoryRoot, "docs/dependency-upgrades/2026-07-17-ledger.json"),
        "utf8",
      ),
    ) as DependencyLedger;

    expect(validateDependencyLedger(inventory, ledger)).toEqual([]);
    expect(inventory.summary.javascriptDirect).toBe(70);
    expect(inventory.summary.rustRegistry).toBe(49);
    expect(inventory.summary.rustPath).toBe(1);
    expect(inventory.summary.actions).toBe(9);
  });
});
