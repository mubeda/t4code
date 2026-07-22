# Windows Codex ConPTY Console Theme Plan

> **Supersedes:** Task 2 of `2026-07-22-codex-terminal-theme.md` and the abandoned OSC startup-response design. Native ConPTY tests proved that Codex's OSC query is consumed by the console host and attempted PTY-input replies are discarded.

**Goal:** Make Codex render with the resolved T4Code palette on Windows by ensuring its built-in console-attribute fallback observes the correct ConPTY defaults.

**Architecture:** The web marks only Codex launches with `T4CODE_WINDOWS_CONSOLE_THEME=light|dark`. The server retains this reserved marker in `PtySpawnInput`, removes it and the existing reserved OSC palette values from the real child environment, and, on Windows only, opens the PTY and runs a fixed `/d /c color F0` or `color 0F` initializer on the slave through the absolute system `cmd.exe` resolved by `GetSystemDirectoryW`. After that initializer exits successfully, the server launches the original prepared Codex command unchanged on the same slave. No wrapper remains around Codex, no trusted setup executable is resolved through `PATH`, and no user-controlled command, argument, working directory, or environment value is interpolated into the initializer.

## Global constraints

- Use the exact palette centralized in `terminalTheme.ts`.
- Set `T4CODE_WINDOWS_CONSOLE_THEME` only for `isCodexTerminalCommand(command)`, with the exact value `light` or `dark` from the resolved theme.
- Runtime and command environment entries cannot override the reserved marker or OSC color keys.
- Strip the internal marker and existing `T4CODE_OSC_BACKGROUND`, `T4CODE_OSC_FOREGROUND`, and `T4CODE_OSC_CURSOR` values before building the real child environment. On Windows, reserved-key matching is case-insensitive.
- Resolve the initializer executable through `GetSystemDirectoryW` and append `cmd.exe`; never resolve it through `PATH`, `ComSpec`, the terminal cwd, or launch env.
- Under `cfg(windows)`, map only `light` to the fixed raw command `/d /c color F0` and `dark` to `/d /c color 0F`.
- Run the initializer and real command on the same PTY slave. Wait for initializer success before spawning the real command.
- Treat initializer spawn, wait, and nonzero exit as terminal setup failures. Do not launch the real child after such a failure.
- On initializer wait/setup failure, perform best-effort child cleanup before returning.
- Preserve the real command's executable, argv, working directory, and ordinary environment exactly. Do not add a persistent wrapper process.
- Non-Codex terminals and non-Windows PTYs retain the existing launch lifecycle unchanged.
- Do not add sleeps, retries, dependencies, sidecars, or changes under `.repos`.
- Do not fix the two separately approved baseline PTY failures.

### Task 1: Initialize Windows Codex ConPTY console attributes

**Files:**

- Modify: `apps/web/src/components/terminalTheme.ts`
- Modify: `apps/web/src/components/terminalTheme.test.ts`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`
- Modify: `apps/server/src/terminal/pty.rs`
- Modify: `apps/server/tests/windows_terminal_shims.rs`
- Modify: `apps/server/Cargo.toml`

- [ ] **Step 1: Write web marker RED tests**

Require Codex launches to include the exact resolved `T4CODE_WINDOWS_CONSOLE_THEME` value, prove hostile runtime/command environment values cannot override it, and prove non-Codex launches omit it.

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx --project unit
```

Expected: FAIL before marker wiring.

- [ ] **Step 2: Implement the narrow web marker**

Extend the shared spawn-environment resolver so the reserved marker is appended only when `isCodexTerminalCommand(command)` is true. Pass the current resolved theme as `light` or `dark`, after runtime and command environment merging.

Run Step 1 again. Expected: PASS.

- [ ] **Step 3: Write server preparation RED tests**

Require pure Windows initializer selection for the exact marker values and no initializer for missing/invalid values. Prove the marker and all reserved OSC palette entries are stripped from the real child environment while ordinary environment entries remain. Cover mixed/lowercase reserved spellings under Windows semantics.

```powershell
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
```

Expected: new tests FAIL before the helper and stripping exist.

- [ ] **Step 4: Implement marker parsing and same-PTY initialization**

After `openpty`, resolve the absolute trusted system `cmd.exe`, spawn the fixed theme initializer on `pair.slave`, wait for successful exit, and then spawn the existing prepared command on that same slave. Keep the actual command builder untouched apart from excluding all reserved internal theme keys. Return a setup error on initializer resolution, spawn, wait, or nonzero exit, and clean up a spawned initializer on failure.

Run Step 3 again. Expected: PASS.

- [ ] **Step 5: Add native Windows fallback acceptance tests**

Use a native fixture that mirrors Codex v0.144: wait 100 ms for an OSC response, then call `GetConsoleScreenBufferInfoEx` and decode `wAttributes` through `ColorTable`. Assert light and dark markers initialize the expected foreground/background. Also prove the real child's arguments (including spaces, `%PATH%`, and `!`), working directory, and ordinary environment survive unchanged, and that an absent marker does not initialize the console.

```powershell
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --test windows_terminal_shims -- --nocapture
```

Expected: the no-initializer characterization is RED for light, then both marked theme cases PASS after Step 4. No acceptance test is ignored.

- [ ] **Step 6: Remove abandoned experiments**

Confirm the production diff contains no OSC pre-seeding, focus-sequence trigger, passthrough-mode flag, diagnostic logging, persistent wrapper, sleeps, or vendored edits. Parser characterizations may remain only if independently useful and directly relevant.

- [ ] **Step 7: Verify focused regressions and platform isolation**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx --project unit
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --test windows_terminal_shims -- --nocapture
vp check
vp run typecheck
```

Expected: all exit 0. If the broader PTY suite is run, only the two recorded baseline failures may remain.

- [ ] **Step 8: Self-review and task-only commit**

Confirm Windows-only behavior, fixed initializer commands, strict marker parsing, setup-failure cleanup, unchanged real argv/cwd/env, and no unrelated edits. Commit only listed files; if policy blocks commit, preserve the task-specific staged diff without bypassing policy.
