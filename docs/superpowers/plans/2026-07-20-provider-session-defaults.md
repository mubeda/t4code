# Provider Session Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable per-provider-driver defaults for model, effort, and fast mode; show them once on separate provider panels; and apply the resolved selection to every new chat/session and supported AI terminal launch.

**Architecture:** Store one server-authoritative `providerSessionDefaults` map keyed by `ProviderDriverKind`. Put all capability interpretation, model fallback, option normalization, and UI mutation logic in a pure `@t4code/shared/providerSessionDefaults` module. Keep UI and creation actions thin: they choose a target provider instance, call the resolver, then persist or dispatch the resulting complete `ModelSelection`.

**Tech Stack:** Effect Schema contracts, React 19, Base UI Select/Switch primitives, Zustand composer state, Rust/Serde settings persistence, Vite+ tests, Cargo tests, Tauri 2 desktop.

## Global Constraints

- Follow `/Users/admin/.codex/worktrees/6f54/t4code/AGENTS.md`.
- Before modifying Effect-based schemas, read `.repos/effect-smol/LLMS.md` completely and use the vendored Effect source for API examples.
- Do not edit anything under `.repos/`.
- Preserve provider/instance routing. The resolver selects only model/options after a target instance is known.
- Defaults are shared by driver, never by instance, and controls render only on the built-in/default instance card.
- Explicit creation selection wins, then project default, then shared driver default, then discovered/built-in defaults.
- Existing threads and resumed sessions must not be rewritten.
- Preserve settings atomic-write behavior, provider binary-path precedence, permission flags, and terminal command-bound validation.
- Use structured argument arrays. Do not construct shell command strings or add undocumented CLI flags.
- Follow red-green-refactor for every task: add a focused failing test, run it and observe the intended failure, implement the minimum change, rerun it, then refactor.
- Run `vp check` and `vp run typecheck` before completion. Both must pass.

---

