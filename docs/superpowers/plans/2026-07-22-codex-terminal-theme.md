# Codex Terminal Theme Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Terminal start with the correct Light or Dark palette and keep an already-running Codex terminal visually coherent until the user explicitly restarts it to apply a changed theme.

**Architecture:** Centralize terminal launch-color derivation in a pure web helper driven by `useTheme().resolvedTheme`, then make the Rust PTY responder enter its read loop immediately after child creation and before process-identity bookkeeping. Track the launch theme per terminal generation; Codex terminals defer live repaint and expose an explicit restart action, while other terminals retain live repaint behavior.

**Tech Stack:** React 19, TypeScript, xterm.js, Effect Atom commands, Rust, portable-pty/ConPTY, Tokio broadcast/watch, Vite+ test, Cargo test.

## Global Constraints

- Fresh Codex Terminal launches must match the active Light or Dark theme.
- Codex's exact 100 ms OSC 10/11 startup probe must receive both foreground and background replies.
- Never rewrite provider ANSI output as a theme workaround.
- Never restart a running Codex process without an explicit user action.
- Cursor, Claude, shell, and other terminals retain current live xterm theme updates.
- Runtime environment keys win ordinary provider defaults; reserved `T4CODE_OSC_*` keys remain T4Code-owned.
- Preserve PTY output, history, resize, cleanup, and supervision behavior.
- Use TDD and run the Windows integration test on the current Windows host.
- `vp check` and `vp run typecheck` must pass before completion.

## File Structure

- Create `apps/web/src/components/terminalTheme.ts`: pure palette/env merge and Codex-command classification.
- Create `apps/web/src/components/terminalTheme.test.ts`: focused helper tests independent of the terminal renderer.
- Modify `apps/web/src/components/ThreadTerminalDrawer.tsx`: consume resolved theme, track launch theme, preserve Codex palette, and invoke explicit restart.
- Modify `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`: renderer/env/restart integration coverage.
- Modify `apps/server/src/terminal/osc.rs`: exact Codex batched-probe regression coverage.
- Modify `apps/server/src/terminal/pty.rs`: start and readiness-handshake the raw output loop before post-spawn identity work.
- Modify `apps/server/tests/windows_terminal_shims.rs`: real ConPTY child probe with the same bounded response window as Codex.

---

### Task 1: Centralize resolved terminal colors and spawn environment

**Files:**
- Create: `apps/web/src/components/terminalTheme.ts`
- Create: `apps/web/src/components/terminalTheme.test.ts`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:397-500,664-703`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx:360-430,1515-1575`

**Interfaces:**
- Produces: `TerminalThemeMode`, `terminalOscColorEnv(mode)`, `mergeTerminalSpawnEnv(input)`, and `isCodexTerminalCommand(command)`.
- Consumes later: Task 3 uses the same helpers to decide whether live repaint is safe.

- [ ] **Step 1: Write failing pure helper tests**

