import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface AlertButton {
  readonly text: string;
  readonly style?: string;
  readonly onPress?: () => void;
}

const h = vi.hoisted(() => ({
  hasCloudPublicConfig: true,
  isLoaded: true,
  isSignedIn: true,
  user: null as { primaryEmailAddress: { emailAddress: string } | null } | null,
  savedConnectionsById: {} as Record<string, { environmentId: string; environmentLabel: string }>,
  getTokenImpl: (async () => "clerk-token") as (options?: unknown) => Promise<string | null>,
  getPermissionsImpl: (async () => ({ granted: true })) as () => Promise<{ granted: boolean }>,
  preferencesImpl: (async () => ({})) as () => Promise<Record<string, unknown>>,
  exit: null as unknown,
  interrupted: false,
  squashed: null as unknown,
  effects: [] as Array<() => void | (() => void)>,
  pressables: [] as Array<Record<string, unknown>>,
  switches: [] as Array<Record<string, unknown>>,
  alerts: [] as Array<{ title: string; message?: string; buttons?: ReadonlyArray<AlertButton> }>,
  openSettingsCalls: [] as Array<number>,
  routerPush: [] as Array<unknown>,
  expandClerk: [] as Array<number>,
  reports: [] as Array<string | null>,
  runEffectArgs: [] as Array<unknown>,
  liveActivityInputs: [] as Array<Record<string, unknown>>,
  managedRefreshes: [] as Array<number>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((initial?: unknown) => {
      const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [
        value,
        (next: unknown) => {
          if (typeof next === "function") (next as (prev: unknown) => unknown)(value);
        },
      ];
    }) as typeof actual.useState,
    useEffect: ((effect: () => void | (() => void)) => {
      h.effects.push(effect);
    }) as typeof actual.useEffect,
  };
});

vi.mock("@clerk/expo", () => ({
  useAuth: (_options?: unknown) => ({
    getToken: (options?: unknown) => h.getTokenImpl(options),
    isLoaded: h.isLoaded,
    isSignedIn: h.isSignedIn,
  }),
  useUser: () => ({ user: h.user }),
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: () => h.getPermissionsImpl(),
}));

vi.mock("expo-router", () => ({
  Link: (props: { readonly children?: ReactNode }) => <>{props.children}</>,
  Stack: { Screen: () => null },
  useRouter: () => ({ push: (target: unknown) => h.routerPush.push(target) }),
}));

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message?: string, buttons?: ReadonlyArray<AlertButton>) => {
      h.alerts.push({ title, message, buttons });
    },
  },
  Linking: {
    openSettings: () => {
      h.openSettingsCalls.push(1);
      return Promise.resolve();
    },
  },
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return (
      <button type="button" data-a11y={String(props["accessibilityLabel"] ?? "")}>
        {props.children}
      </button>
    );
  },
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Switch: (props: Record<string, unknown>) => {
    h.switches.push(props);
    return <i data-switch={String(props["value"])} />;
  },
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 12, left: 0, right: 0 }),
}));

vi.mock("@t3tools/client-runtime/state/runtime", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  const Cause = await import("effect/Cause");
  return {
    settlePromise: async (execute: () => Promise<unknown>) => {
      try {
        return AsyncResult.success(await execute());
      } catch (defect) {
        return AsyncResult.failure(Cause.die(defect));
      }
    },
    settleAsyncResult: async (execute: () => Promise<Exit.Exit<unknown, unknown>>) => {
      try {
        return AsyncResult.fromExit(await execute());
      } catch (defect) {
        return AsyncResult.failure(Cause.die(defect));
      }
    },
    reportAtomCommandResult: (_result: unknown, options?: { label?: string }) => {
      h.reports.push(options?.label ?? null);
    },
    isAtomCommandInterrupted: () => h.interrupted,
    squashAtomCommandFailure: () => h.squashed,
  };
});

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("../../features/agent-awareness/liveActivityPreferences", async () => {
  const Effect = await import("effect/Effect");
  return {
    setLiveActivityUpdatesEnabled: (input: Record<string, unknown>) => {
      h.liveActivityInputs.push(input);
      return Effect.void;
    },
  };
});

