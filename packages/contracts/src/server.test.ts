import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import {
  isProviderAvailable,
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceTotals,
  ServerProvider,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
} from "./server.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeProviderDriverKind = Schema.decodeUnknownSync(ProviderDriverKind);
const decodeProviderUpdateError = Schema.decodeUnknownSync(ServerProviderUpdateError);
const decodeProcessDiagnosticsEntry = Schema.decodeUnknownSync(ServerProcessDiagnosticsEntry);
const decodeProcessResourceTotals = Schema.decodeUnknownSync(ServerProcessResourceTotals);
const encodeProviderUpdateError = Schema.encodeSync(ServerProviderUpdateError);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.agents).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("treats omitted availability as available and explicit unavailability as unavailable", () => {
    const base = {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    } as const;

    expect(isProviderAvailable(decodeServerProvider(base))).toBe(true);
    expect(
      isProviderAvailable(
        decodeServerProvider({
          ...base,
          availability: "unavailable",
          unavailableReason: "offline",
        }),
      ),
    ).toBe(false);
  });
});

describe("ServerProviderUpdateError", () => {
  const provider = decodeProviderDriverKind("codex");
  const error = new ServerProviderUpdateError({
    provider,
    reason: "update process failed",
    cause: "exit 1",
  });

  it("constructs a tagged error with provider context and round-trips it", () => {
    expect(error.message).toBe("Provider update failed for codex: update process failed");
    const encoded = encodeProviderUpdateError(error);
    expect(decodeProviderUpdateError(encoded)._tag).toBe("ServerProviderUpdateError");
  });

  it("reports invalid provider paths on decode and encode", () => {
    const invalid = {
      _tag: "ServerProviderUpdateError",
      provider: "Invalid Provider",
      reason: "update failed",
    };
    const expectedPath = {
      paths: [["provider"]],
      containsTag: "InvalidValue" as const,
    };
    const decodeExpected = {
      ...expectedPath,
      rootTag: "Encoding" as const,
    };
    const encodeExpected = { ...expectedPath, rootTag: "Composite" as const };
    expectDecodeFailure(ServerProviderUpdateError, invalid, decodeExpected);
    expectEncodeFailure(
      ServerProviderUpdateError,
      makeInvalidClassInstance(ServerProviderUpdateError.prototype, invalid),
      encodeExpected,
    );
  });

  it("reports invalid update input providers on decode and encode", () => {
    const invalid = { provider: "Invalid Provider" };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["provider"]],
      containsTag: "InvalidValue" as const,
    };
    expectDecodeFailure(ServerProviderUpdateInput, invalid, expected);
    expectEncodeFailure(ServerProviderUpdateInput, invalid, expected);
  });
});

describe("server process resource metrics", () => {
  const totals = {
    cpuPercent: 1,
    rssBytes: 1024,
    processCount: 1,
  };
  const process = {
    pid: 1,
    ppid: 0,
    pgid: Option.none(),
    status: "Run",
    cpuPercent: 1,
    rssBytes: 1024,
    elapsed: "00:00:01",
    command: "t4code",
    depth: 0,
    childPids: [],
    processKey: "1:1",
    scope: "core",
    kind: "server",
    label: "T4Code Server",
    confidence: "exact",
  };

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite live CPU values at the contract boundary",
    (cpuPercent) => {
      const expected = {
        rootTag: "Composite" as const,
        paths: [["cpuPercent"]],
        containsTag: "Filter" as const,
      };

      expectDecodeFailure(ServerProcessResourceTotals, { ...totals, cpuPercent }, expected);
      expectDecodeFailure(ServerProcessDiagnosticsEntry, { ...process, cpuPercent }, expected);
    },
  );

  it("preserves finite negative live CPU values", () => {
    expect(decodeProcessResourceTotals({ ...totals, cpuPercent: -1.5 }).cpuPercent).toBe(-1.5);
    expect(decodeProcessDiagnosticsEntry({ ...process, cpuPercent: -1.5 }).cpuPercent).toBe(-1.5);
  });
});
