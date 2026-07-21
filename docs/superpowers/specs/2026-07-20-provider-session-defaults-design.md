# Provider Session Defaults Design

**Date:** 2026-07-20

## Summary

Add one shared set of session defaults per provider driver:

- default model;
- default reasoning effort, when the selected model supports it; and
- default fast mode, when the selected model supports it.

The defaults apply to every configured instance of that driver. For example,
`codex`, `codex_personal`, and `codex_work` all use the same Codex defaults.
Only the built-in/default instance panel renders the controls, avoiding
duplicated synchronized controls on custom instance panels.

Every newly created chat or provider session uses the resolved defaults unless
the creation flow supplies an explicit model selection. Existing threads retain
their persisted selections. Provider terminal actions append equivalent CLI
arguments only where the target CLI supports them.

## Goals

- Separate provider rows into individual rounded panels.
- Keep the default controls directly below the authentication/status message in
  one row.
- Disable all default controls while the provider is disabled.
- Derive effort and fast-mode support from the selected model's capabilities.
- Persist the shared defaults in server settings across application restarts.
- Resolve shared driver defaults safely against each target provider instance.
- Use the same resolution logic for every new chat/session entry point.
- Propagate supported defaults into structured AI terminal launch arguments.
- Preserve predictable behavior during provider discovery failures, upgrades,
  and model-list differences between instances.

## Non-Goals

- Changing the default provider selected for a new draft.
- Updating existing threads when a provider default changes.
- Making provider defaults instance-specific.
- Adding controls for context window, agent, thinking, or arbitrary provider
  options.
- Adding undocumented terminal flags or injecting initial slash commands into a
  provider terminal.
- Changing provider credentials, binary-path precedence, permission modes, or
  terminal process supervision.

## Settings Model

Add a server-authoritative `providerSessionDefaults` map keyed by the open
`ProviderDriverKind` slug:

```ts
interface ProviderSessionDefaults {
  readonly model: string;
  readonly options?: ReadonlyArray<{
    readonly id: string;
    readonly value: string | boolean;
  }>;
}

type ProviderSessionDefaultsMap = Readonly<
  Record<ProviderDriverKind, ProviderSessionDefaults>
>;
```

The actual contract uses the existing trimmed model schema and
`ProviderOptionSelections`. Options retain provider-native descriptor IDs:

- Codex reasoning uses `reasoningEffort`.
- Claude reasoning uses `effort`.
- Cursor reasoning uses `reasoning`.
- Boolean fast mode uses `fastMode`.
- Codex fast mode uses `serviceTier`, with `fast` and `default` values.

Storing provider-native option selections keeps the settings compatible with
the existing `ModelSelection` dispatch contract and avoids a second translation
format. UI helpers expose the three requested concepts without making the
persisted schema depend on one provider's names.

An absent driver entry means "use the currently discovered provider defaults."
This preserves current behavior for existing settings files and lets newly
installed or unknown provider drivers work without migration data.

`ServerSettings`, `ServerSettingsPatch`, Rust server-settings state, patch
decoding, default stripping, and JSON encoding gain the corresponding map. The
map is small and is replaced as a whole, following the current
`providerInstances` update pattern. The settings store continues serializing
writes under its existing lock and writing `settings.json` atomically.

The map is server-owned rather than a client-only preference so local desktop,
browser, remote-environment, session creation, and provider-terminal paths all
observe the same durable value.

## Shared Default Resolver

A focused shared runtime module owns provider-default interpretation. It
accepts:

- the selected provider driver;
- the target provider instance;
- current server settings;
- the target instance's discovered model list; and
- an optional explicit creation-time selection.

It returns a complete `ModelSelection` containing the target `instanceId`, a
supported model, and compatible provider option selections.

Resolution precedence is:

1. a model/options selection explicitly supplied by the creation flow;
2. an explicit project default;
3. `providerSessionDefaults[driver]`;
4. the target instance's discovered model and option defaults.

The resolver does not choose the provider driver or instance. Existing routing
rules continue selecting those values; this feature selects the model and the
two requested traits after the target is known.

### Cross-instance fallback

Provider instances of the same driver may expose different models. The resolver
uses the shared configured model when the target instance contains it.
Otherwise it chooses:

1. the first non-custom model reported by that instance;
2. the first reported model; or
3. the existing built-in fallback for that provider driver.

This fallback applies to that launch only. It does not rewrite the saved shared
default.

After resolving the model, the resolver overlays saved option values onto that
model's capability descriptors. It keeps values that are valid for the
descriptor and derives the descriptor's current/default value for missing or
invalid values. Options not supported by the resolved model are omitted from
the returned `ModelSelection`.

Fast mode is normalized as follows:

- a `fastMode` boolean descriptor receives the saved boolean value;
- a Codex `serviceTier` descriptor receives `fast` when enabled and `default`
  when disabled;
