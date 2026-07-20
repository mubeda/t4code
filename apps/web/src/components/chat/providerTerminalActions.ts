import {
  ProviderDriverKind,
  type ServerSettings,
  type TerminalLaunchCommand,
} from "@t4code/contracts";

import { decodeTerminalLaunchCommand } from "~/lib/terminalLaunchCommand";
import type { ProviderInstanceEntry } from "~/providerInstances";

interface ProviderTerminalDefinition {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

const DEFINITIONS: Partial<Record<ProviderDriverKind, ProviderTerminalDefinition>> = {
  [ProviderDriverKind.make("claudeAgent")]: {
    executable: "claude",
    args: ["--dangerously-skip-permissions"],
  },
  [ProviderDriverKind.make("codex")]: {
    executable: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
  },
  [ProviderDriverKind.make("opencode")]: {
    executable: "opencode",
    args: [],
  },
  [ProviderDriverKind.make("cursor")]: {
    executable: "cursor-agent",
    args: ["--yolo"],
  },
  [ProviderDriverKind.make("grok")]: {
    executable: "grok",
    args: ["--permission-mode", "bypassPermissions"],
  },
};

export interface ProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: TerminalLaunchCommand;
  readonly disabledReason: null;
}

export interface DisabledProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: null;
  readonly disabledReason: string;
}

export type ProviderTerminalActionItem = ProviderTerminalAction | DisabledProviderTerminalAction;

const COMMAND_BOUNDS_REASON =
  "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.";

function binaryPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { binaryPath?: unknown }).binaryPath;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveProviderTerminalAction(
  entry: ProviderInstanceEntry,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): ProviderTerminalActionItem | null {
  const definition = DEFINITIONS[entry.driverKind];
  if (!definition) return null;
  const instance = settings.providerInstances?.[entry.instanceId];
  const legacy = (settings.providers as Readonly<Record<string, unknown>>)[entry.driverKind];
  const executable = binaryPath(instance?.config) ?? binaryPath(legacy) ?? definition.executable;
  const label = `${entry.displayName} Terminal`;
  const command = decodeTerminalLaunchCommand({
    executable,
    args: [...definition.args],
    label,
  });
  if (command === null) {
    return {
      entry,
      label,
      command: null,
      disabledReason: COMMAND_BOUNDS_REASON,
    };
  }
  return {
    entry,
    label,
    command,
    disabledReason: null,
  };
}