## Task 1: Add the provider-session-defaults settings contract

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/settings.test.ts`

**Interfaces:**

```ts
export const ProviderSessionDefault = Schema.Struct({
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type ProviderSessionDefault = typeof ProviderSessionDefault.Type;

export const ProviderSessionDefaultsMap = Schema.Record(
  ProviderDriverKind,
  ProviderSessionDefault,
);
export type ProviderSessionDefaultsMap = typeof ProviderSessionDefaultsMap.Type;
```

Add `providerSessionDefaults` to `ServerSettings` with an empty decoding default and to
`ServerSettingsPatch` as an optional whole-map replacement:

```ts
providerSessionDefaults: ProviderSessionDefaultsMap.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
),
```

```ts
providerSessionDefaults: Schema.optionalKey(ProviderSessionDefaultsMap),
```

- [ ] Read `.repos/effect-smol/LLMS.md` completely before editing the schema.

- [ ] Add failing tests covering:

  - absent field decodes to `{}` in both `ServerSettings` and `DEFAULT_SERVER_SETTINGS`;
  - known and unknown/open driver slugs decode;
  - canonical options such as `{ id: "reasoningEffort", value: "high" }` and `{ id: "fastMode", value: true }` round-trip;
  - legacy object-shaped options normalize to the canonical array;
  - whitespace is trimmed during encoding;
  - an omitted patch field stays `undefined`;
  - a supplied patch is a complete map value.

- [ ] Run the contract test and verify it fails because the new field/schema does not exist:

```bash
vp test run packages/contracts/src/settings.test.ts
```

Expected red state: assertions for `providerSessionDefaults` fail or TypeScript reports the missing export/field.

- [ ] Implement the two schemas and wire them into `ServerSettings` and `ServerSettingsPatch`. Import `ProviderDriverKind` from `providerInstance.ts`; continue using the existing `ProviderOptionSelections` import.

- [ ] Ensure `DEFAULT_SERVER_SETTINGS` receives `{ providerSessionDefaults: {} }` solely through schema decoding; do not hand-maintain a second default object.

- [ ] Rerun the focused contract test and confirm it passes:

```bash
vp test run packages/contracts/src/settings.test.ts
```

- [ ] Commit the contract slice:

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts
git commit -m "feat(settings): add provider session defaults contract"
```

---

## Task 2: Persist the map through both server settings paths

**Files:**

- Modify: `apps/server/src/server_settings/mod.rs`
- Modify: `apps/server/tests/server_settings_domain.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/tests/production_control.rs` only if the public production-control assertions live there rather than in the module tests

**Rust state:**

```rust
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProviderOptionSelectionValueState {
    String(String),
    Boolean(bool),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptionSelectionState {
    pub id: String,
    pub value: ProviderOptionSelectionValueState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionDefaultState {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ProviderOptionSelectionState>>,
}
```

Add:

```rust
#[serde(default)]
pub provider_session_defaults: BTreeMap<String, ProviderSessionDefaultState>,
```

to `ProviderSettingsState`, and:

```rust
pub provider_session_defaults: Option<BTreeMap<String, ProviderSessionDefaultState>>,
```

to `ServerSettingsPatch`.

- [ ] Add a failing `server_settings_domain` test that:

  1. updates Codex and Claude defaults;
  2. verifies the patch replaces the entire defaults map without changing provider instances or unrelated settings;
  3. reads `settings.json` and checks camelCase JSON;
  4. drops the original store;
  5. constructs a new `ProviderSettingsStore` at the same root and verifies model/options survive.

- [ ] Run the focused integration test and confirm the new state/patch fields are missing:

```bash
cargo test -p t4code-server --test server_settings_domain
```

- [ ] Add the typed state and patch fields, initialize the map in `Default`, and apply it as a whole-map replacement in `apply_patch`.

- [ ] Keep `strip_defaults` unchanged. The empty map should disappear from persisted JSON naturally because it matches the default, while a non-empty map remains.

- [ ] Add failing production-control assertions that:

  - `apply_settings_defaults` adds `"providerSessionDefaults": {}`;
  - `apply_settings_patch` replaces that map as a whole;
  - a patch to the map leaves `providers` and `providerInstances` unchanged;
  - a patch to another field leaves the defaults map unchanged.

- [ ] Run the production-control tests and confirm the default/whole-map assertions fail:

```bash
cargo test -p t4code-server production::control::tests
```

- [ ] Add `"providerSessionDefaults": {}` to the production JSON defaults and include `providerSessionDefaults` beside `providerInstances` in the whole-replacement branch:

```rust
if key == "providerInstances"
    || key == "providerSessionDefaults"
    || key == "automaticGitFetchInterval"
{
    target.insert(key.clone(), value.clone());
    continue;
}
```

- [ ] Rerun both focused Rust test commands and confirm they pass.

- [ ] Commit the server persistence slice:

```bash
git add apps/server/src/server_settings/mod.rs apps/server/tests/server_settings_domain.rs \
  apps/server/src/production/control.rs apps/server/tests/production_control.rs
git commit -m "feat(server): persist provider session defaults"
```

If the production-control assertions remain inside `apps/server/src/production/control.rs`,
omit the unchanged `apps/server/tests/production_control.rs` path from `git add`.

---

## Task 3: Implement the single pure resolver and mutation helpers

**Files:**

- Create: `packages/shared/src/providerSessionDefaults.ts`
- Create: `packages/shared/src/providerSessionDefaults.test.ts`
- Modify: `packages/shared/package.json`

**Public API:**

```ts
export const PROVIDER_SESSION_EFFORT_OPTION_IDS = [
  "reasoningEffort",
  "effort",
  "reasoning",
] as const;

export type ProviderSessionDefaultFallbackReason =
  | "configured-model-unavailable"
  | "models-unavailable";

export interface ProviderSessionDefaultFallback {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly configuredModel: string;
  readonly resolvedModel: string;
  readonly reason: ProviderSessionDefaultFallbackReason;
}

export interface ResolvedProviderSessionDefault {
  readonly modelSelection: ModelSelection;
  readonly effort: string | null;
  readonly fastMode: boolean | null;
  readonly configuredModelAvailable: boolean;
  readonly fallback: ProviderSessionDefaultFallback | null;
}

export interface ProviderSessionDefaultControls {
  readonly configuredModel: string;
  readonly resolvedModel: string;
  readonly modelAvailable: boolean;
  readonly effortDescriptor: SelectProviderOptionDescriptor | null;
  readonly effort: string | null;
  readonly fastModeSupported: boolean;
  readonly fastMode: boolean | null;
}

export type ProviderSessionDefaultChange =
  | { readonly type: "model"; readonly value: string }
  | { readonly type: "effort"; readonly value: string }
  | { readonly type: "fastMode"; readonly value: boolean };

export function resolveProviderSessionDefault(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredDefault?: ProviderSessionDefault | null;
  readonly projectSelection?: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
}): ResolvedProviderSessionDefault;

export function getProviderSessionDefaultControls(input: {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredDefault?: ProviderSessionDefault | null;
}): ProviderSessionDefaultControls;

export function updateProviderSessionDefault(input: {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly current?: ProviderSessionDefault | null;
  readonly change: ProviderSessionDefaultChange;
}): ProviderSessionDefault;
```

- [ ] Add `"./providerSessionDefaults"` to `packages/shared/package.json`:

```json
"./providerSessionDefaults": {
  "types": "./src/providerSessionDefaults.ts",
  "import": "./src/providerSessionDefaults.ts"
}
```

- [ ] Write table-driven failing tests using realistic model fixtures for:

  - Codex `reasoningEffort` plus `serviceTier`;
  - Claude `effort` plus boolean `fastMode`;
  - Cursor `reasoning` plus boolean `fastMode`;
  - OpenCode `variant`/`agent` descriptors that must not become effort;
  - a context-window select that must not become effort.

- [ ] Cover the precedence chain. An explicit or project selection only participates when its `instanceId` matches the target instance; a mismatched selection cannot reroute the resolver.

- [ ] Cover fallback order exactly:

```ts
const fallbackModel =
  models.find((model) => !model.isCustom) ??
  models[0] ??
  null;
```

When no discovered model exists, use
`DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL`. Do not write the fallback back into settings.

- [ ] Cover option normalization:

  - a valid configured value is retained;
  - an invalid effort resolves to the descriptor current/default value;
  - unsupported selections are omitted;
  - `fastMode` maps as a boolean;
  - `serviceTier: "fast"` maps to `true`;
  - Codex fast off maps to `serviceTier: "default"`;
  - model changes preserve compatible values and reset incompatible values.

- [ ] Cover discovery failure: `getProviderSessionDefaultControls` returns the configured model with `modelAvailable: false`, no capability-only controls, and does not mutate the configured value.

- [ ] Run the new test and observe the missing module failure:

```bash
vp test run packages/shared/src/providerSessionDefaults.test.ts
```

- [ ] Implement the module by composing existing helpers from `@t4code/shared/model`:

  - `getProviderOptionDescriptors`;
  - `getProviderOptionCurrentValue`;
  - `buildProviderOptionSelectionsFromDescriptors`;
  - `createModelSelection`;
  - `resolveSelectableModel`.

  Keep model and option processing pure. Build the returned `fallback` object with only driver, instance ID, configured model, resolved model, and reason; never include auth, environment, or credential data.

- [ ] Ensure resolved session selections contain descriptor-compatible options, while `updateProviderSessionDefault` persists only the model and the requested effort/fast provider-native IDs. Do not persist `variant`, `agent`, `thinking`, or `contextWindow` merely because a descriptor has a default.

- [ ] Rerun the shared test and the existing model helper regression suite:

```bash
vp test run \
  packages/shared/src/providerSessionDefaults.test.ts \
  packages/shared/src/model.test.ts
```

- [ ] Commit the resolver slice:

```bash
git add packages/shared/package.json packages/shared/src/providerSessionDefaults.ts \
  packages/shared/src/providerSessionDefaults.test.ts
git commit -m "feat(shared): resolve provider session defaults"
```

---

## Task 4: Build the accessible defaults row

**Files:**

- Create: `apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx`
- Create: `apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx`

**Props:**

```ts
interface ProviderSessionDefaultsControlsProps {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly value: ProviderSessionDefault | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderSessionDefault) => void;
}
```

- [ ] Write failing component tests that render a capability-rich model and assert:

  - labels “Default model”, “Default effort”, and “Fast by default”;
  - controls render in model/effort/fast order;
  - all controls receive disabled state when `disabled` is true;
  - effort and fast controls disappear when unsupported;
  - `variant`, `agent`, and `contextWindow` do not render as effort;
  - a saved missing model remains visible, disabled, with an unavailable/fallback message;
  - model, effort, and fast events call `onChange` with provider-native option IDs.

- [ ] Run the test and observe the missing component failure:

```bash
vp test run apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx
```

- [ ] Implement the component with existing primitives from:

  - `apps/web/src/components/ui/select.tsx`;
  - `apps/web/src/components/ui/switch.tsx`.

  Use the pure shared functions rather than reinterpreting descriptors in JSX.

- [ ] Use an always-visible, responsive one-row layout:

```tsx
<div
  className="grid gap-3 pt-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-end"
  data-testid="provider-session-defaults"
>
  {/* model, effort, fast in this order */}
</div>
```

Each control must have an explicit visible `<label>` or equivalent accessible association. The fast switch must have `aria-label="Fast by default"`.

- [ ] When models are temporarily empty or the configured slug is absent:

  - show the saved slug in the model control;
  - disable that select even if the provider itself is enabled;
  - render concise text such as `Unavailable here; new sessions will use <fallback>.`;
  - do not call `onChange` on render.

- [ ] Rerun the component test and confirm it passes.

- [ ] Commit the control slice:

```bash
git add apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx \
  apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx
git commit -m "feat(web): add provider defaults controls"
```

---

## Task 5: Render separate provider panels and persist edits once per driver

**Files:**

- Modify: `apps/web/src/components/settings/settingsLayout.tsx`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.tsx`
- Modify: `apps/web/src/components/settings/ProviderInstanceCard.test.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx`

**Layout API:**

```ts
export function SettingsSection(
  props: ComponentPropsWithoutRef<"section"> & {
    title: string;
    icon?: ReactNode;
    headerAction?: ReactNode;
    children: ReactNode;
    contentVariant?: "card" | "stack";
  },
)
```

The default remains `"card"` for every other settings section. `"stack"` renders
`<div className="grid gap-3">{children}</div>` with no surrounding card chrome.

Add to `ProviderInstanceCardProps`:

```ts
readonly sessionDefaults?: ProviderSessionDefault | undefined;
readonly onSessionDefaultsChange?: ((next: ProviderSessionDefault) => void) | undefined;
```

- [ ] Extend the mocked-card tests in `SettingsPanels.test.tsx` first. Assert that:

  - `SettingsSection` receives `contentVariant="stack"`;
  - only default rows receive `onSessionDefaultsChange`;
  - a custom instance of the same driver receives neither defaults props nor controls;
  - updating Codex defaults replaces only the `codex` map entry and preserves Claude/unknown entries;
  - the controls are disabled through the card when its instance is disabled.

- [ ] Extend `ProviderInstanceCard.test.tsx` first. Assert that the defaults node is:

  - after the auth/status text in DOM order;
  - before/outside `CollapsibleContent`;
  - absent when the callback is omitted;
  - passed `disabled={!enabled}`.

- [ ] Run the two tests and observe the missing props/layout behavior:

```bash
vp test run \
  apps/web/src/components/settings/ProviderInstanceCard.test.tsx \
  apps/web/src/components/settings/SettingsPanels.test.tsx
```

- [ ] Add `contentVariant` to `SettingsSection` without changing the default rendering/classes used by other settings pages.

- [ ] Change the card root from the current divider row:

```tsx
<div className="border-t border-border/60 first:border-t-0">
```

to an independent panel using the same rounded-card visual language:

```tsx
<div className="relative overflow-visible rounded-2xl border bg-card text-card-foreground shadow-sm/4">
```

Keep internal advanced-section dividers.

- [ ] Render `ProviderSessionDefaultsControls` immediately after `authRowNode` in the always-visible left header column and before the collapsible. Pass `modelsForDisplay`, `instance.driver`, and `disabled={!enabled}`.

- [ ] In `ProviderSettingsPanel`, compute the whole-map update without mutating existing settings:

```ts
const updateSessionDefaults = (
  driver: ProviderDriverKind,
  next: ProviderSessionDefault,
) => {
  updateSettings({
    providerSessionDefaults: {
      ...settings.providerSessionDefaults,
      [driver]: next,
    },
  });
};
```

Pass these props only when `row.isDefault` is true. Leave defaults untouched when enabling/disabling, resetting, or deleting provider instances.

- [ ] Do not add a success message. Let the existing optimistic settings command and error/toast path handle rejection and rollback.

- [ ] Rerun both focused tests and confirm they pass.

- [ ] Run the settings contract/UI regression group:

```bash
vp test run \
  packages/contracts/src/settings.test.ts \
  apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx \
  apps/web/src/components/settings/ProviderInstanceCard.test.tsx \
  apps/web/src/components/settings/SettingsPanels.test.tsx
```

- [ ] Commit the settings UI slice:

```bash
git add apps/web/src/components/settings/settingsLayout.tsx \
  apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx \
  apps/web/src/components/settings/ProviderInstanceCard.tsx \
  apps/web/src/components/settings/ProviderInstanceCard.test.tsx \
  apps/web/src/components/settings/SettingsPanels.tsx \
  apps/web/src/components/settings/SettingsPanels.test.tsx
git commit -m "feat(web): separate provider panels and edit defaults"
```

---

## Task 6: Seed every fresh standard/worktree draft from resolved defaults

**Files:**

- Modify: `apps/web/src/hooks/useHandleNewThread.ts`
- Modify: `apps/web/src/hooks/useHandleNewThread.test.tsx`
- Modify: `apps/web/src/composerDraftStore.test.ts` only if a new narrow store action is required

**Selection rule for a new draft:**

```ts
const targetInstanceId =
  project?.defaultModelSelection?.instanceId ??
  stickyActiveProvider ??
  defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
```

Find the matching target provider in the selected environment’s
`ServerConfig.providers`. Use its `driver` and `models`; if discovery has not
produced an entry, derive the driver from the matching configured instance or
the built-in instance ID.

- [ ] Add failing hook tests for:

  - a normal new draft gets the configured model, effort, and fast mode;
  - the same happens with `envMode: "worktree"`;
  - project `defaultModelSelection` wins and retains all explicit options;
  - a sticky active provider continues choosing the provider instance, but its sticky model/options do not override current shared defaults;
  - a cross-instance configured model missing from the target instance falls back to its first non-custom model without changing settings;
  - reusing an already-created draft does not reseed or overwrite its current model/options;
  - an existing server thread remains unchanged.

- [ ] Run the hook test and verify the current `applyStickyState` behavior fails the new expectations:

```bash
vp test run apps/web/src/hooks/useHandleNewThread.test.tsx
```

- [ ] In `useNewThreadHandler`, destructure `stickyActiveProvider` and `setModelSelection` from the store state. For only the newly allocated `draftId` path:

  1. keep the current target-provider routing precedence;
  2. call `resolveProviderSessionDefault`;
  3. call `setModelSelection(draftId, resolution.modelSelection)`;
  4. do not call `applyStickyState(draftId)`.

  The existing reuse/active-draft return paths must remain untouched.

- [ ] If fallback occurred, emit one safe structured diagnostic at the creation boundary:

```ts
console.warn("Provider session default fallback", resolution.fallback);
```

The fallback object is intentionally credential-free.

- [ ] Ensure the hook callback dependency list includes the provider/config inputs used by the resolver.

- [ ] Rerun the hook test and the relevant composer-store tests:

```bash
vp test run \
  apps/web/src/hooks/useHandleNewThread.test.tsx \
  apps/web/src/composerDraftStore.test.ts
```

- [ ] Commit the new-draft slice:

```bash
git add apps/web/src/hooks/useHandleNewThread.ts \
  apps/web/src/hooks/useHandleNewThread.test.tsx \
  apps/web/src/composerDraftStore.test.ts
git commit -m "feat(web): seed new drafts from provider defaults"
```

---

## Task 7: Pass the complete resolved selection into center Chat panels

**Files:**

- Modify: `apps/web/src/centerPanelActions.ts`
- Modify: `apps/web/src/centerPanelActions.test.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`

**Replace the panel action input:**

```ts
export interface CreateChatPanelInput {
  readonly hostRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly modelSelection: ModelSelection;
  readonly providerLabel: string;
}
```

- [ ] First update tests so `createChatPanel` receives and forwards a full selection:

```ts
modelSelection: {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "fast" },
  ],
},
```

Assert `threadEnvironment.create` receives that exact value without reconstructing it.

- [ ] Add/adjust `ChatView.hooks.test.tsx` assertions for:

  - configured model/options instead of `entry.models[0]`;
  - target-instance fallback;
  - model-discovery-empty built-in fallback;
  - copied project/worktree/branch remains unchanged.

- [ ] Run the focused tests and observe the old `instanceId`/`model` interface failures:

```bash
vp test run \
  apps/web/src/centerPanelActions.test.ts \
  apps/web/src/components/ChatView.hooks.test.tsx
