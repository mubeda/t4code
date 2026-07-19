# Terminal Nerd Font Support Design

**Status:** Approved
**Date:** 2026-07-19

## Summary

T4Code will make terminal icon rendering deterministic by bundling the complete
monospaced JetBrains Mono Nerd Font. One font therefore owns ordinary text,
Powerline separators, Nerd Font icons, and their advance widths. This font
becomes the automatic default for new and existing installations.

The terminal font preference is device-local. Users can select the bundled
default, the operating system monospace font, or one custom font family. Every
selection uses one primary terminal font rather than mixing fonts with
incompatible cell metrics.

## Problem

The terminal currently requests the following families:

```text
"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas,
"Liberation Mono", Menlo, monospace
```

Those fonts render ordinary text but do not guarantee glyphs in the Powerline
and Nerd Fonts private-use ranges. On a clean macOS installation this produces
missing-glyph boxes for prompts and directory icons even though the same prompt
works in a separately configured system terminal.

Relying on a system-installed Nerd Font would leave behavior dependent on the
device and would continue to fail on clean macOS, Windows, and Linux
installations.

## Goals

- Render Powerline and Nerd Font glyphs in every packaged T4Code build.
- Preserve the existing JetBrains Mono terminal typography through its patched
  Nerd Font build.
- Make the corrected font stack the automatic default for existing users.
- Support a system monospace preset and one custom device-local font family.
- Apply font changes to active terminals without replacing the terminal
  session, reconnecting, or losing scrollback.
- Behave consistently with both WebGL and fallback terminal renderers.
- Keep the setting in the existing Terminal settings section.
- Validate the behavior through TDD, package checks, and a packaged macOS UI
  test.

## Non-goals

- Enumerating all fonts installed on the operating system.
- Synchronizing a font selection between devices or remote environments.
- Adding terminal font size, line-height, weight, or ligature controls.
- Bundling every weight and style of JetBrains Mono Nerd Font.
- Changing shell prompts or asking users to install fonts manually.

## Existing Settings Audit

The visible Settings navigation contains General, Keybindings, Providers,
Source Control, and Archive. Connections and Diagnostics also exist as
special-purpose routes. None currently owns terminal typography.

General already contains a dedicated Terminal section with the WebGL renderer
setting. The terminal font control belongs in that section, immediately above
WebGL renderer. This avoids a new page, another navigation item, or a duplicate
Terminal section.

The existing `terminal.webglEnabled` value is server-synced. A font preference
must not be added to that object because installed custom fonts vary by client.
It belongs in `ClientSettings`, which is device-local and participates in the
existing settings defaults and reset flow.

## User Experience

The existing General → Terminal section gains a **Terminal font** row with:

1. **T4Code Nerd Font (bundled)** — default.
2. **System monospace**.
3. **Custom font family**.

Selecting Custom reveals a single font-family input. The input accepts one
family name, not an arbitrary CSS stack. A best-effort availability check can
show a non-blocking warning when the family is not available on the current
device. The terminal still works through the browser's monospace fallback.

Supporting text explains that:

- A complete monospaced Nerd Font is bundled.
- The preference is stored only on this device.

Restore Defaults resets the preference to T4Code Nerd Font (bundled).

## Settings Model

`ClientSettings` gains a typed `terminalFontPreference` value with three states:

```ts
type TerminalFontPreference =
  | { readonly mode: "bundled" }
  | { readonly mode: "system" }
  | { readonly mode: "custom"; readonly family: string };
```

The custom family is trimmed, length-bounded, and rejects control characters
and commas. Font-stack construction quotes and escapes the family name; the
stored value is never treated as arbitrary CSS.

The schema default is `{ mode: "bundled" }`. Decoding settings that predate the
field therefore activates the new stack immediately. Missing, malformed, or
obsolete values also recover to the bundled default instead of preventing
Settings from loading.

This value remains outside `ServerSettings` and is never sent through the
server settings patch path.

