import {
  ProviderInstanceId,
  type ProjectEntry,
  type ServerProviderAgent,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t4code/contracts";
import { detectComposerTrigger, type ComposerTrigger } from "@t4code/shared/composerTrigger";
import { describe, expect, it } from "vite-plus/test";

import { buildComposerCommandItems, type ComposerCommandItemsInput } from "./composerCommandItems";
import type { ComposerCapabilityProfile } from "./composerCapabilities";

function makeSkill(
  name: string,
  invocation: ServerProviderSkill["invocation"],
  overrides: Partial<ServerProviderSkill> = {},
): ServerProviderSkill {
  return {
    name,
    path: `/skills/${name}`,
    enabled: true,
    invocation,
    ...overrides,
  };
}

interface InputOverrides {
  readonly providerInstanceId?: string;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly slashSkills?: ReadonlyArray<ServerProviderSkill>;
  readonly dollarSkills?: ReadonlyArray<ServerProviderSkill>;
  readonly agents?: ReadonlyArray<ServerProviderAgent>;
  readonly pathEntries?: ReadonlyArray<ProjectEntry>;
  readonly pathError?: unknown;
  readonly trigger?: ComposerTrigger | null;
  readonly triggerProfile?: ComposerCapabilityProfile["trigger"];
}

function inputFor(text: string, overrides: InputOverrides = {}): ComposerCommandItemsInput {
  const slashCommands = overrides.slashCommands ?? [];
  const slashSkills = overrides.slashSkills ?? [];
  const dollarSkills = overrides.dollarSkills ?? [];
  const agents = overrides.agents ?? [];
  const triggerProfile = overrides.triggerProfile ?? {
    providerSlash: slashCommands.length > 0 || slashSkills.length > 0,
    providerDollarSkill: dollarSkills.length > 0,
  };

  return {
    trigger: overrides.trigger ?? detectComposerTrigger(text, text.length, triggerProfile),
    providerInstanceId: ProviderInstanceId.make(overrides.providerInstanceId ?? "codex_work"),
    capabilities: {
      trigger: triggerProfile,
      slashCommands,
      slashSkills,
      dollarSkills,
      mentionableAgents: agents,
      mentionableAgentNames: new Set(agents.map((agent) => agent.name)),
    },
    pathSearch: {
      entries: overrides.pathEntries ?? [],
      error: overrides.pathError ?? null,
      isPending: false,
    },
  };
}

describe("buildComposerCommandItems", () => {
  it("keeps T4Code actions isolated under colon", () => {
    expect(buildComposerCommandItems(inputFor(":")).items).toMatchObject([
      { type: "t4code-action", group: "t4code", action: "model", replacement: null },
      { type: "t4code-action", group: "t4code", action: "plan", replacement: null },
      { type: "t4code-action", group: "t4code", action: "default", replacement: null },
    ]);
  });

  it("groups native slash commands and slash skills and deduplicates names", () => {
    const result = buildComposerCommandItems(
      inputFor("/", {
        slashCommands: [{ name: "review" }],
        slashSkills: [makeSkill("review", "slash"), makeSkill("audit", "slash")],
      }),
    );

    expect(result.items.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: "provider-command", label: "/review" },
      { type: "provider-skill", label: "/audit" },
    ]);
    expect(result.items.map((item) => item.group)).toEqual(["commands", "skills"]);
  });

  it("keeps dollar menus limited to dollar skills", () => {
    const result = buildComposerCommandItems(
      inputFor("$", {
        slashCommands: [{ name: "review" }],
        slashSkills: [makeSkill("audit", "slash")],
        dollarSkills: [makeSkill("fix", "dollar")],
      }),
    );

    expect(result.items.map(({ type, label, group }) => ({ type, label, group }))).toEqual([
      { type: "provider-skill", label: "$fix", group: "skills" },
    ]);
  });

  it("orders file references before mentionable agents", () => {
    const result = buildComposerCommandItems(
      inputFor("@", {
        pathEntries: [
          { path: "src/main.ts", kind: "file" },
          { path: "src/components", kind: "directory" },
        ],
        agents: [{ name: "planner", invocation: "mention" }],
      }),
    );

    expect(result.items.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: "file-reference", label: "main.ts" },
      { type: "file-reference", label: "components" },
      { type: "agent-reference", label: "@planner" },
    ]);
  });

  it("prefers an exact agent match without removing file results", () => {
    const result = buildComposerCommandItems(
      inputFor("@planner", {
        pathEntries: [{ path: "notes/planner.md", kind: "file" }],
        agents: [
          { name: "planner", invocation: "mention" },
          { name: "planner-assistant", invocation: "mention" },
        ],
      }),
    );

    expect(result.items.map((item) => item.type)).toEqual([
      "file-reference",
      "agent-reference",
      "agent-reference",
    ]);
    expect(result.preferredItemId).toBe(
      result.items.find((item) => item.type === "agent-reference" && item.agent.name === "planner")
        ?.id,
    );
  });

  it("scopes provider-native stable IDs by provider instance", () => {
    const command = [{ name: "review" }] as const;
    const work = buildComposerCommandItems(
      inputFor("/", { providerInstanceId: "codex_work", slashCommands: command }),
    );
    const personal = buildComposerCommandItems(
      inputFor("/", { providerInstanceId: "codex_personal", slashCommands: command }),
    );

    expect(work.items[0]?.id).not.toBe(personal.items[0]?.id);
    expect(work.items[0]?.id).toContain("codex_work");
    expect(personal.items[0]?.id).toContain("codex_personal");
  });

  it("provides native replacements with exactly one trailing space", () => {
    const slash = buildComposerCommandItems(
      inputFor("/", {
        slashCommands: [{ name: "review" }],
        slashSkills: [makeSkill("audit", "slash")],
      }),
    );
    const dollar = buildComposerCommandItems(
      inputFor("$", { dollarSkills: [makeSkill("fix", "dollar")] }),
    );
    const references = buildComposerCommandItems(
      inputFor("@", {
        pathEntries: [{ path: "src/main.ts", kind: "file" }],
        agents: [{ name: "planner", invocation: "mention" }],
      }),
    );

    expect([
      ...slash.items.map((item) => item.replacement),
      ...dollar.items.map((item) => item.replacement),
      ...references.items.map((item) => item.replacement),
    ]).toEqual(["/review ", "/audit ", "$fix ", "@src/main.ts ", "@planner "]);
  });

  it("quotes file paths that cannot be represented as simple mentions", () => {
    const result = buildComposerCommandItems(
      inputFor("@My", {
        pathEntries: [{ path: 'docs/My "File".md', kind: "file" }],
      }),
    );

    expect(result.items[0]).toMatchObject({
      type: "file-reference",
      replacement: '@"docs/My \\"File\\".md" ',
    });
  });

  it("keeps agent results visible when path search fails", () => {
    const result = buildComposerCommandItems(
      inputFor("@plan", {
        pathError: new Error("search unavailable"),
        agents: [{ name: "planner", invocation: "mention" }],
      }),
    );

    expect(result.items).toMatchObject([
      { type: "agent-reference", label: "@planner", replacement: "@planner " },
    ]);
  });

  it.each([
    {
      kind: "provider-slash",
      profile: { providerSlash: false, providerDollarSkill: true },
      inventory: { slashCommands: [{ name: "review" }] },
    },
    {
      kind: "provider-dollar-skill",
      profile: { providerSlash: true, providerDollarSkill: false },
      inventory: { dollarSkills: [makeSkill("fix", "dollar")] },
    },
  ] as const)("returns no items for unsupported $kind triggers", ({ kind, profile, inventory }) => {
    const result = buildComposerCommandItems(
      inputFor("", {
        ...inventory,
        triggerProfile: profile,
        trigger: { kind, query: "", rangeStart: 0, rangeEnd: 1 },
      }),
    );

    expect(result.items).toEqual([]);
    expect(result.preferredItemId).toBeNull();
  });
});