```

- [ ] Make `useCenterPanelActions` a dumb dispatcher: destructure `modelSelection` from input and pass it directly to the create command. Remove `DEFAULT_MODEL`, `ProviderInstanceId`, and `createModelSelection` imports that are no longer needed.

- [ ] In `ChatView.handleCreateChatPanel`, resolve against:

  - `entry.driverKind`;
  - `entry.instanceId`;
  - `entry.models`;
  - `settings.providerSessionDefaults[entry.driverKind]`;
  - any genuinely explicit project selection only when it targets the entry instance.

  Pass `resolution.modelSelection` to `createChatPanel`, and emit the safe fallback diagnostic at this event boundary.

- [ ] Rerun both tests and confirm they pass.

- [ ] Commit the center-panel slice:

```bash
git add apps/web/src/centerPanelActions.ts apps/web/src/centerPanelActions.test.ts \
  apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "feat(web): apply provider defaults to chat panels"
```

---

## Task 8: Append supported defaults to AI terminal actions

**Files:**

- Modify: `apps/web/src/components/chat/providerTerminalActions.ts`
- Modify: `apps/web/src/components/chat/providerTerminalActions.test.ts`
- Modify: `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx` only if its narrowed settings prop must be widened
- Modify: `apps/web/src/components/ChatView.tsx` only if the call site’s memo dependencies/types need adjustment

**Settings input:**

```ts
settings: Pick<
  ServerSettings,
  "providerInstances" | "providers" | "providerSessionDefaults"