- no fast option is emitted when the resolved model exposes neither form.

Reasoning effort is recognized only for the descriptor IDs
`reasoningEffort`, `effort`, and `reasoning`. Other select descriptors such as
`variant`, `agent`, and `contextWindow` are not presented as effort.

## Provider Settings UI

The Providers settings section no longer places every instance inside one
continuous outer card. Each `ProviderInstanceCard` renders as an independent
rounded panel with vertical spacing. The section heading, add-instance action,
last-checked label, and refresh action remain unchanged.

The default controls render only when
`instanceId === defaultInstanceIdForDriver(driver)`. Custom instance panels keep
their existing display-name, accent, environment, binary/config, and custom
model controls but do not repeat the shared defaults.

The defaults row is part of the always-visible card header:

1. provider name, version, status, detail toggle, and enable switch;
2. authentication/status message;
3. default model, effort, and fast-mode controls in one row.

The controls remain visible when advanced provider details are collapsed.
Desktop widths use a model-first three-column row. Narrow widths wrap the same
controls in the same order.

### Control visibility and enablement

- **Default model** appears when the default instance has discovered or
  configured model choices.
- **Default effort** appears only when the selected model exposes a recognized
  reasoning descriptor.
- **Fast mode** appears only when the selected model exposes `fastMode` or a
  Codex `serviceTier` containing `fast`.
- All rendered controls are disabled when the provider is disabled.
- The provider enable switch remains enabled so the provider can be restored.

If the provider is enabled but model discovery is temporarily unavailable, the
saved model remains visible in a disabled control with a concise unavailable
message. Transient discovery failure does not clear or overwrite settings.

Changing the model recomputes the effort and fast controls from the new model's
capabilities. A currently selected value is preserved when valid for the new
model. Unsupported values reset to the new model's discovered default in the
resolved settings update.

All controls use accessible labels and the existing keyboard-accessible Select
and Switch primitives.

## New Chat and Session Behavior

Every entry point that creates a new chat thread, draft, panel, or provider
session must use the shared resolver instead of independently choosing the
first model or a hardcoded global model.

The affected behavior includes:

- a fresh standard chat draft;
- a newly created worktree chat;
- a center Chat panel opened from the header `+` menu;
- any other new-thread path without an explicit model selection; and
- first provider-session startup for those new threads.

Creation flows that intentionally carry a model selection continue to do so.
Examples include a user choice made in a creation dialog, an explicit project
default, and "implement in a new thread" copying the source thread's selection.
Those are explicit selections and take precedence.

Center Chat panels currently select `entry.models[0]` and create a
model-only selection. They instead resolve and pass the complete shared
selection, including effort and fast mode.

A newly created draft is seeded from the selected provider's shared defaults.
A user may change model, effort, or fast mode before the first turn; that draft
selection then becomes explicit for thread creation. Existing persisted
threads, resumed sessions, reconnects, and follow-up turns continue using the
thread's saved `ModelSelection`.

Legacy cross-draft sticky model state does not override provider defaults when
a brand-new draft is created. It may continue preserving choices within an
already-created draft, but the next newly created chat starts from the current
shared provider defaults.

## Provider Terminal Actions

Provider terminal commands remain structured executable/argument vectors.
Defaults are appended only after resolving them against the selected instance
and model. Existing executable precedence and full-access permission arguments
remain unchanged.

The verified mappings are:

| Driver | Model | Effort | Fast mode |
| --- | --- | --- | --- |
| Codex | `--model <model>` | `--config model_reasoning_effort="<effort>"` | `--config service_tier="fast"` or `"default"` |
| Claude | `--model <model>` | `--effort <effort>` | No current launch flag |
| Cursor | Parameterized `--model` | `[effort=<effort>]` | `[fast=true\|false]` |
| Grok | `--model <model>` | `--effort <effort>` | No documented launch flag |
| OpenCode | `--model <model>` | Not supported | Not supported |

