export type TerminalThemeMode = "light" | "dark";

export interface TerminalLaunchThemeState {
  readonly generation: number;
  readonly theme: TerminalThemeMode;
}

const TERMINAL_OSC_COLORS = {
  dark: { background: "14,18,24", foreground: "237,241,247", cursor: "180,203,255" },
  light: { background: "255,255,255", foreground: "28,33,41", cursor: "38,56,78" },
} as const;

const WINDOWS_CONSOLE_THEME = "T4CODE_WINDOWS_CONSOLE_THEME";
const RESERVED_TERMINAL_THEME_ENV = new Set([
  "T4CODE_OSC_BACKGROUND",
  "T4CODE_OSC_FOREGROUND",
  "T4CODE_OSC_CURSOR",
  WINDOWS_CONSOLE_THEME,
]);

function withoutReservedTerminalThemeEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !RESERVED_TERMINAL_THEME_ENV.has(key)),
  );
}

export function terminalOscColorEnv(mode: TerminalThemeMode): Record<string, string> {
  const colors = TERMINAL_OSC_COLORS[mode];
  return {
    T4CODE_OSC_BACKGROUND: colors.background,
    T4CODE_OSC_FOREGROUND: colors.foreground,
    T4CODE_OSC_CURSOR: colors.cursor,
  };
}

export function mergeTerminalSpawnEnv(input: {
  readonly commandEnv?: Readonly<Record<string, string>> | undefined;
  readonly runtimeEnv?: Readonly<Record<string, string>> | undefined;
  readonly resolvedTheme: TerminalThemeMode;
  readonly windowsConsoleTheme: boolean;
}): Record<string, string> {
  return {
    ...withoutReservedTerminalThemeEnv(input.commandEnv),
    ...withoutReservedTerminalThemeEnv(input.runtimeEnv),
    ...terminalOscColorEnv(input.resolvedTheme),
    ...(input.windowsConsoleTheme ? { [WINDOWS_CONSOLE_THEME]: input.resolvedTheme } : {}),
  };
}

export function retainTerminalLaunchTheme(
  previous: TerminalLaunchThemeState | null,
  input: {
    readonly persistentConsoleTheme: boolean;
    readonly generation: number;
    readonly resolvedTheme: TerminalThemeMode;
    readonly authoritativeTheme?: TerminalThemeMode | null;
    readonly restartRequest?: {
      readonly sourceGeneration: number;
      readonly targetTheme: TerminalThemeMode;
    } | null;
  },
): TerminalLaunchThemeState {
  if (
    input.persistentConsoleTheme &&
    input.authoritativeTheme !== null &&
    input.authoritativeTheme !== undefined
  ) {
    return { generation: input.generation, theme: input.authoritativeTheme };
  }
  if (!input.persistentConsoleTheme || previous === null) {
    return { generation: input.generation, theme: input.resolvedTheme };
  }
  if (previous.generation !== input.generation) {
    const requestedTheme =
      input.restartRequest !== null &&
      input.restartRequest !== undefined &&
      input.generation > input.restartRequest.sourceGeneration
        ? input.restartRequest.targetTheme
        : input.resolvedTheme;
    return { generation: input.generation, theme: requestedTheme };
  }
  return previous;
}