>
```

**Verified argument mappings:**

```ts
// Codex
[
  "--dangerously-bypass-approvals-and-sandbox",
  "--model",
  model,
  "--config",
  `model_reasoning_effort="${effort}"`,
  "--config",
  `service_tier="${fastMode ? "fast" : "default"}"`,
]

// Claude
["--dangerously-skip-permissions", "--model", model, "--effort", effort]

// Cursor
["--yolo", "--model", `${baseModel}[effort=${effort},fast=${String(fastMode)}]`]

// Grok
["--permission-mode", "bypassPermissions", "--model", model, "--effort", effort]

// OpenCode
["--model", model]
```

Omit optional fragments when the resolved model does not support them. Claude
and Grok omit fast mode; OpenCode omits effort and fast mode.

- [ ] Write failing table tests for exact executable/argument arrays for all five built-in drivers. Use model capability fixtures, not hand-passed traits, so the tests exercise the shared resolver.

- [ ] Add tests for:

  - Codex explicit `service_tier="default"` when fast is off;
  - Claude fast selection omitted from CLI args;
  - Cursor produces exactly one parameterized model argument;
  - Cursor strips an existing terminal parameter suffix before appending resolved parameters;
  - Grok and OpenCode omit unsupported values;
  - stale effort/fast values are omitted after model fallback;
  - instance path, legacy path, permission flags, labels, and unknown-driver behavior stay unchanged;
  - added arguments still trigger the existing bounds-disabled result.

- [ ] Run the terminal test and observe that current commands contain only permission args:

```bash
vp test run apps/web/src/components/chat/providerTerminalActions.test.ts
```

- [ ] Refactor each `DEFINITIONS` entry to keep only executable and immutable permission args. Add a pure driver argument builder that accepts the resolver result.

- [ ] For Cursor, remove only a trailing parameter block:

```ts
const baseModel = model.replace(/\[[^\]]*\]$/, "");
const parameters = [
  effort === null ? null : `effort=${effort}`,
  fastMode === null ? null : `fast=${String(fastMode)}`,
].filter((value): value is string => value !== null);
const cursorModel =
  parameters.length === 0 ? baseModel : `${baseModel}[${parameters.join(",")}]`;
