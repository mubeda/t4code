/**
 * Behavior tests for the single-prompt provider update notification.
 *
 * The component renders to nothing (`return null`) — all of its behavior lives
 * in captured effects and in the toast action handlers it wires up. The
 * instrumented-hooks pattern (see ChatView.hooks.test.tsx / FilePreviewPanel)
 * replaces `useRef`/`useEffect` so the active-toast ref can be inspected/seeded
 * and effects run manually; `useMemo`/`useCallback` stay real. The pure toast
 * views come from the already-tested `.logic` module (kept real here). Distinct
 * update versions per test dodge the module-level "already seen" de-dupe set.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  EnvironmentId,
  type ServerProvider,
} from "@t4code/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

const harness = vi.hoisted(() => {
  const state = {
    effects: [] as Array<() => void | (() => void)>,
    refs: [] as Array<{ current: unknown }>,
    reset() {
      state.effects.length = 0;
      state.refs.length = 0;
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of state.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return cleanups;
    },
  };
  return state;
});

const testState = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  primaryEnvironment: null as { environmentId: unknown } | null,
  dismissedKeys: new Set<string>(),
  dismissNotificationKey: vi.fn<(key: string) => void>(),
  navigate: vi.fn<(options: unknown) => void>(),
  updateProvider: vi.fn<(input: unknown) => Promise<unknown>>(),
  toastAdds: [] as Array<Record<string, unknown>>,
  toastUpdates: [] as Array<{ id: unknown; config: unknown }>,
  toastCloses: [] as unknown[],
  nextToastId: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useEffect = (effect: () => void | (() => void)) => {
    harness.effects.push(effect);
  };
  const useRef = (initial?: unknown) => {
    const ref = { current: initial ?? null };
    harness.refs.push(ref);
    return ref;
  };
  return {
    ...actual,
    useEffect: useEffect as typeof actual.useEffect,
    useRef: useRef as typeof actual.useRef,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (options: unknown) => {
    testState.navigate(options);
    return Promise.resolve();
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.providers,
}));

vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: { key: "primaryServerProviders" },
  serverEnvironment: { updateProvider: { key: "updateProvider" } },
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: testState.dismissedKeys,
    dismissNotificationKey: testState.dismissNotificationKey,
  }),
}));

vi.mock("./chat/providerIconUtils", () => {
  const CodexIcon = (props: Record<string, unknown>) => (
    <span data-codex-icon className={props.className as string | undefined} />
  );
  return {
    PROVIDER_ICON_BY_PROVIDER: { [ProviderDriverKind.make("codex")]: CodexIcon },
  };
});

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (config: unknown) => config,
  toastManager: {
    add: (config: Record<string, unknown>) => {
      testState.toastAdds.push(config);
      testState.nextToastId += 1;
      return `toast-${testState.nextToastId}`;
    },
    update: (id: unknown, config: unknown) => {
      testState.toastUpdates.push({ id, config });
    },
    close: (id: unknown) => {
      testState.toastCloses.push(id);
    },
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => testState.updateProvider(input),
}));

import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

const CHECKED_AT = "2026-04-23T10:00:00.000Z";
let versionCounter = 0;
function uniqueLatestVersion(): string {
  versionCounter += 1;
  return `9.${versionCounter}.0`;
}

function provider(input: {
  driver?: string;
  instanceId?: string;
  latestVersion?: string;
  canUpdate?: boolean;
  updateCommand?: string | null;
  advisoryStatus?: "behind_latest" | "current";
  updateState?: ServerProvider["updateState"];
}): ServerProvider {
  const driver = ProviderDriverKind.make(input.driver ?? "codex");
  const base: ServerProvider = {
    instanceId: ProviderInstanceId.make(input.instanceId ?? String(driver)),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
    versionAdvisory: {
      status: input.advisoryStatus ?? "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: input.latestVersion ?? "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand! : "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      checkedAt: CHECKED_AT,
      message: "Update available.",
    },
  };
  return input.updateState ? { ...base, updateState: input.updateState } : base;
}

const activeToastRef = () => harness.refs[0]!;

function render() {
  harness.reset();
  testState.toastAdds.length = 0;
  testState.toastUpdates.length = 0;
  testState.toastCloses.length = 0;
  return renderToStaticMarkup(<ProviderUpdatePrimaryNotification />);
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  testState.providers = [];
  testState.primaryEnvironment = { environmentId: EnvironmentId.make("environment-1") };
  testState.dismissedKeys = new Set<string>();
  testState.dismissNotificationKey.mockReset();
  testState.navigate.mockReset();
  testState.updateProvider.mockReset().mockResolvedValue(AsyncResult.success({ providers: [] }));
  testState.nextToastId = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("render + effect wiring", () => {
  it("renders nothing but captures its effects", () => {
    testState.providers = [provider({ latestVersion: uniqueLatestVersion() })];
    expect(render()).toBe("");
    // unmount-cleanup, progress, and main-prompt effects.
    expect(harness.effects).toHaveLength(3);
    expect(activeToastRef().current).toBeNull();
  });

  it("does not prompt when there is no update candidate", () => {
    testState.providers = [
      provider({ advisoryStatus: "current", latestVersion: "1.0.0", canUpdate: false }),
    ];
    render();
    harness.runEffects();
    expect(testState.toastAdds).toHaveLength(0);
    expect(activeToastRef().current).toBeNull();
  });

  it("does not prompt when the notification key was already dismissed", () => {
    const latestVersion = uniqueLatestVersion();
    testState.providers = [provider({ latestVersion })];
    testState.dismissedKeys = new Set([`codex:${latestVersion}`]);
    render();
    harness.runEffects();
    expect(testState.toastAdds).toHaveLength(0);
  });
});

describe("one-click update prompt", () => {
  function renderPrompt(latestVersion: string) {
    testState.providers = [provider({ latestVersion })];
    render();
    harness.runEffects();
  }

  it("adds an Update prompt and records the active prompt toast", () => {
    const latestVersion = uniqueLatestVersion();
    renderPrompt(latestVersion);

    expect(testState.toastAdds).toHaveLength(1);
    const toast = testState.toastAdds[0]!;
    expect((toast.actionProps as { children: string }).children).toBe("Update");
    expect((toast.data as { leadingIcon: unknown }).leadingIcon).toBeDefined();
    const active = activeToastRef().current as { kind: string; key: string };
    expect(active.kind).toBe("prompt");
    expect(active.key).toBe(`codex:${latestVersion}`);
  });

  it("runs the update command for each candidate and drives the toast to success", async () => {
    const latestVersion = uniqueLatestVersion();
    const updated = provider({
      latestVersion,
      advisoryStatus: "current",
      updateState: {
        status: "succeeded",
        startedAt: CHECKED_AT,
        finishedAt: CHECKED_AT,
        message: "Provider updated.",
        output: null,
      },
    });
    testState.updateProvider.mockResolvedValue(AsyncResult.success({ providers: [updated] }));
    renderPrompt(latestVersion);

    const runUpdates = (testState.toastAdds[0]!.actionProps as { onClick: () => void }).onClick;
    runUpdates();

    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId: testState.primaryEnvironment!.environmentId,
      input: {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
      },
    });
    // Immediately flips the active toast to an in-flight update.
    expect((activeToastRef().current as { kind: string }).kind).toBe("update");
    // The running (loading) view is pushed synchronously.
    expect(testState.toastUpdates.length).toBeGreaterThanOrEqual(1);

    await flush();
    // Terminal success clears the active toast and pushes a success view.
    expect(activeToastRef().current).toBeNull();
    const lastUpdate = testState.toastUpdates[testState.toastUpdates.length - 1]!.config as {
      type: string;
    };
    expect(lastUpdate.type).toBe("success");
  });

  it("reports a rejected update through the error toast", async () => {
    const latestVersion = uniqueLatestVersion();
    testState.updateProvider.mockResolvedValue(
      AsyncResult.failure(Cause.die(new Error("network exploded"))),
    );
    renderPrompt(latestVersion);

    (testState.toastAdds[0]!.actionProps as { onClick: () => void }).onClick();
    await flush();

    const errorUpdate = testState.toastUpdates.find(
      (entry) => (entry.config as { type?: string }).type === "error",
    );
    expect(errorUpdate).toBeDefined();
    expect((errorUpdate!.config as { description: string }).description).toBe("network exploded");
    expect(activeToastRef().current).toBeNull();
  });

  it("is a no-op to run updates twice", async () => {
    const latestVersion = uniqueLatestVersion();
    renderPrompt(latestVersion);
    const runUpdates = (testState.toastAdds[0]!.actionProps as { onClick: () => void }).onClick;
    runUpdates();
    testState.updateProvider.mockClear();
    runUpdates();
    await flush();
    expect(testState.updateProvider).not.toHaveBeenCalled();
  });

  it("dismisses the prompt through its close handler", () => {
    const latestVersion = uniqueLatestVersion();
    renderPrompt(latestVersion);
    const onClose = (testState.toastAdds[0]!.data as { onClose: () => void }).onClose;
    onClose();
    expect(testState.dismissNotificationKey).toHaveBeenCalledWith(`codex:${latestVersion}`);
  });
});

describe("settings-only prompt", () => {
  it("offers a Settings action that navigates to provider settings", () => {
    const latestVersion = uniqueLatestVersion();
    testState.providers = [provider({ latestVersion, canUpdate: false })];
    render();
    harness.runEffects();

    const toast = testState.toastAdds[0]!;
    expect((toast.actionProps as { children: string }).children).toBe("Settings");
    (toast.actionProps as { onClick: () => void }).onClick();
    expect(testState.toastCloses.length).toBeGreaterThanOrEqual(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
    // The prompt owner is cleared once settings opens.
    expect(activeToastRef().current).toBeNull();
  });

  it("omits the leading icon for a driver without a known icon", () => {
    const latestVersion = uniqueLatestVersion();
    testState.providers = [
      provider({ driver: "opencode", instanceId: "opencode", latestVersion, canUpdate: false }),
    ];
    render();
    harness.runEffects();
    // Single provider still carries a leading icon element (the fallback download
    // glyph); render it to exercise the no-registered-icon branch.
    const leadingIcon = (testState.toastAdds[0]!.data as { leadingIcon: React.ReactElement })
      .leadingIcon;
    const iconMarkup = renderToStaticMarkup(leadingIcon);
    expect(iconMarkup).not.toContain("data-codex-icon");
  });

  it("renders the codex provider icon in the leading glyph", () => {
    const latestVersion = uniqueLatestVersion();
    testState.providers = [provider({ latestVersion })];
    render();
    harness.runEffects();
    const leadingIcon = (testState.toastAdds[0]!.data as { leadingIcon: React.ReactElement })
      .leadingIcon;
    expect(renderToStaticMarkup(leadingIcon)).toContain("data-codex-icon");
  });
});

describe("live progress + unmount effects", () => {
  it("reconciles an in-flight update against live provider state", () => {
    const latestVersion = uniqueLatestVersion();
    const succeeded = provider({
      instanceId: "codex",
      latestVersion,
      advisoryStatus: "current",
      updateState: {
        status: "succeeded",
        startedAt: CHECKED_AT,
        finishedAt: CHECKED_AT,
        message: "Provider updated.",
        output: null,
      },
    });
    testState.providers = [succeeded];
    render();
    // Seed an in-flight update toast before running the progress effect.
    activeToastRef().current = {
      kind: "update",
      key: `codex:${latestVersion}`,
      toastId: "toast-live",
      providerInstanceIds: new Set([ProviderInstanceId.make("codex")]),
      providerCount: 1,
    };
    harness.runEffects();

    expect(testState.toastUpdates.length).toBeGreaterThanOrEqual(1);
    expect((testState.toastUpdates[0]!.config as { type: string }).type).toBe("success");
    // Terminal view clears the active toast.
    expect(activeToastRef().current).toBeNull();
  });

  it("closes a lingering prompt toast on unmount", () => {
    const latestVersion = uniqueLatestVersion();
    testState.providers = [provider({ latestVersion })];
    render();
    const cleanups = harness.runEffects();
    // Main effect installed a prompt toast.
    expect((activeToastRef().current as { kind: string }).kind).toBe("prompt");
    for (const cleanup of cleanups) cleanup();
    expect(testState.toastCloses.length).toBeGreaterThanOrEqual(1);
    expect(activeToastRef().current).toBeNull();
  });
});
