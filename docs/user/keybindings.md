# Keybindings

T4Code reads keybindings from:

- `~/.t4code/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](../../packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+b", "command": "sidebar.toggle" },
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+alt+b", "command": "rightPanel.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+shift+d", "command": "terminal.splitVertical", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "mod+shift+j", "command": "preview.toggle" },
  { "key": "mod+r", "command": "preview.refresh", "when": "previewFocus" },
  { "key": "mod+l", "command": "preview.focusUrl", "when": "previewFocus" },
  { "key": "mod+=", "command": "preview.zoomIn", "when": "previewFocus" },
  { "key": "mod++", "command": "preview.zoomIn", "when": "previewFocus" },
  { "key": "mod+-", "command": "preview.zoomOut", "when": "previewFocus" },
  { "key": "mod+0", "command": "preview.resetZoom", "when": "previewFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+shift+[", "command": "thread.previous" },
  { "key": "mod+shift+]", "command": "thread.next" }
]
```

The native server validates and persists overrides in
[`apps/server/src/production/control.rs`](../../apps/server/src/production/control.rs).

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `sidebar.toggle`: open/close the left workspace panel
- `terminal.toggle`: open/close the thread terminal drawer
- `terminal.split`: split terminal horizontally in the focused terminal context
- `terminal.splitVertical`: split terminal vertically in the focused terminal context
- `terminal.new`: create a new terminal in the focused terminal context
- `terminal.close`: close/kill the focused terminal
- `rightPanel.toggle`: open/close the right tool panel
- `diff.toggle`: open/close the thread diff view
- `preview.toggle`: open/close the in-app browser preview when the active host exposes preview support
- `preview.refresh`: reload the active preview tab (in focused preview context by default)
- `preview.focusUrl`: focus the URL input of the preview panel (in focused preview context by default)
- `preview.zoomIn`: zoom the preview viewport in one step (in focused preview context by default)
- `preview.zoomOut`: zoom the preview viewport out one step (in focused preview context by default)
- `preview.resetZoom`: reset the preview zoom to 100% (in focused preview context by default)
- `commandPalette.toggle`: open or close the global command palette
- `chat.new`: create a new worktree/chat thread preserving the active context where possible
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `modelPicker.toggle`: open/close the model picker
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `thread.previous` / `thread.next`: jump through visible left-panel workspace rows
- `thread.jump.1` through `thread.jump.9`: jump to a visible left-panel workspace row
- `modelPicker.jump.1` through `modelPicker.jump.9`: jump to a model/provider row while the model picker is open
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `previewFocus`
- `previewOpen`
- `modelPickerOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
