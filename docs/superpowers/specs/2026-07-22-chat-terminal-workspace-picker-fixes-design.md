# Chat Link, Codex Terminal Theme, and Workspace Folder Creation Design

**Date:** 2026-07-22
**Status:** Approved in brainstorming; pending written-spec review

## Summary

Fix three related desktop usability defects without introducing parallel browser,
terminal, or filesystem mutation paths:

1. A normal click on any HTTP(S) link rendered in AI chat opens the internal
   Browser.
2. A newly launched Codex Terminal receives the active T4Code foreground and
   background colors early enough for Codex's startup palette probe, so its
   composer matches Light and Dark themes.
3. The remote **Select Workspace folder** dialog can create a folder in the
   currently browsed directory, enter it, and select it.

For a running Codex Terminal, changing the application theme does not silently
restart the provider process. The terminal remains on its launch palette and
offers an explicit restart action to apply the new theme. This avoids the current
mixed palette while preserving user control over a potentially disruptive
restart.

## Decisions From Brainstorming

- Every `http://` and `https://` chat link uses the internal Browser by default,
  not only localhost or generated-artifact URLs.
- Same-document fragments keep their existing in-chat navigation behavior.
- The existing context menu remains the escape hatch for opening a link in the
  system browser.
- Folder creation targets the selected T4Code host and the directory currently
  displayed by the picker.
- Successful folder creation navigates into the new folder so the existing
  **Select folder** action can immediately choose it.
- Automatic Codex process restarts on theme change are rejected because they can
  lose an active interactive session.
- CSS/ANSI output rewriting is rejected because it depends on Codex's current
  rendering sequences and would be brittle across provider updates.

## Existing Architecture and Root Causes

### Chat links

`ChatMarkdown` already owns the required internal-browser command through
`openUrlInPreview`. The right-click action calls it, but ordinary external link
anchors use `target="_blank"` and their click handler only special-cases `#fragment`
navigation. A Tauri webview does not reliably turn that target into the T4Code
Browser surface, so the visible link can appear inert.

The fix belongs in the existing markdown link renderer. No new browser API or
desktop shell call is required.

### Codex terminal palette

T4Code already passes reserved `T4CODE_OSC_*` launch values and the Rust PTY layer
answers OSC 10/11/12 queries synchronously. Two gaps remain:

1. The frontend derives those launch values from `document.documentElement` inside
   a memo that is not keyed by the reactive resolved theme.
2. The native PTY child is spawned before the output reader and OSC responder are
   installed. Codex gives its startup probe only 100 ms, so post-spawn setup can
   miss the detection window and Codex falls back to ConPTY's black background.

Codex blends its composer background from the detected terminal background. On
Windows it caches the startup colors and its later `requery_default_colors` path
is currently a no-op. Consequently, repainting xterm.js after a theme switch can
produce a white terminal with a dark Codex composer, but cannot make the already
running Codex process recalculate its palette.

References:

- [Codex bounded startup probe](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/tui/src/terminal_probe.rs)
- [Codex terminal palette cache](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/tui/src/terminal_palette.rs)
- [Codex composer color derivation](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/tui/src/style.rs)

### Workspace folder picker

`RemoteDirectoryPickerDialog` is browse-only today. The repository already has a
remote-safe directory mutation through `projectEnvironment.createEntry`, backed by
the server's `WorkspaceService::create_entry`. It accepts an environment ID, a
root `cwd`, a relative path, and `kind: "directory"`; the service owns traversal,
collision, and symlink-boundary validation.

The picker should reuse this mutation instead of adding a second filesystem-create
RPC or falling back to a local native folder dialog, which would be incorrect for
WSL/SSH/remote hosts.

## Design

### 1. HTTP(S) chat links open the internal Browser

The `ChatMarkdown` link renderer classifies the normalized link target before
rendering:

- `#fragment`: preserve the current scroll-to-message behavior.
- `http://` or `https://`: render the existing anchor styling and accessibility
  semantics, but prevent the default navigation on activation and call
  `openUrlInPreview({ threadRef, url, openPreview })`.