```

- [ ] Append defaults after permission arguments, then pass the complete object through `decodeTerminalLaunchCommand` exactly once. Never shell-quote the entire argument vector.

- [ ] Widen the settings `Pick` through `ChatHeaderPanelMenu`/`ChatHeader` so the action can read the durable defaults. Do not add another state source.

- [ ] Rerun terminal and header/chat regression tests:

```bash
vp test run \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/components/ChatView.hooks.test.tsx
```

- [ ] Commit the terminal slice:

```bash
git add apps/web/src/components/chat/providerTerminalActions.ts \
  apps/web/src/components/chat/providerTerminalActions.test.ts \
  apps/web/src/components/chat/ChatHeaderPanelMenu.tsx \
  apps/web/src/components/chat/ChatHeader.tsx \
  apps/web/src/components/ChatView.tsx
git commit -m "feat(web): pass provider defaults to AI terminals"
```

Stage only files actually modified.

---

## Task 9: Prove first-turn behavior and persistence regressions end to end

**Files:**

- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/hooks/useHandleNewThread.test.tsx`
- Modify: `apps/server/tests/server_settings_domain.rs`
- Modify another existing first-turn integration test only if the asserted dispatch lives in a more specific file discovered during implementation

- [ ] Add a failing first-turn regression test that starts from a newly seeded draft, changes no composer fields, promotes/creates the thread, and asserts the server create/send input contains the same full `ModelSelection`.

