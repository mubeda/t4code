# Provider Defaults UX Stability Design

**Date:** 2026-07-20

## Goal

Make the Providers settings experience stable and predictable while provider
status probes run, and prove that newly created chats, chat panels, and AI
terminals use the latest saved provider defaults.

The completed experience must never make a supported control disappear because
live provider metadata is refreshing. Codex always exposes default model,
default effort, and fast-by-default controls. Claude always exposes default
model and default effort, and retains its fast control when supported. Turning
a provider off disables its controls without changing the panel layout.

## Reproduced Problem

The issue was reproduced in the native macOS application with real provider
CLIs. Enabling or disabling Cursor caused the Codex effort control to disappear
immediately and reappear after the full provider probe completed.

The relevant data flow is:

1. A provider setting is persisted.
2. The server publishes the new settings.
3. The server performs and publishes a quick provider probe.
4. The quick Codex probe intentionally omits slow-discovered models and model
   capabilities.
5. The client replaces the authoritative provider snapshot with the incomplete
   quick snapshot.
6. `ProviderSessionDefaultsControls` derives its shape directly from that
   incomplete model list and conditionally unmounts effort and fast controls.
7. A later full probe restores the rich model metadata, causing the controls to
   reappear.

The same transient provider data is consumed by chat and terminal creation, so
the problem is not safely solved by preserving layout in the settings component
alone.

## Design Principles

1. **Capability shape is stable.** A quick health probe must not erase rich
   model or capability metadata.
2. **Status and capabilities are different concerns.** Installation,
   authentication, version, and enabled state may update quickly without
   degrading model-selection metadata.
3. **Provider invariants do not depend on probe timing.** Codex model, effort,
   and fast mode are always represented. Claude model and effort are always
   represented.
4. **One resolver governs all creation paths.** Settings, new chats, additional
   chat panels, and AI terminal commands interpret defaults identically.
5. **Explicit choices still win.** Existing project/session overrides keep
   precedence over shared provider defaults.
6. **Existing sessions are immutable.** A settings change affects only items
   created after the save completes.

## Architecture

### 1. Preserve rich provider metadata on quick probes

The server already distinguishes quick provider probes from full probes. When a
quick probe publishes a provider snapshot, it will merge volatile health fields
into the current snapshot while retaining last-known rich fields that the quick
probe deliberately does not discover.

Provider inventory will return an internal typed result for each instance:

- the public provider snapshot; and
- a rich-metadata outcome of `not-requested`, `succeeded`, or `failed`.

The outcome is internal server state and does not change the provider wire
contract. Quick probes report `not-requested`. Full probes report `succeeded`
only when that provider's authoritative model/capability discovery completed;
an executable, transport, parsing, or other failure that prevents discovery
reports `failed`. This distinction is explicit rather than inferred from an
empty model or capability array, because an empty array can be a valid
successful result.

Retained fields include:

- models and their option descriptors;
- provider skills;
- provider agents; and
- other slow-discovered capability collections.

Quick probes remain authoritative for enabled state, installation state,
version, authentication, health message, update state, and check time. A
`succeeded` full probe is authoritative for rich capability fields and replaces
them, including with an intentionally empty catalog. A `not-requested` or
`failed` result retains the previous valid rich fields.

This prevents all connected clients—not only the Settings screen—from
temporarily observing a degraded model catalog after a settings write.

### 2. Provide stable built-in capability fallbacks

Last-known metadata cannot help on a first launch, after storage removal, or
when a provider starts disabled and has never completed a full probe. Provider
inventory will therefore supply conservative built-in fallback metadata for
invariant controls:

- **Codex:** default model, effort choices, and fast mode.
- **Claude:** default model and effort choices; fast mode when supported by the
  built-in Claude capability contract.

Fallback descriptors are owned by the provider-specific model modules. Claude
reuses its existing canonical built-in model definitions. Codex gains one
canonical fallback factory that synthesizes the configured/default model with
the stable Codex effort vocabulary and the `default`/`fast` service tiers. A
saved effort not present in the conservative fallback vocabulary is included as
a selectable value so persistence never becomes unrepresentable. React and the
shared TypeScript resolver do not carry a second hard-coded effort table.

Live authoritative model descriptors override the fallback when available.
The fallback is used only to keep supported provider controls and saved values
representable; it does not claim that an unavailable binary is runnable. The
shared resolver still treats Codex effort and fast mode as provider-level
invariants, so malformed or legacy snapshots cannot make their controls vanish.

Codex fast mode is a provider-level invariant. It is persisted using the
canonical Codex service-tier selection, with `fast` for enabled and `default`
for disabled. Its visibility does not depend on whether the selected live model
snapshot happens to advertise the service-tier descriptor.

### 3. Keep provider panels structurally stable

The default-provider panels use a fixed control ordering:

1. Default model
2. Default effort, when the provider supports effort
3. Fast by default, when the provider supports fast mode

Codex always renders all three. Claude always renders model and effort. A
provider toggle changes interactivity but never removes supported controls or
changes panel height.

During an initial metadata load:

- the saved/default model remains visible;
- effort and fast controls remain visible from stable capability metadata;
- provider-owned fallback descriptors keep the controls interactive whenever
  the provider itself is enabled; and
- concise availability text may explain that provider details are refreshing.

Transient quick probes do not trigger the unavailable message because the
last-known model catalog remains present.