- Other schemes and file links: preserve their existing specialized behavior.

The internal Browser open is driven by the existing preview environment command,
which applies the server snapshot, remembers the URL, selects the Browser tab,
and opens the right panel. The link context menu continues to expose both
**Open in integrated browser** and **Open in system browser**.

The handler must not double-invoke an inherited markdown click callback, and it
must remain keyboard accessible through the anchor's native Enter activation.
Failures remain on the existing preview command error-reporting path; there is no
fallback to the system browser because that would violate the selected routing
policy and make behavior depend on failure timing.

### 2. Codex Terminal startup theme is deterministic

#### Reactive color source

`TerminalViewport` consumes `useTheme().resolvedTheme`. A pure helper maps
`"light" | "dark"` to both:

- the xterm.js `ITheme`; and
- the reserved OSC foreground/background/cursor launch values.

The launch environment is memoized with `resolvedTheme` as an explicit dependency.
The thread runtime environment continues to win ordinary user keys, but reserved
T4Code color keys are owned by T4Code and cannot be overridden accidentally.
Keeping xterm and OSC values behind the same resolved-theme input prevents the two
representations from drifting.

#### PTY startup ordering

The native PTY setup is reordered so the output reader and `OscColorResponder` are
ready before the provider child can issue its startup query. Setup uses an explicit
readiness handoff rather than relying on thread scheduling. If child creation later
fails, the reader and writer are closed through the existing ownership guards so no
reader thread or PTY handle is leaked.

The responder continues to scan raw bytes before UTF-8 decoding and forwards the
original stream unchanged. It answers Codex's batched OSC 10 and OSC 11 query in
arrival order and preserves the query's BEL or ST terminator.

#### Running terminal theme changes

Each `TerminalViewport` retains the resolved theme associated with the current
terminal process generation. While that process is running:

- xterm remains on the launch palette, preventing a mixed white/dark surface;
- if the application theme differs, a compact notice is displayed:
  **Restart Codex Terminal to apply Light/Dark theme**;
- the restart action clearly indicates that the interactive terminal process will
  restart, then invokes the existing structured terminal restart path with the
  current command, cwd, environment, and newly resolved color values;
- cancel/dismiss leaves the running process and its coherent launch palette
  untouched.

Ordinary shell, Cursor, and Claude terminals retain their existing live xterm theme
update behavior. The guarded restart affordance applies only to a structured Codex
provider terminal because Codex is the process caching and painting the conflicting
background.

When the restarted terminal reports a new generation, the retained launch theme is
updated and normal rendering resumes with no mismatch notice.

### 3. Create a folder from the workspace picker

The picker toolbar gains a **New folder** button beside **Refresh**. Activating it
reveals an inline name editor within the existing dialog rather than opening a
nested modal. The editor:

- is focused immediately;
- supports Enter to create and Escape/Cancel to close;
- trims surrounding whitespace and disables **Create** for an empty name;
- disables duplicate submission while the command is pending;
- keeps the picker open on failure and presents the server's safe error message.

Creation calls `projectEnvironment.createEntry` with:

```ts
{
  environmentId,
  input: {
    cwd: currentDirectory,
    relativePath: folderName,
    kind: "directory",
  },
}
```

The mutation is scoped to the selected host through `environmentId`. On success,
the picker dismisses the inline editor and combines the current directory with the
server-returned normalized relative path through the existing host-aware path
helper. It navigates to that result and refreshes the browse query; the browse
response remains the authority that canonicalizes the location. The breadcrumb
and path input therefore show the newly created directory, and **Select folder**
selects that directory.

The server remains the authority for invalid names, existing entries, permissions,
path traversal, and symlink boundaries. No optimistic folder row is inserted.

## Error Handling and Reliability

- Browser-open failures do not silently redirect outside T4Code.
- A failed OSC response write is non-fatal and leaves Codex on its conservative
  fallback, matching current PTY behavior; the regression tests make the normal
  path deterministic.
- PTY startup failure tears down all early-created reader/writer resources.
- Theme changes never kill or restart Codex without an explicit user action.
- Folder mutation interruption is ignored as cancellation; other structured
  failures remain visible in the picker.