- [ ] Add a companion test that changes model/effort/fast in the draft before the first turn and asserts the explicit draft selection wins.

- [ ] Add an existing-thread regression asserting a saved thread selection is unchanged after updating `providerSessionDefaults`.

- [ ] Run the narrow tests and observe any missing propagation:

```bash
vp test run \
  apps/web/src/hooks/useHandleNewThread.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx
```

- [ ] If a propagation gap appears, fix it at the narrowest boundary by passing the existing full draft `ModelSelection`; do not add a second resolver inside follow-up-turn dispatch.

- [ ] Reconfirm the Rust close/reopen test uses a newly constructed store instance and not the same in-memory object.

- [ ] Run all feature-focused automated tests:

```bash
vp test run \
  packages/contracts/src/settings.test.ts \
  packages/shared/src/model.test.ts \
  packages/shared/src/providerSessionDefaults.test.ts \
  apps/web/src/components/settings/ProviderSessionDefaultsControls.test.tsx \
  apps/web/src/components/settings/ProviderInstanceCard.test.tsx \
  apps/web/src/components/settings/SettingsPanels.test.tsx \
  apps/web/src/hooks/useHandleNewThread.test.tsx \
  apps/web/src/composerDraftStore.test.ts \
  apps/web/src/centerPanelActions.test.ts \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/chat/providerTerminalActions.test.ts
```

