// @effect-diagnostics nodeBuiltinImport:off - The packaged fixture owns a host-side JSONL log.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { composerProviderProfiles } from "./test-project.ts";

export interface ProviderInputLogEntry {
  readonly provider: keyof typeof composerProviderProfiles;
  readonly prompt: string;
  readonly recordedAt: string;
}

export function appendProviderInputLogEntry(path: string, entry: ProviderInputLogEntry): void {
  if (!NodePath.isAbsolute(path)) {
    throw new Error(`Provider input log path must be absolute: ${path}`);
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readProviderInputLog(path: string): ProviderInputLogEntry[] {
  if (!NodeFS.existsSync(path)) {
    return [];
  }
  return NodeFS.readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ProviderInputLogEntry);
}