- The folder list is refreshed only after confirmed server success, avoiding
  phantom folders during reconnects or partial failures.

## Testing Strategy

### Chat markdown

- A normal HTTP and HTTPS link activation calls the preview open command exactly
  once and prevents default navigation.
- Keyboard activation uses the same route.
- Same-document fragments retain their scroll behavior.
- File links and non-HTTP schemes retain existing behavior.
- The context menu still exposes integrated and system browser actions.

### Terminal frontend

- Light and Dark resolved themes produce matching xterm and OSC colors.
- The launch environment changes with `resolvedTheme` and reserved values cannot
  drift from the rendered palette.
- A running Codex generation keeps its launch palette after an app-theme change
  and shows the explicit restart affordance.
- Confirming restart sends the current structured command and new theme colors;
  dismissing it does not mutate the session.
- Non-Codex terminals keep live theme updates.

### Terminal server

- The responder parses Codex's exact batched startup sequence, including leading
  cursor-position and keyboard-capability queries.
- OSC 10 and OSC 11 replies work in one chunk and across arbitrary chunk splits.
- A probe emitted immediately by the child is answered inside the bounded startup
  window.
- Spawn failure after reader readiness releases all PTY resources.
- Existing BEL/ST, malformed-input, and DEC color-scheme tests remain green.

### Workspace picker

- New-folder controls, focus, Enter, Escape, empty-name validation, and pending
  state.
- The create command receives the active environment and current directory.
- Success refreshes and enters the canonical new folder.
- Duplicate, permission, and interrupted-command paths behave as designed.
- Windows and POSIX path separators are covered by pure path tests.

### Completion gates

- Focused web and Rust test suites pass during implementation.
- `vp test` passes for the built-in Vite+ test command.
- `vp check` passes.
- `vp run typecheck` passes.

## Approved Windows ConPTY Addendum

Real ConPTY testing disproved the original output-thread timing hypothesis: the Windows console host consumes Codex's OSC 10/11 query before PortablePty's host output stream can observe it. The parser remains correct, and the user confirmed that macOS does not reproduce the defect.

Official Codex v0.144 source and native ConPTY characterization show the Windows-specific failure path: after its 100 ms OSC probe times out, Codex reads the ConPTY console's default foreground/background attributes. A newly created light-theme ConPTY still reports black background attributes, producing the visible black composer rectangle. Direct OSC input seeding and host-output triggers cannot repair this because ConPTY consumes the query and its console input parser discards the attempted replies.

For Codex launches only, the web client adds the authoritative reserved marker `T4CODE_WINDOWS_CONSOLE_THEME=light|dark` alongside the exact resolved palette. The server keeps the marker in `PtySpawnInput`, strips it and the existing reserved `T4CODE_OSC_*` values from the real child environment, and on Windows only initializes the same newly opened ConPTY by running the fixed command `/d /c color F0` for light or `/d /c color 0F` for dark on the PTY slave. The executable is the absolute trusted system `cmd.exe` resolved with `GetSystemDirectoryW`, never `PATH` or user launch input. Windows reserved-key matching is case-insensitive. The server waits for that short initializer to succeed, then launches the original prepared Codex command unchanged on the same slave. The console attributes persist across the two child processes, so Codex's normal Windows fallback observes the correct defaults without a wrapper, user-controlled command interpolation, startup sleeps, or changes to Codex. Initializer spawn, wait, or nonzero-exit failures are explicit terminal setup failures with best-effort initializer cleanup. Non-Codex terminals and non-Windows PTYs use the existing launch path unchanged. Native Windows acceptance tests must exercise the same 100 ms timeout and console-attribute fallback for both themes, preserve hostile argv/cwd/ordinary-env values, and prove an unmarked backend launch does not initialize the console.

## Out of Scope

- Changing Codex itself to support live palette requery on Windows.
- Automatically resuming a Codex interactive session after restart.
- Routing `mailto:`, `tel:`, or custom URI schemes into the internal Browser.
- File creation, rename, or deletion from the workspace picker.
- A new general-purpose filesystem mutation protocol.