Create `apps/web/src/components/terminalTheme.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  isCodexTerminalCommand,
  mergeTerminalSpawnEnv,
  terminalOscColorEnv,
} from "./terminalTheme";

describe("terminal theme launch values", () => {
  it("maps resolved light and dark themes to exact OSC colors", () => {
    expect(terminalOscColorEnv("light")).toEqual({
      T4CODE_OSC_BACKGROUND: "255,255,255",
      T4CODE_OSC_FOREGROUND: "28,33,41",
      T4CODE_OSC_CURSOR: "38,56,78",
    });
    expect(terminalOscColorEnv("dark")).toEqual({
      T4CODE_OSC_BACKGROUND: "14,18,24",
      T4CODE_OSC_FOREGROUND: "237,241,247",
      T4CODE_OSC_CURSOR: "180,203,255",
    });
  });

  it("keeps runtime env precedence while protecting reserved theme keys", () => {
    expect(
      mergeTerminalSpawnEnv({
        commandEnv: { SHARED: "command", COMMAND_ONLY: "yes", T4CODE_OSC_BACKGROUND: "0,0,0" },
        runtimeEnv: { SHARED: "runtime", RUNTIME_ONLY: "yes", T4CODE_OSC_FOREGROUND: "0,0,0" },
        resolvedTheme: "light",
      }),
    ).toEqual({
      SHARED: "runtime",
      COMMAND_ONLY: "yes",
      RUNTIME_ONLY: "yes",
      T4CODE_OSC_BACKGROUND: "255,255,255",
      T4CODE_OSC_FOREGROUND: "28,33,41",
      T4CODE_OSC_CURSOR: "38,56,78",
    });
  });

  it("recognizes configured Codex binaries without classifying other providers", () => {
    expect(
      isCodexTerminalCommand({
        executable: "C:\\tools\\codex.exe",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
      }),
    ).toBe(true);
    expect(
      isCodexTerminalCommand({ executable: "C:\\tools\\my-codex-wrapper.cmd", args: [] }),
    ).toBe(true);
    expect(isCodexTerminalCommand({ executable: "claude", args: [] })).toBe(false);
    expect(isCodexTerminalCommand(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the helper test and confirm RED**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts --project unit
```

Expected: FAIL because `terminalTheme.ts` does not exist.

- [ ] **Step 3: Implement the pure theme helper**

Create `apps/web/src/components/terminalTheme.ts`:

```ts
import type { TerminalLaunchCommand } from "@t4code/contracts";

export type TerminalThemeMode = "light" | "dark";

const TERMINAL_OSC_COLORS = {
  dark: { background: "14,18,24", foreground: "237,241,247", cursor: "180,203,255" },
  light: { background: "255,255,255", foreground: "28,33,41", cursor: "38,56,78" },
} as const;

export function terminalOscColorEnv(mode: TerminalThemeMode): Record<string, string> {
  const colors = TERMINAL_OSC_COLORS[mode];
  return {
    T4CODE_OSC_BACKGROUND: colors.background,
    T4CODE_OSC_FOREGROUND: colors.foreground,
    T4CODE_OSC_CURSOR: colors.cursor,
  };
}

export function mergeTerminalSpawnEnv(input: {
  readonly commandEnv?: Readonly<Record<string, string>>;
  readonly runtimeEnv?: Readonly<Record<string, string>>;
  readonly resolvedTheme: TerminalThemeMode;
}): Record<string, string> {
  return {
    ...input.commandEnv,
    ...input.runtimeEnv,
    ...terminalOscColorEnv(input.resolvedTheme),
  };
}

export function isCodexTerminalCommand(command: TerminalLaunchCommand | undefined): boolean {
  if (!command) return false;
  const executable = command.executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  return (
    executable === "codex" ||
    executable === "codex.exe" ||
    executable.includes("codex") ||
    command.args.includes("--dangerously-bypass-approvals-and-sandbox")
  );
}
```

- [ ] **Step 4: Wire `TerminalViewport` to `useTheme().resolvedTheme`**

In `ThreadTerminalDrawer.tsx`:

```ts
import { useTheme } from "../hooks/useTheme";
import {
  isCodexTerminalCommand,
  mergeTerminalSpawnEnv,
  type TerminalThemeMode,
} from "./terminalTheme";
```

Delete the local `TERMINAL_OSC_COLORS` and zero-argument `terminalOscColorEnv`. Inside `TerminalViewport`, add:

```ts
const { resolvedTheme } = useTheme();
const isCodexTerminal = isCodexTerminalCommand(command);
const spawnEnv = useMemo(() => {
  const merged = mergeTerminalSpawnEnv({
    commandEnv: command?.env,
    runtimeEnv,
    resolvedTheme,
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}, [command, resolvedTheme, runtimeEnv]);
```

Change `terminalThemeFromApp` to accept an explicit mode instead of reading the DOM for dark/light selection:

```ts
function terminalThemeFromApp(
  resolvedTheme: TerminalThemeMode,
  mountElement?: HTMLElement | null,
): ITheme {
  const isDark = resolvedTheme === "dark";
  // Keep the existing palette body unchanged below this line.
```

Pass `resolvedTheme` at every call site for now. Task 3 will replace it with the retained launch theme for running Codex processes.

- [ ] **Step 5: Update the interaction harness to control the reactive theme**

Import `type TerminalThemeMode` from `./terminalTheme`, add
`resolvedTheme: "light" as TerminalThemeMode` to `testState`, mock `useTheme`, and
reset it in `beforeEach`:

```ts
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: testState.resolvedTheme }),
}));
```

Change the existing OSC env test to set `testState.resolvedTheme` rather than mutating only the DOM, and add an assertion that a stale dark DOM class cannot override a reactive light launch:

```tsx
testState.resolvedTheme = "light";
document.documentElement.classList.add("dark");
await mount(<TerminalViewport {...viewportProps()} />);
expect((testState.attachedSessionInputs.at(-1) as { terminal: { env: Record<string, string> } })
  .terminal.env.T4CODE_OSC_BACKGROUND).toBe("255,255,255");
```

- [ ] **Step 6: Run focused web tests and confirm GREEN**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx --project unit
```

Expected: PASS.

- [ ] **Step 7: Commit the resolved-theme launch path**

```powershell
git add apps/web/src/components/terminalTheme.ts apps/web/src/components/terminalTheme.test.ts apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
git commit -m "fix(web): derive terminal launch colors from resolved theme"
```

### Task 2: Answer Codex's bounded OSC probe before post-spawn work

**Files:**
- Modify: `apps/server/src/terminal/osc.rs:306-435`
- Modify: `apps/server/src/terminal/pty.rs:227-345,505-551`
- Modify: `apps/server/tests/windows_terminal_shims.rs`

**Interfaces:**
- Consumes: reserved `T4CODE_OSC_FOREGROUND`, `T4CODE_OSC_BACKGROUND`, and `T4CODE_OSC_CURSOR` launch values.
- Produces: readiness-handshaken `read_output` startup before process identity sampling; exact paired OSC replies.

- [ ] **Step 1: Add the exact batched Codex scanner regression**

In `apps/server/src/terminal/osc.rs` tests, add:

```rust
#[test]
fn answers_codex_batched_startup_probe_with_both_colors() {
    let mut responder = OscColorResponder::new(OscColors {
        foreground: Some([28, 33, 41]),
        background: Some([255, 255, 255]),
        cursor: Some([38, 56, 78]),
    });
    let query = b"\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c";

    assert_eq!(
        responder.process(query),
        b"\x1b]10;rgb:1c1c/2121/2929\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\"
    );
}

#[test]
fn answers_codex_batched_probe_across_every_chunk_boundary() {
    let query = b"\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\";
    let expected = b"\x1b]10;rgb:1c1c/2121/2929\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
    for split in 1..query.len() {
        let mut responder = OscColorResponder::new(OscColors {
            foreground: Some([28, 33, 41]),
            background: Some([255, 255, 255]),
            cursor: None,
        });
        let mut reply = responder.process(&query[..split]);
        reply.extend(responder.process(&query[split..]));
        assert_eq!(reply, expected, "split at byte {split}");
    }
}
```

- [ ] **Step 2: Run the OSC unit tests**

```powershell
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::osc::tests -- --nocapture
```

Expected: the exact parser tests PASS, proving the parser itself is not the timing defect. This is a characterization test, not the RED integration test.

- [ ] **Step 3: Add a failing real ConPTY bounded-probe test**

In `apps/server/tests/windows_terminal_shims.rs`, add a PowerShell child that emits the same paired query immediately and waits no longer than Codex's 100 ms budget:

```rust
const CODEX_OSC_MARKER: &str = "T4CODE_CODEX_OSC_LIGHT";

