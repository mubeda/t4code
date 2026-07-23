# Provider-Native Composer Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat composer use `:` for T4Code actions and each provider's normalized native `/`, `$`, and `@` capabilities, while preserving polished file and agent chips whose source text is provider-native.

**Architecture:** Normalize invocation metadata at the server boundary, derive a provider-neutral capability profile in a pure web module, and make shared trigger/reference utilities the canonical source for detection and serialization. Keep `ChatComposer` responsible for editor state and local action execution, while the Lexical editor maps native source tokens to visual nodes. Canonicalize legacy Markdown file links only at draft reconstruction and the provider send boundary.

**Tech Stack:** TypeScript, Effect Schema, React, Lexical, Vite+, Vitest, Rust, Tauri 2, WebdriverIO, macOS Computer Use.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-23-provider-native-composer-triggers-design.md`.
- Do not branch on provider names in web composer logic. The client must use normalized capability metadata only.
- Keep `ServerProviderAgent.invocation` optional so older snapshots continue decoding.
- Keep provider-native text in the draft store and provider payload; chips are presentation only.
- Continue recognizing legacy Markdown file links, but do not rewrite historical transcript messages.
- Preserve concurrent-edit range validation, cursor clamping, terminal-context placeholder boundaries, keyboard navigation, and re-entrant selection protection.
- Use tests first for every behavior change.
- Do not edit vendored repositories under `.repos/`.
- Run `vp check` and `vp run typecheck` before completion.
- Completion additionally requires a packaged macOS desktop build and a Computer Use pass against that local application.

---

## Task 1: Add Explicit Agent Invocation Metadata

**Files:**

- Modify: `packages/contracts/src/server.ts:83-104`
- Modify: `packages/contracts/src/server.test.ts:27-118`
- Modify: `apps/server/src/provider/opencode/model.rs:131-158`
- Modify: `apps/server/src/provider/opencode/model.rs` test module
- Verify: `apps/server/src/provider/cursor/capabilities.rs:1-90`
- Verify: `apps/server/src/production/provider_inventory.rs:725-790`

- [ ] **Step 1: Write contract decoding tests**

Add tests proving that legacy agents still decode, mentionable agents decode, and unsupported invocation values fail:

```ts
it("decodes optional provider-agent invocation metadata", () => {
  const parsed = decodeServerProvider({
    ...baseProviderSnapshot,
    agents: [{ name: "legacy-agent" }, { name: "reviewer", invocation: "mention" }],
  });

  expect(parsed.agents).toEqual([
    { name: "legacy-agent" },
    { name: "reviewer", invocation: "mention" },
  ]);
});

