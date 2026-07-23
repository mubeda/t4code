# Provider-Native Composer Triggers Design

**Date:** 2026-07-23

## Goal

Make the AI chat composer follow the selected provider's native conventions for
commands, skills, agents, and files while giving T4Code-owned actions a
separate, unambiguous trigger.

The completed interaction uses:

- `:` for T4Code actions;
- `/` for provider-native slash commands and slash-invoked skills;
- `$` for provider-native dollar-invoked skills;
- `@` for native file references and, only where supported, native agent
  mentions.

The composer keeps its polished inline chips. File chips serialize to native
`@path` text rather than Markdown links, so presentation and provider-facing
syntax remain separate concerns.

## Current Behavior

The current composer has a fixed trigger model:

- `/` mixes T4Code actions, provider commands, and provider agents;
- `$` lists every discovered skill, even when the provider invokes that skill
  with `/` or prose;
- `@` searches only workspace files and folders; and
- selected files are serialized as Markdown links such as
  `[main.ts](src/main.ts)`.

This creates several inconsistencies:

1. T4Code actions occupy the same namespace as provider commands.
2. Agents appear in the slash menu even when the selected provider has no
   inline agent syntax.
3. Skills are discovered through one fixed trigger and translated only after
   selection.
4. File references look polished but no longer use the provider's native
   composer syntax.
5. `ChatComposer` owns provider capability interpretation, search, grouping,
   insertion, and local action execution in one large component.

## Research Basis

The supplied cross-provider trigger report establishes the shared mental model:

- `/` is the common command and skill trigger;
- `@` is the common file-reference trigger; and
- agent invocation is the major provider-specific exception.

The expected defaults are:

| Provider | Commands and skills                                | Agents                                                            | Files   |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| Codex    | `/` commands and `$` skills when reported by Codex | Prose-driven; no synthetic sigil                                  | `@path` |
| Claude   | `/` commands and slash skills                      | Native `/agents` management or prose; no direct synthetic mention | `@path` |
| Cursor   | `/` commands and slash skills                      | Provider mode and agent controls; no synthetic mention            | `@path` |
| OpenCode | `/` commands                                       | `@agent` for mentionable subagents                                | `@path` |
| Grok     | `/` commands and slash skills                      | Native automatic/prose behavior; no synthetic mention             | `@path` |

This table supplies defaults and fixture expectations, not permanent web-client
conditionals. Live normalized provider capability metadata remains the source of
truth because these tools change frequently.

## Design Principles

1. **Trigger ownership is explicit.** T4Code and providers never compete for the
   same menu item.
2. **Provider-native behavior wins.** The UI does not invent agent or skill
   invocation syntax.
3. **Capabilities, not provider names, drive the client.** Provider-specific
   interpretation is normalized at the server boundary.
4. **Presentation is independent from serialization.** A native token may
   render as a rich chip without changing the text sent to the provider.
5. **Unsupported triggers remain ordinary text.** The composer does not open an
   empty or misleading menu for a trigger the active provider does not own.
6. **Draft text remains portable.** No hidden editor-only representation is
   required to send or restore a prompt.
7. **Compatibility is lossless.** Existing Markdown file references continue
   to load and migrate safely.

## Trigger Contract

| Key | Owner                          | Available items                                           | Selection result                           |
| --- | ------------------------------ | --------------------------------------------------------- | ------------------------------------------ |
| `:` | T4Code                         | Local actions such as `:model`, `:plan`, and `:default`   | Execute locally and remove the action text |
| `/` | Selected provider              | Provider commands and skills whose invocation is `slash`  | Insert `/name`                             |
| `$` | Selected provider              | Skills whose invocation is `dollar`                       | Insert `$name`                             |
| `@` | Provider and workspace context | Workspace files plus agents whose invocation is `mention` | Insert `@path` or `@agent`                 |

`:` and `/` are command-style triggers and are recognized only from the start
of the current line while the user is still typing the command name. `$` and
`@` are inline-token triggers and are recognized at whitespace or editor
placeholder boundaries.