#[tokio::test]
async fn portable_backend_answers_codex_palette_probe_inside_startup_budget() {
    let directory = tempfile::tempdir().unwrap();
    let script = format!(
        r#"
$output = [Console]::OpenStandardOutput()
$input = [Console]::OpenStandardInput()
$query = [Text.Encoding]::ASCII.GetBytes("$([char]27)]10;?$([char]27)\$([char]27)]11;?$([char]27)\")
$output.Write($query, 0, $query.Length)
$output.Flush()
$buffer = [byte[]]::new(256)
$read = $input.ReadAsync($buffer, 0, $buffer.Length)
if (-not $read.Wait(100)) {{ exit 90 }}
$reply = [Text.Encoding]::ASCII.GetString($buffer, 0, $read.Result)
if ($reply.Contains("10;rgb:1c1c/2121/2929") -and $reply.Contains("11;rgb:ffff/ffff/ffff")) {{
  [Console]::WriteLine("{CODEX_OSC_MARKER}")
  exit 0
}}
exit 91
"#
    );
    let process = PortablePtyBackend
        .spawn(&PtySpawnInput {
            executable: "powershell.exe".to_owned(),
            args: vec![
                "-NoLogo".to_owned(),
                "-NoProfile".to_owned(),
                "-NonInteractive".to_owned(),
                "-EncodedCommand".to_owned(),
                powershell_encoded_command(&script),
            ],
            cwd: directory.path().to_path_buf(),
            cols: 80,
            rows: 24,
            env: BTreeMap::from([
                ("T4CODE_OSC_FOREGROUND".to_owned(), "28,33,41".to_owned()),
                ("T4CODE_OSC_BACKGROUND".to_owned(), "255,255,255".to_owned()),
                ("T4CODE_OSC_CURSOR".to_owned(), "38,56,78".to_owned()),
            ]),
        })
        .unwrap();
    let mut output = process.subscribe_output();
    let mut exit = process.subscribe_exit();
    let text = tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while !text.contains(CODEX_OSC_MARKER) && exit.borrow().is_none() {
            tokio::select! {
                received = output.recv() => text.push_str(&received.unwrap()),
                changed = exit.changed() => { changed.unwrap(); }
            }
        }
        text
    })
    .await
    .unwrap();
    assert!(text.contains(CODEX_OSC_MARKER), "output={text:?}, exit={:?}", exit.borrow().clone());
}
```

- [ ] **Step 4: Run the Windows integration test and confirm RED**

```powershell
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --test windows_terminal_shims portable_backend_answers_codex_palette_probe_inside_startup_budget -- --exact --nocapture
```

Expected: FAIL with exit code 90 or missing `T4CODE_CODEX_OSC_LIGHT`, demonstrating the responder starts too late for the bounded child probe.

- [ ] **Step 5: Move output-loop startup ahead of process identity sampling**

In `PortablePtyBackend::spawn_command`, keep child creation guarded, but move `retain_captured_identity_if_child_live(...)` below reader/writer creation and the output-thread readiness handshake. Use:

```rust
let (output, _) = broadcast::channel(256);
let (exit, _) = watch::channel(None);
let (resize, resize_requests) = mpsc::sync_channel(1);
let osc_responder = {
    let colors = colors_from_env(&input.env);
    (!colors.is_empty()).then(|| (OscColorResponder::new(colors), Arc::clone(&writer)))
};
let (output_ready, output_ready_rx) = std::sync::mpsc::sync_channel(0);
let output_sender = output.clone();
thread::Builder::new()
    .name(format!("t4code-pty-output-{pid}"))
    .spawn(move || {
        let _ = output_ready.send(());
        read_output(&mut reader, &output_sender, osc_responder);
    })
    .map_err(|error| error.to_string())?;