it("rejects unknown provider-agent invocation metadata", () => {
  expect(() =>
    decodeServerProvider({
      ...baseProviderSnapshot,
      agents: [{ name: "reviewer", invocation: "slash" }],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the contract test and confirm it fails**

Run:

```bash
vp test run packages/contracts/src/server.test.ts
```

Expected: failure because `ServerProviderAgent` does not yet accept `invocation`.

- [ ] **Step 3: Add the schema field**

Implement a dedicated schema so agent invocation cannot accidentally reuse skill values:

```ts
export const ServerProviderAgentInvocation = Schema.Literals(["mention"]);
export type ServerProviderAgentInvocation = typeof ServerProviderAgentInvocation.Type;

export const ServerProviderAgent = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
  invocation: Schema.optional(ServerProviderAgentInvocation),
});
```

- [ ] **Step 4: Write OpenCode inventory tests**

Cover hidden, primary-only, subagent, and all-mode agents:

```rust
#[test]
fn agent_inventory_marks_only_visible_subagent_capable_agents_as_mentions() {
    let inventory = agent_inventory(&json!([
        { "name": "plan", "mode": "primary" },
        { "name": "review", "mode": "subagent" },
        { "name": "build", "mode": "all" },
        { "name": "secret", "mode": "subagent", "hidden": true }
    ]));

    assert_eq!(inventory.len(), 3);
    assert!(inventory.iter().any(|agent| {
        agent["name"] == "plan" && agent.get("invocation").is_none()
    }));
    assert!(inventory.iter().any(|agent| {
        agent["name"] == "review" && agent["invocation"] == "mention"
    }));
    assert!(inventory.iter().any(|agent| {
        agent["name"] == "build" && agent["invocation"] == "mention"
    }));
}
```

Treat OpenCode `mode: "all"` as mentionable because it is subagent-capable as well as primary-capable.

- [ ] **Step 5: Run the focused Rust test and confirm it fails**

Run:

```bash
cargo test -p t4code-server agent_inventory_marks_only_visible_subagent_capable_agents_as_mentions -- --nocapture
```

Expected: failure because `agent_inventory` does not emit invocation metadata.

- [ ] **Step 6: Normalize OpenCode agent invocation**

After copying `mode`, add `invocation: "mention"` only for `subagent` and `all`:

```rust
let mode = agent
    .get("mode")
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty());

if matches!(mode, Some("subagent" | "all")) {
    result["invocation"] = json!("mention");
}
```

Do not add invocation metadata to Codex, Claude, Cursor, or Grok agents. Their existing inventory remains available for settings and mode controls without becoming inline autocomplete.

- [ ] **Step 7: Run focused contract and server tests**

Run:

```bash
vp test run packages/contracts/src/server.test.ts
cargo test -p t4code-server provider::opencode::model -- --nocapture
cargo test -p t4code-server production::provider_inventory -- --nocapture
```

Expected: all pass, including existing Claude and Cursor slash-skill tests.

- [ ] **Step 8: Commit the contract boundary**

```bash
git add packages/contracts/src/server.ts packages/contracts/src/server.test.ts apps/server/src/provider/opencode/model.rs
git commit -m "feat: expose native provider agent invocation"
```

---

## Task 2: Make Native Composer References Canonical

**Files:**

- Create: `packages/shared/src/composerReferences.ts`
- Create: `packages/shared/src/composerReferences.test.ts`
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/src/composerTrigger.ts`
- Modify: `packages/shared/src/composerTrigger.test.ts`
- Modify: `packages/shared/src/composerInlineTokens.test.ts`

- [ ] **Step 1: Write native serialization and migration tests**

Cover simple paths, quoted paths, escaping, Windows paths, mixed content, malformed links, and external Markdown links:

```ts
describe("serializeComposerReference", () => {
  it("serializes simple and quoted native references", () => {
    expect(serializeComposerReference("src/main.ts")).toBe("@src/main.ts");
    expect(serializeComposerReference("docs/My File.md")).toBe('@"docs/My File.md"');
    expect(serializeComposerReference('docs/My "File".md')).toBe('@"docs/My \\"File\\".md"');
  });
});

describe("canonicalizeLegacyComposerFileReferences", () => {
  it("migrates only recognized legacy file links", () => {
    expect(
      canonicalizeLegacyComposerFileReferences(
        "Inspect [main.ts](src/main.ts) and [docs](https://example.com) next",
      ),
    ).toBe("Inspect @src/main.ts and [docs](https://example.com) next");
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
vp test run packages/shared/src/composerReferences.test.ts
```

Expected: failure because the module does not exist.

- [ ] **Step 3: Implement a focused reference module**

Move `serializeComposerMentionPath` into the new module and retain a compatibility re-export from `composerTrigger.ts`. Implement migration using `collectComposerInlineTokens`, replacing legacy mention tokens from right to left:

```ts
export function serializeComposerReference(value: string): string {
  return `@${serializeComposerMentionPath(value)}`;
}

export function canonicalizeLegacyComposerFileReferences(text: string): string {
  const legacy = collectComposerInlineTokens(text).filter(
    (token) => token.type === "mention" && token.source.startsWith("["),
  );
  return legacy.reduceRight(
    (current, token) =>
      `${current.slice(0, token.start)}${serializeComposerReference(token.value)}${current.slice(token.end)}`,
    text,
  );
}
```

Keep `serializeComposerFileLink` temporarily as a deprecated compatibility helper for historical parser tests. New composer code must not call it.

- [ ] **Step 4: Add the explicit shared-package export**

Add:

```json
"./composerReferences": "./src/composerReferences.ts"
```

to `packages/shared/package.json`.

- [ ] **Step 5: Add parser regression cases**

Extend `composerInlineTokens.test.ts` to prove that native file references and agent-shaped references remain lossless tokens and that only file-link-shaped Markdown is migrated.

- [ ] **Step 6: Run shared tests**

Run:

```bash
vp test run packages/shared/src/composerReferences.test.ts packages/shared/src/composerInlineTokens.test.ts packages/shared/src/composerTrigger.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit native reference utilities**

```bash
git add packages/shared/src/composerReferences.ts packages/shared/src/composerReferences.test.ts packages/shared/src/composerTrigger.ts packages/shared/src/composerTrigger.test.ts packages/shared/src/composerInlineTokens.test.ts packages/shared/package.json
git commit -m "feat: canonicalize composer references as native mentions"
```

---

## Task 3: Introduce a Capability-Gated Trigger Model

**Files:**

- Modify: `packages/shared/src/composerTrigger.ts`
- Modify: `packages/shared/src/composerTrigger.test.ts`
- Modify: `apps/web/src/composer-logic.ts:1-280`
- Modify: `apps/web/src/composer-logic.test.ts:1-410`
- Create: `apps/web/src/components/chat/composerCapabilities.ts`
- Create: `apps/web/src/components/chat/composerCapabilities.test.ts`
- Modify: `apps/web/src/components/chat/composerSlashCommandSearch.ts`
- Modify: `apps/web/src/components/chat/composerSlashCommandSearch.test.ts`

- [ ] **Step 1: Write the shared trigger matrix**

Define tests for line-start rules and capability gating:

```ts
const allCapabilities = {
  providerSlash: true,
  providerDollarSkill: true,
};

it.each([
  [":mod", "t4code-action"],
  ["/rev", "provider-slash"],
  ["use $ref", "provider-dollar-skill"],
  ["open @src", "provider-reference"],
] as const)("detects %s as %s", (text, kind) => {
  expect(detectComposerTrigger(text, text.length, allCapabilities)).toMatchObject({ kind });
});

it("leaves unsupported provider triggers as text", () => {
  const profile = { providerSlash: false, providerDollarSkill: false };
  expect(detectComposerTrigger("/review", 7, profile)).toBeNull();
  expect(detectComposerTrigger("$review", 7, profile)).toBeNull();
  expect(detectComposerTrigger("@src", 4, profile)?.kind).toBe("provider-reference");
  expect(detectComposerTrigger(":plan", 5, profile)?.kind).toBe("t4code-action");
});
```

Also retain coverage for custom whitespace callbacks, non-finite cursors, mid-prompt tokens, and multiline line starts.

- [ ] **Step 2: Run the shared trigger tests and confirm they fail**

Run:

```bash
vp test run packages/shared/src/composerTrigger.test.ts
```

Expected: failures for colon detection, renamed trigger kinds, and profile gating.

- [ ] **Step 3: Implement the canonical trigger API**

Use these public types:

```ts
export type ComposerTriggerKind =
  "t4code-action" | "provider-slash" | "provider-dollar-skill" | "provider-reference";

export interface ComposerTriggerProfile {
  readonly providerSlash: boolean;
  readonly providerDollarSkill: boolean;
}

export type ComposerT4CodeAction = "model" | "plan" | "default";
```

Detect `:` and `/` only when the current line prefix is exactly one non-whitespace token. Gate `/` and `$` with the profile. Never gate `:` or `@`.

Rename the standalone parser:

```ts
export function parseStandaloneComposerT4CodeAction(text: string): ComposerT4CodeAction | null {
  const match = /^:(model|plan|default)\s*$/i.exec(text.trim());
  // return normalized action or null
}
```

- [ ] **Step 4: Remove duplicate web trigger behavior**

Keep cursor-collapse and terminal-placeholder logic in `apps/web/src/composer-logic.ts`, but import the shared detector and wrap it with the web whitespace predicate:

```ts
export function detectComposerTrigger(
  text: string,
  cursor: number,
  profile: ComposerTriggerProfile,
): ComposerTrigger | null {
  return detectSharedComposerTrigger(text, cursor, profile, {
    isWhitespaceChar: isWhitespace,
  });
}
```

Re-export the shared trigger types from the web module so existing component imports change incrementally. Remove the duplicate slash parser and range replacement implementation after callers use the shared versions.

- [ ] **Step 5: Write pure capability-profile tests**

Build provider fixtures by capability shape, not driver name:

```ts
it("derives triggers from invocation metadata without driver branches", () => {
  const profile = deriveComposerCapabilityProfile({
    slashCommands: [{ name: "review" }],
    skills: [
      makeSkill("audit", "slash"),
      makeSkill("fix", "dollar"),
      makeSkill("explain", "prompt"),
    ],
    agents: [{ name: "reviewer", invocation: "mention" }, { name: "planner" }],
  });

  expect(profile.trigger).toEqual({
    providerSlash: true,
    providerDollarSkill: true,
  });
  expect([...profile.mentionableAgentNames]).toEqual(["reviewer"]);
});
```

Add fixture cases representing Codex, Claude, Cursor, OpenCode, Grok, empty inventory, disabled skills, and a snapshot refresh.

- [ ] **Step 6: Implement `composerCapabilities.ts`**

Expose only semantic helpers:

```ts
export interface ComposerCapabilityProfile {
  readonly trigger: ComposerTriggerProfile;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly slashSkills: ReadonlyArray<ServerProviderSkill>;
  readonly dollarSkills: ReadonlyArray<ServerProviderSkill>;
  readonly mentionableAgents: ReadonlyArray<ServerProviderAgent>;
  readonly mentionableAgentNames: ReadonlySet<string>;
}

export function deriveComposerCapabilityProfile(
  provider: Pick<ServerProvider, "slashCommands" | "skills" | "agents"> | null,
): ComposerCapabilityProfile;
```

Rules:

- enabled `invocation: "slash"` skills populate slash skills;
- enabled `invocation: "dollar"` skills populate dollar skills;
- prompt skills populate neither inline menu;
- `invocation: "mention"` agents populate mentionable agents;
- slash command names win over same-named slash skills;
- ordering is deterministic and stable.

- [ ] **Step 7: Generalize slash search**

Change the search helper to accept provider command and slash-skill items only. Preserve exact-name-first and fuzzy matching. Remove T4Code actions and agents from its input type.

- [ ] **Step 8: Run capability and trigger suites**

Run:

```bash
vp test run packages/shared/src/composerTrigger.test.ts apps/web/src/composer-logic.test.ts apps/web/src/components/chat/composerCapabilities.test.ts apps/web/src/components/chat/composerSlashCommandSearch.test.ts
```

Expected: all pass.

- [ ] **Step 9: Commit capability-driven trigger logic**

```bash
git add packages/shared/src/composerTrigger.ts packages/shared/src/composerTrigger.test.ts apps/web/src/composer-logic.ts apps/web/src/composer-logic.test.ts apps/web/src/components/chat/composerCapabilities.ts apps/web/src/components/chat/composerCapabilities.test.ts apps/web/src/components/chat/composerSlashCommandSearch.ts apps/web/src/components/chat/composerSlashCommandSearch.test.ts
git commit -m "feat: gate composer triggers by provider capabilities"
```

---

## Task 4: Build Semantic Menu Items Outside `ChatComposer`

**Files:**

- Create: `apps/web/src/components/chat/composerCommandItems.ts`
- Create: `apps/web/src/components/chat/composerCommandItems.test.ts`
- Modify: `apps/web/src/components/chat/ComposerCommandMenu.tsx`
- Modify: `apps/web/src/components/chat/ComposerCommandMenu.test.tsx`
- Modify: `apps/web/src/components/chat/composerMenuHighlight.ts`
- Modify: `apps/web/src/components/chat/composerMenuHighlight.test.ts`

- [ ] **Step 1: Write menu derivation tests**

Test every trigger independently:

```ts
it("keeps T4Code actions isolated under colon", () => {
  expect(buildComposerCommandItems(inputFor(":"))).toMatchObject([
    { type: "t4code-action", group: "t4code", action: "model", replacement: null },
    { type: "t4code-action", group: "t4code", action: "plan", replacement: null },
    { type: "t4code-action", group: "t4code", action: "default", replacement: null },
  ]);
});

it("groups native slash commands and slash skills and deduplicates names", () => {
  const items = buildComposerCommandItems(
    inputFor("/", {
      slashCommands: [{ name: "review" }],
      slashSkills: [makeSkill("review", "slash"), makeSkill("audit", "slash")],
    }),
  );

  expect(items.map(({ type, label }) => ({ type, label }))).toEqual([
    { type: "provider-command", label: "/review" },
    { type: "provider-skill", label: "/audit" },
  ]);
});
```

Add cases for:

- dollar menu containing only dollar skills;
- `@` files before agents;
- exact agent query setting a preferred highlight while preserving file results;
- stable IDs scoped by provider instance;
- native replacements with one trailing space;
- quoted file paths;
- path-search failure leaving agent results visible;
- no items for unsupported provider triggers.

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/composerCommandItems.test.ts
```

Expected: failure because the module does not exist.

- [ ] **Step 3: Implement semantic menu items**

Use a single discriminated union with an explicit group:

```ts
export type ComposerCommandItem =
  | T4CodeActionItem
  | ProviderCommandItem
  | ProviderSkillItem
  | FileReferenceItem
  | AgentReferenceItem;

export type ComposerCommandGroupId = "t4code" | "commands" | "skills" | "files" | "agents";
```

Every selectable provider item includes its exact `replacement`; T4Code actions use `replacement: null`. File replacement must call `serializeComposerReference(path)`. Agent replacement is `@${agent.name} `.

Return:

```ts
export interface ComposerCommandItemsResult {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly preferredItemId: string | null;
  readonly emptyStateText: string;
}
```

- [ ] **Step 4: Make the menu render semantic groups**

Delete item type ownership from `ComposerCommandMenu.tsx`; import it from `composerCommandItems.ts`. Group by `item.group` in this order:

```ts
const GROUPS = [
  ["t4code", "T4Code"],
  ["commands", "Commands"],
  ["skills", "Skills"],
  ["files", "Files"],
  ["agents", "Agents"],
] as const;
```

Use the existing file glyph, skill glyph, and bot glyph. T4Code actions retain the bot/internal-action glyph. Remove `groupSlashCommandSections`.

- [ ] **Step 5: Teach highlight resolution about exact agent matches**

Add an optional preferred item ID to `resolveComposerMenuActiveItemId`. Priority is:

1. preserved highlighted stable ID when still present in the same search;
2. exact-match preferred ID;
3. first item.

- [ ] **Step 6: Run focused menu tests**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/composerMenuHighlight.test.ts
```

Expected: all pass with group labels `T4Code`, `Commands`, `Skills`, `Files`, and `Agents`.

- [ ] **Step 7: Commit the menu extraction**

```bash
git add apps/web/src/components/chat/composerCommandItems.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/components/chat/ComposerCommandMenu.tsx apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/composerMenuHighlight.ts apps/web/src/components/chat/composerMenuHighlight.test.ts
git commit -m "refactor: derive semantic composer menus outside the view"
```

---

## Task 5: Render Native File and Agent Chips

**Files:**

- Modify: `apps/web/src/composer-editor-mentions.ts`
- Modify: `apps/web/src/composer-editor-mentions.test.ts`
- Modify: `apps/web/src/components/ComposerPromptEditor.tsx:96-360`
- Modify: `apps/web/src/components/ComposerPromptEditor.tsx:824-850`
- Modify: `apps/web/src/components/ComposerPromptEditor.tsx:877-940`
- Modify: `apps/web/src/components/ComposerPromptEditor.tsx:1380-1490`
- Modify: `apps/web/src/components/ComposerPromptEditor.test.tsx`

- [ ] **Step 1: Write segment-classification tests**

Pass mentionable agent names into the segment splitter and prove exact-name precedence:

```ts
it("classifies exact mentionable-agent names before files", () => {
  const segments = splitPromptIntoComposerSegments(
    "Ask @reviewer about @src/reviewer",
    [],
    new Set(["reviewer"]),
  );

  expect(segments).toMatchObject([
    { type: "text", text: "Ask " },
    { type: "agent", name: "reviewer", source: "@reviewer" },
    { type: "text", text: " about " },
    { type: "mention", path: "src/reviewer", source: "@src/reviewer" },
  ]);
});
```

Keep legacy Markdown link segments classified as files.

- [ ] **Step 2: Run segment tests and confirm they fail**

Run:

```bash
vp test run --project unit apps/web/src/composer-editor-mentions.test.ts
```

Expected: failure because the splitter has no agent inventory.

- [ ] **Step 3: Extend the segment model**

Add an `agent` segment while retaining `mention` for files. Use exact case-sensitive provider names. If a name is not in the mentionable set, classify it as a file.

Update cursor helpers in `composer-logic.ts` so agent segments are inline tokens with collapsed length one.

- [ ] **Step 4: Write editor-node tests**

Add tests for:

- a file chip whose `getTextContent()` is `@src/main.ts`;
- a quoted file chip whose text is `@"docs/My File.md"`;
- an agent chip whose text is `@reviewer`;
- a legacy Markdown file draft becoming native source after editor serialization;
- reload preserving file, agent, and dollar-skill chips;
- provider inventory refresh changing `@reviewer` between file and agent presentation without changing source text.

- [ ] **Step 5: Run editor tests and confirm they fail**

Run:

```bash
vp test run --project unit apps/web/src/components/ComposerPromptEditor.test.tsx
```

Expected: failures because file nodes still emit Markdown links and agent nodes do not exist.

- [ ] **Step 6: Make file nodes serialize natively**

Replace:

```ts
return serializeComposerFileLink(this.__path);
```

with:

```ts
return serializeComposerReference(this.__path);
```

Keep the current `FileTagChipContent` visuals and tooltip unchanged.

- [ ] **Step 7: Add `ComposerAgentNode`**

Create a serialized Lexical decorator node with:

```ts
type SerializedComposerAgentNode = Spread<
  {
    agentName: string;
    agentDescription?: string;
    type: "composer-agent";
    version: 1;
  },
  SerializedLexicalNode
>;
```

Render an agent-specific bot chip using the shared inline-chip classes, expose `data-composer-agent-chip="true"`, serialize to `@name`, and show the description in a tooltip when present.

- [ ] **Step 8: Thread agent metadata through the editor**

Add `agents: ReadonlyArray<ServerProviderAgent>` to `ComposerPromptEditorProps`. Derive a stable signature and a metadata map from agents with `invocation === "mention"`. Rewrite controlled editor state when that signature changes, just as skill metadata does.

Register the new node:

```ts
nodes: [
  ComposerMentionNode,
  ComposerAgentNode,
  ComposerSkillNode,
  ComposerTerminalContextNode,
],
```

- [ ] **Step 9: Run editor and cursor tests**

Run:

```bash
vp test run --project unit apps/web/src/composer-editor-mentions.test.ts apps/web/src/composer-logic.test.ts apps/web/src/components/ComposerPromptEditor.test.tsx
```

Expected: all pass.

- [ ] **Step 10: Commit native chip behavior**

```bash
git add apps/web/src/composer-editor-mentions.ts apps/web/src/composer-editor-mentions.test.ts apps/web/src/composer-logic.ts apps/web/src/composer-logic.test.ts apps/web/src/components/ComposerPromptEditor.tsx apps/web/src/components/ComposerPromptEditor.test.tsx
git commit -m "feat: render native file and agent references as chips"
```

---

## Task 6: Integrate Native Triggers and Local Actions

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx:930-1100`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:1540-1665`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:1680-1790`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:2270-2470`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx`
- Modify: `apps/web/src/components/ChatView.tsx:65-72`
- Modify: `apps/web/src/components/ChatView.tsx:4150-4270`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`

- [ ] **Step 1: Rewrite composer integration tests first**

Replace old expectations with the native contract:

```ts
it("lists only T4Code actions for colon", () => {
  const menu = renderMenuFor(":");
  expect(menu.items.map((item) => item.label)).toEqual([":model", ":plan", ":default"]);
});

it("keeps provider commands and slash skills under slash", () => {
  const menu = renderMenuFor("/");
  expect(menu.items.map((item) => item.label)).toEqual(["/review", "/docs"]);
  expect(menu.items.map((item) => item.label)).not.toContain(":plan");
  expect(menu.items.some((item) => item.type === "agent-reference")).toBe(false);
});

it("keeps unsupported dollar text and opens no menu", () => {
  setProviderCapabilities({ skills: [] });
  seedPrompt("$ordinary");
  renderComposer();
  expect(findCaptures("ComposerCommandMenu")).toHaveLength(0);
  expect(draftOf(threadRef)?.prompt).toBe("$ordinary");
});
```

Add tests for file insertion as native `@path`, agent insertion as `@name`, slash/dollar skill filtering, local-action execution, direct Enter submission of `:model`, pending custom-answer behavior, capability refresh, and stale-menu closure. Keep each chat panel provider-locked.

- [ ] **Step 2: Run the ChatComposer suite and confirm it fails**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: failures matching the old fixed `/`, `$`, `@`, and Markdown-link behavior.

- [ ] **Step 3: Derive the capability profile once**

In `ChatComposer`, memoize:

```ts
const composerCapabilities = useMemo(
  () => deriveComposerCapabilityProfile(selectedProviderStatus ?? null),
  [selectedProviderStatus],
);
```

Pass `composerCapabilities.trigger` to every trigger-detection call. Pass `composerCapabilities.mentionableAgents` to `ComposerPromptEditor`.

- [ ] **Step 4: Replace inline menu construction**

Keep `useComposerPathSearch` in `ChatComposer`, active only for `provider-reference`. Pass its entries, error state, the active trigger, provider instance ID, and normalized capabilities to `buildComposerCommandItems`.

Delete:

- hard-coded slash T4Code items;
- direct skill filtering;
- direct provider-agent instruction construction;
- provider-native insertion branching inside selection.

- [ ] **Step 5: Centralize T4Code action execution**

Create one callback:

```ts
const executeT4CodeAction = useCallback(
  (action: ComposerT4CodeAction) => {
    if (action === "model") {
      setIsComposerModelPickerOpen(true);
      return;
    }
    void handleInteractionModeChange(action);
  },
  [handleInteractionModeChange],
);
```

Selection clears the expected trigger range, clears highlight state, executes the action, and focuses the editor. Provider item selection applies `item.replacement` with the existing expected-text safeguard.

- [ ] **Step 6: Intercept submitted colon actions**

Before `onSend` in `submitComposer`, parse a standalone colon action. Execute it locally, clear the draft, reset cursor/menu state, and return. This includes `:model`.

Rename the ChatView safety parser from slash to colon for `:plan` and `:default`, so direct parent-level calls also cannot leak those actions. `:model` remains composer-owned because the picker state belongs to `ChatComposer`.

- [ ] **Step 7: Recompute menus after capability changes**

Add an effect keyed by the trigger-profile signature and provider instance ID:

```ts
useLayoutEffect(() => {
  const next = detectComposerTrigger(
    promptRef.current,
    readComposerSnapshot().expandedCursor,
    composerCapabilities.trigger,
  );
  setComposerTrigger(next);
  if (!next) {
    setComposerHighlightedItemId(null);
    setComposerHighlightedSearchKey(null);
  }
}, [composerCapabilities.signature, selectedProviderStatus?.instanceId]);
```

Do not change the prompt text during provider capability refresh or session hydration.

- [ ] **Step 8: Update placeholder copy**

Use provider-neutral copy that advertises internal actions without promising unsupported provider keys:

```text
Ask anything, @ files, : T4Code actions, or a provider-native command
```

Avoid dynamically listing unavailable sigils in a way that causes layout churn.

- [ ] **Step 9: Run composer and ChatView suites**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: all pass.

- [ ] **Step 10: Commit integrated trigger behavior**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "feat: use native triggers in the chat composer"
```

---

## Task 7: Canonicalize Legacy Drafts at the Send Boundary

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx:4178-4268`
- Modify: `apps/web/src/components/ChatView.test.tsx:1280-1410`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Verify: `apps/web/src/components/chat/MessagesTimeline.tsx`
- Verify: `apps/web/src/components/ChatMarkdown.tsx`

- [ ] **Step 1: Add send-payload migration tests**

Cover a successful turn, failed turn restoration, mixed native/legacy references, and an external link:

```ts
it("canonicalizes legacy file links before starting a provider turn", async () => {
  seedPrompt("Inspect [main.ts](src/main.ts) and @README.md");
  await onSend();

  expect(startTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "Inspect @src/main.ts and @README.md",
    }),
  );
});

it("does not rewrite normal Markdown links or historical messages", async () => {
  seedPrompt("Read [docs](https://example.com) first");
  await onSend();
  expect(startTurnPrompt()).toBe("Read [docs](https://example.com) first");
  expect(existingTimelineMessage()).toBe(legacyHistoricalText);
});
```

- [ ] **Step 2: Run the focused send tests and confirm they fail**

Run:

```bash
vp test run --project unit apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: legacy file links reach the mocked turn unchanged.

- [ ] **Step 3: Canonicalize before deriving send state**

Change:

```ts
const promptForSend = promptRef.current;
```

to:

```ts
const promptForSend = canonicalizeLegacyComposerFileReferences(promptRef.current);
```

Use this canonical value consistently for send-state derivation, terminal-context expansion, turn start, and failed-send draft restoration.

- [ ] **Step 4: Verify transcript rendering remains untouched**

Do not call the canonicalizer in `MessagesTimeline` or `ChatMarkdown`. Existing stored messages must render exactly as stored.

- [ ] **Step 5: Run send and inline-token tests**

Run:

```bash
vp test run --project unit apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
vp test run packages/shared/src/composerReferences.test.ts packages/shared/src/composerInlineTokens.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit compatibility migration**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "fix: migrate legacy composer file links before send"
```

---

## Task 8: Add Deterministic Packaged-Desktop Coverage

**Files:**

- Modify: `apps/desktop/e2e/support/test-project.ts`
- Modify: `apps/desktop/e2e/support/test-project.test.ts`
- Create: `apps/desktop/e2e/support/provider-input-log.ts`
- Create: `apps/desktop/e2e/support/provider-input-log.test.ts`
- Create: `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts`
- Modify: `apps/desktop/e2e/wdio.conf.ts`

- [ ] **Step 1: Define deterministic capability profiles**

Extend `desktopUiFixture` with five named profiles:

```ts
export const composerProviderProfiles = {
  codex: {
    commands: ["review"],
    slashSkills: [],
    dollarSkills: ["refactor"],
    mentionableAgents: [],
  },
  claudeAgent: {
    commands: ["compact"],
    slashSkills: ["docs"],
    dollarSkills: [],
    mentionableAgents: [],
  },
  cursor: {
    commands: ["review"],
    slashSkills: ["frontend"],
    dollarSkills: [],
    mentionableAgents: [],
  },
  opencode: {
    commands: ["init"],
    slashSkills: [],
    dollarSkills: [],
    mentionableAgents: ["reviewer"],
  },
  grok: {
    commands: ["help"],
    slashSkills: ["research"],
    dollarSkills: [],
    mentionableAgents: [],
  },
} as const;
```

The exact names are fixture-only and intentionally unique enough to make false-positive menu matches obvious.

- [ ] **Step 2: Write fixture-generation tests**

Test that:

- every provider is enabled and points at an absolute shim;
- the fixture project contains provider-native command/skill/agent metadata;
- the input-log path is exported;
- profile capabilities match the files/protocol responses generated by the fixture;
- hidden and prose-only agents are present in upstream fixtures but absent from expected inline profiles.

- [ ] **Step 3: Run fixture tests and confirm they fail**

Run:

```bash
vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.test.ts
```

Expected: failures because only Codex is enabled and no provider input log exists.

- [ ] **Step 4: Add the shared provider input log**

Keep fixtures test-only in `apps/desktop/e2e/support`.

Use one JSON object per input-log line:

```ts
interface ProviderInputLogEntry {
  readonly provider: keyof typeof composerProviderProfiles;
  readonly prompt: string;
  readonly recordedAt: string;
}
```

Implement append/read helpers and export the absolute log path as
`T4CODE_E2E_PROVIDER_INPUT_LOG`.

- [ ] **Step 5: Extend the Codex fixture**

Return a dollar-invoked `refactor` skill from `skills/list`, expose the fixture
`review` slash command through the existing Codex driver inventory, and append
every `turn/start` prompt to the shared JSONL input log.

- [ ] **Step 6: Extend the Claude and Cursor fixtures**

For Claude, respond to the stream-json initialization probe with commands and
prose-only agents, generate `.claude/skills/docs/SKILL.md`, and log submitted
prompt text.

For Cursor, generate `.cursor/commands/review.md`,
`.cursor/skills/frontend/SKILL.md`, and a prose-only agent fixture; respond to
the cursor capability probe and log prompts.

- [ ] **Step 7: Extend the OpenCode fixture**

Have the shim's `serve` mode start a local HTTP fixture implementing the health,
config, agent, and session/message endpoints used by
`apps/server/src/provider/opencode`. Return visible `primary`, `subagent`, `all`,
and hidden agents so server normalization is exercised, and log submitted
message parts.

- [ ] **Step 8: Extend the Grok fixture and enable all profiles**

Respond to Grok's native probe/run protocol, expose one command and one slash
skill, and log prompts. Update the generated settings so all five fixture
providers are enabled and pinned to their absolute shim paths.

Do not add a production server environment override for capability snapshots. The packaged app must exercise real provider normalization against deterministic shims.

- [ ] **Step 9: Add the packaged composer E2E spec**

For each profile, open a separate chat panel created for that provider. Never
switch the provider of an existing chat through the composer model picker.

1. open the provider's dedicated chat panel and assert its model picker lists
   only models for that provider, including before the first send;
2. type `:` and assert only T4Code actions;
3. choose and verify a local action clears;
4. type `/` and assert the expected Commands and Skills groups;
5. type `$` and assert the dollar skill or no menu;
6. type `@` and assert Files plus only expected Agents;
7. select using keyboard and mouse in separate cases;
8. send one native token;
9. read the provider input log and assert the exact payload;
10. move to another provider's dedicated panel and assert menus and
    capabilities do not leak between panels.

Use stable selectors already present on the composer and add narrowly scoped `data-*` selectors only where accessibility roles and labels are insufficient.

- [ ] **Step 10: Add persistence coverage**

Leave a draft containing:

```text
@README.md @reviewer $refactor
```

Restart the packaged session, reselect the matching profile, and assert the correct file, agent, and skill chip selectors. Capture:

- `composer-colon-menu.png`;
- `composer-slash-groups.png`;
- `composer-reference-groups.png`;
- `composer-restored-chips.png`.

- [ ] **Step 11: Register the E2E spec**

Add `./specs/composer-native-triggers.e2e.ts` to the default WDIO spec list.

- [ ] **Step 12: Run fixture unit tests**

Run:

```bash
vp test run apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.test.ts
```

Expected: all pass.

- [ ] **Step 13: Commit packaged acceptance fixtures**

```bash
git add apps/desktop/e2e/support/test-project.ts apps/desktop/e2e/support/test-project.test.ts apps/desktop/e2e/support/provider-input-log.ts apps/desktop/e2e/support/provider-input-log.test.ts apps/desktop/e2e/specs/composer-native-triggers.e2e.ts apps/desktop/e2e/wdio.conf.ts
git commit -m "test: cover native composer triggers in packaged desktop"
```

---

## Task 9: Run Full Verification and Computer Use Acceptance

**Files:**

- Verify all modified files
- Produce local artifacts under the desktop E2E artifact directory
- Do not commit generated app bundles, DMGs, logs, or screenshots

- [ ] **Step 1: Format and inspect the diff**

Run:

```bash
vp fmt
git diff --check
git status --short
```

Expected: formatting completes, `git diff --check` prints nothing, and only intended source/test files are modified.

- [ ] **Step 2: Run focused TypeScript and Rust suites**

Run:

```bash
vp test run packages/contracts/src/server.test.ts packages/shared/src/composerTrigger.test.ts packages/shared/src/composerReferences.test.ts packages/shared/src/composerInlineTokens.test.ts
vp test run --project unit apps/web/src/composer-logic.test.ts apps/web/src/composer-editor-mentions.test.ts apps/web/src/components/ComposerPromptEditor.test.tsx apps/web/src/components/chat/composerCapabilities.test.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
cargo test -p t4code-server provider::opencode::model -- --nocapture
cargo test -p t4code-server production::provider_inventory -- --nocapture
```

Expected: all pass.

- [ ] **Step 3: Run repository-required gates**

Run:

```bash
vp check
vp run typecheck
vp test
```

Expected: all exit with status 0. Do not treat the task as complete if either required gate fails.

- [ ] **Step 4: Build the packaged macOS desktop app and DMG**

Run:

```bash
vp run test:ui:desktop:build
```

Expected:

- the Tauri packaged `.app` exists under the macOS bundle output;
- a local `.dmg` exists under the DMG bundle output;
- the build used the `desktop-e2e` feature and `VITE_T4CODE_DESKTOP_E2E=1`.

- [ ] **Step 5: Run the automated packaged-app E2E suite**

Set `T4CODE_E2E_APP_PATH` to the absolute `.app` bundle path produced in Step 4, then run:

```bash
export T4CODE_E2E_APP_PATH
T4CODE_E2E_APP_PATH="$(
  find \
    "$PWD/target/release/bundle/macos" \
    "$PWD/apps/desktop/src-tauri/target/release/bundle/macos" \
    -maxdepth 1 -type d -name '*.app' -print 2>/dev/null |
    head -n 1
)"
test -n "$T4CODE_E2E_APP_PATH"
vp run test:ui:desktop
```

Expected: all packaged specs pass, including `composer-native-triggers.e2e.ts`, and the output prints the retained artifact directory.

- [ ] **Step 6: Launch the packaged app with an isolated fixture home**

Reuse `prepareDesktopUiTestContext` to create a disposable workspace, shim directory, input log, and `T4CODE_HOME`. Launch the `.app` executable from that environment so the real desktop app—not Vite or a browser preview—uses the deterministic provider shims.

Record the absolute app path and artifact directory in the verification notes.

- [ ] **Step 7: Bootstrap Computer Use through `node_repl`**

Use the Computer Use skill's prescribed runtime:

```js
if (!globalThis.sky) {
  const { setupComputerUseRuntime } =
    await import("/Users/admin/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000451/scripts/computer-use-client.mjs");
  await setupComputerUseRuntime({ globals: globalThis });
}
```

List apps, select the locally built T4Code application, and get a fresh app state before each interaction sequence.

- [ ] **Step 8: Validate all trigger profiles with Computer Use**

For every deterministic provider profile, visibly confirm:

- the profile is opened in its own provider-locked chat panel;
- the model picker lists only that panel's provider models, including before
  the first send;
- `:` contains only `:model`, `:plan`, and `:default`;
- `:model` opens the picker and clears its text;
- `:plan` and `:default` change mode and clear their text;
- `/` contains only native commands and slash skills with separate headings;
- `$` contains only dollar skills or remains ordinary text;
- `@` always contains files and contains only mentionable agents;
- exact agent matching highlights the agent without hiding files;
- file selection renders the existing polished chip;
- agent selection renders the new agent chip;
- arrow keys, Tab/Enter, mouse selection, scroll, and empty states work;
- moving between separate provider chat panels never leaks the previous
  panel's menu or capabilities.

After every action, fetch a fresh accessibility/UI state instead of relying on stale coordinates.

- [ ] **Step 9: Validate provider payloads and restart persistence**

Send one example of each native syntax and inspect the deterministic JSONL input log:

```text
/review
/docs
$refactor
@README.md
@reviewer
```

Confirm no `:model`, `:plan`, or `:default` entry exists.

Leave a draft with file, agent, and dollar-skill tokens, quit the packaged app, relaunch it with the same fixture home, and confirm the chips restore while their source text remains native.

- [ ] **Step 10: Capture visual and accessibility evidence**

Save screenshots and accessibility state for:

- T4Code action menu;
- provider slash Commands/Skills groups;
- file/agent reference groups;
- restored file, agent, and skill chips;
- a provider-switch stale-menu case.

Compare observations with the approved design and fix every discrepancy before continuing.

- [ ] **Step 11: Re-run gates after any acceptance fix**

If Computer Use reveals a defect, return to the relevant test-first task, add a regression test, fix it, and repeat:

```bash
vp check
vp run typecheck
vp test
vp run test:ui:desktop
```

Rebuild the packaged app before repeating Computer Use whenever source changed.

- [ ] **Step 12: Audit the final worktree and commit history**

After all automated and Computer Use checks pass:

```bash
git status --short
git diff --check
git log --oneline -12
```

Expected: no uncommitted source changes remain, the diff check is clean, and the
task commits are present. Do not add bundle outputs, DMGs, logs, screenshots,
temporary homes, or generated state.

---

## Completion Checklist

- [ ] `:` is the only trigger for T4Code-owned actions.
- [ ] `/` shows only native provider commands and slash-invoked skills.
- [ ] `$` shows only enabled dollar-invoked skills.
- [ ] `@` shows workspace files and only natively mentionable agents.
- [ ] Unsupported provider triggers remain ordinary text.
- [ ] Web code contains no provider-name conditionals for composer capabilities.
- [ ] Duplicate `/name` entries prefer the provider command.
- [ ] File chips serialize as native `@path` or quoted native references.
- [ ] Agent chips serialize as native `@name`.
- [ ] Legacy Markdown file links migrate at edit/send boundaries only.
- [ ] Provider switching closes stale menus without changing the draft.
- [ ] `vp check`, `vp run typecheck`, and `vp test` pass.
- [ ] Packaged desktop E2E passes.
- [ ] A local macOS `.app` and `.dmg` are built.
- [ ] Computer Use validates the real packaged desktop app and all fixture profiles.