## Font Resolution

A single shared resolver maps the preference to the xterm font-family string.
No component constructs its own stack.

The bundled family uses a T4Code-specific name,
`T4Code JetBrainsMono Nerd Font Mono`, so it cannot accidentally bind to a
different system-installed version.

Resolved stacks have this shape:

```text
Bundled:
  "T4Code JetBrainsMono Nerd Font Mono", monospace

System:
  ui-monospace, monospace

Custom:
  "<escaped custom family>", monospace
```

The bundled font contains both text and icons with the same one-cell advance.
Mixing a text font with a symbols-only fallback is deliberately avoided:
fallback glyphs can have a wider advance than the primary font's xterm cell,
causing the glyph to spill beneath the cursor in the following cell.

## Asset and Licensing

The repository will pin `JetBrains Mono Nerd Font Mono` from the stable Nerd
Fonts v3.4.0 release:

- <https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0>
- <https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.tar.xz>

The optimized WOFF2 asset is stored with its upstream license, source URL,
version, and checksums. Builds never download an unpinned `latest` font.

An `@font-face` declaration loads the asset under the T4Code-owned family name.
Vite emits the asset into the web build, and the Tauri packages consume that
same build on macOS, Windows, and Linux.

## Runtime Behavior

New xterm instances receive the resolved font stack in their initial options.
When the preference changes:

1. Wait for the selected web font to become ready when applicable.
2. Update the existing xterm instance's `fontFamily` option.
3. clear the renderer's glyph/texture cache as supported.
4. Re-fit and refresh the visible terminal.

The terminal object and backend session remain intact. Changing the font must
not reconnect the shell, replace the xterm instance, or discard scrollback.

WebGL and fallback renderers use the same resolved stack and update path.

If the bundled font fails to load, T4Code logs one structured diagnostic
warning and leaves the terminal usable with an ordinary monospace fallback. It
does not crash or enter a retry loop.

## Testing Strategy

Implementation follows red–green–refactor.

### Schema and resolver tests

- Settings without `terminalFontPreference` decode to bundled.
- Invalid and obsolete persisted values recover to bundled.
- The preference remains in the client settings patch path.
- Every preset produces the expected ordered stack.
- Custom family names are normalized, validated, quoted, and escaped.
- The bundled preset resolves to one complete Nerd Font rather than a mixed
  metrics stack.

### Asset tests

- Parse the bundled font character map.
- Assert representative Powerline, Nerd Font private-use, and
  supplementary-plane glyphs are present.
- Assert ordinary text and representative icon glyphs have identical advance
  widths so the cursor cannot overlap a preceding icon.
- Assert the pinned asset provenance and license are included.

### Settings tests

- Terminal font appears in the existing Terminal section.
- No new Settings navigation item or duplicate section is introduced.
- Selecting Custom reveals the family input.
- An unavailable custom font shows a warning without disabling the setting.
- Restore Defaults returns to the bundled preset.

### Terminal tests

- New terminal instances receive the resolved stack.
- Changing the setting updates the existing terminal instance.
- The backend session and scrollback are not replaced.
- Renderer cache refresh and fitting occur after an update.
- WebGL enabled and disabled paths receive the same font.

### Cross-platform and UI validation

- Run the normal unit, integration, and package/build checks for macOS,
  Windows, and Linux.
- Run the required repository gates: `vp check` and `vp run typecheck`.
- Build and launch the packaged macOS application.
- Render a probe containing ordinary text, a check mark, Powerline glyphs, and
  Nerd Font icons; confirm there are no missing-glyph boxes.
- Change the preset and custom family, restart the app, and verify device-local
  persistence.
- Restore Defaults and confirm the bundled stack is active again.

## Rollout

No migration dialog or opt-in is required. On first launch after upgrading,
existing settings decode with the bundled preference and active/new terminals
use the corrected stack.

The old hard-coded font stack is removed once all terminal creation and update
paths use the shared resolver.
