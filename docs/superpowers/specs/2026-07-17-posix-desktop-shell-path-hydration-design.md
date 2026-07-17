# POSIX Desktop Shell PATH Hydration

## Goal

Packaged T4Code desktop builds on macOS and Linux must discover and launch the
same command-line tools that the user can run from their interactive login
shell. This fixes provider discovery for Codex, Claude, Cursor Agent, OpenCode,
and other PATH-based executables when the desktop application inherits a
minimal GUI environment.

Windows behavior remains unchanged.

## Root Cause

GUI-launched macOS applications commonly inherit a launchd PATH containing
only `/usr/bin:/bin:/usr/sbin:/sbin`. T4Code starts its Rust server in-process,
and provider executable resolution reads that process PATH directly. The
desktop startup path does not currently load the user's login-shell
environment, so executables installed under Homebrew or user-local directories
are reported as missing even though they work in Terminal.

Linux desktop and AppImage launches can inherit the same kind of sparse
environment. The fix therefore applies to both supported POSIX desktop
platforms.

## Architecture

Add a focused Rust module under `apps/desktop/src-tauri/src/` that owns POSIX
login-shell PATH hydration. `t4code_desktop_lib::run` will call the module
before constructing `tauri::Builder`.

The module will:

1. Select the absolute executable named by `SHELL` when its basename is one of
   `zsh`, `bash`, `fish`, `sh`, or `dash`.
2. Fall back to `/bin/zsh` on macOS or `/bin/bash` on Linux when `SHELL` is
   missing, relative, unsupported, or unavailable.
3. Start the shell once with interactive-login command flags.
4. Print the shell's exported PATH between distinct fixed start/end delimiters using a
   shell-neutral `printenv` command.
5. Parse the delimited value despite unrelated shell startup output.
6. Merge shell PATH entries before inherited GUI PATH entries, preserving
   first-match order and removing duplicates.
7. Install the merged PATH before Tauri or the in-process server starts.

The hydration child and its stdout-reader thread must both finish before the
process environment is updated. This preserves the Rust 2024 safety invariant
that process environment mutation occurs while T4Code startup is still
single-threaded. The unsafe environment update will be isolated in one
documented function.

The server's provider inventory and provider launch code will continue using
the process PATH. No provider-specific directories, absolute paths, or fallback
rules will be added.

On Windows the hydration entry point is a no-op.

## Shell Probe Reliability

The probe is best-effort and must not prevent T4Code from opening.

- The probe has a five-second deadline.
- stdin and stderr are discarded so interactive startup scripts cannot wait
  for input or flood the application log.
- stdout is drained concurrently while retaining a bounded amount for parsing,
  preventing pipe backpressure and unbounded memory growth.
- A timed-out child is killed, waited on, and its reader thread is joined.
- Missing or unsupported shells, spawn errors, non-zero exits, oversized
  output, missing delimiters, empty PATH values, and invalid merged PATH values
  leave the inherited PATH unchanged.
- Shell banners and other stdout outside the delimiters are ignored.

Hydration returns a structured outcome. After application logging is
available, startup records whether hydration succeeded and the number of PATH
segments added. It must not log the PATH value, captured shell output, or other
environment contents.

## PATH Semantics

The shell PATH has precedence because it represents the user's intended
interactive command resolution. Existing GUI PATH entries that are not already
present remain available after the shell entries.

The merge preserves:

- the shell's original entry order;
- entries containing spaces;
- the first occurrence of each entry; and
- inherited entries absent from the shell PATH.

An empty or unusable shell result never replaces a valid inherited PATH.

## Test Design

Implementation follows red-green-refactor. Unit tests must cover:

1. extracting a valid PATH surrounded by unrelated startup output;
2. rejecting missing, incomplete, reversed, or empty delimiters;
3. enforcing the captured-output size bound;
4. preserving shell order and paths containing spaces;
5. removing duplicates without changing first-match precedence;
6. retaining inherited-only PATH entries after shell entries;
7. leaving PATH unchanged for spawn failures and non-zero exits;
8. killing and reaping a timed-out shell and joining its output reader;
9. falling back when the configured shell is absent or unsupported;
10. selecting the macOS and Linux default shells;
11. keeping Windows hydration as a no-op;
12. resolving a provider executable from a user-local directory after merging
    it into a GUI-minimal PATH; and
13. retaining explicit provider executable-path behavior.

Tests that exercise command execution will use temporary fixture executables
and deterministic short deadlines. Pure parsing, merging, and executable
resolution will be tested without mutating the test runner's global PATH so
parallel tests remain reliable.

Required automated verification:

- targeted desktop shell-environment tests;
- targeted server provider-executable resolution tests;
- the complete desktop and server Rust test suites;
- `vp check`;
- `vp run typecheck`; and
- the complete `vp test` suite.

## Packaged macOS UI Verification

After automated verification passes:

1. Build a fresh arm64 macOS DMG from the fixed source.
2. Install or replace the local `T4Code (Alpha).app`.
3. Launch it through the normal macOS GUI path, not from an environment-rich
   development shell.
4. Confirm the running process no longer has only the launchd-minimal PATH.
5. Open provider settings and refresh provider status.
6. Verify Codex and Claude are detected without absolute-path configuration and
   no longer show **Provider executable was not found**.
7. Start a disposable Codex conversation and receive a response, proving the
   same hydrated environment reaches provider launch rather than only provider
   inventory.

The UI verification must not change persisted provider binary paths. Any
disposable thread created for the test should be removed when practical.

## Non-Goals

- Hardcoding Homebrew, npm, pnpm, Cargo, or provider-specific installation
  directories.
- Adding provider-specific executable workarounds.
- Changing Windows environment discovery.
- Changing provider authentication, models, or settings defaults.
- Changing WSL or SSH environment handling.