## Interaction Semantics

### Provider enable and disable

- Disabling a provider immediately disables model, effort, and fast controls.
- Values and layout remain unchanged.
- Re-enabling the provider immediately restores interaction with the same saved
  values.
- Probe completion may update status text and available model choices but does
  not cause control flicker.

### Model changes

When the user changes the default model:

- the model is persisted immediately through the existing settings update;
- effort choices update in place from the selected model's authoritative or
  fallback descriptor;
- the previous effort is retained when valid for the new model;
- otherwise effort moves to the new model's declared default, or the first
  valid effort when no default is declared;
- fast mode remains selected when the provider continues to support it; and
- the control row never temporarily disappears while the settings write causes
  provider refreshes.

### Effort and fast changes

- Effort is stored using the provider-native option identifier.
- Codex fast mode is stored as its canonical service-tier value.
- Claude fast mode continues to use its native boolean option when available.
- Saving one option preserves the selected model and every other supported
  provider-default option.

### Unavailable or changed models

If a saved model is genuinely absent from a completed authoritative model
catalog, the existing deterministic fallback policy remains:

1. first non-custom model on the selected instance;
2. first model on the selected instance; then
3. built-in provider fallback.

The saved shared setting is not silently rewritten. The settings panel keeps
the saved value visible and explains the runtime fallback.

## Chat And Terminal Propagation

After a settings save completes, every newly created surface resolves defaults
through the shared provider-session selection logic:

- main chat creation;
- worktree chat creation;
- add-project chat creation;
- additional/center chat panels; and
- AI terminal actions.

The resolved model selection includes the provider-native effort and fast-mode
option. AI terminal actions translate that selection only into CLI arguments
that the target provider actually supports. Unsupported flags are omitted.

Existing chats, panels, terminals, and provider processes keep their original
selection. This avoids mutating running sessions behind the user's back.

## Error Handling

- A failed quick probe updates health/status fields but does not erase
  last-known capabilities.
- A full probe whose per-provider rich-metadata outcome is `failed` retains the
  previous valid rich metadata while exposing the failure through status and
  message fields.
- A successful full probe with a changed catalog becomes authoritative and may
  remove retired models or options.
- A provider that has never produced rich metadata uses the built-in fallback
  only for known invariant controls.
- Rapid consecutive settings writes continue to use the existing generation
  checks so stale probes cannot overwrite newer settings or capabilities.

## Automated Test Matrix

### Server provider stream

- Quick Codex snapshots retain existing models and option descriptors.
- Quick snapshots still update status, authentication, enabled state, version,
  and timestamps.
- Per-provider probe results distinguish `not-requested`, `succeeded`, and
  `failed` without inferring success from collection contents.
- A full successful snapshot replaces retained rich metadata, including with a
  valid empty catalog.
- A failed full probe does not erase the last valid rich metadata.
- First-launch and never-probed Codex snapshots contain the provider-owned
  fallback effort and service-tier descriptors.
- Stale quick/full probes remain rejected after newer settings commits.

### Shared resolver

- Codex exposes effort and fast mode with an empty model list.
- Claude exposes effort with an empty model list.
- Codex fast mode maps to `serviceTier=fast/default` without a live descriptor.
- Model changes retain valid effort, default invalid effort, and preserve fast
  mode.
- Saved unavailable models remain unchanged while runtime fallback stays
  deterministic.

### Settings UI

- Codex always renders model, effort, and fast controls.
- Claude always renders model and effort controls.
- Disabling any provider disables its controls without unmounting them.
- Replacing rich models with a transient incomplete snapshot does not change
  the control count, labels, values, or grid structure.
- Switching among models with different effort choices never leaves a blank or
  invalid selection.

### Creation paths

- New main chats use the latest model, effort, and fast mode.
- New worktree and add-project chats use the same values.
- Added chat panels use the same values.
- AI terminal commands contain the correct supported model/effort/fast
  arguments and omit unsupported ones.
- Existing sessions remain unchanged after settings edits.

## Native macOS Verification

Use the current-worktree Tauri application with an isolated `T4CODE_HOME` and
real installed provider CLIs. Record screenshots and accessibility state while
performing the following workflow:

1. Open Providers settings and confirm stable Codex and Claude control rows.
2. Toggle every provider off and on while sampling the UI during quick and full
   probe phases; no supported control may disappear.
3. Trigger repeated manual refreshes; panel geometry and values remain stable.
4. Exercise every available Codex and Claude model transition and each effort
   value, including incompatible-effort fallback.
5. Toggle Codex and Claude fast mode and confirm the values persist after
   closing Settings and after a full application restart.
6. Change defaults, create a new main chat, and verify its visible model,
   effort, and fast mode.
7. Add an AI chat panel and verify the same selection.
8. Launch each supported AI terminal action and inspect the launched command or
   process arguments for the selected model, effort, and fast mapping.
9. Confirm a pre-existing chat remains unchanged throughout.

## Completion Criteria

- No model, effort, or fast control flickers during provider settings changes or
  refreshes.
- Codex always shows model, effort, and fast mode.
- Claude always shows model and effort.
- Disabled providers retain their layout with disabled controls.
- New chats, chat panels, and terminals use the most recently saved defaults.
- Persistence survives a full native application restart.
- Repository gates and focused regression tests pass.