An unsupported `/` or `$` expression remains editable prompt text and opens no
menu. `@` remains available whenever the thread has a searchable workspace,
regardless of provider inventory state.

## Architecture

### 1. Provider capability contracts

The existing provider snapshot remains the source for commands, skills, and
agents:

- `ServerProviderSlashCommand` continues to mean native slash invocation.
- `ServerProviderSkill.invocation` continues to support `slash`, `dollar`, and
  `prompt`.
- `ServerProviderAgent` gains optional invocation metadata. The only inline
  value required by this design is `mention`; absent metadata means that the
  agent is not offered through an inline trigger.

The new agent field is optional so legacy snapshots decode unchanged. An agent
without invocation metadata remains visible to provider-specific settings or
mode controls but is excluded from composer autocomplete.

### 2. Provider inventory normalization

Each server driver normalizes upstream data once:

- Codex skill inventory preserves its reported invocation.
- Claude and Cursor skills discovered as slash-invoked remain `slash`.
- OpenCode marks only non-hidden, natively mentionable subagents as
  `invocation: "mention"`.
- Claude, Codex, Cursor, and Grok agents receive no inline invocation unless an
  upstream protocol explicitly reports one.

The provider inventory must not encode web-specific menu groupings. It reports
semantic capability and invocation data only.

Provider commands already present in `slashCommands` retain their `/` syntax,
including driver-supported commands such as `/goal`. T4Code-local actions are
the actions executed entirely by the web client, currently model and
interaction-mode changes.

### 3. Shared trigger detection

Shared composer logic gains a provider-neutral capability profile:

- whether provider slash items exist;
- whether dollar-invoked skills exist; and
- the set of mentionable agent names.

Trigger detection accepts this profile instead of assuming that every sigil is
active. It returns independent trigger kinds for:

- T4Code action;
- provider slash item;
- provider dollar skill; and
- provider reference.

The current cursor clamping, placeholder-boundary support, range replacement,
and `/model`-style line handling remain in shared runtime code. Tests cover
every enabled and disabled combination.

### 4. Composer menu derivation

Capability interpretation and menu-item construction move out of
`ChatComposer` into a focused composer-capability module. That module:

1. derives the active trigger profile from the selected provider snapshot;
2. filters skills and agents by invocation;
3. merges file and mentionable-agent search results for `@`;
4. deduplicates equivalent native invocations;
5. produces stable IDs and semantic groups; and
6. returns the native insertion text for each item.

`ChatComposer` remains responsible for current editor state, invoking workspace
path search, applying the selected replacement, and executing T4Code-local
actions.

`ComposerCommandMenu` renders semantic groups:

- T4Code;
- Commands;
- Skills;
- Files; and
- Agents.

A bare native trigger displays all applicable groups. Filtered results retain
their semantic groups. Files precede agents in an `@` menu because file
references are supported by every provider; an exact mentionable-agent match
may still become the active result.

### 5. Inline editor nodes

The editor separates semantic source text from visual decoration:

- A file node displays the existing file chip.
- Its text content becomes `@path` or `@"path with spaces"` using the existing
  mention-path serializer.
- A new agent node displays an agent-specific chip and serializes as `@name`.
- Dollar-invoked skills retain their skill chip and `$name` serialization.
- Slash commands and slash-invoked skills remain command text because their
  native syntax is intentionally shared.

When a draft is reconstructed, exact names from the selected provider's
mentionable-agent inventory are classified as agents. Every other `@` token is
classified as a file reference. If an agent name and a file path collide, the
exact agent name wins, matching the provider's native mention semantics.

## Interaction Semantics

### T4Code actions

Typing `:` at the start of a line opens a T4Code-only menu. The initial actions
are:

- `:model` — open the response-model picker;
- `:plan` — switch the thread to plan mode; and
- `:default` — switch the thread to normal build mode.

