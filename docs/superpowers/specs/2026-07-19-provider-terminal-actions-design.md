# Provider Terminal Actions Design

**Date:** 2026-07-19

## Summary

Extend the chat-header `+` menu with a provider-terminal section between
**Open Terminal** and **Add custom action…**. The new section mirrors the
enabled provider-instance list. Selecting an item opens a center terminal in
the active thread's current worktree and launches that provider's configured
CLI directly under the PTY with the required full-access arguments.

The feature must preserve existing shell-terminal behavior, provider-instance
semantics, reconnect behavior, and persisted center-panel state.

## User Experience

The menu order is:

1. Enabled provider instances for new chat panels.
2. **Open Terminal**.
3. Enabled provider instances for provider terminals.
4. **Add custom action…**.

Each provider-terminal item:

- reuses the provider instance's icon and accent presentation;
- is labeled `${displayName} Terminal`;
- appears only when the provider instance is enabled in Settings;
- remains visible but disabled when the instance is not ready, using the same
  readiness tooltip as the corresponding chat action;
- is disabled with the existing thread-level explanation when the host thread
  cannot create center panels.

When no provider-terminal items exist, the menu keeps the existing single
separator between **Open Terminal** and **Add custom action…**. When items do
exist, separators bracket the new section.

Selecting an enabled item opens and activates a uniquely identified center
terminal tab. The tab uses the provider-terminal label, for example
**Codex Terminal** or **Codex Personal Terminal**.

## Provider Command Definitions

The launch executable comes from the selected provider instance's Settings
configuration. Resolution order is:

1. the instance's `config.binaryPath`;
2. the legacy/default driver's `providers.<driver>.binaryPath`;
3. the built-in command definition's default executable.

Whitespace-only values are ignored. A custom provider instance therefore uses
its own executable when configured and otherwise inherits its driver's
configured executable.

The built-in command definitions are:

| Driver | Default executable | Arguments |
| --- | --- | --- |
| Claude | `claude` | `--dangerously-skip-permissions` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode` | none |
| Cursor | `cursor-agent` | `--yolo` |
| Grok | `grok` | `--permission-mode`, `bypassPermissions` |

The current Cursor default is `agent` in the TypeScript and Rust settings even
though the repository README and the requested command use `cursor-agent`.
This feature aligns the TypeScript and Rust defaults, placeholders, and affected
tests to `cursor-agent`. Explicit user-configured Cursor binary paths remain
unchanged.

Provider environment entries and Claude's free-form `launchArgs` are not
automatically appended. The provider terminal receives the existing project
runtime environment and only the fixed arguments listed above. Future built-in
drivers must register a provider-terminal command definition before they can
offer this action.

## Architecture

### Provider terminal action model

A focused web module owns provider-terminal presentation and command
resolution. It maps a `ProviderInstanceEntry` plus current provider Settings to
a structured launch model:

```ts
interface ProviderTerminalAction {
  readonly entry: ProviderInstanceEntry;
  readonly label: string;
  readonly command: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
  };
}
```

The module keeps driver-specific terminal arguments out of the menu component
and is independently unit tested. `ChatHeaderPanelMenu` reuses the already
derived `PanelMenuProviderItem[]` for visibility, ordering, disabled state, and
tooltips, then resolves launch data for the second provider section.

### Center-panel state

The terminal member of `CenterSurface` gains optional launch metadata and an
optional display label:

```ts
{
  readonly id: `terminal:${string}`;
  readonly kind: "terminal";
  readonly terminalId: string;
  readonly label?: string;
  readonly command?: TerminalLaunchCommand;
}
```

`openTerminalPanel` accepts an optional launch descriptor. Ordinary terminal
creation omits it and behaves exactly as it does today. Provider-terminal
creation includes the provider label and structured command.

The center-panel persistence version is incremented. Migration preserves valid
launch metadata, accepts older terminal surfaces without it, and drops invalid
or oversized executable/argument data rather than trusting arbitrary persisted
values.

### Terminal contracts

The schema-only contracts package defines a bounded structured terminal command:

```ts
interface TerminalLaunchCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly label?: string;
}
```

The executable is trimmed, non-empty, and length-bounded. Argument count and
individual argument lengths are bounded. `TerminalOpenInput`,
`TerminalAttachInput`, and `TerminalRestartInput` accept the command as an
optional field.

The command is structured rather than serialized into a shell command. This
avoids shell interpolation, handles executable paths containing spaces, and
keeps behavior predictable across macOS, Linux, and Windows.

### Rust terminal runtime

The Rust terminal model mirrors the optional structured command. The PTY spawn
input is expressed in neutral executable/argument terms rather than assuming
that every root process is a shell.

`TerminalManager::start` chooses one of two paths:

- no command: resolve and launch the preferred shell exactly as today;
- command present: launch the configured executable directly with the supplied
  argument vector.

Both paths preserve the resolved terminal `cwd`, project runtime environment,
dimensions, history, event stream, process supervision, and cleanup behavior.
The provider label becomes the initial terminal session label for direct
provider launches.

Attach-created terminals forward the optional command only when creating a
missing session. An already-running terminal is returned unchanged, so mounting,
tab switching, or reconnecting cannot launch the command twice. Restart
requests preserve the command when explicitly recreating the session.

## Data Flow

1. `ChatHeaderPanelMenu` derives provider-instance entries and overlays current
   Settings, as it already does for chat actions.
2. `buildPanelMenuModel` filters disabled instances and computes readiness.
3. The provider-terminal resolver combines each visible entry with its
   configured binary path and the built-in argument definition.
4. Clicking an enabled provider-terminal item calls the provider-terminal
   callback with its structured action.
5. `ChatView` resolves all terminal IDs already associated with the thread.
6. `useCenterPanelActions` allocates the next `term-N` ID and stores a terminal
   surface containing the label and command.
7. `CenterTerminalPanel` resolves the host thread's current worktree `cwd` and
   project runtime environment, then passes the command to the existing
   attach-created terminal layer.
8. The terminal attach RPC creates the missing server session and the Rust
   terminal manager launches the provider executable directly in that `cwd`.
9. Existing terminal output, input, resize, metadata, history, and close paths
   continue through the normal terminal runtime.

## Persistence and Reconnection

The structured launch command is persisted with the center surface so the UI
retains the terminal's intent across application reloads.

- If the server still owns the terminal session, attaching returns that session
  and ignores the persisted creation command.
- If the server restarted and the session is missing, attaching recreates the
  provider terminal from the persisted command.
- If an existing session has exited, a normal attachment does not implicitly
  restart it.
- Older persisted surfaces without commands remain ordinary shell terminals.

These rules provide at-most-once launch for a live server session while still
allowing recovery after server process loss.

## Error Handling

Provider readiness disables the action before launch when installation or
connection checks report a known problem. This is advisory rather than a
security boundary: settings or filesystem state can change between rendering
and spawning.

If direct process creation fails:

- the center terminal remains open;
- the existing terminal error path presents the structured spawn failure;
- no fallback shell is launched, because that would hide the failed provider
  invocation;
- no automatic retry loop runs.

Ordinary shell terminals retain their existing shell-candidate fallback.
Invalid command payloads are rejected at the contract boundary. Executables and
arguments are passed directly to the PTY process builder and never evaluated as
shell text.

## Testing

### Web unit tests

- Provider-terminal resolution covers every built-in executable and exact
  argument vector.
- Explicit instance binary paths override legacy/default paths.
- Custom instances inherit the driver's path when no instance path exists.
- Enabled filtering, provider ordering, display names, and readiness match the
  existing provider menu model.
- Menu rendering covers section order, separators, icons, labels, disabled
  tooltips, and provider-terminal callbacks.

### Center-panel tests

- Provider terminal creation allocates a collision-free `term-N` ID.
- Launch metadata and labels persist on terminal surfaces.
- Persisted-state migration accepts old shell surfaces and sanitizes new launch
  metadata.
- `ChatView` passes the selected launch model into the center terminal.
- `CenterTerminalPanel` supplies the active host thread's current worktree
  directory.

### Contract and client-runtime tests

- Open, attach, and restart schemas encode and decode valid structured commands.
- Empty executables, excessive arguments, and oversized values are rejected.
- Existing payloads without commands remain valid.
- RPC fixtures and generated shape expectations are updated where required.

### Rust terminal tests

- Structured commands produce the exact executable and argument vector in
  `PtySpawnInput`.
- Direct launches preserve `cwd`, dimensions, and environment.
- Ordinary terminal inputs still use shell-candidate resolution and fallback.
- Attaching to an existing session does not spawn a second process.
- Attaching to a missing session recreates the direct provider command.
- Spawn failures remain provider-terminal errors and do not fall back to a
  shell.

### Verification

Run focused tests while implementing, then complete the repository-required:

```sh
vp check
vp run typecheck
```

Use `vp test` for the relevant built-in Vite+ test suites. Run `vp run test`
only if the package-script test path is specifically required.

## Documentation

Update:

- `docs/user/workspace-ui.md` to describe the new provider-terminal section and
  current-worktree behavior;
- `docs/architecture/providers.md` to describe structured provider-terminal
  launches and provider-instance command resolution;
- `docs/getting-started/quick-start.md` so its chat-header menu summary includes
  provider terminals.

## Out of Scope

- Adding Gemini or another provider driver.
- Executing arbitrary custom shell strings.
- Automatically appending Claude `launchArgs`.
- Injecting provider-instance environment secrets into the terminal process.
- Changing normal shell-terminal behavior.
- Adding user-editable provider-terminal flags.
