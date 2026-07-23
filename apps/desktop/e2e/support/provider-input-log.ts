// @effect-diagnostics nodeBuiltinImport:off - The packaged fixture owns a host-side JSONL log.
// @effect-diagnostics globalDate:off - The standalone WDIO helper polls a host-written fixture log.
// @effect-diagnostics globalTimers:off - The standalone WDIO helper polls without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { composerProviderProfiles } from "./test-project.ts";

export interface ProviderInputLogEntry {
  readonly provider: keyof typeof composerProviderProfiles;
  readonly prompt: string;
  readonly recordedAt: string;
}

export interface WaitForProviderInputLogEntryOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly settleMs?: number;
}

type ExpectedProviderInputLogEntry = Pick<ProviderInputLogEntry, "provider" | "prompt">;

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

export async function waitForProviderInputLogEntry(
  path: string,
  startIndex: number,
  expected: ExpectedProviderInputLogEntry,
  options: WaitForProviderInputLogEntryOptions = {},
): Promise<ProviderInputLogEntry> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const settleMs = options.settleMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let candidateObservedAt: number | null = null;
  let lastEntries: ProviderInputLogEntry[] = [];

  while (Date.now() <= deadline) {
    try {
      lastEntries = readProviderInputLog(path);
    } catch (error) {
      let rawLog: string;
      try {
        rawLog = NodeFS.readFileSync(path, "utf8");
      } catch (readError) {
        rawLog = `<unreadable: ${String(readError)}>`;
      }
      throw new Error(
        `Provider input log became malformed while waiting for ${JSON.stringify(expected)}: ${String(error)}. Raw log: ${JSON.stringify(rawLog)}`,
        { cause: error },
      );
    }
    if (lastEntries.length < startIndex) {
      throw new Error(
        `Provider input log was truncated from baseline ${startIndex} to ${lastEntries.length}.`,
      );
    }

    const appended = lastEntries.slice(startIndex);
    if (appended.length > 1) {
      throw new Error(
        `Expected exactly one appended provider input after index ${startIndex}, observed ${appended.length}: ${JSON.stringify(appended)}`,
      );
    }
    const candidate = appended[0];
    if (candidate) {
      if (candidate.provider !== expected.provider || candidate.prompt !== expected.prompt) {
        throw new Error(
          `Provider input mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(candidate)}.`,
        );
      }
      candidateObservedAt ??= Date.now();
      if (Date.now() - candidateObservedAt >= settleMs) {
        return candidate;
      }
    } else {
      candidateObservedAt = null;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for one provider input ${JSON.stringify(expected)} after index ${startIndex}. Last log: ${JSON.stringify(lastEntries)}`,
  );
}