Selecting or submitting an action executes it locally, clears the action text,
closes the menu, and returns focus to the composer. The provider never receives
the colon action.

### Provider slash menu

Typing `/` at the start of a line shows:

1. native provider slash commands; and
2. enabled provider skills whose invocation is `slash`.

Commands and skills use separate headings even when they share the same
trigger. If a command and skill serialize to the same `/name`, normalization
keeps the command and removes the duplicate skill because both would perform
the same provider invocation.

### Provider dollar menu

Typing `$` at an inline-token boundary opens a menu only when the selected
provider has an enabled `dollar` skill. Skills with `slash` or `prompt`
invocation do not appear.

For providers without dollar-invoked skills, `$` behaves as normal prompt text.

### Provider references

Typing `@` searches workspace files. If the provider reports mentionable
agents, the same menu also includes an Agents section.

Selecting a file inserts a native file reference and renders it as the current
polished file chip. Selecting an agent inserts `@name` and renders an agent
chip. Keyboard navigation, filtering, trailing-space handling, and re-entrant
selection protection remain consistent across item types.

### Provider switching

Changing the selected provider recomputes the trigger profile immediately. Any
open menu that is no longer valid closes, its highlight is cleared, and the
typed text remains untouched. A capability refresh preserves the highlighted
item only when its stable ID remains in the refreshed result set.

## Data Flow

1. The server probes the active provider and normalizes commands, skills,
   agents, and invocation metadata.
2. The client receives the provider snapshot through the existing server
   configuration stream.
3. The composer-capability module derives the enabled trigger profile.
4. Shared trigger detection examines the current source text, cursor, and
   profile.
5. The relevant capability inventory and/or workspace path search produces
   grouped menu items.
6. Selection produces native source text.
7. The Lexical editor reconstructs a file, agent, or skill chip when the source
   token has a rich visual representation.
8. The draft store and provider send path retain the native text.

No provider name is required after step 1.

## Compatibility And Migration

The shared inline-token parser continues recognizing existing Markdown file
links. This supports drafts created before the change and avoids altering
historical messages.

Before sending a draft, recognized legacy file-link tokens are canonicalized to
native `@path` tokens. Editing or reserializing a legacy file chip performs the
same canonicalization. Historical transcript content is not rewritten.

Legacy provider snapshots omit agent invocation metadata and therefore expose
no inline agent menu. Existing skill snapshots continue using their decoded
invocation value and existing decoding defaults.

## Error Handling

- A missing or slow provider inventory never blocks `:` actions or `@` file
  search.
- Provider triggers without applicable capabilities open no menu and remain
  ordinary text.
- Path-search failures stay scoped to the Files group and do not hide valid
  mentionable agents.
- Capability refreshes cannot apply a stale highlighted item after the active
  provider changes.
- Replacement validates the expected source range before modifying the prompt,
  retaining the current concurrent-edit safeguard.
- Duplicate native invocations are resolved during normalization, not during
  rendering.
- Invalid or incomplete `@` tokens remain plain text until completed.
- Quoted paths preserve whitespace and escaping through the existing mention
  serializer and parser.

## Automated Test Matrix

### Shared composer runtime

- Detect `:` and `/` only at the start of the current line.
- Detect `$` and `@` at every supported token boundary.
- Gate provider triggers through the capability profile.
- Leave unsupported triggers as ordinary text.
- Preserve cursor clamping, custom placeholder boundaries, mid-prompt
  replacement, quoting, and trailing-space behavior.
- Canonicalize legacy Markdown file links to native mentions.

### Contracts

- Decode old agent snapshots without invocation metadata.
- Decode mentionable-agent metadata.
- Reject unknown invocation values.
- Preserve existing skill invocation compatibility.

### Server provider inventory

- Preserve Codex-reported dollar skill invocation.
- Preserve Claude and Cursor slash skill invocation.
- Mark only non-hidden OpenCode subagents as mentionable.
- Keep Claude, Codex, Cursor, and Grok agents out of inline autocomplete unless
  upstream metadata explicitly enables mentioning.
