// @effect-diagnostics nodeBuiltinImport:off - Desktop UI fixture tests inspect host temp files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  appendProviderInputLogEntry,
  readProviderInputLog,
  type ProviderInputLogEntry,
} from "./provider-input-log.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider input log", () => {
  it("appends one JSON object per line and preserves provider input order", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-provider-log-"));
    temporaryDirectories.push(directory);
    const path = NodePath.join(directory, "nested", "provider-input.jsonl");
    const entries: ProviderInputLogEntry[] = [
      {
        provider: "codex",
        prompt: "$refactor",
        recordedAt: "2026-07-23T12:00:00.000Z",
      },
      {
        provider: "opencode",
        prompt: "@reviewer",
        recordedAt: "2026-07-23T12:00:01.000Z",
      },
    ];

    for (const entry of entries) {
      appendProviderInputLogEntry(path, entry);
    }

    expect(NodeFS.readFileSync(path, "utf8")).toBe(
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(readProviderInputLog(path)).toEqual(entries);
  });

  it("returns an empty inventory before a provider records input", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4code-provider-log-"));
    temporaryDirectories.push(directory);

    expect(readProviderInputLog(NodePath.join(directory, "missing.jsonl"))).toEqual([]);
  });
});