Codex mappings were accepted by the installed `codex-cli 0.144.6` under
`--strict-config`. Claude, Cursor, and OpenCode mappings come from their
installed CLI help. Grok model and effort flags are documented in the
[official Grok CLI reference](https://docs.x.ai/build/cli/reference).

Cursor builds one parameterized model argument, for example:

```text
--model claude-opus-4-8[effort=high,fast=true]
```

The builder starts from the base model ID, adds only supported resolved
parameters, and produces one argument without shell quoting or interpolation.

Claude's internal T4Code session may still receive a supported `fastMode`
selection through the provider protocol. The AI terminal action omits fast mode
because the installed Claude CLI exposes no startup flag for it. The same rule
applies to Grok fast mode and unsupported OpenCode traits.

If a driver has no verified mapping for a resolved value, the terminal builder
omits that value rather than guessing a flag or injecting a command. Unknown
drivers retain their current terminal definition behavior.

The completed command still passes through `TerminalLaunchCommand` validation.
If added arguments exceed existing bounds, the action remains visible but
disabled with the existing command-bounds explanation.

## Failure Handling

Saved preferences are durable intent, not a cache of the latest provider probe.
The application therefore does not erase them when:

- a provider is disabled;
- authentication expires;
- an executable is missing;
- model discovery fails;
- a model temporarily disappears; or
- an instance exposes a narrower model list.

The resolver filters or falls back for one launch and emits structured
diagnostic context containing the driver, instance, saved model, resolved model,
and fallback reason. Diagnostics must not contain credentials, environment
values, or authentication details.

The UI warns when the default instance cannot currently use the saved model.
The warning reports the fallback model without automatically persisting it.

Settings-write failures use the existing settings error/toast path. The UI must
not claim that a new default was saved when the server rejects the update.

Terminal spawn failures retain the existing behavior: the center terminal stays
open, displays the structured spawn failure, and does not fall back to a shell.

## Testing

### Contracts and persistence

- `ServerSettings` and patch schemas decode an absent defaults map as empty.
- Canonical model/option selections encode and decode for known and unknown
  driver slugs.
- Rust settings patches replace only the defaults map requested by the update.
- `settings.json` survives a write/read cycle and a new store instance,
  representing application close and reopen.
- Default stripping and unrelated provider settings remain unchanged.
- Malformed settings fail through the existing structured settings error path.

### Resolver

- Configured model and valid effort/fast values resolve unchanged.
- Explicit creation and project selections take precedence.
- A missing model falls back deterministically for each target instance.
- A cross-instance fallback does not mutate the saved shared value.
- Invalid effort resets to the selected model's discovered default.
- Unsupported fast mode is omitted.
- Boolean fast mode and Codex service-tier fast mode map correctly.
- `variant`, `agent`, and `contextWindow` are never mistaken for effort.
- Disabled or temporarily unavailable providers preserve stored defaults.

### Web UI

- Provider instances render as separate rounded panels.
- Only the default instance panel renders the shared defaults row.
- Controls appear below authentication/status and outside the advanced
  collapsible content.
- Provider disablement disables all default controls but not the enable switch.
- Effort and fast controls follow selected-model capabilities.
- Model changes preserve compatible values and reset incompatible ones.
- Missing discovery retains the saved display value and shows an unavailable
  state.
- Keyboard and accessible labels work for each control.

### Chat/session creation

- Standard drafts are seeded from the selected provider's shared defaults.
- Cross-draft sticky model state does not override a brand-new draft's shared
  provider defaults.
- Center Chat panels receive the resolved model and options instead of the first
  model.
- Worktree-created chats use the resolver when no explicit selection exists.
- Explicit creation/project selections win.
- Existing and resumed threads retain their persisted selections.
- First-turn dispatch carries the same full `ModelSelection` stored on the new
  thread.

### Provider terminal actions

- Exact executable/argument vectors are covered for every built-in driver.
- Codex emits model, effort, and explicit fast/default service tier.
- Claude emits model and effort but no fast argument.
- Cursor emits one correctly parameterized model argument.
- Grok emits supported model and effort arguments.
- OpenCode emits only its supported model argument.
- Unsupported or stale values are omitted.
- Existing permission arguments and binary-path precedence are preserved.
- Oversized resolved commands use the existing disabled-state explanation.

### Required repository verification

- Targeted contract, web, server-settings, chat-panel, and terminal-action
  tests.
- `vp test` for the relevant built-in Vite+ suites.
- `vp check`.
- `vp run typecheck`.

## macOS Desktop Verification

After automated verification passes, launch the current T4Code macOS
application through its normal desktop UI and perform this walkthrough:

1. Open **Settings → Providers** and confirm providers render as separate
   panels.
2. Verify defaults appear only on each driver's default panel and sit directly
   below authentication/status.
3. Disable a provider and confirm the three defaults controls disable while the
   provider switch remains usable.
4. Re-enable the provider, select a model, effort, and fast mode supported by
   that model, and close Settings.
5. Create a normal new chat for that provider and verify the composer/thread
   selection matches.
6. Create a center Chat panel and verify it starts with the same full selection.
7. Open the provider's AI terminal action and verify supported CLI defaults are
   present in the structured launch command and unsupported ones are absent.
8. Quit T4Code completely, reopen it, and confirm the provider defaults remain.
9. Create another new chat after relaunch and verify it uses the persisted
   values.
10. Change to a model that lacks effort or fast mode and confirm the unsupported
    controls disappear and the created chat omits those options.

The walkthrough must use disposable threads/panels and remove them when
practical. It must not change unrelated provider credentials, executable paths,
or environment variables.
