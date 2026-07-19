import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t4code/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { resolveProviderTerminalAction } from "./providerTerminalActions";

function entry(driver: string, instanceId = driver, displayName = driver): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driver),
    displayName,
    accentColor: undefined,
    continuationGroupKey: undefined,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: instanceId === driver,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
  };
}

describe("resolveProviderTerminalAction", () => {
  it.each([
    ["claudeAgent", "claude", ["--dangerously-skip-permissions"], "Claude Terminal"],
    ["codex", "codex", ["--dangerously-bypass-approvals-and-sandbox"], "Codex Terminal"],
    ["opencode", "opencode", [], "OpenCode Terminal"],
    ["cursor", "cursor-agent", ["--yolo"], "Cursor Terminal"],
    ["grok", "grok", ["--permission-mode", "bypassPermissions"], "Grok Terminal"],
  ])("resolves %s", (driver, executable, args, label) => {
    const action = resolveProviderTerminalAction(
      entry(driver, driver, label.replace(" Terminal", "")),
      DEFAULT_SERVER_SETTINGS,
    );
    expect(action).toMatchObject({
      label,
      command: { executable, args, label },
    });
  });

  it("prefers instance paths, then legacy paths, and preserves custom names", () => {
    const customId = ProviderInstanceId.make("codex_personal");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/legacy/codex",
        },
      },
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Personal Codex",
          config: { binaryPath: " /custom/Codex CLI " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), settings),
    ).toMatchObject({
      label: "Personal Codex Terminal",
      command: { executable: "/custom/Codex CLI" },
    });

    const inherited = {
      ...settings,
      providerInstances: {
        [customId]: {
          ...settings.providerInstances[customId]!,
          config: {},
        },
      },
    };
    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), inherited),
    ).toMatchObject({ command: { executable: "/legacy/codex" } });
  });

  it("falls through whitespace-only instance and legacy binary paths", () => {
    const customId = ProviderInstanceId.make("codex_personal");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: " /legacy/codex ",
        },
      },
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: " \t " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), settings),
    ).toMatchObject({ command: { executable: "/legacy/codex" } });

    expect(
      resolveProviderTerminalAction(entry("codex", customId, "Personal Codex"), {
        ...settings,
        providers: {
          ...settings.providers,
          codex: {
            ...settings.providers.codex,
            binaryPath: " \n ",
          },
        },
      }),
    ).toMatchObject({ command: { executable: "codex" } });
  });

  it("preserves an explicit non-default Cursor binary path", () => {
    const customId = ProviderInstanceId.make("cursor_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("cursor"),
          config: { binaryPath: " /Applications/Cursor Agent/custom-agent " },
        },
      },
    } satisfies ServerSettings;

    expect(
      resolveProviderTerminalAction(entry("cursor", customId, "Work Cursor"), settings),
    ).toMatchObject({
      command: { executable: "/Applications/Cursor Agent/custom-agent" },
    });
  });

  it("does not invent command semantics for an unregistered driver", () => {
    expect(
      resolveProviderTerminalAction(entry("forkDriver", "fork", "Fork"), DEFAULT_SERVER_SETTINGS),
    ).toBeNull();
  });
});
