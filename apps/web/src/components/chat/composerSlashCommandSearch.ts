import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t4code/shared/searchRanking";

import type { LegacyComposerCommandItem } from "./composerCommandItems";

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

function scoreSlashCommandItem(item: SearchItem, query: string): number | null {
  const primaryValue = searchItemName(item).toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function searchCommandItems<T extends SearchItem>(items: ReadonlyArray<T>, query: string): T[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: T;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: `${item.type}\u0000${searchItemName(item)}\u0000${"provider" in item ? item.provider : ""}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
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