output_ready_rx
    .recv()
    .map_err(|_| "PTY output reader stopped before becoming ready".to_string())?;

let process_identity = retain_captured_identity_if_child_live(
    child.child_mut(),
    NativeProcessSampler::process_identity(pid).ok(),
);
```

Do not change raw-byte scanning, UTF-8 decoding, writer locking, history publication, resize, or exit handling.

- [ ] **Step 6: Run server tests and confirm GREEN**

```powershell
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::osc::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --test windows_terminal_shims portable_backend_answers_codex_palette_probe_inside_startup_budget -- --exact --nocapture
```

Expected: PASS; the integration child prints `T4CODE_CODEX_OSC_LIGHT` and exits 0.

- [ ] **Step 7: Commit the PTY timing fix**

```powershell
git add apps/server/src/terminal/osc.rs apps/server/src/terminal/pty.rs apps/server/tests/windows_terminal_shims.rs
git commit -m "fix(server): answer Codex terminal palette probe promptly"
```

### Task 3: Keep running Codex palettes coherent and offer explicit restart

**Files:**
- Modify: `apps/web/src/components/ThreadTerminalDrawer.tsx:598-703,770-1180,1400-1435`
- Modify: `apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx`
- Modify: `apps/web/src/components/terminalTheme.ts`
- Modify: `apps/web/src/components/terminalTheme.test.ts`

**Interfaces:**
- Consumes: `isCodexTerminalCommand`, `mergeTerminalSpawnEnv`, `terminalThemeFromApp(mode, mount)`, `terminalEnvironment.restart`.
- Produces: launch-theme retention keyed by terminal generation and an explicit restart control.

- [ ] **Step 1: Add failing helper and viewport tests**

Extend `terminalTheme.test.ts` with:

```ts
import { retainTerminalLaunchTheme } from "./terminalTheme";