vi.mock("../../features/agent-awareness/notificationPermissions", async () => {
  const Effect = await import("effect/Effect");
  return { requestAgentNotificationPermission: Effect.succeed({ type: "granted" }) };
});

vi.mock("../../features/agent-awareness/remoteRegistration", async () => {
  const Effect = await import("effect/Effect");
  return { refreshAgentAwarenessRegistration: () => Effect.void };
});

vi.mock("../../features/cloud/managedRelayState", () => ({
  refreshManagedRelayEnvironments: () => {
    h.managedRefreshes.push(1);
  },
}));

vi.mock("../../features/cloud/ClerkSettingsSheetDetent", () => ({
  useClerkSettingsSheetDetent: () => ({
    expand: () => {
      h.expandClerk.push(1);
    },
  }),
}));

vi.mock("../../features/cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => h.hasCloudPublicConfig,
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (effect: unknown) => {
      h.runEffectArgs.push(effect);
      return Promise.resolve(h.exit);
    },
  },
}));

vi.mock("../../lib/storage", () => ({
  loadPreferences: () => h.preferencesImpl(),
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#123456",
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: h.savedConnectionsById }),
}));

import SettingsRouteScreen from "./index";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

function renderScreen(): string {
  h.effects.length = 0;
  h.pressables.length = 0;
  h.switches.length = 0;
  return renderToStaticMarkup(<SettingsRouteScreen />);
}

