import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t4code/contracts";

import type { LegacyComposerCommandItem } from "./composerCommandItems";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
      {
        id: "slash-skill:claudeAgent:ui-review",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "ui-review",
          path: "/skills/ui-review",
          enabled: true,
          invocation: "slash",
        },
        label: "/ui-review",
        description: "Review user interfaces",
      },
    ] satisfies Array<
      Extract<LegacyComposerCommandItem, { type: "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash-skill:claudeAgent:ui-review",
    ]);
  });

  it("supports fuzzy provider command and slash-skill matches", () => {
    const items = [
      {
        id: "slash-skill:claudeAgent:gh-fix-ci",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "gh-fix-ci",
          path: "/skills/gh-fix-ci",
          enabled: true,
          invocation: "slash",
        },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<LegacyComposerCommandItem, { type: "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "slash-skill:claudeAgent:gh-fix-ci",
    ]);
  });

  it("matches provider commands through their descriptions", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:review",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "review" },
        label: "/review",
        description: "Review staged changes",
      },
    ] satisfies Array<
      Extract<LegacyComposerCommandItem, { type: "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "staged").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:review",
    ]);
  });

  it("sorts empty-query results deterministically instead of preserving inventory order", () => {
    const alpha = {
      id: "provider-slash-command:claudeAgent:alpha",
      type: "provider-slash-command",
      provider: claudeDriver,
      command: { name: "alpha" },
      label: "/alpha",
      description: "Alpha command",
    } as const;
    const zebra = {
      id: "provider-slash-command:claudeAgent:zebra",
      type: "provider-slash-command",
      provider: claudeDriver,
      command: { name: "zebra" },
      label: "/zebra",
      description: "Zebra command",
    } as const;

    expect(searchSlashCommandItems([zebra, alpha], "").map((item) => item.id)).toEqual([
      alpha.id,
      zebra.id,
    ]);
    expect(searchSlashCommandItems([alpha, zebra], "").map((item) => item.id)).toEqual([
      alpha.id,
      zebra.id,
    ]);
  });
});