it("retains a Codex launch theme until the terminal generation changes", () => {
  const initial = retainTerminalLaunchTheme(null, {
    codex: true,
    generation: 4,
    resolvedTheme: "dark",
  });
  expect(
    retainTerminalLaunchTheme(initial, {
      codex: true,
      generation: 4,
      resolvedTheme: "light",
    }),
  ).toEqual({ generation: 4, theme: "dark" });
  expect(
    retainTerminalLaunchTheme(initial, {
      codex: true,
      generation: 5,
      resolvedTheme: "light",
    }),
  ).toEqual({ generation: 5, theme: "light" });
});
```

Add `restartCommand: vi.fn()` to `testState`, expose `terminalEnvironment.restart`, and route it from the `useAtomCommand` mock. Then add an interaction test:

```tsx
it("keeps a running Codex launch palette until explicit theme restart", async () => {
  testState.resolvedTheme = "dark";
  const props = viewportProps({
    terminalLabel: "Codex Terminal",
    command: decodeTerminalLaunchCommand({
      executable: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    })!,
  });
  const mounted = await mount(<TerminalViewport {...props} />);
  const terminal = xtermState.terminals[0]!;

  testState.resolvedTheme = "light";
  document.documentElement.classList.remove("dark");
  await act(async () => mounted.root.render(<TerminalViewport {...props} />));

  expect((terminal.options.theme as { background: string }).background).toContain("14, 18, 24");
  const apply = buttonByLabel("Restart Codex Terminal to apply Light theme");
  await click(apply);

  expect(testState.restartCommand).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: expect.objectContaining({
      threadId: THREAD_ID,
      terminalId: "term-1",
      cwd: "/repo",
      command: props.command,
      env: expect.objectContaining({ T4CODE_OSC_BACKGROUND: "255,255,255" }),
    }),
  });
});
```

Add a companion non-Codex test asserting a Claude command repaints without showing the restart button.
Add a separate dismissal test so closing the notice never invokes restart:

```tsx
it("dismisses the Codex theme notice without restarting the process", async () => {
  testState.resolvedTheme = "dark";
  const props = viewportProps({
    terminalLabel: "Codex Terminal",
    command: decodeTerminalLaunchCommand({
      executable: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
    })!,
  });
  const mounted = await mount(<TerminalViewport {...props} />);
  testState.resolvedTheme = "light";
  await act(async () => mounted.root.render(<TerminalViewport {...props} />));

  await click(buttonByLabel("Dismiss terminal theme notice"));

  expect(testState.restartCommand).not.toHaveBeenCalled();
  expect(document.querySelector('button[aria-label^="Restart Codex Terminal"]')).toBeNull();
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx --project unit
```

Expected: FAIL because launch-theme retention, restart command wiring, and the notice do not exist.

- [ ] **Step 3: Add the pure launch-theme transition**

In `terminalTheme.ts` add:

```ts
export interface TerminalLaunchThemeState {
  readonly generation: number;
  readonly theme: TerminalThemeMode;
}

export function retainTerminalLaunchTheme(
  previous: TerminalLaunchThemeState | null,
  input: {
    readonly codex: boolean;
    readonly generation: number;
    readonly resolvedTheme: TerminalThemeMode;
  },
): TerminalLaunchThemeState {
  if (!input.codex || previous === null || previous.generation !== input.generation) {
    return { generation: input.generation, theme: input.resolvedTheme };
  }
  return previous;
}
```

- [ ] **Step 4: Track the effective palette per generation**

Inside `TerminalViewport`:

```ts
const launchThemeRef = useRef<TerminalLaunchThemeState | null>(null);
launchThemeRef.current = retainTerminalLaunchTheme(launchThemeRef.current, {
  codex: isCodexTerminal,
  generation: terminalGeneration,
  resolvedTheme,
});
const effectiveTerminalTheme = isCodexTerminal
  ? launchThemeRef.current.theme
  : resolvedTheme;
const effectiveTerminalThemeRef = useRef(effectiveTerminalTheme);
effectiveTerminalThemeRef.current = effectiveTerminalTheme;
const codexThemeMismatch =
  isCodexTerminal && terminalStatus === "running" && effectiveTerminalTheme !== resolvedTheme;
```

Use `effectiveTerminalTheme` for xterm creation and theme refresh. Add a small effect keyed by it so a successful restart generation applies the new palette even when the DOM class no longer changes:

```ts
useEffect(() => {
  const terminal = terminalRef.current;
  if (!terminal) return;
  const nextTheme = terminalThemeFromApp(effectiveTerminalTheme, containerRef.current);
  if (terminal.options.theme && terminalThemesEqual(terminal.options.theme, nextTheme)) return;
  terminal.options.theme = nextTheme;
  terminal.refresh(0, terminal.rows - 1);
}, [effectiveTerminalTheme]);
```

The existing `MutationObserver` must call
`terminalThemeFromApp(effectiveTerminalThemeRef.current, ...)`. Do not capture
`effectiveTerminalTheme` directly in the renderer effect: that closure would be
stale after a non-Codex live theme change and could repaint the old palette over
the newer one.

- [ ] **Step 5: Add the explicit restart command and notice**

Create the restart command and local pending/error state:

```ts
const runTerminalRestart = useAtomCommand(terminalEnvironment.restart, { reportFailure: false });
const [themeRestartPending, setThemeRestartPending] = useState(false);
const [themeRestartError, setThemeRestartError] = useState<string | null>(null);
const [dismissedThemeNotice, setDismissedThemeNotice] = useState<{
  readonly generation: number;
  readonly targetTheme: TerminalThemeMode;
} | null>(null);
const showCodexThemeNotice =
  codexThemeMismatch &&
  (dismissedThemeNotice === null ||
    dismissedThemeNotice.generation !== terminalGeneration ||
    dismissedThemeNotice.targetTheme !== resolvedTheme);

const restartForTheme = useCallback(() => {
  const terminal = terminalRef.current;
  if (!terminal || themeRestartPending) return;
  setThemeRestartPending(true);
  setThemeRestartError(null);
  void runTerminalRestart({
    environmentId,
    input: {
      threadId,
      terminalId,
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      cols: terminal.cols,
      rows: terminal.rows,
      ...(spawnEnv ? { env: spawnEnv } : {}),
      ...(command ? { command } : {}),
    },
  }).then((result) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThemeRestartError(error instanceof Error ? error.message : "Unable to restart terminal");
    }
  }).catch((cause: unknown) => {
    setThemeRestartError(cause instanceof Error ? cause.message : "Unable to restart terminal");
  }).finally(() => setThemeRestartPending(false));
}, [command, cwd, environmentId, runTerminalRestart, spawnEnv, terminalId, themeRestartPending, threadId, worktreePath]);
```

Render inside the terminal container:

```tsx
{showCodexThemeNotice ? (
  <div className="absolute top-2 right-2 z-10 flex max-w-sm items-center gap-2 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md">
    <span>Codex cached the previous terminal theme.</span>
    <Button
      type="button"
      size="xs"
      disabled={themeRestartPending}
      aria-label={`Restart Codex Terminal to apply ${resolvedTheme === "light" ? "Light" : "Dark"} theme`}
      onClick={restartForTheme}
    >
      {themeRestartPending ? "Restarting…" : "Restart to apply"}
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Dismiss terminal theme notice"
      disabled={themeRestartPending}
      onClick={() =>
        setDismissedThemeNotice({ generation: terminalGeneration, targetTheme: resolvedTheme })
      }
    >
      <XIcon className="size-3.5" />
    </Button>
    {themeRestartError ? <span role="alert" className="text-destructive">{themeRestartError}</span> : null}
  </div>
) : null}
```

Import the existing `Button` component. Do not restart from an effect.

- [ ] **Step 6: Run focused web tests and confirm GREEN**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx src/components/ThreadTerminalDrawer.test.tsx --project unit
```

