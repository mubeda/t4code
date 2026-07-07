/**
 * Behavior tests for the root route.
 *
 * The route's component tree (RootRouteView and its in-file children
 * DocumentTitleSync / AuthenticatedTracingBootstrap / EventRouter /
 * HostedStaticEnvironmentBootstrap) is exercised with the repo's
 * instrumented-hooks pattern (see FilePreviewPanel.test.tsx): a partial
 * `vi.mock("react")` records effects/refs so their bodies can be run manually,
 * `useEffectEvent` returns the wrapped function directly, and `@tanstack/
 * react-router` is replaced with a controllable stub so `Route.options.*`
 * (component, errorComponent, beforeLoad, head) can be driven without a live
 * router. Heavy child components are replaced with pass-through stand-ins.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// ── Controllable test state ──────────────────────────────────────────
const s = vi.hoisted(() => ({
  routeContext: { authGateState: { status: "authenticated" } as { status: string } },
  pathname: "/",
  navigateCalls: [] as unknown[],
  atomValues: new Map<string, unknown>(),
  environments: [] as unknown[],
  primaryEnvironment: null as unknown,
  project: null as unknown,
  activeEnvironmentId: null as string | null,
  setActiveCalls: [] as string[],
  settings: {} as Record<string, unknown>,
  logicalKey: null as string | null,
  physicalKey: null as string | null,
  syncThemeCalls: 0,
  tracingCalls: 0,
  toasts: [] as unknown[],
  setProjectExpandedCalls: [] as Array<{ key: string; expanded: boolean }>,
  controllerDecision: null as { readonly _tag: string; readonly message?: string } | null,
  openInEditorResult: { _tag: "Success" } as { _tag: string },
  openInEditorCalls: [] as unknown[],
  preferredEditor: "code" as string | null,
  authGate: { status: "authenticated" } as { status: string },
  hostedPairing: false,
  hostedStatic: false,
  buttonClicks: [] as Array<() => void>,
}));

// ── React hook instrumentation ───────────────────────────────────────
const hk = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
  setStateCalls: [] as Array<{ next: unknown; applied: unknown }>,
  reset() {
    hk.effects.length = 0;
    hk.refs.length = 0;
    hk.setStateCalls.length = 0;
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  const useState = (initial?: unknown) => {
    const value = resolveInitial(initial);
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      hk.setStateCalls.push({ next, applied });
    };
    return [value, setValue];
  };
  const useEffect = (effect: () => void | (() => void)) => {
    hk.effects.push(effect);
  };
  const useRef = (initial?: unknown) => {
    const ref = { current: initial ?? null };
    hk.refs.push(ref);
    return ref;
  };
  const useEffectEvent = (fn: (...args: never[]) => unknown) => fn;
  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
    useRef: useRef as typeof actual.useRef,
    useEffectEvent: useEffectEvent as unknown,
  };
});

// ── Router stub ──────────────────────────────────────────────────────
vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: Record<string, unknown>) => ({
    options,
    useRouteContext: () => s.routeContext,
  }),
  Outlet: () => <div data-mock="outlet" />,
  useLocation: (opts?: { select?: (loc: { pathname: string }) => unknown }) =>
    opts?.select ? opts.select({ pathname: s.pathname }) : { pathname: s.pathname },
  useNavigate: () => (args: unknown) => {
    s.navigateCalls.push(args);
    return Promise.resolve();
  },
}));

// ── State / atom modules ─────────────────────────────────────────────
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { key?: string } | null | undefined) =>
    atom && typeof atom.key === "string" ? s.atomValues.get(atom.key) : undefined,
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, _options?: unknown) => (input: unknown) => {
    s.openInEditorCalls.push(input);
    return Promise.resolve(s.openInEditorResult);
  },
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: s.environments }),
  usePrimaryEnvironment: () => s.primaryEnvironment,
}));

vi.mock("../state/entities", () => ({
  readProject: () => s.project,
  setActiveEnvironmentId: (environmentId: string) => {
    s.setActiveCalls.push(environmentId);
  },
  useActiveEnvironmentId: () => s.activeEnvironmentId,
}));

vi.mock("../state/server", () => ({
  primaryServerConfigAtom: { key: "config" },
  primaryServerConfigEventAtom: { key: "configEvent" },
  primaryServerWelcomeAtom: { key: "welcome" },
}));

vi.mock("../state/shell", () => ({
  shellEnvironment: { openInEditor: { key: "openInEditor" } },
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (selector?: (settings: unknown) => unknown) =>
    selector ? selector(s.settings) : s.settings,
}));

vi.mock("../uiStateStore", () => ({
  useUiStateStore: {
    getState: () => ({
      setProjectExpanded: (key: string, expanded: boolean) => {
        s.setProjectExpandedCalls.push({ key, expanded });
      },
    }),
  },
}));

vi.mock("../hooks/useTheme", () => ({
  syncBrowserChromeTheme: () => {
    s.syncThemeCalls += 1;
  },
}));

vi.mock("../observability/clientTracing", () => ({
  configureClientTracing: () => {
    s.tracingCalls += 1;
    return Promise.resolve();
  },
}));

vi.mock("../environments/primary", () => ({
  resolveInitialServerAuthGateState: () => Promise.resolve(s.authGate),
}));

vi.mock("../hostedPairing", () => ({
  hasHostedPairingRequest: () => s.hostedPairing,
  isHostedStaticApp: () => s.hostedStatic,
}));

vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => s.logicalKey,
  derivePhysicalProjectKeyFromPath: () => s.physicalKey,
  selectProjectGroupingSettings: (settings: unknown) => settings,
}));

vi.mock("../editorPreferences", () => ({
  resolveAndPersistPreferredEditor: () => s.preferredEditor,
}));

vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopedProjectKey: () => "scoped-project-key",
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error?: unknown }) => result.error ?? new Error("failed"),
}));

vi.mock("../components/KeybindingsUpdateToast.logic", () => ({
  createKeybindingsUpdateToastController: () => ({
    handle: () => s.controllerDecision,
  }),
}));

// ── Toast + child component stand-ins ────────────────────────────────
vi.mock("../components/ui/toast", () => ({
  toastManager: {
    add: (toast: unknown) => {
      s.toasts.push(toast);
      return "toast-id";
    },
  },
  stackedThreadToast: (toast: unknown) => toast,
  ToastProvider: ({ children }: { children?: ReactNode }) => <div data-mock="toast">{children}</div>,
  AnchoredToastProvider: ({ children }: { children?: ReactNode }) => (
    <div data-mock="anchored-toast">{children}</div>
  ),
}));

vi.mock("../components/ui/button", () => ({
  Button: (props: { children?: ReactNode; onClick?: () => void }) => {
    if (props.onClick) s.buttonClicks.push(props.onClick);
    return <button type="button">{props.children}</button>;
  },
}));

vi.mock("../components/AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { children?: ReactNode }) => (
    <div data-mock="sidebar-layout">{children}</div>
  ),
}));

vi.mock("../components/CommandPalette", () => ({
  CommandPalette: ({ children }: { children?: ReactNode }) => (
    <div data-mock="command-palette">{children}</div>
  ),
}));

vi.mock("../components/cloud/RelayClientInstallDialog", () => ({
  RelayClientInstallDialog: () => <div data-mock="relay-install" />,
}));

vi.mock("../components/desktop/SshPasswordPromptDialog", () => ({
  SshPasswordPromptDialog: () => <div data-mock="ssh-password" />,
}));

vi.mock("../components/ProviderUpdateLaunchNotification", () => ({
  ProviderUpdateLaunchNotification: () => <div data-mock="provider-update" />,
}));

vi.mock("../components/SlowRpcRequestToastCoordinator", () => ({
  SlowRpcRequestToastCoordinator: () => <div data-mock="slow-rpc" />,
}));

import { Route } from "./__root";

// ── Helpers ──────────────────────────────────────────────────────────
type RootComponent = () => ReactNode;

function renderComponent(): string {
  hk.reset();
  const Component = Route.options.component as RootComponent;
  return renderToStaticMarkup(<Component />);
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const effects = [...hk.effects];
  hk.effects.length = 0;
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

interface RafWindow {
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  location: { href: string; reload: () => void };
}

let reloadCalls = 0;

beforeEach(() => {
  s.routeContext = { authGateState: { status: "authenticated" } };
  s.pathname = "/";
  s.navigateCalls.length = 0;
  s.atomValues.clear();
  s.environments = [];
  s.primaryEnvironment = null;
  s.project = null;
  s.activeEnvironmentId = null;
  s.setActiveCalls.length = 0;
  s.settings = {};
  s.logicalKey = null;
  s.physicalKey = null;
  s.syncThemeCalls = 0;
  s.tracingCalls = 0;
  s.toasts.length = 0;
  s.setProjectExpandedCalls.length = 0;
  s.controllerDecision = null;
  s.openInEditorResult = { _tag: "Success" };
  s.openInEditorCalls.length = 0;
  s.preferredEditor = "code";
  s.authGate = { status: "authenticated" };
  s.hostedPairing = false;
  s.hostedStatic = false;
  s.buttonClicks.length = 0;
  reloadCalls = 0;
  hk.reset();

  const windowStub: RafWindow = {
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    location: {
      href: "https://app.test/",
      reload: () => {
        reloadCalls += 1;
      },
    },
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { title: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────
// Route configuration: beforeLoad + head
// ─────────────────────────────────────────────────────────────────────

describe("Route.beforeLoad", () => {
  const beforeLoad = () =>
    (
      Route.options.beforeLoad as (args: {
        location: { pathname: string };
      }) => Promise<{ authGateState: { status: string } }>
    );

  it("returns hosted-pairing context for a pairing request on /pair", async () => {
    s.hostedPairing = true;
    const result = await beforeLoad()({ location: { pathname: "/pair" } });
    expect(result.authGateState.status).toBe("hosted-pairing");
  });

  it("returns hosted-static context for the hosted static app", async () => {
    s.hostedPairing = false;
    s.hostedStatic = true;
    const result = await beforeLoad()({ location: { pathname: "/" } });
    expect(result.authGateState.status).toBe("hosted-static");
  });

  it("resolves the server auth gate state for a normal boot", async () => {
    s.authGate = { status: "unauthenticated" };
    const result = await beforeLoad()({ location: { pathname: "/" } });
    expect(result.authGateState.status).toBe("unauthenticated");
  });
});

describe("Route.head", () => {
  it("advertises the app display name as the title meta", () => {
    const head = Route.options.head as () => { meta: Array<{ name: string; content: string }> };
    const result = head();
    expect(result.meta[0]!.name).toBe("title");
    expect(typeof result.meta[0]!.content).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────
// RootRouteErrorView + errorMessage / errorDetails
// ─────────────────────────────────────────────────────────────────────

describe("Route.errorComponent", () => {
  function renderError(error: unknown): { markup: string; reset: () => void } {
    let resetCalls = 0;
    const reset = () => {
      resetCalls += 1;
    };
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: unknown;
      reset: () => void;
      info?: unknown;
    }) => ReactNode;
    const markup = renderToStaticMarkup(<ErrorComponent error={error} reset={reset} />);
    return { markup, reset: () => reset() };
  }

  it("renders an Error message and stack, and wires the action buttons", () => {
    const error = new Error("boom happened");
    const { markup } = renderError(error);
    expect(markup).toContain("boom happened");
    expect(markup).toContain("Something went wrong.");

    // Two buttons captured: retry (reset) and reload.
    expect(s.buttonClicks.length).toBe(2);
    s.buttonClicks[1]!(); // reload button
    expect(reloadCalls).toBe(1);
    s.buttonClicks[0]!(); // retry/reset button (executes reset arrow)
  });

  it("renders a plain string error", () => {
    const { markup } = renderError("string failure");
    expect(markup).toContain("string failure");
  });

  it("falls back to a generic message and stringified details for opaque errors", () => {
    const { markup } = renderError({ some: "object" });
    expect(markup).toContain("An unexpected router error occurred.");
    expect(markup).toContain("some");
  });

  it("survives details that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { markup } = renderError(circular);
    expect(markup).toContain("No additional error details are available.");
  });

  it("renders an Error whose message is blank via the generic message", () => {
    const { markup } = renderError(new Error("   "));
    expect(markup).toContain("An unexpected router error occurred.");
  });
});

// ─────────────────────────────────────────────────────────────────────
// RootRouteView branches
// ─────────────────────────────────────────────────────────────────────

describe("RootRouteView", () => {
  it("renders only the outlet on the /pair route and syncs chrome theme", () => {
    s.pathname = "/pair";
    const markup = renderComponent();
    expect(markup).toContain('data-mock="outlet"');
    expect(markup).not.toContain('data-mock="command-palette"');

    const cleanups = runEffects();
    expect(s.syncThemeCalls).toBe(1);
    for (const cleanup of cleanups) cleanup();
  });

  it("renders only the outlet when the primary environment is unauthenticated", () => {
    s.routeContext = { authGateState: { status: "unauthenticated" } };
    const markup = renderComponent();
    expect(markup).toContain('data-mock="outlet"');
    expect(markup).not.toContain('data-mock="sidebar-layout"');
  });

  it("renders the full authenticated shell", () => {
    s.routeContext = { authGateState: { status: "authenticated" } };
    s.atomValues.set("config", { environment: { serverVersion: "1.2.3" } });
    const markup = renderComponent();
    expect(markup).toContain('data-mock="command-palette"');
    expect(markup).toContain('data-mock="sidebar-layout"');
    expect(markup).toContain('data-mock="relay-install"');
    expect(markup).toContain('data-mock="provider-update"');
    runEffects();
  });

  it("renders the hosted-static shell without the authenticated-only bootstraps", () => {
    s.routeContext = { authGateState: { status: "hosted-static" } };
    const markup = renderComponent();
    expect(markup).toContain('data-mock="sidebar-layout"');
    // provider-update / tracing only mount for the authenticated primary.
    expect(markup).not.toContain('data-mock="provider-update"');
    runEffects();
  });
});

// ─────────────────────────────────────────────────────────────────────
// DocumentTitleSync effect
// ─────────────────────────────────────────────────────────────────────

describe("DocumentTitleSync", () => {
  it("writes the resolved app display name to the document title", () => {
    s.atomValues.set("config", { environment: { serverVersion: "9.9.9" } });
    const doc = { title: "" };
    vi.stubGlobal("document", doc);
    renderComponent();
    runEffects();
    expect(doc.title.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// EventRouter effects and effect-event handlers
// ─────────────────────────────────────────────────────────────────────

describe("EventRouter", () => {
  function seedServerConfig(overrides: Record<string, unknown> = {}) {
    return {
      environment: { environmentId: "env-1", serverVersion: "1.0.0" },
      cwd: "X:/repo",
      availableEditors: ["code"],
      keybindingsConfigPath: "X:/repo/.keybindings.json",
      ...overrides,
    };
  }

  it("activates the environment reported by the server config", () => {
    s.atomValues.set("config", seedServerConfig());
    renderComponent();
    runEffects();
    expect(s.setActiveCalls).toContain("env-1");
  });

  it("handles a welcome payload by expanding the project and navigating", async () => {
    s.pathname = "/";
    s.project = { id: "proj-1" };
    s.logicalKey = "logical-project-key";
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("welcome", {
      environment: { environmentId: "env-1" },
      bootstrapProjectId: "proj-1",
      bootstrapThreadId: "thread-1",
    });

    renderComponent();
    runEffects();
    await flush();

    expect(s.setActiveCalls).toContain("env-1");
    expect(s.setProjectExpandedCalls).toContainEqual({
      key: "logical-project-key",
      expanded: true,
    });
    expect(s.navigateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("derives the project key from the server cwd when the project is unknown", async () => {
    s.pathname = "/other";
    s.project = null;
    s.physicalKey = "physical-key";
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("welcome", {
      environment: { environmentId: "env-1" },
      bootstrapProjectId: "proj-1",
      bootstrapThreadId: "thread-1",
    });

    renderComponent();
    runEffects();
    await flush();

    // A non-root pathname short-circuits before navigating.
    expect(s.setProjectExpandedCalls).toContainEqual({ key: "physical-key", expanded: true });
    expect(s.navigateCalls.length).toBe(0);
  });

  it("ignores a welcome payload that lacks bootstrap identifiers", async () => {
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("welcome", {
      environment: { environmentId: "env-1" },
      bootstrapProjectId: null,
      bootstrapThreadId: null,
    });

    renderComponent();
    runEffects();
    await flush();

    expect(s.navigateCalls.length).toBe(0);
    expect(s.setProjectExpandedCalls.length).toBe(0);
  });

  it("shows a success toast when keybindings reload cleanly", () => {
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("configEvent", { kind: "reloaded" });
    s.controllerDecision = { _tag: "Success" };

    renderComponent();
    // Force the config-event effect past its "already handled" guard.
    const configRef = hk.refs.find((ref) => ref.current === s.atomValues.get("configEvent"));
    if (configRef) configRef.current = null;
    runEffects();

    expect(
      s.toasts.some(
        (toast) => (toast as { title?: string }).title === "Keybindings updated",
      ),
    ).toBe(true);
  });

  it("shows a warning toast and opens the keybindings file on action", async () => {
    s.primaryEnvironment = { environmentId: "env-1" };
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("configEvent", { kind: "invalid" });
    s.controllerDecision = { _tag: "InvalidConfiguration", message: "bad config" };

    renderComponent();
    const configRef = hk.refs.find((ref) => ref.current === s.atomValues.get("configEvent"));
    if (configRef) configRef.current = null;
    runEffects();

    const warning = s.toasts.find(
      (toast) => (toast as { title?: string }).title === "Invalid keybindings configuration",
    ) as { actionProps?: { onClick?: () => void } } | undefined;
    expect(warning).toBeDefined();

    // Invoke the toast action to run the open-in-editor flow.
    warning!.actionProps!.onClick!();
    await flush();
    expect(s.openInEditorCalls.length).toBe(1);
  });

  it("surfaces an error toast when opening the keybindings file fails", async () => {
    s.primaryEnvironment = { environmentId: "env-1" };
    s.atomValues.set("config", seedServerConfig());
    s.atomValues.set("configEvent", { kind: "invalid" });
    s.controllerDecision = { _tag: "InvalidConfiguration", message: "bad config" };
    s.openInEditorResult = { _tag: "Failure" };

    renderComponent();
    const configRef = hk.refs.find((ref) => ref.current === s.atomValues.get("configEvent"));
    if (configRef) configRef.current = null;
    runEffects();

    const warning = s.toasts.find(
      (toast) => (toast as { title?: string }).title === "Invalid keybindings configuration",
    ) as { actionProps?: { onClick?: () => void } } | undefined;
    warning!.actionProps!.onClick!();
    await flush();

    expect(
      s.toasts.some(
        (toast) => (toast as { title?: string }).title === "Unable to open keybindings file",
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// AuthenticatedTracingBootstrap + HostedStaticEnvironmentBootstrap
// ─────────────────────────────────────────────────────────────────────

describe("bootstrap effects", () => {
  it("configures client tracing once the authenticated shell mounts", () => {
    s.routeContext = { authGateState: { status: "authenticated" } };
    renderComponent();
    runEffects();
    expect(s.tracingCalls).toBe(1);
  });

  it("activates the first saved environment when none is active in hosted mode", () => {
    s.routeContext = { authGateState: { status: "hosted-static" } };
    s.activeEnvironmentId = null;
    s.environments = [
      { environmentId: "env-saved", entry: { target: { _tag: "BearerConnectionTarget" } } },
    ];
    renderComponent();
    runEffects();
    expect(s.setActiveCalls).toContain("env-saved");
  });

  it("does not override the active environment when a primary target exists", () => {
    s.routeContext = { authGateState: { status: "hosted-static" } };
    s.activeEnvironmentId = null;
    s.environments = [
      { environmentId: "env-primary", entry: { target: { _tag: "PrimaryConnectionTarget" } } },
    ];
    renderComponent();
    runEffects();
    expect(s.setActiveCalls).not.toContain("env-primary");
  });
});
