import type { ComposerCommandItem } from "./composerCommandItems";
import { searchComposerCommandCandidates } from "./composerCommandSearch";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "provider-command" | "provider-skill" }
>;

function searchItemName(item: SlashSearchItem): string {
  if (item.type === "provider-command") {
    return item.command.name;
  }
  return item.skill.name;
}

function searchCommandItems<T extends SlashSearchItem>(
  items: ReadonlyArray<T>,
  query: string,
): T[] {
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