Expected: PASS; Codex retains its launch palette until the explicit restart, and non-Codex terminals repaint live.

- [ ] **Step 7: Commit the guarded live-theme behavior**

```powershell
git add apps/web/src/components/terminalTheme.ts apps/web/src/components/terminalTheme.test.ts apps/web/src/components/ThreadTerminalDrawer.tsx apps/web/src/components/ThreadTerminalDrawer.interactions.test.tsx
git commit -m "fix(web): guard Codex terminal theme changes"
```

### Task 4: Verify terminal behavior and repository gates

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: focused web/Rust evidence and mandatory repository gate results.

- [ ] **Step 1: Run all focused terminal tests**

```powershell
corepack pnpm --filter @t4code/web exec vp test run src/components/terminalTheme.test.ts src/components/ThreadTerminalDrawer.interactions.test.tsx src/components/ThreadTerminalDrawer.test.tsx --project unit
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::osc::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --lib terminal::pty::tests -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p t4code-server --test windows_terminal_shims -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: Run the built-in frontend test suite**

```powershell
vp test
```

Expected: PASS.

- [ ] **Step 3: Run mandatory repository checks**

```powershell
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 4: Perform the Windows desktop smoke check**

1. Set T4Code to Light theme before opening a Codex Terminal.
2. Open a new Codex Terminal and verify the composer background is light, not black.
3. Switch T4Code to Dark and verify the running terminal remains entirely light with the restart notice rather than becoming mixed.
4. Activate **Restart to apply** and verify the restarted Codex Terminal is entirely dark.
5. Repeat Dark → Light.
6. Open Claude and Cursor terminals and verify they retain live xterm theme updates.

Expected: no mixed-palette rectangle and no automatic Codex process restart.

- [ ] **Step 5: Confirm repository cleanliness**

```powershell
git status --short
git diff --check
```

Expected: no unintended changes or whitespace errors.