function runEffects(): void {
  const effects = [...h.effects];
  h.effects.length = 0;
  for (const effect of effects) effect();
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function accountRowOnPress(): () => void {
  const row = h.pressables.find(
    (pressable) =>
      typeof pressable["onPress"] === "function" && pressable["accessibilityLabel"] === undefined,
  );
  if (!row) throw new Error("account row pressable not found");
  return row["onPress"] as () => void;
}

function deviceNotificationsSwitch(): (value: boolean) => void {
  return h.switches[0]!["onValueChange"] as (value: boolean) => void;
}

function liveActivitySwitch(): (value: boolean) => void {
  return h.switches[1]!["onValueChange"] as (value: boolean) => void;
}

function lastAlert(): { title: string; message?: string; buttons?: ReadonlyArray<AlertButton> } {
  const alert = h.alerts.at(-1);
  if (!alert) throw new Error("no alert recorded");
  return alert;
}

function pressAlertButton(text: string): void {
  const button = lastAlert().buttons?.find((candidate) => candidate.text === text);
  if (!button?.onPress) throw new Error(`alert button "${text}" not found`);
  button.onPress();
}

beforeEach(() => {
  h.hasCloudPublicConfig = true;
  h.isLoaded = true;
  h.isSignedIn = true;
  h.user = null;
  h.savedConnectionsById = {};
  h.getTokenImpl = async () => "clerk-token";
  h.getPermissionsImpl = async () => ({ granted: true });
  h.preferencesImpl = async () => ({});
  h.exit = Exit.succeed(undefined);
  h.interrupted = false;
  h.squashed = new Error("squash message");
  h.effects.length = 0;
  h.pressables.length = 0;
  h.switches.length = 0;
  h.alerts.length = 0;
  h.openSettingsCalls.length = 0;
  h.routerPush.length = 0;
  h.expandClerk.length = 0;
  h.reports.length = 0;
  h.runEffectArgs.length = 0;
  h.liveActivityInputs.length = 0;
  h.managedRefreshes.length = 0;
  delete process.env.EXPO_OS;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LocalSettingsRouteScreen", () => {
  it("renders the local settings sections when cloud config is absent", () => {
    h.hasCloudPublicConfig = false;
    h.savedConnectionsById = {
      "environment-1": { environmentId: "environment-1", environmentLabel: "Alpha" },
    };
    const markup = renderScreen();

    expect(markup).toContain("Configuration");
    expect(markup).toContain("Environments");
    expect(markup).toContain("Archived Threads");
    expect(markup).toContain("Version");
    expect(markup).toContain("Alpha");
    // The environment count reflects the saved connections.
    expect(markup).toContain(">1<");
    // Local screen has no account section.
    expect(markup).not.toContain("T4 Account");
  });
});

describe("ConfiguredSettingsRouteScreen account label", () => {
  it("shows Checking while auth is still loading", () => {
    h.isLoaded = false;
    const markup = renderScreen();
    expect(markup).toContain("Checking");
    expect(markup).toContain("T4 Account");
  });

  it("shows Request access when signed out", () => {
    h.isSignedIn = false;
    const markup = renderScreen();
    expect(markup).toContain("Request access");
  });

  it("shows the primary email address when signed in", () => {
    h.user = { primaryEmailAddress: { emailAddress: "dev@example.com" } };
    const markup = renderScreen();
    expect(markup).toContain("dev@example.com");
  });

  it("falls back to Signed in when the account has no email", () => {
    h.user = { primaryEmailAddress: null };
    const markup = renderScreen();
    expect(markup).toContain("Signed in");
  });
});

describe("ConfiguredSettingsRouteScreen notification effect", () => {
  it("marks notifications unsupported off iOS", async () => {
    renderScreen();
    runEffects();
    await flush();
    // No permission lookup happens off iOS; nothing to assert beyond no throw.
    expect(h.reports).toEqual([]);
  });

  it("marks notifications enabled when iOS grants permission", async () => {
    process.env.EXPO_OS = "ios";
    h.getPermissionsImpl = async () => ({ granted: true });
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toEqual([]);
  });

  it("reports a failed notification permission lookup", async () => {
    process.env.EXPO_OS = "ios";
    h.getPermissionsImpl = async () => {
      throw new Error("permission blew up");
    };
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toContain("notification permission refresh");
  });
});

describe("ConfiguredSettingsRouteScreen live activity effect", () => {
  it("stays in checking when auth has not loaded", async () => {
    h.isLoaded = false;
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toEqual([]);
  });

  it("marks live activities signed-out when not signed in", async () => {
    h.isSignedIn = false;
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toEqual([]);
  });

  it("loads the disabled preference for a signed-in account", async () => {
    h.preferencesImpl = async () => ({ liveActivitiesEnabled: false });
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toEqual([]);
  });

  it("reports a failed preference load", async () => {
    h.preferencesImpl = async () => {
      throw new Error("prefs blew up");
    };
    renderScreen();
    runEffects();
    await flush();
    expect(h.reports).toContain("live activity preference load");
  });
});

describe("ConfiguredSettingsRouteScreen device notifications switch", () => {
  it("requests permission and confirms when granted", async () => {
    h.exit = Exit.succeed({ type: "granted" });
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Notifications enabled");
  });

  it("explains that iOS-only notifications are unsupported", async () => {
    h.exit = Exit.succeed({ type: "unsupported" });
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Notifications unavailable");
  });

  it("notes when notifications can be requested again", async () => {
    h.exit = Exit.succeed({ type: "denied", canAskAgain: true });
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(lastAlert().message).toContain("were not enabled");
  });

  it("offers to open settings when notifications are permanently denied", async () => {
    h.exit = Exit.succeed({ type: "denied", canAskAgain: false });
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Notifications disabled");
    pressAlertButton("Open Settings");
    expect(h.openSettingsCalls).toHaveLength(1);
  });

  it("alerts when the permission request fails without interruption", async () => {
    h.exit = Exit.fail(new Error("request failed"));
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Notifications unavailable");
    expect(lastAlert().message).toBe("squash message");
  });

  it("swallows an interrupted permission request", async () => {
    h.exit = Exit.fail(new Error("interrupted"));
    h.interrupted = true;
    renderScreen();
    deviceNotificationsSwitch()(true);
    await flush();
    expect(h.alerts).toHaveLength(0);
  });

  it("prompts to open iOS settings when turning notifications off", () => {
    renderScreen();
    deviceNotificationsSwitch()(false);
    expect(lastAlert().title).toBe("Disable notifications");
    pressAlertButton("Open Settings");
    expect(h.openSettingsCalls).toHaveLength(1);
  });
});

describe("ConfiguredSettingsRouteScreen live activity switch", () => {
  it("prompts to sign in when enabling while signed out", () => {
    h.isSignedIn = false;
    renderScreen();
    liveActivitySwitch()(true);
    expect(lastAlert().title).toBe("Request T4 Cloud access");
    pressAlertButton("Continue");
    expect(h.routerPush).toContain("/settings/waitlist");
  });

  it("links environments and confirms with a plural summary when enabled", async () => {
    h.savedConnectionsById = {
      a: { environmentId: "a", environmentLabel: "A" },
      b: { environmentId: "b", environmentLabel: "B" },
    };
    h.exit = Exit.succeed(undefined);
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(h.liveActivityInputs.at(-1)).toMatchObject({ enabled: true, clerkToken: "clerk-token" });
    expect(h.managedRefreshes).toHaveLength(1);
    expect(lastAlert().title).toBe("Live Activities enabled");
    expect(lastAlert().message).toContain("2 environments linked");
  });

  it("confirms with a singular summary when exactly one environment is linked", async () => {
    h.savedConnectionsById = { a: { environmentId: "a", environmentLabel: "A" } };
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(lastAlert().message).toContain("1 environment linked");
  });

  it("confirms with an add-environment hint when none are linked", async () => {
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(lastAlert().message).toContain("Add an environment");
  });

  it("alerts when the clerk token lookup fails", async () => {
    h.getTokenImpl = async () => {
      throw new Error("no token");
    };
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Live Activities unavailable");
  });

  it("prompts to sign in when the clerk token is empty", async () => {
    h.getTokenImpl = async () => null;
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Request T4 Cloud access");
  });

  it("alerts when enabling live activities fails on the runtime", async () => {
    h.savedConnectionsById = { a: { environmentId: "a", environmentLabel: "A" } };
    h.exit = Exit.fail(new Error("update failed"));
    renderScreen();
    liveActivitySwitch()(true);
    await flush();
    expect(lastAlert().title).toBe("Live Activities unavailable");
  });

  it("disables live activities using a signed-in token", async () => {
    h.savedConnectionsById = { a: { environmentId: "a", environmentLabel: "A" } };
    renderScreen();
    liveActivitySwitch()(false);
    await flush();
    expect(h.liveActivityInputs.at(-1)).toMatchObject({
      enabled: false,
      clerkToken: "clerk-token",
    });
    expect(h.managedRefreshes).toHaveLength(1);
  });

  it("disables live activities without a token when signed out", async () => {
    h.isSignedIn = false;
    renderScreen();
    liveActivitySwitch()(false);
    await flush();
    expect(h.liveActivityInputs.at(-1)).toMatchObject({ enabled: false, clerkToken: null });
  });

  it("reports a failed token lookup while disabling", async () => {
    h.getTokenImpl = async () => {
      throw new Error("token failed");
    };
    renderScreen();
    liveActivitySwitch()(false);
    await flush();
    expect(h.reports).toContain("live activity disable token lookup");
    expect(h.liveActivityInputs).toHaveLength(0);
  });

  it("reports a failed disable runtime call", async () => {
    h.exit = Exit.fail(new Error("disable failed"));
    renderScreen();
    liveActivitySwitch()(false);
    await flush();
    expect(h.reports).toContain("live activity disable");
  });
});

describe("ConfiguredSettingsRouteScreen account row", () => {
  it("does nothing while auth is loading", () => {
    h.isLoaded = false;
    renderScreen();
    accountRowOnPress()();
    expect(h.routerPush).toEqual([]);
    expect(h.expandClerk).toEqual([]);
  });

  it("routes to the waitlist when signed out", () => {
    h.isSignedIn = false;
    renderScreen();
    accountRowOnPress()();
    expect(h.routerPush).toEqual(["/settings/waitlist"]);
  });

  it("expands the clerk sheet and opens auth when signed in", () => {
    renderScreen();
    accountRowOnPress()();
    expect(h.expandClerk).toHaveLength(1);
    expect(h.routerPush).toEqual(["/settings/auth"]);
  });
});
