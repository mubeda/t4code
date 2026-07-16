# Worktree Provider Labels Design

**Date:** 2026-07-16

## Goal

Make the Create worktree dialog's Agent selector use the same provider-instance names shown in Provider Settings. Default instances must use canonical product labels such as `Claude`, `Codex`, `OpenCode`, and `Cursor`; configured display names must take precedence.

## Current Behavior and Root Cause

`CreateWorktreeDialog` reads `serverConfig.providers` directly. When a live provider snapshot has no `displayName`, the dialog falls back to the raw `instanceId`. This leaks implementation identifiers such as `claudeAgent` and produces lowercase labels such as `codex` and `opencode`.

Provider Settings does not use that fallback. It combines the live provider snapshot with `serverConfig.settings.providerInstances`, then falls back to the canonical driver label from the shared provider-instance presentation layer. The two surfaces therefore derive labels from different sources.

## Design

### Shared source of truth

Extend the existing provider-instance settings overlay so an explicit configured `providerInstances[instanceId].displayName` overrides the live snapshot presentation name. The shared projection remains responsible for canonical driver-name fallbacks when neither settings nor the live snapshot supplies an explicit instance name.

The precedence is:

1. The configured provider-instance display name from the selected environment's settings.
2. An explicit live snapshot display name that differs from the generic driver label.
3. A human-readable custom instance name when needed to distinguish instances.
4. The canonical driver label, including `Claude` for the `claudeAgent` driver.

### Create worktree dialog

For the selected project's environment, derive `ProviderInstanceEntry` values from `serverConfig.providers` and apply `serverConfig.settings` through the shared overlay. Preserve the dialog's existing enabled-and-installed filtering, provider order, selected instance ID, default-model selection, and submitted thread payload. Only presentation labels change.

The Select component's `items` and rendered `SelectItem` content both use `ProviderInstanceEntry.displayName`; raw instance IDs are never used as visible fallback labels.

### Scope

This change does not add an individual model selector, change model selection behavior, reorder providers, change provider availability rules, or modify the server protocol. Improving the shared overlay may also correct stale configured names in other existing consumers of that same projection; that is intended consistency, not a separate feature.

## Error and State Handling

No new asynchronous operation or error state is introduced. If the selected environment has no server configuration, the selector remains empty as it does today. If configuration is incomplete, the shared canonical fallback always produces a non-empty visible label while the stable provider instance ID remains the submitted value.

## Testing

Add regression coverage at both relevant seams:

- Provider-instance projection tests prove that a configured display name overrides a missing, generic, or stale snapshot name while unnamed default instances retain canonical driver labels.
- Create worktree dialog tests provide snapshots without display names and assert canonical labels (`Claude`, `Codex`, `OpenCode`, and `Cursor`), then provide a configured custom name and assert that exact name is rendered and associated with the unchanged instance ID.
- Existing dialog submission tests continue to prove that the selected instance and model are sent unchanged.

Run the focused provider-instance and Create worktree dialog tests, followed by the repository-required `vp check`, `vp run typecheck`, and `vp test` gates.
