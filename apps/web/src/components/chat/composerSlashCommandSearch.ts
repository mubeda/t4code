import type { LegacyComposerCommandItem } from "./composerCommandItems";
import { searchComposerCommandCandidates } from "./composerCommandSearch";

type SlashSearchItem = Extract<
  LegacyComposerCommandItem,
  { type: "provider-slash-command" | "skill" }
>;

type LegacySlashSearchItem = Extract<
  LegacyComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "provider-agent" }
>;

type SearchItem = SlashSearchItem | LegacySlashSearchItem;

function searchItemName(item: SearchItem): string {
  if (item.type === "slash-command") {
    return item.command;
  }
  if (item.type === "provider-slash-command") {
    return item.command.name;
  }
  if (item.type === "provider-agent") {
    return item.agent.name;
  }
  return item.skill.name;
}

function searchCommandItems<T extends SearchItem>(items: ReadonlyArray<T>, query: string): T[] {
  return searchComposerCommandCandidates(
    items.map((item) => ({
      item,
      name: searchItemName(item),
      description: item.description,
      tieBreaker: `${item.type}\u0000${item.id}`,
    })),
    query,
    { trimLeadingPattern: /^\/+/ },
  );
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  return searchCommandItems(items, query);
}

/** @deprecated Use searchSlashCommandItems with provider slash commands and slash skills. */
export function searchLegacySlashCommandItems(
  items: ReadonlyArray<LegacySlashSearchItem>,
  query: string,
): LegacySlashSearchItem[] {
  return searchCommandItems(items, query);
}
