// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const workflowDirectory = NodePath.join(repositoryRoot, ".github", "workflows");
const ledgerPath = NodePath.join(
  repositoryRoot,
  "docs",
  "dependency-upgrades",
  "2026-07-17-ledger.json",
);
const immutableCommitPattern = /^[0-9a-f]{40}$/;

interface ActionLedgerEntry {
  readonly key: string;
  readonly name: string;
  readonly target: string;
  readonly tag?: string;
  readonly sha?: string;
}

interface ActionReference {
  readonly action: string;
  readonly comment?: string;
  readonly file: string;
  readonly line: number;
  readonly revision: string;
}

function readActionLedger(): ReadonlyMap<string, ActionLedgerEntry> {
  const ledger = JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as {
    readonly dependencies: ReadonlyArray<ActionLedgerEntry>;
  };
  return new Map(
    ledger.dependencies
      .filter((entry) => entry.key.startsWith("action:"))
      .map((entry) => [entry.name, entry]),
  );
}

function readActionReferences(): ReadonlyArray<ActionReference> {
  const references: Array<ActionReference> = [];
  for (const file of NodeFS.readdirSync(workflowDirectory).filter((entry) =>
    entry.endsWith(".yml"),
  )) {
    const source = NodeFS.readFileSync(NodePath.join(workflowDirectory, file), "utf8");
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const match = /^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/.exec(line);
      if (!match) continue;
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      const separator = reference.lastIndexOf("@");
      if (separator < 1) {
        throw new Error(`${file}:${index + 1} has an invalid Action reference: ${reference}`);
      }
      references.push({
        action: reference.slice(0, separator),
        comment: match[2],
        file,
        line: index + 1,
        revision: reference.slice(separator + 1),
      });
    }
  }
  return references;
}

describe("GitHub workflow dependencies", () => {
  const ledger = readActionLedger();
  const references = readActionReferences();

  it("pins every external Action to an immutable commit with an audited version comment", () => {
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const location = `${reference.file}:${reference.line}`;
      const entry = ledger.get(reference.action);
      expect(entry, `${location} is missing from the dependency ledger`).toBeDefined();
      expect(reference.revision, `${location} must use a full commit SHA`).toMatch(
        immutableCommitPattern,
      );
      expect(entry?.sha, `${location} ledger SHA is missing`).toBe(reference.revision);
      expect(entry?.tag, `${location} ledger tag is missing`).toBe(reference.comment);
    }
  });

  it.each([
    ["actions/checkout", "v7"],
    ["actions/github-script", "v9"],
    ["actions/upload-artifact", "v7"],
    ["actions/download-artifact", "v8"],
    ["softprops/action-gh-release", "v3"],
  ] as const)("uses the audited major for %s", (name, major) => {
    const entry = ledger.get(name);
    expect(entry?.tag).toMatch(new RegExp(`^${major}(?:\\.|$)`));
    expect(references.filter((reference) => reference.action === name).length).toBeGreaterThan(0);
  });

  it("keeps the action ledger and workflows in exact agreement", () => {
    expect(new Set(references.map((reference) => reference.action))).toEqual(
      new Set(ledger.keys()),
    );
  });
});