- Deduplicate command and skill names that serialize to the same slash
  invocation.

### Composer capability module

- Build the correct `:`, `/`, `$`, and `@` groups for every provider fixture.
- Use no provider-name branches in client-side menu derivation.
- Sort and filter each semantic group deterministically.
- Prefer an exact agent match without dropping file results.
- Produce stable IDs and exact native insertion text.
- Close or refresh menus correctly when provider capabilities change.

### Editor and menu components

- Render semantic group headings and glyphs.
- Render files with the existing polished chip and native `@path` text.
- Render mentionable agents with an agent chip and native `@name` text.
- Preserve `$skill` chips.
- Restore native tokens correctly after reload.
- Apply the agent-over-file collision rule.
- Keep keyboard navigation, mouse selection, scroll-to-highlight, empty states,
  and re-entrant selection locks working.

### Integration

- `:model`, `:plan`, and `:default` execute locally and never reach the
  provider.
- `/` sends only native provider command or slash-skill text.
- `$` sends only native dollar-skill text.
- `@` sends native file or agent mentions.
- Switching among provider fixtures changes available triggers without stale
  menus.
- Pending user-input composers use the same trigger and replacement behavior as
  the normal composer.

## Packaged Desktop Acceptance With Computer Use

Automated tests are necessary but not sufficient. Completion requires a
host-native packaged desktop build and a Computer Use pass against the actual
macOS application.

Use the packaged desktop E2E fixture infrastructure and its deterministic
provider shims so every capability profile can be exercised without depending
on the user's installed provider binaries. Extend the fixtures with commands,
slash skills, dollar skills, mentionable agents, and prose-only agents as
needed. The fixtures remain test-only.

The acceptance workflow is:

1. Run `vp check`, `vp run typecheck`, the focused suites, and the relevant full
   test command.
2. Build the host-native packaged desktop application.
3. Launch that local application with an isolated fixture home and disposable
   workspace.
4. Use Computer Use through the prescribed `node_repl` integration to operate
   the real macOS app.
5. For each deterministic provider profile, validate:
   - the `:` menu contains only T4Code actions;
   - each local action executes and clears correctly;
   - `/` contains only native commands and slash skills;
   - `$` contains only dollar skills or opens no menu when unsupported;
   - `@` contains files and only natively mentionable agents;
   - file and agent selections render the expected chips;
   - the underlying mock-provider input contains native `@path`, `@agent`,
     `/name`, or `$name` text;
   - provider switching closes invalid menus and exposes the new native
     triggers;
   - filtering, keyboard navigation, mouse selection, scrolling, and empty
     states behave correctly.
6. Restart the packaged application and confirm native tokens and chips restore
   correctly from persisted drafts.
7. Capture screenshots and accessibility state for the trigger menus and
   restored chips.
8. Record and resolve every difference between expected and observed behavior.

The desktop acceptance pass must use the packaged application, not a browser
preview or Vite development server. Work is not complete until this Computer
Use workflow passes.

## Non-Goals

- Inventing a universal T4Code agent invocation syntax.
- Adding new provider commands, skills, or agents.
- Replacing provider mode or model controls with composer triggers.
- Expanding Cursor's broader context menu beyond workspace files.
- Changing historical transcript rendering.
- Changing shell-command conventions such as a provider-native leading `!`.

## Completion Criteria

- `:` is the only T4Code action trigger.
- Provider commands, skills, and agents appear only under their native trigger.
- The client derives menus from normalized capabilities without provider-name
  conditionals.
- Unsupported triggers remain ordinary prompt text.
- Files display as polished chips and serialize as native `@path`.
- Mentionable agents display as agent chips and serialize as native `@name`.
- Legacy Markdown file references migrate without data loss.
- Automated regression tests pass.
- `vp check` and `vp run typecheck` pass.
- The packaged macOS application passes the complete Computer Use acceptance
  workflow.
