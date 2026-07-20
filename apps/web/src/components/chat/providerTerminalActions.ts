import {
  ProviderDriverKind,
  type ServerSettings,
  type TerminalLaunchCommand,
} from "@t4code/contracts";
import {
  PROVIDER_SESSION_EFFORT_OPTION_IDS,
  resolveProviderSessionDefault,
  type ProviderSessionDefaultFallback,
  type ResolvedProviderSessionDefault,
} from "@t4code/shared/providerSessionDefaults";
import { resolvePromptInjectedEffort } from "@t4code/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

import { decodeTerminalLaunchCommand } from "~/lib/terminalLaunchCommand";
import type { ProviderInstanceEntry } from "~/providerInstances";

interface ProviderTerminalDefinition {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

type ProviderTerminalSettings = Pick<
  ServerSettings,
  "providerInstances" | "providers" | "providerSessionDefaults"
>;

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
  readonly fallback?: ProviderSessionDefaultFallback;
}

export interface DisabledProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: null;
  readonly disabledReason: string;
  readonly fallback?: ProviderSessionDefaultFallback;
}

export type ProviderTerminalActionItem = ProviderTerminalAction | DisabledProviderTerminalAction;

const COMMAND_BOUNDS_REASON =
  "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.";
const CLAUDE_NATIVE_EFFORT_FALLBACKS = new Set(["low", "medium", "high", "xhigh", "max"]);

function binaryPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { binaryPath?: unknown }).binaryPath;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveClaudeNativeEffort(
  resolution: ResolvedProviderSessionDefault,
  models: ProviderInstanceEntry["models"],
): string | null {
  const effort = resolution.effort;
  if (effort === null) return null;

  const driver = ProviderDriverKind.make("claudeAgent");
  const capabilities = getProviderModelCapabilities(
    models,
    resolution.modelSelection.model,
    driver,
  );
  if (resolvePromptInjectedEffort(capabilities, effort) !== null) {
    return null;
  }
  const metadataRecognizesEffort = capabilities.optionDescriptors?.some(
    (descriptor) =>
      descriptor.type === "select" &&
      PROVIDER_SESSION_EFFORT_OPTION_IDS.some((id) => id === descriptor.id) &&
      descriptor.options.some((option) => option.id === effort),
  );
  if (metadataRecognizesEffort) {
    return effort;
  }
  return CLAUDE_NATIVE_EFFORT_FALLBACKS.has(effort) ? effort : null;
}

function providerArguments(
  driver: ProviderDriverKind,
  resolution: ResolvedProviderSessionDefault,
  models: ProviderInstanceEntry["models"],
): ReadonlyArray<string> {
  const model = resolution.modelSelection.model;
  if (driver === ProviderDriverKind.make("codex")) {
    const args = ["--model", model];
    if (resolution.effort !== null) {
      args.push("--config", `model_reasoning_effort="${resolution.effort}"`);
    }
    if (resolution.fastMode !== null) {
      args.push("--config", `service_tier="${resolution.fastMode ? "fast" : "default"}"`);
    }
    return args;
  }
  if (driver === ProviderDriverKind.make("claudeAgent")) {
    const nativeEffort = resolveClaudeNativeEffort(resolution, models);
    return ["--model", model, ...(nativeEffort === null ? [] : ["--effort", nativeEffort])];
  }
  if (driver === ProviderDriverKind.make("cursor")) {
    const baseModel = model.replace(/\[[^\]]*\]$/, "");
    const parameters = [
      resolution.effort === null ? null : `effort=${resolution.effort}`,
      resolution.fastMode === null ? null : `fast=${String(resolution.fastMode)}`,
    ].filter((value): value is string => value !== null);
    const cursorModel =
      parameters.length === 0 ? baseModel : `${baseModel}[${parameters.join(",")}]`;
    return ["--model", cursorModel];
  }
  if (driver === ProviderDriverKind.make("grok")) {
    return [
      "--model",
      model,
      ...(resolution.effort === null ? [] : ["--effort", resolution.effort]),
    ];
  }
  if (driver === ProviderDriverKind.make("opencode")) {
    return ["--model", model];
  }
  return [];
}

export function resolveProviderTerminalAction(
  entry: ProviderInstanceEntry,
  settings: ProviderTerminalSettings,
): ProviderTerminalActionItem | null {
  const definition = DEFINITIONS[entry.driverKind];
  if (!definition) return null;
  const instance = settings.providerInstances?.[entry.instanceId];
  const legacy = (settings.providers as Readonly<Record<string, unknown>>)[entry.driverKind];
  const executable = binaryPath(instance?.config) ?? binaryPath(legacy) ?? definition.executable;
  const label = `${entry.displayName} Terminal`;
  const resolution = resolveProviderSessionDefault({
    driver: entry.driverKind,
    instanceId: entry.instanceId,
    models: entry.models,
    configuredDefault: settings.providerSessionDefaults[entry.driverKind] ?? null,
  });
  const command = decodeTerminalLaunchCommand({
    executable,
    args: [...definition.args, ...providerArguments(entry.driverKind, resolution, entry.models)],
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
    ...(resolution.fallback ? { fallback: resolution.fallback } : {}),
  };
}
