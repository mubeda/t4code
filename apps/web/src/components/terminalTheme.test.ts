import { describe, expect, it } from "vite-plus/test";
import {
  mergeTerminalSpawnEnv,
  retainTerminalLaunchTheme,
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

  it("replaces exact reserved keys with authoritative values inserted last", () => {
    const merged = mergeTerminalSpawnEnv({
      commandEnv: {
        SHARED: "command",
        COMMAND_ONLY: "yes",
        T4CODE_OSC_BACKGROUND: "0,0,0",
        T4CODE_WINDOWS_CONSOLE_THEME: "command",
      },
      runtimeEnv: {
        SHARED: "runtime",
        RUNTIME_ONLY: "yes",
        T4CODE_OSC_FOREGROUND: "0,0,0",
        T4CODE_OSC_CURSOR: "0,0,0",
        T4CODE_WINDOWS_CONSOLE_THEME: "runtime",
      },
      resolvedTheme: "light",
      windowsConsoleTheme: true,
    });

    expect(merged).toEqual({
      SHARED: "runtime",
      COMMAND_ONLY: "yes",
      RUNTIME_ONLY: "yes",
      T4CODE_OSC_BACKGROUND: "255,255,255",
      T4CODE_OSC_FOREGROUND: "28,33,41",
      T4CODE_OSC_CURSOR: "38,56,78",
      T4CODE_WINDOWS_CONSOLE_THEME: "light",
    });
    expect(Object.keys(merged).slice(-4)).toEqual([
      "T4CODE_OSC_BACKGROUND",
      "T4CODE_OSC_FOREGROUND",
      "T4CODE_OSC_CURSOR",
      "T4CODE_WINDOWS_CONSOLE_THEME",
    ]);
  });

  it("preserves differently cased variables for case-sensitive platforms", () => {
    expect(
      mergeTerminalSpawnEnv({
        commandEnv: {
          t4code_osc_foreground: "command-lowercase",
          T4Code_Osc_Cursor: "command-mixed-case",
          t4code_windows_console_theme: "command-lowercase",
        },
        runtimeEnv: {
          t4code_osc_background: "runtime-lowercase",
          T4Code_Windows_Console_Theme: "runtime-mixed-case",
        },
        resolvedTheme: "light",
        windowsConsoleTheme: true,
      }),
    ).toEqual({
      t4code_osc_foreground: "command-lowercase",
      T4Code_Osc_Cursor: "command-mixed-case",
      t4code_windows_console_theme: "command-lowercase",
      t4code_osc_background: "runtime-lowercase",
      T4Code_Windows_Console_Theme: "runtime-mixed-case",
      T4CODE_OSC_BACKGROUND: "255,255,255",
      T4CODE_OSC_FOREGROUND: "28,33,41",
      T4CODE_OSC_CURSOR: "38,56,78",
      T4CODE_WINDOWS_CONSOLE_THEME: "light",
    });
  });

  it("omits the Windows console theme when it is not requested", () => {
    expect(
      mergeTerminalSpawnEnv({
        commandEnv: { T4CODE_WINDOWS_CONSOLE_THEME: "command" },
        runtimeEnv: { T4CODE_WINDOWS_CONSOLE_THEME: "runtime" },
        resolvedTheme: "dark",
        windowsConsoleTheme: false,
      }),
    ).toEqual({
      T4CODE_OSC_BACKGROUND: "14,18,24",
      T4CODE_OSC_FOREGROUND: "237,241,247",
      T4CODE_OSC_CURSOR: "180,203,255",
    });
  });

  it("retains a Codex launch theme until the terminal generation changes", () => {
    const initial = retainTerminalLaunchTheme(null, {
      persistentConsoleTheme: true,
      generation: 4,
      resolvedTheme: "dark",
    });

    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: true,
        generation: 4,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 4, theme: "dark" });
    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: true,
        generation: 5,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 5, theme: "light" });
  });

  it("uses the requested process theme when that restart advances the generation", () => {
    const previous = { generation: 4, theme: "dark" } as const;

    expect(
      retainTerminalLaunchTheme(previous, {
        persistentConsoleTheme: true,
        generation: 5,
        resolvedTheme: "dark",
        restartRequest: { sourceGeneration: 4, targetTheme: "light" },
      }),
    ).toEqual({ generation: 5, theme: "light" });
  });

  it("tracks the resolved theme live for non-Codex terminals", () => {
    const initial = retainTerminalLaunchTheme(null, {
      persistentConsoleTheme: false,
      generation: 4,
      resolvedTheme: "dark",
    });

    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: false,
        generation: 4,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 4, theme: "light" });
  });
});