```bash
cargo test -p t4code-server --test server_settings_domain
cargo test -p t4code-server production::control::tests
```

- [ ] Commit any final propagation/regression changes:

```bash
git add apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/hooks/useHandleNewThread.test.tsx \
  apps/server/tests/server_settings_domain.rs
git commit -m "test: cover provider default session propagation"
```

Stage additional implementation files only if this task required a narrowly scoped fix.

---

## Task 10: Repository verification and macOS visual/behavioral QA

**Files:**

- No planned source changes. If QA exposes a defect, return to the owning task and repeat red-green-refactor before continuing.

- [ ] Inspect `git status --short` and `git diff --check`. Preserve unrelated user changes.

- [ ] Run the repository-required checks:

```bash
vp check
vp run typecheck
```

Expected: both exit successfully with no errors.

- [ ] Run the built-in repository test command required by `AGENTS.md`:

```bash
vp test
```

Expected: all discovered Vite+ suites pass.

- [ ] Run the server package test suite because the feature changes Rust persistence:

```bash
vp run --filter t4code test
```

Expected: Cargo tests pass.

- [ ] Before controlling the macOS application, announce the unrequested `computer-use` skill, explain that it is required for the user-requested visual verification, and read its `SKILL.md` completely.

- [ ] Launch the current worktree’s Tauri desktop app with a unique development instance so it cannot attach to an unrelated running build:

```bash
T4CODE_DEV_INSTANCE=provider-session-defaults vp run dev:desktop
```

Keep the process running in a PTY and poll it in intervals shorter than 60 seconds while it builds.

- [ ] Use macOS computer control—not browser-only inspection—to open the resulting **T4Code (Alpha)** window and perform this exact walkthrough:

  1. Open **Settings → Providers**.
  2. Confirm each provider is an independent rounded panel with visible spacing.
  3. Confirm the defaults row appears only on each driver’s built-in/default panel, directly below authentication/status and while details are collapsed.
  4. Confirm model, effort, and fast controls stay in one row at normal desktop width.
  5. Disable a provider; confirm defaults controls disable while the provider enable switch remains usable.
  6. Re-enable it; choose a capability-rich model, a non-default effort, and fast mode.
  7. Close and reopen Settings; confirm the values remain.
  8. Create a disposable normal chat and confirm its composer selection matches.
  9. Create a disposable center Chat panel and confirm it starts with the same model/options.
  10. Open that provider’s AI terminal panel and inspect the visible structured launch/session behavior; confirm supported CLI defaults are applied and unsupported flags are absent.
  11. Quit T4Code completely, relaunch the same development instance, and confirm the saved defaults remain.
  12. Create another disposable chat and confirm the persisted defaults apply after relaunch.
  13. Choose a model without effort or fast support and confirm unsupported controls disappear and the new chat omits them.

- [ ] Capture screenshots after steps 3, 5, 9, and 11. Inspect them at full resolution. Keep the best evidence outside ignored temporary build output if the project has an established artifact location; otherwise report their temporary absolute paths without committing them.

- [ ] Remove disposable chats/panels where practical. Restore only settings changed for the walkthrough; do not alter credentials, environment variables, or binary paths.

- [ ] Stop the development PTY cleanly.

- [ ] Perform the final self-review:

  - compare the implementation against every Goals, Failure Handling, Testing, and macOS Desktop Verification item in `docs/superpowers/specs/2026-07-20-provider-session-defaults-design.md`;
  - search for placeholders:

```bash
rg -n "TODO|FIXME|placeholder|not implemented" \
  packages/shared/src/providerSessionDefaults.ts \
  apps/web/src/components/settings/ProviderSessionDefaultsControls.tsx \
  apps/web/src/components/chat/providerTerminalActions.ts
```

  - inspect `git diff --stat` and `git status --short`;
  - rerun `vp check` and `vp run typecheck` after any QA fix.

- [ ] Invoke `superpowers:verification-before-completion`, follow it completely, and record the fresh command outputs used for the completion claim.

- [ ] Invoke `superpowers:requesting-code-review` for a final review of spec coverage, persistence safety, fallback correctness, and terminal argument construction. Address any actionable findings with tests.

- [ ] Commit final QA-driven fixes, if any, with a focused message. Do not create a merge commit or pull request unless the user separately requests it.

## Completion Evidence

The final handoff must include:

- the implemented settings and resolver behavior;
- the exact automated verification commands and pass results;
- macOS walkthrough results and screenshot paths;
- any driver-specific terminal omissions, especially Claude/Grok fast mode and OpenCode effort/fast mode;
- confirmation that close/reopen persistence was exercised;
- confirmation that existing threads were not modified;
- the final commit(s) and clean/known worktree status.
