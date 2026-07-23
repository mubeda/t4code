import type {
  ServerProvider,
  ServerProviderAgent,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t4code/contracts";
import type { ComposerTriggerProfile } from "@t4code/shared/composerTrigger";

export interface ComposerCapabilityProfile {
  readonly signature: string;
  readonly trigger: ComposerTriggerProfile;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly slashSkills: ReadonlyArray<ServerProviderSkill>;
  readonly dollarSkills: ReadonlyArray<ServerProviderSkill>;
  readonly mentionableAgents: ReadonlyArray<ServerProviderAgent>;
  readonly mentionableAgentNames: ReadonlySet<string>;
}

export function deriveComposerCapabilityProfile(
  provider: Pick<ServerProvider, "slashCommands" | "skills" | "agents"> | null,
): ComposerCapabilityProfile {
  const slashCommands = provider?.slashCommands ?? [];
  const commandNames = new Set(slashCommands.map((command) => command.name.toLowerCase()));
  const slashSkills: ServerProviderSkill[] = [];
  const dollarSkills: ServerProviderSkill[] = [];

  for (const skill of provider?.skills ?? []) {
    if (!skill.enabled) {
      continue;
    }
    if (skill.invocation === "slash" && !commandNames.has(skill.name.toLowerCase())) {
      slashSkills.push(skill);
      continue;
    }
    if (skill.invocation === "dollar") {
      dollarSkills.push(skill);
    }
  }

  const mentionableAgents = (provider?.agents ?? []).filter(
    (agent) => agent.invocation === "mention",
  );

  return {
    signature: `${slashCommands.length > 0 || slashSkills.length > 0 ? "slash" : ""}:${
      dollarSkills.length > 0 ? "dollar" : ""
    }`,
    trigger: {
      providerSlash: slashCommands.length > 0 || slashSkills.length > 0,
      providerDollarSkill: dollarSkills.length > 0,
    },
    slashCommands,
    slashSkills,
    dollarSkills,
    mentionableAgents,
    mentionableAgentNames: new Set(mentionableAgents.map((agent) => agent.name)),
  };
}
