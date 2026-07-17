import { act, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  type AdvertisedEndpoint,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
  type DesktopDiscoveredSshHost,
  type DesktopWslState,
  EnvironmentId,
} from "@t4code/contracts";

type AnyProps = Record<string, unknown>;

interface CapturedControl {
  readonly kind: string;
  readonly label: string;
  readonly props: AnyProps;
}

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];
let domWindow: Window | null = null;

const h = vi.hoisted(() => {
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node !== null && typeof node === "object" && "props" in node) {
      const props = (node as { props: { children?: unknown } }).props;
      return textOf(props.children);
    }
    return "";
  };

  return {
    textOf,
    controls: [] as Array<{ kind: string; label: string; props: Record<string, unknown> }>,
    rows: [] as Array<Record<string, unknown>>,
    stateOverrides: new Map<unknown, unknown>(),
    copyBehavior: "copy" as "copy" | "error",
    copies: [] as Array<{ value: string; context: unknown }>,
    loopbackHostnames: new Set<string>(),
    hasCloudConfig: true,
    clerkAuth: {
      isSignedIn: true as boolean,
      getToken: vi.fn(),
    },
    environments: [] as unknown[],
    primaryEnvironment: null as unknown,
    relayDiscovery: {
      environments: new Map<string, unknown>(),
      refreshing: false,
    },
    primarySessionState: { data: null as unknown },
    cloudLinkState: {
      target: null as unknown,
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    uiState: {
      defaultAdvertisedEndpointKey: null as string | null,
      setDefaultAdvertisedEndpointKey: vi.fn(),
    },
    nullQuery: {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    networkAccessQuery: {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    sshHostsQuery: {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    wslQuery: {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    accessChangesQuery: {
      data: null as unknown,
      error: null as string | null,
      isPending: false,
      refresh: vi.fn(),
    },
    atoms: {
      desktopNetworkAccess: Symbol("desktopNetworkAccessStateAtom"),
      desktopSshHosts: Symbol("desktopSshHostsStateAtom"),
      desktopWsl: Symbol("desktopWslStateAtom"),
      connectPairing: Symbol("connectPairing"),
      connectSsh: Symbol("connectSshEnvironment"),
      catalogRegister: Symbol("environmentCatalog.register"),
      catalogRemove: Symbol("environmentCatalog.remove"),
      catalogRetryNow: Symbol("environmentCatalog.retryNow"),
      relayRefresh: Symbol("relayEnvironmentDiscovery.refresh"),
      linkPrimary: Symbol("linkPrimaryEnvironment"),
      unlinkPrimary: Symbol("unlinkPrimaryEnvironment"),
    },
    commands: {
      connectPairing: vi.fn(),
      connectSsh: vi.fn(),
      register: vi.fn(),
      remove: vi.fn(),
      retryNow: vi.fn(),
      relayRefresh: vi.fn(),
      link: vi.fn(),
      unlink: vi.fn(),
    },
    refreshDesktopNetworkAccessState: vi.fn(),
    refreshDesktopWslState: vi.fn(),
    createServerPairingCredential: vi.fn(),
    revokeServerPairingLink: vi.fn(),
    revokeServerClientSession: vi.fn(),
    revokeOtherServerClientSessions: vi.fn(),
    toastAdd: vi.fn(),
  };
});

// Execute functional state updaters synchronously (React's server renderer
// ignores post-render dispatches) and allow tests to pin selected pieces of
// internal state by their initial value, e.g. forcing the add-environment
// dialog into SSH mode.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial: unknown) => {
    const [value, actualSetState] = (
      actual.useState as (input: unknown) => [unknown, (next: unknown) => void]
    )(initial);
    const isOverridden = typeof initial !== "function" && h.stateOverrides.has(initial);
    const resolved = isOverridden ? h.stateOverrides.get(initial) : value;
    const setState = (next: unknown) => {
      if (isOverridden && typeof next === "function") {
        (next as (previous: unknown) => unknown)(resolved);
        return;
      }
      if (!isOverridden) actualSetState(next);
    };
    return [resolved, setState];
  };
  return { ...actual, useState };
});

vi.mock("@clerk/react", () => ({
  useAuth: () => h.clerkAuth,
}));

vi.mock("@t4code/client-runtime/connection", () => ({
  connectionStatusText: (connection: { phase: string }) => `status:${connection.phase}`,
  RelayConnectionRegistration: class RelayConnectionRegistration {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  RelayConnectionTarget: class RelayConnectionTarget {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@t4code/client-runtime/errors", () => ({
  findErrorTraceId: (cause: unknown) =>
    cause !== null && typeof cause === "object" && "traceId" in cause
      ? ((cause as { traceId: string }).traceId ?? null)
      : null,
}));

vi.mock("@t4code/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: unknown) =>
    (result as { interrupted?: boolean }).interrupted === true,
  squashAtomCommandFailure: (result: unknown) =>
    (result as { cause?: unknown }).cause ?? new Error("Command failed."),
  settlePromise: async (run: () => Promise<unknown>) => {
    try {
      return { _tag: "Success", value: await run() };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  },
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options?: {
    onCopy?: (context: unknown) => void;
    onError?: (error: Error, context: unknown) => void;
  }) => ({
    isCopied: false,
    copyToClipboard: (value: string, context: unknown) => {
      h.copies.push({ value, context });
      if (h.copyBehavior === "error") {
        options?.onError?.(new Error("copy failed"), context);
      } else {
        options?.onCopy?.(context);
      }
    },
  }),
}));

vi.mock("../../cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => h.hasCloudConfig,
  resolveRelayClerkTokenOptions: () => ({ template: "relay" }),
}));

vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: h.createServerPairingCredential,
  revokeOtherServerClientSessions: h.revokeOtherServerClientSessions,
  revokeServerClientSession: h.revokeServerClientSession,
  revokeServerPairingLink: h.revokeServerPairingLink,
  isLoopbackHostname: (hostname: string) => h.loopbackHostnames.has(hostname),
  usePrimarySessionState: () => h.primarySessionState,
}));

vi.mock("~/connection/desktopLocal", () => ({
  isDesktopLocalConnectionTarget: (target: unknown) =>
    (target as { _tag?: string })._tag === "DesktopLocalConnectionTarget",
}));

vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (state: unknown) => unknown) => selector(h.uiState),
}));

vi.mock("~/versionSkew", () => ({
  resolveServerConfigVersionMismatch: (serverConfig: unknown) =>
    serverConfig !== null && typeof serverConfig === "object" && "mismatch" in serverConfig
      ? (serverConfig as { mismatch: unknown }).mismatch
      : null,
}));

vi.mock("~/cloud/primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => h.cloudLinkState,
}));

vi.mock("~/cloud/linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: h.atoms.linkPrimary,
  unlinkPrimaryEnvironment: h.atoms.unlinkPrimary,
}));

vi.mock("~/state/auth", () => ({
  authEnvironment: {
    accessChanges: (args: unknown) => ({ __kind: "accessChanges", args }),
  },
}));

vi.mock("~/connection/catalog", () => ({
  environmentCatalog: {
    register: h.atoms.catalogRegister,
    remove: h.atoms.catalogRemove,
    retryNow: h.atoms.catalogRetryNow,
  },
}));

vi.mock("~/connection/onboarding", () => ({
  connectPairing: h.atoms.connectPairing,
  connectSshEnvironment: h.atoms.connectSsh,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === null) return h.nullQuery;
    if (atom === h.atoms.desktopNetworkAccess) return h.networkAccessQuery;
    if (atom === h.atoms.desktopSshHosts) return h.sshHostsQuery;
    if (atom === h.atoms.desktopWsl) return h.wslQuery;
    if ((atom as { __kind?: string }).__kind === "accessChanges") return h.accessChangesQuery;
    return h.nullQuery;
  },
}));

vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: h.atoms.desktopNetworkAccess,
  refreshDesktopNetworkAccessState: h.refreshDesktopNetworkAccessState,
}));

vi.mock("~/state/desktopSshHosts", () => ({
  desktopSshHostsStateAtom: h.atoms.desktopSshHosts,
}));

vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: h.atoms.desktopWsl,
  refreshDesktopWslState: h.refreshDesktopWslState,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: h.environments }),
  usePrimaryEnvironment: () => h.primaryEnvironment,
  useRelayEnvironmentDiscovery: () => h.relayDiscovery,
}));

vi.mock("~/state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: h.atoms.relayRefresh },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) => {
    if (atom === h.atoms.connectPairing) return h.commands.connectPairing;
    if (atom === h.atoms.connectSsh) return h.commands.connectSsh;
    if (atom === h.atoms.catalogRegister) return h.commands.register;
    if (atom === h.atoms.catalogRemove) return h.commands.remove;
    if (atom === h.atoms.catalogRetryNow) return h.commands.retryNow;
    if (atom === h.atoms.relayRefresh) return h.commands.relayRefresh;
    if (atom === h.atoms.linkPrimary) return h.commands.link;
    if (atom === h.atoms.unlinkPrimary) return h.commands.unlink;
    throw new Error("Unexpected atom command in test");
  },
}));

vi.mock("./settingsLayout", () => ({
  useRelativeTimeTick: () => Date.now(),
  SettingsPageContainer: (props: AnyProps) => (
    <div data-testid="settings-page">{props.children as ReactNode}</div>
  ),
  SettingsSection: (props: AnyProps) => (
    <section data-section-title={typeof props.title === "string" ? props.title : "custom"}>
      {props.icon as ReactNode}
      {props.title as ReactNode}
      {props.headerAction as ReactNode}
      {props.children as ReactNode}
    </section>
  ),
  SettingsRow: (props: AnyProps) => {
    h.rows.push(props);
    return (
      <div data-testid="settings-row">
        {props.title as ReactNode}
        {props.resetAction as ReactNode}
        {props.description as ReactNode}
        {props.status as ReactNode}
        {props.control as ReactNode}
        {props.children as ReactNode}
      </div>
    );
  },
  SettingResetButton: (props: AnyProps) => (
    <button type="button" data-reset-label={String(props.label)} />
  ),
}));

function renderSlot(render: unknown, children: unknown): ReactNode {
  return (
    <span data-slot>
      {render as ReactNode}
      {children as ReactNode}
    </span>
  );
}

vi.mock("../ui/button", () => ({
  Button: (props: AnyProps) => {
    h.controls.push({
      kind: "button",
      label: (props["aria-label"] as string | undefined) ?? h.textOf(props.children),
      props,
    });
    return (
      <button type="button" data-variant={String(props.variant)} disabled={Boolean(props.disabled)}>
        {props.children as ReactNode}
      </button>
    );
  },
}));

vi.mock("../ui/input", () => ({
  Input: (props: AnyProps) => {
    h.controls.push({
      kind: "input",
      label: (props.placeholder as string | undefined) ?? (props.type as string | undefined) ?? "",
      props,
    });
    return (
      <input
        placeholder={props.placeholder as string | undefined}
        readOnly
        defaultValue={props.value as string | undefined}
      />
    );
  },
}));

vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: AnyProps) => {
    h.controls.push({ kind: "checkbox", label: String(props.checked), props });
    return <span data-checkbox data-checked={String(props.checked)} />;
  },
}));

vi.mock("../ui/dialog", () => ({
  Dialog: (props: AnyProps) => {
    h.controls.push({ kind: "dialog", label: String(props.open), props });
    return <div data-dialog>{props.children as ReactNode}</div>;
  },
  DialogTrigger: (props: AnyProps) => renderSlot(props.render, props.children),
  DialogPopup: (props: AnyProps) => <div data-dialog-popup>{props.children as ReactNode}</div>,
  DialogHeader: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  DialogTitle: (props: AnyProps) => <h2>{props.children as ReactNode}</h2>,
  DialogDescription: (props: AnyProps) => <p>{props.children as ReactNode}</p>,
  DialogPanel: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  DialogFooter: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  DialogClose: (props: AnyProps) => renderSlot(props.render, props.children),
}));

vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: (props: AnyProps) => {
    h.controls.push({ kind: "alert-dialog", label: String(props.open), props });
    return <div data-alert-dialog>{props.children as ReactNode}</div>;
  },
  AlertDialogPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogHeader: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogTitle: (props: AnyProps) => <h2>{props.children as ReactNode}</h2>,
  AlertDialogDescription: (props: AnyProps) => <p>{props.children as ReactNode}</p>,
  AlertDialogFooter: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  AlertDialogClose: (props: AnyProps) => renderSlot(props.render, props.children),
}));

vi.mock("../ui/popover", () => ({
  Popover: (props: AnyProps) => <span data-popover>{props.children as ReactNode}</span>,
  PopoverTrigger: (props: AnyProps) => renderSlot(props.render, props.children),
  PopoverPopup: (props: AnyProps) => <div data-popover-popup>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/menu", () => ({
  Menu: (props: AnyProps) => <span data-menu>{props.children as ReactNode}</span>,
  MenuTrigger: (props: AnyProps) => renderSlot(props.render, props.children),
  MenuPopup: (props: AnyProps) => <div data-menu-popup>{props.children as ReactNode}</div>,
  MenuItem: (props: AnyProps) => {
    h.controls.push({ kind: "menu-item", label: h.textOf(props.children), props });
    return <div data-menu-item>{props.children as ReactNode}</div>;
  },
  MenuGroup: (props: AnyProps) => <div data-menu-group>{props.children as ReactNode}</div>,
  MenuGroupLabel: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  MenuSeparator: () => <hr />,
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => {
    h.controls.push({ kind: "select", label: String(props.value), props });
    return (
      <div data-select data-value={String(props.value)}>
        {props.children as ReactNode}
      </div>
    );
  },
  SelectTrigger: (props: AnyProps) => (
    <div data-select-trigger aria-label={props["aria-label"] as string | undefined}>
      {props.children as ReactNode}
    </div>
  ),
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: (props: AnyProps) => <div data-select-popup>{props.children as ReactNode}</div>,
  SelectItem: (props: AnyProps) => (
    <div data-select-item data-value={String(props.value)}>
      {props.children as ReactNode}
    </div>
  ),
}));

vi.mock("../ui/switch", () => ({
  Switch: (props: AnyProps) => {
    h.controls.push({
      kind: "switch",
      label: (props["aria-label"] as string | undefined) ?? "",
      props,
    });
    return (
      <span
        data-switch
        aria-label={props["aria-label"] as string | undefined}
        data-checked={String(props.checked)}
        data-disabled={String(Boolean(props.disabled))}
      />
    );
  },
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: h.toastAdd },
  stackedThreadToast: (options: unknown) => options,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => renderSlot(props.render, props.children),
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/textarea", () => ({
  Textarea: (props: AnyProps) => {
    h.controls.push({ kind: "textarea", label: String(props.value), props });
    return <textarea readOnly defaultValue={props.value as string | undefined} />;
  },
}));

vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: (props: AnyProps) => <svg data-qr data-value={String(props.value)} />,
}));

vi.mock("../ui/skeleton", () => ({
  Skeleton: () => <div data-skeleton />,
}));

vi.mock("../ui/spinner", () => ({
  Spinner: () => <span data-spinner />,
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: (props: AnyProps) => <div data-scroll-area>{props.children as ReactNode}</div>,
}));

vi.mock("../ui/empty", () => ({
  Empty: (props: AnyProps) => <div data-empty>{props.children as ReactNode}</div>,
  EmptyDescription: (props: AnyProps) => <p>{props.children as ReactNode}</p>,
  EmptyHeader: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  EmptyMedia: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  EmptyTitle: (props: AnyProps) => <h3>{props.children as ReactNode}</h3>,
}));

vi.mock("../ui/group", () => ({
  Group: (props: AnyProps) => <div data-group>{props.children as ReactNode}</div>,
  GroupSeparator: () => <span data-group-separator />,
}));

vi.mock("../AnimatedHeight", () => ({
  AnimatedHeight: (props: AnyProps) => <div data-animated>{props.children as ReactNode}</div>,
}));

import { ConnectionsSettings, connectionsSettingsInternals } from "./ConnectionsSettings";

const PRIMARY_ID = EnvironmentId.make("environment-primary");
const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const PAST = DateTime.makeUnsafe("2020-01-01T00:00:00.000Z");
const RECENT = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const STANDARD_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];
const ADMIN_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  ...STANDARD_SCOPES,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
];

function success<A>(value: A) {
  return { _tag: "Success" as const, value };
}

function failure(cause: unknown, interrupted = false) {
  return { _tag: "Failure" as const, cause, interrupted };
}

function clearRegistries(): void {
  h.controls.length = 0;
  h.rows.length = 0;
  h.copies.length = 0;
}

function render(node: ReactElement = <ConnectionsSettings />): string {
  clearRegistries();
  return renderToStaticMarkup(node);
}

async function mountConnections(): Promise<HTMLDivElement> {
  clearRegistries();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(<ConnectionsSettings />));
  return container;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function findControls(kind: string, label: string): CapturedControl[] {
  const exact = h.controls.filter((entry) => entry.kind === kind && entry.label === label);
  if (exact.length > 0) return exact;
  return h.controls.filter((entry) => entry.kind === kind && entry.label.includes(label));
}

function control(kind: string, label: string): CapturedControl {
  const found = findControls(kind, label);
  if (found.length === 0) {
    throw new Error(`No ${kind} control labelled ${label}`);
  }
  return found[0]!;
}

function invoke(entry: CapturedControl, handlerName: string, ...args: unknown[]): unknown {
  const handler = entry.props[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`Control ${entry.label} has no handler ${handlerName}`);
  }
  return (handler as (...input: unknown[]) => unknown)(...args);
}

/** Click the first button with the given label that actually has an onClick handler. */
function clickButton(label: string): void {
  const target = findControls("button", label).find(
    (entry) => typeof entry.props.onClick === "function",
  );
  if (!target) {
    throw new Error(`No clickable button labelled ${label}`);
  }
  invoke(target, "onClick");
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function stubBrowserWindow(options?: {
  readonly hostname?: string;
  readonly secure?: boolean;
  readonly clipboard?: boolean;
}) {
  const hostname = options?.hostname ?? "app.example.com";
  vi.stubGlobal("window", {
    desktopBridge: undefined,
    isSecureContext: options?.secure ?? true,
    location: {
      href: `https://${hostname}/settings`,
      origin: `https://${hostname}`,
      hostname,
      assign: vi.fn(),
    },
  });
  if (options?.clipboard === false) {
    vi.stubGlobal("navigator", {});
  } else {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  }
}

interface DesktopBridgeStub {
  setServerExposureMode: ReturnType<typeof vi.fn>;
  setTailscaleServeEnabled: ReturnType<typeof vi.fn>;
  setWslBackendEnabled: ReturnType<typeof vi.fn>;
  setWslDistro: ReturnType<typeof vi.fn>;
  setWslOnly: ReturnType<typeof vi.fn>;
}

function createDesktopBridgeStub(): DesktopBridgeStub {
  const wslState: DesktopWslState = {
    enabled: true,
    distro: "Ubuntu",
    available: true,
    wslOnly: false,
    distros: [
      { name: "Ubuntu", isDefault: true, version: 2 },
      { name: "Debian", isDefault: false, version: 2 },
    ],
    preflightError: null,
  };
  return {
    setServerExposureMode: vi.fn(async () => ({})),
    setTailscaleServeEnabled: vi.fn(async () => ({})),
    setWslBackendEnabled: vi.fn(async () => wslState),
    setWslDistro: vi.fn(async () => wslState),
    setWslOnly: vi.fn(async () => wslState),
  };
}

function stubDesktopWindow(): DesktopBridgeStub {
  const bridge = createDesktopBridgeStub();
  vi.stubGlobal("window", {
    desktopBridge: bridge,
    isSecureContext: true,
    location: {
      href: "https://desktop.localhost/settings",
      origin: "https://desktop.localhost",
      hostname: "desktop.localhost",
      assign: vi.fn(),
    },
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  return bridge;
}

function installMountedDesktopWindow(): DesktopBridgeStub {
  const bridge = createDesktopBridgeStub();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: bridge,
  });
  return bridge;
}

function pairingLink(input: {
  readonly id: string;
  readonly label?: string;
  readonly expiresAt?: DateTime.Utc;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}): AuthPairingLink {
  return {
    id: input.id,
    credential: `credential-${input.id}`,
    scopes: input.scopes ?? STANDARD_SCOPES,
    subject: `subject-${input.id}`,
    ...(input.label === undefined ? {} : { label: input.label }),
    createdAt: RECENT,
    expiresAt: input.expiresAt ?? FUTURE,
  } as AuthPairingLink;
}

function clientSession(input: {
  readonly sessionId: string;
  readonly current?: boolean;
  readonly connected?: boolean;
  readonly lastConnectedAt?: DateTime.Utc | null;
  readonly label?: string;
  readonly deviceType?: "desktop" | "mobile" | "unknown";
  readonly os?: string;
  readonly browser?: string;
  readonly ipAddress?: string;
  readonly issuedAt?: DateTime.Utc;
}): AuthClientSession {
  return {
    sessionId: input.sessionId,
    subject: `subject-${input.sessionId}`,
    scopes: STANDARD_SCOPES,
    method: "bearer",
    client: {
      deviceType: input.deviceType ?? "desktop",
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.os === undefined ? {} : { os: input.os }),
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
    },
    issuedAt: input.issuedAt ?? RECENT,
    expiresAt: FUTURE,
    lastConnectedAt: input.lastConnectedAt === undefined ? PAST : input.lastConnectedAt,
    connected: input.connected ?? false,
    current: input.current ?? false,
  } as unknown as AuthClientSession;
}

function accessSnapshot(input: {
  readonly pairingLinks: ReadonlyArray<AuthPairingLink>;
  readonly clientSessions: ReadonlyArray<AuthClientSession>;
}) {
  return {
    type: "snapshot" as const,
    payload: { pairingLinks: input.pairingLinks, clientSessions: input.clientSessions },
  };
}

function endpoint(input: {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly status?: AdvertisedEndpoint["status"];
  readonly reachability?: AdvertisedEndpoint["reachability"];
  readonly hostedHttpsApp?: AdvertisedEndpoint["compatibility"]["hostedHttpsApp"];
  readonly isDefault?: boolean;
  readonly providerId?: string;
}): AdvertisedEndpoint {
  return {
    id: input.id,
    label: input.label,
    provider: {
      id: input.providerId ?? "desktop-core",
      label: "Desktop",
      kind: "core",
      isAddon: false,
    },
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.httpBaseUrl.replace(/^http/u, "ws"),
    reachability: input.reachability ?? "lan",
    compatibility: {
      hostedHttpsApp: input.hostedHttpsApp ?? "unknown",
      desktopApp: "compatible",
    },
    source: "desktop-core",
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  };
}

interface TestConnection {
  readonly phase: string;
  readonly error?: unknown;
  readonly traceId?: string | null;
}

function environment(input: {
  readonly id: string;
  readonly label: string;
  readonly targetTag?: string;
  readonly connection?: TestConnection;
  readonly relayManaged?: boolean;
  readonly sshTarget?: {
    alias: string;
    hostname: string;
    username: string | null;
    port: number | null;
  };
  readonly serverConfig?: unknown;
}) {
  return {
    environmentId: EnvironmentId.make(input.id),
    label: input.label,
    relayManaged: input.relayManaged ?? false,
    connection: {
      traceId: null,
      ...(input.connection ?? { phase: "disconnected" }),
    },
    serverConfig: input.serverConfig ?? null,
    entry: {
      target: { _tag: input.targetTag ?? "SavedConnectionTarget", label: input.label },
      profile: input.sshTarget
        ? Option.some({ _tag: "SshConnectionProfile", target: input.sshTarget })
        : Option.none(),
    },
  };
}

function relayEnvironmentEntry(input: {
  readonly id: string;
  readonly label: string;
  readonly availability: "online" | "offline" | "checking" | "error";
  readonly errorMessage?: string;
}) {
  return {
    environment: { environmentId: EnvironmentId.make(input.id), label: input.label },
    availability: input.availability,
    error:
      input.errorMessage === undefined ? Option.none() : Option.some(new Error(input.errorMessage)),
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllGlobals();
  domWindow = new Window({ url: "https://t4code.test/" });
  vi.stubGlobal("window", domWindow);
  vi.stubGlobal("document", domWindow.document);
  vi.stubGlobal("navigator", domWindow.navigator);
  vi.stubGlobal("localStorage", domWindow.localStorage);
  vi.stubGlobal("Node", domWindow.Node);
  vi.stubGlobal("Element", domWindow.Element);
  vi.stubGlobal("HTMLElement", domWindow.HTMLElement);
  vi.stubGlobal("Event", domWindow.Event);
  vi.stubGlobal("MouseEvent", domWindow.MouseEvent);
  vi.stubGlobal("KeyboardEvent", domWindow.KeyboardEvent);
  vi.stubGlobal("CustomEvent", domWindow.CustomEvent);
  vi.stubGlobal("customElements", domWindow.customElements);
  vi.stubGlobal("MutationObserver", domWindow.MutationObserver);
  vi.stubGlobal("ResizeObserver", domWindow.ResizeObserver);
  vi.stubGlobal("getComputedStyle", domWindow.getComputedStyle.bind(domWindow));
  vi.stubGlobal("requestAnimationFrame", domWindow.requestAnimationFrame.bind(domWindow));
  vi.stubGlobal("cancelAnimationFrame", domWindow.cancelAnimationFrame.bind(domWindow));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearRegistries();
  h.stateOverrides.clear();
  h.copyBehavior = "copy";
  h.loopbackHostnames.clear();
  h.loopbackHostnames.add("localhost");
  h.hasCloudConfig = true;
  h.clerkAuth.isSignedIn = true;
  h.clerkAuth.getToken.mockReset();
  h.clerkAuth.getToken.mockResolvedValue("clerk-token");
  h.environments = [];
  h.primaryEnvironment = { environmentId: PRIMARY_ID, serverConfig: null };
  h.relayDiscovery = { environments: new Map(), refreshing: false };
  h.primarySessionState = { data: null };
  h.cloudLinkState = {
    target: { environmentId: PRIMARY_ID },
    data: { linked: true },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  };
  h.uiState = {
    defaultAdvertisedEndpointKey: null,
    setDefaultAdvertisedEndpointKey: vi.fn(),
  };
  h.nullQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  h.networkAccessQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  h.sshHostsQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  h.wslQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  h.accessChangesQuery = { data: null, error: null, isPending: false, refresh: vi.fn() };
  for (const command of Object.values(h.commands)) {
    command.mockReset();
    command.mockResolvedValue(success(undefined));
  }
  h.refreshDesktopNetworkAccessState.mockReset();
  h.refreshDesktopWslState.mockReset();
  h.createServerPairingCredential.mockReset();
  h.createServerPairingCredential.mockResolvedValue({ id: "new", credential: "new-credential" });
  h.revokeServerPairingLink.mockReset();
  h.revokeServerPairingLink.mockResolvedValue(true);
  h.revokeServerClientSession.mockReset();
  h.revokeServerClientSession.mockResolvedValue(true);
  h.revokeOtherServerClientSessions.mockReset();
  h.revokeOtherServerClientSessions.mockResolvedValue(1);
  h.toastAdd.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const { root, container } of mountedTrees.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
  consoleErrorSpy.mockRestore();
  domWindow?.close();
  domWindow = null;
  vi.unstubAllGlobals();
});

describe("ConnectionsSettings deterministic helpers", () => {
  it("parses manual SSH targets and rejects every invalid boundary", () => {
    const { formatDesktopSshTarget, parseManualDesktopSshTarget } = connectionsSettingsInternals;

    expect(() => parseManualDesktopSshTarget({ host: " ", username: "", port: "" })).toThrow(
      "SSH host or alias is required.",
    );
    expect(
      parseManualDesktopSshTarget({ host: "alice@example.test:2222", username: "", port: "" }),
    ).toEqual({ alias: "example.test", hostname: "example.test", username: "alice", port: 2222 });
    expect(
      parseManualDesktopSshTarget({
        host: "inline@example.test",
        username: "explicit",
        port: "2200",
      }),
    ).toEqual({
      alias: "example.test",
      hostname: "example.test",
      username: "explicit",
      port: 2200,
    });
    expect(parseManualDesktopSshTarget({ host: "[::1]", username: "", port: "" })).toEqual({
      alias: "::1",
      hostname: "::1",
      username: null,
      port: null,
    });
    expect(
      parseManualDesktopSshTarget({ host: "host:not-a-port", username: "", port: "" }),
    ).toMatchObject({ hostname: "host:not-a-port", port: null });
    expect(() => parseManualDesktopSshTarget({ host: "user@", username: "", port: "" })).toThrow(
      "SSH host or alias is required.",
    );
    for (const port of ["nope", "0", "65536"]) {
      expect(() =>
        parseManualDesktopSshTarget({ host: "example.test", username: "", port }),
      ).toThrow("SSH port must be between 1 and 65535.");
    }
    expect(
      formatDesktopSshTarget({ alias: "host", hostname: "host", username: null, port: null }),
    ).toBe("host");
    expect(
      formatDesktopSshTarget({ alias: "host", hostname: "host", username: "alice", port: 22 }),
    ).toBe("alice@host:22");
  });

  it("parses pairing URLs and validates separate remote pairing fields", () => {
    const { parsePairingUrlFields, parseRemotePairingFields } = connectionsSettingsInternals;
    expect(parsePairingUrlFields(" ")).toBeNull();
    expect(parsePairingUrlFields("not a valid host")).toBeNull();
    expect(parsePairingUrlFields("https://backend.test/pair")).toBeNull();
    expect(parsePairingUrlFields("backend.test/pair?token=secret")).toEqual({
      host: "https://backend.test",
      pairingCode: "secret",
    });
    expect(parsePairingUrlFields("//backend.test/pair?token=secret-2")).toEqual({
      host: "https://backend.test",
      pairingCode: "secret-2",
    });
    expect(
      parseRemotePairingFields({
        host: "https://backend.test/pair?token=url-token",
        pairingCode: "ignored",
      }),
    ).toEqual({ host: "https://backend.test", pairingCode: "url-token" });
    expect(parseRemotePairingFields({ host: " backend.test ", pairingCode: " code " })).toEqual({
      host: "backend.test",
      pairingCode: "code",
    });
    expect(() => parseRemotePairingFields({ host: "", pairingCode: "code" })).toThrow(
      "Enter a backend host.",
    );
    expect(() => parseRemotePairingFields({ host: "backend.test", pairingCode: "" })).toThrow(
      "Enter a pairing code.",
    );
  });

  it("normalizes SSH errors, timestamps, endpoint classes, and preference keys", () => {
    const {
      endpointDefaultPreferenceKey,
      endpointRowClassName,
      formatAccessTimestamp,
      formatDesktopSshConnectionError,
      isHostedAppPairingUrl,
      isTailscaleHttpsEndpoint,
    } = connectionsSettingsInternals;
    expect(formatAccessTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatAccessTimestamp("2025-01-01T12:00:00.000Z")).not.toBe("2025-01-01T12:00:00.000Z");
    expect(formatDesktopSshConnectionError("opaque")).toBe("Failed to connect SSH host.");
    expect(
      formatDesktopSshConnectionError(
        new Error(
          "Error invoking remote method 'desktop:ensure-ssh-environment': SshAuthError: denied",
        ),
      ),
    ).toBe("denied");
    expect(formatDesktopSshConnectionError(new Error(" "))).toBe("Failed to connect SSH host.");
    expect(endpointRowClassName("endpoint-rail", false)).toContain("bg-muted/20");
    expect(endpointRowClassName("endpoint-rail", true)).not.toContain("bg-muted/20");
    expect(endpointRowClassName("current", false)).toContain("bg-muted/24");
    expect(endpointRowClassName("current", true)).not.toContain("bg-muted/24");

    const cases = [
      [
        endpoint({ id: "desktop-loopback:1", label: "Loopback", httpBaseUrl: "http://localhost" }),
        "desktop-core:loopback:http",
      ],
      [
        endpoint({ id: "desktop-lan:1", label: "LAN", httpBaseUrl: "http://lan.test" }),
        "desktop-core:lan:http",
      ],
      [
        endpoint({ id: "tailscale-ip:1", label: "Tailnet", httpBaseUrl: "http://100.64.0.1" }),
        "tailscale:ip:http",
      ],
      [
        endpoint({
          id: "tailscale-magicdns:1",
          label: "MagicDNS",
          httpBaseUrl: "https://host.ts.net",
        }),
        "tailscale:magicdns:https",
      ],
    ] as const;
    for (const [candidate, key] of cases) {
      expect(endpointDefaultPreferenceKey(candidate)).toBe(key);
    }
    expect(
      endpointDefaultPreferenceKey(
        endpoint({
          id: "custom:1",
          label: "Custom",
          httpBaseUrl: "https://custom.test",
          providerId: "custom",
        }),
      ),
    ).toBe("custom:lan:https:Custom");
    expect(
      endpointDefaultPreferenceKey(
        endpoint({
          id: "custom:bad",
          label: "Broken",
          httpBaseUrl: "://bad",
          providerId: "custom",
        }),
      ),
    ).toBe("custom:lan:unknown:Broken");
    expect(isTailscaleHttpsEndpoint(cases[3][0])).toBe(true);
    expect(isTailscaleHttpsEndpoint(cases[0][0])).toBe(false);
    expect(isHostedAppPairingUrl("https://app.test/pair?host=https%3A%2F%2Fbackend.test")).toBe(
      true,
    );
    expect(isHostedAppPairingUrl("https://app.test/pair")).toBe(false);
    expect(isHostedAppPairingUrl("not a url")).toBe(false);
  });

  it("selects, sorts, and converts access records across fallback paths", () => {
    const {
      resolveAdvertisedEndpointPairingUrl,
      selectPairingEndpoint,
      sortDesktopClientSessions,
      sortDesktopPairingLinks,
      toDesktopClientSessionRecord,
      toDesktopPairingLinkRecord,
    } = connectionsSettingsInternals;
    const loopback = endpoint({
      id: "desktop-loopback:1",
      label: "Loopback",
      httpBaseUrl: "http://localhost:9876",
      reachability: "loopback",
    });
    const lan = endpoint({ id: "desktop-lan:1", label: "LAN", httpBaseUrl: "http://lan.test" });
    const hosted = endpoint({
      id: "custom:hosted",
      label: "Hosted",
      httpBaseUrl: "https://hosted.test",
      reachability: "loopback",
      hostedHttpsApp: "compatible",
    });
    const unavailable = endpoint({
      id: "custom:off",
      label: "Offline",
      httpBaseUrl: "https://off.test",
      status: "unavailable",
      isDefault: true,
    });
    expect(selectPairingEndpoint([loopback, lan], "desktop-core:lan:http")).toBe(lan);
    expect(selectPairingEndpoint([{ ...loopback, isDefault: true }, lan], "missing")).toMatchObject(
      {
        id: loopback.id,
      },
    );
    expect(selectPairingEndpoint([loopback, lan])).toBe(lan);
    expect(selectPairingEndpoint([loopback, hosted])).toBe(hosted);
    expect(selectPairingEndpoint([unavailable])).toBeNull();
    expect(resolveAdvertisedEndpointPairingUrl(lan, "credential")).toContain("credential");
    expect(resolveAdvertisedEndpointPairingUrl(hosted, "credential")).toContain("credential");

    const links = [pairingLink({ id: "old", expiresAt: RECENT }), pairingLink({ id: "new" })];
    const linkRecords = links.map(toDesktopPairingLinkRecord);
    expect(
      sortDesktopPairingLinks([
        { ...linkRecords[0]!, createdAt: "2024-01-01T00:00:00.000Z" },
        { ...linkRecords[1]!, createdAt: "2025-01-01T00:00:00.000Z" },
      ])[0]?.id,
    ).toBe("new");
    const sessions = [
      clientSession({ sessionId: "old", issuedAt: PAST }),
      clientSession({ sessionId: "connected", connected: true }),
      clientSession({ sessionId: "current", current: true }),
      clientSession({ sessionId: "new" }),
    ];
    expect(
      sortDesktopClientSessions(sessions.map(toDesktopClientSessionRecord)).map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["current", "connected", "new", "old"]);
    expect(toDesktopPairingLinkRecord(links[0]!).createdAt).toBe(DateTime.formatIso(RECENT));
    expect(
      toDesktopClientSessionRecord(clientSession({ sessionId: "never", lastConnectedAt: null }))
        .lastConnectedAt,
    ).toBeNull();
    expect(
      toDesktopClientSessionRecord(clientSession({ sessionId: "seen", lastConnectedAt: RECENT }))
        .lastConnectedAt,
    ).toBe(DateTime.formatIso(RECENT));
  });
});

describe("ConnectionsSettings", () => {
  it("shows the administrative-access notice for non-admin browser sessions", () => {
    stubBrowserWindow();
    h.hasCloudConfig = false;
    h.primarySessionState = {
      data: { authenticated: true, scopes: STANDARD_SCOPES, auth: { policy: "loopback-only" } },
    };

    const markup = render();

    expect(markup).toContain("Administrative access");
    expect(markup).toContain("access:write");
    expect(markup).toContain("No saved remote environments");
    expect(markup).not.toContain("Authorized clients");
    expect(markup).not.toContain("T4 Connect.");
  });

  it("lists saved environments with connect, disconnect and error affordances", async () => {
    stubBrowserWindow();
    h.hasCloudConfig = false;
    h.primarySessionState = {
      data: { authenticated: false, auth: { policy: "loopback-only" } },
    };
    h.environments = [
      environment({
        id: "environment-ssh",
        label: "Devbox",
        targetTag: "SshConnectionTarget",
        connection: { phase: "connected" },
        sshTarget: { alias: "devbox", hostname: "devbox.internal", username: "dev", port: 2222 },
        serverConfig: { mismatch: { clientVersion: "1.0.0", serverVersion: "2.0.0" } },
      }),
      environment({
        id: "environment-relay",
        label: "Relay Env",
        targetTag: "RelayConnectionTarget",
        relayManaged: true,
        connection: { phase: "error", error: new Error("boom"), traceId: "trace-1" },
      }),
      environment({
        id: "environment-wsl",
        label: "WSL Backend",
        targetTag: "DesktopLocalConnectionTarget",
        connection: { phase: "connecting" },
      }),
      environment({
        id: "environment-idle",
        label: "Idle Env",
        connection: { phase: "disconnected" },
      }),
    ];

    const markup = render();

    expect(markup).toContain("Devbox");
    expect(markup).toContain("SSH dev@devbox.internal:2222");
    expect(markup).toContain("Version drift: client 1.0.0, server 2.0.0.");
    expect(markup).toContain("status:error");
    expect(markup).toContain("Copy trace ID");
    expect(markup).toContain("Managed above");
    expect(markup).not.toContain("No saved remote environments");

    // Disconnect the connected SSH environment.
    invoke(control("button", "Disconnect"), "onClick");
    await flush();
    expect(h.commands.remove).toHaveBeenCalledWith(EnvironmentId.make("environment-ssh"));

    // Connect the idle environment.
    invoke(control("button", "Connect"), "onClick");
    await flush();
    expect(h.commands.retryNow).toHaveBeenCalledWith(EnvironmentId.make("environment-idle"));

    // Failures surface a toast.
    h.commands.retryNow.mockResolvedValueOnce(failure(new Error("connect failed")));
    invoke(control("button", "Connect"), "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not connect backend" }),
    );

    h.commands.remove.mockResolvedValueOnce(failure(new Error("remove failed")));
    invoke(control("button", "Disconnect"), "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not remove backend" }),
    );
  });

  it("manages pairing links and authorized clients for a remote-reachable browser admin", async () => {
    stubBrowserWindow();
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "remote-reachable" } },
    };
    h.hasCloudConfig = false;
    h.accessChangesQuery.data = accessSnapshot({
      pairingLinks: [
        pairingLink({ id: "pl-live", label: "Living room iPad" }),
        pairingLink({
          id: "pl-read-only",
          label: "Read-only tablet",
          scopes: [AuthOrchestrationReadScope],
        }),
        pairingLink({ id: "pl-anonymous" }),
        pairingLink({ id: "pl-expired", expiresAt: PAST }),
      ],
      clientSessions: [
        clientSession({
          sessionId: "session-current",
          current: true,
          connected: true,
          label: "This browser",
          os: "Windows",
          browser: "Chrome",
          ipAddress: "10.0.0.9",
        }),
        clientSession({
          sessionId: "session-live",
          connected: true,
          os: "macOS",
          browser: "Safari",
        }),
        clientSession({
          sessionId: "session-idle",
          connected: false,
          deviceType: "unknown",
          lastConnectedAt: null,
        }),
      ],
    });

    const markup = render();

    expect(markup).toContain("Authorized clients");
    expect(markup).toContain("Living room iPad");
    expect(markup).toContain("1 scope");
    expect(markup).toContain("Pairing link");
    expect(markup).not.toContain("credential-pl-expired");
    expect(markup).toContain("This device");
    expect(markup).toContain("macOS · Safari");
    expect(markup).toContain("This backend is already configured for remote access.");

    // Copy the shareable pairing URL (current-origin fallback: no endpoints).
    invoke(control("button", "Copy pairing URL for: URL"), "onClick");
    expect(h.copies[0]?.value).toContain("https://app.example.com/pair");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Pairing URL copied" }),
    );

    // Secure-context URL failures distinguish full URLs from raw codes.
    h.toastAdd.mockClear();
    h.copyBehavior = "error";
    invoke(control("button", "Copy pairing URL for: URL"), "onClick");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy pairing URL" }),
    );
    h.copyBehavior = "copy";

    // Copy the raw pairing code from the grouped menu.
    h.toastAdd.mockClear();
    invoke(control("menu-item", "Copy code"), "onClick");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Pairing code copied" }),
    );

    // Copy errors open the reveal dialog and surface an error toast.
    h.toastAdd.mockClear();
    h.copyBehavior = "error";
    invoke(control("menu-item", "Copy code"), "onClick");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy pairing code" }),
    );
    h.copyBehavior = "copy";

    // The reveal textarea selects its content on focus/click.
    const selectSpy = vi.fn();
    const textarea = h.controls.find((entry) => entry.kind === "textarea");
    invoke(textarea!, "onFocus", { currentTarget: { select: selectSpy } });
    invoke(textarea!, "onClick", { currentTarget: { select: selectSpy } });
    expect(selectSpy).toHaveBeenCalledTimes(2);

    // Revoke a pairing link (success then failure).
    invoke(findControls("button", "Revoke")[0]!, "onClick");
    await flush();
    expect(h.revokeServerPairingLink).toHaveBeenCalled();
    h.toastAdd.mockClear();
    h.revokeServerPairingLink.mockRejectedValueOnce(new Error("revoke failed"));
    invoke(findControls("button", "Revoke")[0]!, "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not revoke pairing link" }),
    );

    // Revoke a client session (success then failure).
    invoke(findControls("button", "Revoke").at(-1)!, "onClick");
    await flush();
    expect(h.revokeServerClientSession).toHaveBeenCalled();
    h.toastAdd.mockClear();
    h.revokeServerClientSession.mockRejectedValueOnce(new Error("session revoke failed"));
    invoke(findControls("button", "Revoke").at(-1)!, "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not revoke client access" }),
    );

    // Revoke all other clients (success then failure).
    h.toastAdd.mockClear();
    invoke(control("button", "Revoke others"), "onClick");
    await flush();
    expect(h.revokeOtherServerClientSessions).toHaveBeenCalled();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Revoked 1 other client" }),
    );
    h.toastAdd.mockClear();
    h.revokeOtherServerClientSessions.mockResolvedValueOnce(3);
    invoke(control("button", "Revoke others"), "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Revoked 3 clients" }),
    );
    h.toastAdd.mockClear();
    h.revokeOtherServerClientSessions.mockRejectedValueOnce(new Error("bulk revoke failed"));
    invoke(control("button", "Revoke others"), "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not revoke other clients" }),
    );

    // Create-link dialog: scope presets, checkbox toggles, create + cancel.
    invoke(findControls("checkbox", "true")[0]!, "onCheckedChange", false);
    invoke(findControls("checkbox", "false")[0]!, "onCheckedChange", true);
    invoke(control("button", "Read only"), "onClick");
    invoke(control("button", "Standard"), "onClick");
    const labelInput = control("input", "e.g. Living room iPad");
    invoke(labelInput, "onChange", { target: { value: "Kitchen tablet" } });

    h.toastAdd.mockClear();
    clickButton("Create link");
    await flush();
    expect(h.createServerPairingCredential).toHaveBeenCalled();
    expect(h.toastAdd).not.toHaveBeenCalled();

    h.createServerPairingCredential.mockRejectedValueOnce(new Error("create failed"));
    clickButton("Create link");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not create pairing URL" }),
    );

    clickButton("Cancel");
    for (const dialog of findControls("dialog", "false")) {
      invoke(dialog, "onOpenChange", false);
      invoke(dialog, "onOpenChange", true);
    }
    invoke(control("button", "Done"), "onClick");
  });

  it("falls back to reveal dialogs when the clipboard is unavailable on a loopback host", () => {
    stubBrowserWindow({ hostname: "localhost", secure: false, clipboard: false });
    h.hasCloudConfig = false;
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "remote-reachable" } },
    };
    h.accessChangesQuery.data = accessSnapshot({
      pairingLinks: [pairingLink({ id: "pl-local" })],
      clientSessions: [],
    });

    const markup = render();

    // Loopback host + no endpoints: no shareable URL, token-only guidance.
    expect(markup).toContain("Show code");
    expect(markup).toContain("Copy the token and pair from another client");
    expect(markup).toContain("Clipboard copy is unavailable here.");
  });

  it("shows the local-only network notice for non-remote browser admins", () => {
    stubBrowserWindow();
    h.hasCloudConfig = false;
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "local-only" } },
    };

    const markup = render();

    expect(markup).toContain("This backend is only reachable on this machine.");
    expect(markup).not.toContain("Authorized clients");
  });

  it("renders the full desktop backend surface and drives its handlers", async () => {
    const bridge = stubDesktopWindow();
    h.primaryEnvironment = {
      environmentId: PRIMARY_ID,
      serverConfig: { mismatch: { clientVersion: "1.2.3", serverVersion: "1.2.4" } },
    };
    h.environments = [
      environment({
        id: "environment-wsl",
        label: "WSL Backend",
        targetTag: "DesktopLocalConnectionTarget",
        connection: { phase: "connected" },
      }),
    ];
    h.networkAccessQuery.data = {
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "https://desktop.example.com",
        advertisedHost: "desktop.local",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        endpoint({
          id: "desktop-loopback:1",
          label: "Loopback",
          httpBaseUrl: "http://127.0.0.1:5133",
          reachability: "loopback",
        }),
        endpoint({
          id: "desktop-lan:1",
          label: "LAN",
          httpBaseUrl: "http://192.168.1.20:5133",
          isDefault: true,
        }),
        endpoint({
          id: "tailscale-ip:1",
          label: "Tailscale IP",
          httpBaseUrl: "https://100.100.1.2:443",
          hostedHttpsApp: "compatible",
          reachability: "private-network",
        }),
        endpoint({
          id: "custom:1",
          label: "Odd Custom",
          httpBaseUrl: "gopher://custom.example.com",
          providerId: "manual",
        }),
        endpoint({
          id: "custom:2",
          label: "Unavailable Custom",
          httpBaseUrl: "http://unavailable.example.com",
          status: "unavailable",
          providerId: "manual",
        }),
        endpoint({
          id: "tailscale-magicdns:1",
          label: "Tailscale HTTPS",
          httpBaseUrl: "https://machine.tailnet.ts.net",
          status: "unavailable",
          reachability: "private-network",
          hostedHttpsApp: "compatible",
        }),
      ],
    };
    h.wslQuery.data = {
      enabled: true,
      distro: "Ubuntu",
      available: true,
      wslOnly: false,
      distros: [
        { name: "Ubuntu", isDefault: true, version: 2 },
        { name: "Debian", isDefault: false, version: 2 },
      ],
      preflightError: "node not found",
    } satisfies DesktopWslState;
    h.accessChangesQuery.data = accessSnapshot({
      pairingLinks: [pairingLink({ id: "pl-desktop", label: "Phone" })],
      clientSessions: [clientSession({ sessionId: "session-desktop", connected: true })],
    });
    h.uiState.defaultAdvertisedEndpointKey = "desktop-core:lan:http";

    const markup = render();

    expect(markup).toContain("Version drift");
    expect(markup).toContain("Network access");
    expect(markup).toContain("Reachable at");
    expect(markup).toContain("http://192.168.1.20:5133");
    expect(markup).toContain("Tailscale HTTPS");
    expect(markup).toContain("WSL backend");
    expect(markup).toContain("WSL backend couldn&#x27;t start: node not found");
    expect(markup).toContain("WSL only");
    expect(markup).toContain("T4 Connect");
    expect(markup).toContain("Authorized clients");

    // The pairing link resolves URLs against the advertised endpoints.
    expect(markup).toContain("Copy pairing URL for: LAN");
    invoke(control("button", "Copy pairing URL for: LAN"), "onClick");
    expect(h.copies[0]?.value).toContain("http://192.168.1.20:5133");

    // Endpoint copy menu contains backend URLs and hosted app links.
    invoke(control("menu-item", "Tailscale IP"), "onClick");
    expect(h.copies[1]?.value).toContain("/pair?host=");
    invoke(control("menu-item", "LAN"), "onClick");
    invoke(control("menu-item", "Loopback"), "onClick");
    invoke(control("menu-item", "Odd Custom"), "onClick");

    h.toastAdd.mockClear();
    h.copyBehavior = "error";
    invoke(control("menu-item", "Tailscale IP"), "onClick");
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy hosted app link" }),
    );
    h.copyBehavior = "copy";

    // Network exposure switch stages a confirmation.
    invoke(control("switch", "Enable network access"), "onCheckedChange", false);
    invoke(control("switch", "Enable network access"), "onCheckedChange", true);

    // The exposure confirm button is a no-op until a change is pending.
    for (const entry of findControls("button", "Restart and disable")) {
      invoke(entry, "onClick");
    }
    await flush();
    // Only the tailscale-disable confirmation reaches the bridge.
    expect(bridge.setTailscaleServeEnabled).toHaveBeenCalledTimes(1);
    expect(bridge.setTailscaleServeEnabled).toHaveBeenCalledWith({ enabled: false, port: 443 });
    expect(bridge.setServerExposureMode).not.toHaveBeenCalled();
    expect(h.refreshDesktopNetworkAccessState).toHaveBeenCalled();

    // Disabling tailscale can fail with a toast.
    h.toastAdd.mockClear();
    bridge.setTailscaleServeEnabled.mockRejectedValueOnce(new Error("serve down"));
    const disableButtons = findControls("button", "Restart and disable");
    invoke(disableButtons.at(-1)!, "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not disable Tailscale HTTPS" }),
    );

    // Tailscale setup dialog confirm (valid default port).
    bridge.setTailscaleServeEnabled.mockClear();
    invoke(control("button", "Enable"), "onClick");
    await flush();
    expect(bridge.setTailscaleServeEnabled).toHaveBeenCalledWith({ enabled: true, port: 443 });
    h.toastAdd.mockClear();
    bridge.setTailscaleServeEnabled.mockRejectedValueOnce(new Error("setup failed"));
    invoke(control("button", "Enable"), "onClick");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not set up Tailscale HTTPS" }),
    );

    // The tailscale switch stages setup/disable flows.
    invoke(control("switch", "Enable Tailscale HTTPS"), "onCheckedChange", true);
    invoke(control("switch", "Enable Tailscale HTTPS"), "onCheckedChange", false);

    // Tailscale port input.
    invoke(control("input", "number"), "onChange", { target: { value: "8443" } });

    // WSL mode selection: registered environments force confirmation dialogs.
    const wslSelect = control("select", "Ubuntu");
    invoke(wslSelect, "onValueChange", 42);
    invoke(wslSelect, "onValueChange", "backend:wsl-off");
    invoke(wslSelect, "onValueChange", "Debian");
    invoke(wslSelect, "onValueChange", "Ubuntu");
    invoke(wslSelect, "onValueChange", "backend:default-wsl");
    expect(bridge.setWslBackendEnabled).not.toHaveBeenCalled();
    expect(bridge.setWslDistro).not.toHaveBeenCalled();

    // WSL-only toggle always stages a confirmation; same-value is a no-op.
    invoke(control("switch", "Run WSL only"), "onCheckedChange", true);
    invoke(control("switch", "Run WSL only"), "onCheckedChange", false);

    // The WSL confirm button is a no-op while nothing is pending.
    invoke(findControls("button", "Restart and disable")[1]!, "onClick");

    // Dialog open-change plumbing.
    for (const dialog of findControls("alert-dialog", "false")) {
      invoke(dialog, "onOpenChange", false);
      if (typeof dialog.props.onOpenChangeComplete === "function") {
        invoke(dialog, "onOpenChangeComplete", false);
        invoke(dialog, "onOpenChangeComplete", true);
      }
    }
    for (const dialog of findControls("dialog", "false")) {
      invoke(dialog, "onOpenChange", false);
    }

    // Add-environment dialog (remote mode by default on desktop).
    const hostInput = control("input", "backend.example.com");
    invoke(hostInput, "onChange", {
      target: { value: "https://pairhost.example.com/pair?token=abc123" },
    });
    invoke(hostInput, "onChange", { target: { value: "plain-host.example.com" } });
    invoke(hostInput, "onChange", { target: { value: "   " } });
    invoke(hostInput, "onChange", {
      target: {
        value: "https://hosted.example.com/pair?host=https%3A%2F%2Fbackend.example.com&token=tok9",
      },
    });
    invoke(control("input", "PAIRCODE"), "onChange", { target: { value: "CODE99" } });

    // Adding with empty fields fails fast with a toast.
    h.toastAdd.mockClear();
    clickButton("Add environment");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not add backend",
        description: "Enter a backend host.",
      }),
    );
    expect(h.commands.connectPairing).not.toHaveBeenCalled();

    // Cloud link row renders because the desktop session is administrative.
    expect(control("switch", "Enable T4 Connect")).toBeDefined();
  });

  it("confirms staged desktop exposure and WSL changes", async () => {
    const bridge = stubDesktopWindow();
    // Pin every null-initialised piece of dialog state to a pending value so
    // the confirmation handlers run their apply paths.
    h.stateOverrides.set(null, "network-accessible");
    h.networkAccessQuery.data = {
      serverExposureState: {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [],
    };
    h.wslQuery.data = {
      enabled: true,
      distro: "Ubuntu",
      available: true,
      wslOnly: false,
      distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
      preflightError: null,
    } satisfies DesktopWslState;

    const markup = render();
    expect(markup).toContain("Enable network access?");
    expect(markup).toContain("Re-enable the Windows backend?");

    for (const entry of findControls("button", "Restart and enable")) {
      if (typeof entry.props.onClick === "function") {
        invoke(entry, "onClick");
      }
    }
    for (const entry of findControls("button", "Restart and disable")) {
      if (typeof entry.props.onClick === "function") {
        invoke(entry, "onClick");
      }
    }
    await flush();
    expect(bridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    expect(h.refreshDesktopNetworkAccessState).toHaveBeenCalled();
    // The pending WSL change falls through to the wsl-only toggle apply path.
    expect(bridge.setWslOnly).toHaveBeenCalled();

    // Exposure change failures surface a toast.
    h.toastAdd.mockClear();
    bridge.setServerExposureMode.mockRejectedValueOnce(new Error("exposure failed"));
    for (const entry of findControls("button", "Restart and enable")) {
      if (typeof entry.props.onClick === "function") {
        invoke(entry, "onClick");
      }
    }
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update network access" }),
    );
  });

  it("applies WSL changes directly when no WSL environment is registered", async () => {
    const bridge = stubDesktopWindow();
    h.environments = [];
    h.wslQuery.data = {
      enabled: true,
      distro: null,
      available: true,
      wslOnly: false,
      distros: [
        { name: "Ubuntu", isDefault: true, version: 2 },
        { name: "Debian", isDefault: false, version: 2 },
      ],
      preflightError: null,
    } satisfies DesktopWslState;

    render();

    // distro is null, so the select maps to the default distro name.
    const wslSelect = control("select", "Ubuntu");

    invoke(wslSelect, "onValueChange", "backend:wsl-off");
    await flush();
    expect(bridge.setWslBackendEnabled).toHaveBeenCalledWith(false);
    expect(h.refreshDesktopWslState).toHaveBeenCalledTimes(1);

    invoke(wslSelect, "onValueChange", "Debian");
    await flush();
    expect(bridge.setWslDistro).toHaveBeenCalledWith("Debian");

    // Failures toast and still refresh the WSL state.
    h.toastAdd.mockClear();
    bridge.setWslDistro.mockRejectedValueOnce(new Error("distro switch failed"));
    invoke(wslSelect, "onValueChange", "Debian");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not change WSL backend" }),
    );
    expect(h.refreshDesktopWslState).toHaveBeenCalledTimes(3);
  });

  it("offers the enable confirmation when WSL is currently off", () => {
    const bridge = stubDesktopWindow();
    h.wslQuery.data = {
      enabled: false,
      distro: null,
      available: true,
      wslOnly: false,
      distros: [],
      preflightError: null,
    } satisfies DesktopWslState;

    const markup = render();

    expect(markup).toContain("Default distro");
    const wslSelect = control("select", "backend:wsl-off");
    // Turning off an already-off backend is a no-op.
    invoke(wslSelect, "onValueChange", "backend:wsl-off");
    // Picking a distro stages the enable-mode confirmation (no direct call).
    invoke(wslSelect, "onValueChange", "backend:default-wsl");
    expect(bridge.setWslBackendEnabled).not.toHaveBeenCalled();
    // The WSL-only switch is only rendered while the backend is enabled.
    expect(findControls("switch", "Run WSL only")).toHaveLength(0);
  });

  it("renders WSL recovery rows for load failures and unavailable distros", async () => {
    stubDesktopWindow();
    h.wslQuery.data = null;
    h.wslQuery.error = "wsl state failed to load";

    let markup = render();
    expect(markup).toContain("Couldn&#x27;t load the WSL backend state.");
    invoke(control("button", "Retry"), "onClick");
    expect(h.refreshDesktopWslState).toHaveBeenCalledTimes(1);

    // WSL uninstalled while the preference is persisted: recovery row.
    h.wslQuery.error = null;
    h.wslQuery.data = {
      enabled: false,
      distro: "Ubuntu",
      available: false,
      wslOnly: true,
      distros: [],
      preflightError: null,
    } satisfies DesktopWslState;
    markup = render();
    expect(markup).toContain("WSL is no longer available");
    invoke(control("button", "Switch to Windows"), "onClick");
    await flush();

    // WSL unavailable and unused: the row disappears entirely.
    h.wslQuery.data = {
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    } satisfies DesktopWslState;
    markup = render();
    expect(markup).not.toContain("WSL backend");
  });

  it("renders busy states with the endpoint rail expanded and SSH mode active", async () => {
    stubDesktopWindow();
    h.stateOverrides.set(false, true);
    h.stateOverrides.set("remote", "ssh");
    h.stateOverrides.set("443", "0");
    h.networkAccessQuery.data = {
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "https://desktop.example.com",
        advertisedHost: null,
        tailscaleServeEnabled: true,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [
        endpoint({
          id: "desktop-lan:1",
          label: "LAN",
          httpBaseUrl: "http://192.168.1.20:5133",
        }),
        endpoint({
          id: "desktop-loopback:1",
          label: "Loopback",
          httpBaseUrl: "http://127.0.0.1:5133",
          reachability: "loopback",
        }),
        endpoint({
          id: "tailscale-magicdns:1",
          label: "Tailscale HTTPS",
          httpBaseUrl: "https://machine.tailnet.ts.net",
          status: "available",
          hostedHttpsApp: "compatible",
        }),
      ],
    };
    h.wslQuery.data = {
      enabled: true,
      distro: "Ubuntu",
      available: true,
      wslOnly: true,
      distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
      preflightError: null,
    } satisfies DesktopWslState;
    h.accessChangesQuery.data = accessSnapshot({
      pairingLinks: [pairingLink({ id: "pl-busy" })],
      clientSessions: [clientSession({ sessionId: "session-busy", connected: true })],
    });
    h.sshHostsQuery.data = [
      {
        alias: "devbox",
        hostname: "devbox.internal",
        username: "dev",
        port: 22,
        source: "ssh-config",
      },
      {
        alias: "spare",
        hostname: "spare.internal",
        username: null,
        port: null,
        source: "known-hosts",
      },
    ] satisfies ReadonlyArray<DesktopDiscoveredSshHost>;

    const markup = render();

    // Busy affordances driven by the overridden boolean state.
    expect(markup).toContain("Restarting…");
    expect(markup).toContain("Adding…");
    expect(markup).toContain("Revoking…");
    expect(markup).toContain("Creating…");

    // The endpoint rail is expanded and renders per-endpoint actions.
    expect(markup).toContain("LAN");
    expect(markup).toContain("Loopback");
    invoke(control("button", "Set as default"), "onClick");
    expect(h.uiState.setDefaultAdvertisedEndpointKey).toHaveBeenCalled();

    // While tailscale updates are running the rail and confirm buttons all
    // render their busy labels; invoking them exercises the busy guards.
    expect(markup).toContain("Enter a port from 1 to 65535.");
    for (const entry of findControls("button", "Restarting…")) {
      if (typeof entry.props.onClick === "function") {
        invoke(entry, "onClick");
      }
    }
    for (const entry of findControls("button", "Applying…")) {
      if (typeof entry.props.onClick === "function") {
        invoke(entry, "onClick");
      }
    }
    await flush();

    // Busy dialogs refuse to close while their operation is running.
    for (const dialog of h.controls.filter(
      (entry) => entry.kind === "dialog" || entry.kind === "alert-dialog",
    )) {
      invoke(dialog, "onOpenChange", false);
    }

    // SSH mode renders discovered hosts.
    expect(markup).toContain("Suggested hosts");
    expect(markup).toContain("devbox");
    expect(markup).toContain("spare");
    invoke(findControls("button", "Refresh")[0]!, "onClick");
    expect(h.sshHostsQuery.refresh).toHaveBeenCalled();

    // Connect one of the discovered hosts.
    clickButton("Add environment");
    await flush();
    expect(h.commands.connectSsh).toHaveBeenCalled();
  });

  it("adds a remote backend through the pairing form", async () => {
    stubDesktopWindow();
    h.stateOverrides.set("", "pairhost.example.com");
    h.wslQuery.data = null;

    render();

    clickButton("Add environment");
    await flush();
    expect(h.commands.connectPairing).toHaveBeenCalledWith({
      host: "pairhost.example.com",
      pairingCode: "pairhost.example.com",
    });
    expect(h.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Backend added" }));

    // Failure path.
    h.toastAdd.mockClear();
    h.commands.connectPairing.mockResolvedValueOnce(failure(new Error("pairing rejected")));
    clickButton("Add environment");
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not add backend", description: "pairing rejected" }),
    );

    // Interrupted commands stay silent.
    h.toastAdd.mockClear();
    h.commands.connectPairing.mockResolvedValueOnce(failure(new Error("interrupted"), true));
    clickButton("Add environment");
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });

  it("adds SSH backends with parsed manual targets", async () => {
    stubDesktopWindow();
    h.stateOverrides.set("remote", "ssh");
    h.stateOverrides.set("", "10.0.0.5:2222");
    h.wslQuery.data = null;
    h.sshHostsQuery.data = [];

    render();

    clickButton("Add environment");
    await flush();
    expect(h.commands.connectSsh).toHaveBeenCalledTimes(1);
    const target = (
      h.commands.connectSsh.mock.calls[0]![0] as {
        target: { hostname: string; username: string | null; port: number | null };
      }
    ).target;
    expect(target.hostname).toBe("10.0.0.5");
    expect(target.username).toBe("10.0.0.5:2222");
    expect(target.port).toBe(10);
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Environment connected" }),
    );

    // SSH connect failures strip IPC prefixes from the error text.
    h.toastAdd.mockClear();
    h.commands.connectSsh.mockResolvedValueOnce(
      failure(
        new Error(
          "Error invoking remote method 'desktop:ensure-ssh-environment': SshConnectionError: host unreachable",
        ),
      ),
    );
    clickButton("Add environment");
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });

  it("rejects manual SSH targets with invalid ports", async () => {
    stubDesktopWindow();
    h.stateOverrides.set("remote", "ssh");
    h.stateOverrides.set("", "user@wsl-box");
    h.wslQuery.data = null;
    h.sshHostsQuery.data = [];

    render();

    clickButton("Add environment");
    await flush();
    expect(h.commands.connectSsh).not.toHaveBeenCalled();
  });

  it("parses bracketed IPv6 SSH hosts", async () => {
    stubDesktopWindow();
    h.stateOverrides.set("remote", "ssh");
    h.stateOverrides.set("", "[2001:db8::1]:8443");
    h.wslQuery.data = null;
    h.sshHostsQuery.data = [];

    render();

    // The port field mirrors the host text and fails to parse as a number.
    clickButton("Add environment");
    await flush();
    expect(h.commands.connectSsh).not.toHaveBeenCalled();
  });

  it("manages the T4 Connect link", async () => {
    stubBrowserWindow();
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "remote-reachable" } },
    };
    h.hasCloudConfig = true;

    const markup = render();
    expect(markup).toContain("This environment is available to your other devices");

    const linkSwitch = control("switch", "Enable T4 Connect");

    // Successful link.
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.commands.link).toHaveBeenCalledWith({
      target: h.cloudLinkState.target,
      clerkToken: "clerk-token",
    });
    expect(h.cloudLinkState.refresh).toHaveBeenCalled();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "T4 Connect linked" }),
    );

    // Successful unlink.
    h.toastAdd.mockClear();
    invoke(linkSwitch, "onCheckedChange", false);
    await flush();
    expect(h.commands.unlink).toHaveBeenCalledWith({
      target: h.cloudLinkState.target,
      clerkToken: "clerk-token",
    });
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "T4 Connect unlinked" }),
    );

    // Clerk token failures report an update failure with a trace id action.
    h.toastAdd.mockClear();
    const tokenError = Object.assign(new Error("token expired"), { traceId: "trace-42" });
    h.clerkAuth.getToken.mockRejectedValueOnce(tokenError);
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    const failureToast = h.toastAdd.mock.calls[0]?.[0] as {
      title: string;
      data?: { secondaryActionProps?: { onClick: () => void } };
    };
    expect(failureToast.title).toBe("Could not update T4 Connect");
    failureToast.data?.secondaryActionProps?.onClick();

    // Missing token while linking asks the user to sign in.
    h.toastAdd.mockClear();
    h.clerkAuth.getToken.mockResolvedValueOnce(null);
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update T4 Connect" }),
    );

    // Link command failure.
    h.toastAdd.mockClear();
    h.commands.link.mockResolvedValueOnce(failure(new Error("link denied")));
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update T4 Connect" }),
    );

    // Interrupted link command stays silent.
    h.toastAdd.mockClear();
    h.commands.link.mockResolvedValueOnce(failure(new Error("interrupted"), true));
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();

    // Relay refresh failure after a successful link.
    h.toastAdd.mockClear();
    h.commands.relayRefresh.mockResolvedValueOnce(failure(new Error("refresh failed")));
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update T4 Connect" }),
    );

    // Interrupted refreshes stay silent, and unlinking permits a missing Clerk token.
    h.toastAdd.mockClear();
    h.commands.relayRefresh.mockResolvedValueOnce(failure(new Error("interrupted"), true));
    invoke(linkSwitch, "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();

    h.clerkAuth.getToken.mockResolvedValueOnce(null);
    invoke(linkSwitch, "onCheckedChange", false);
    await flush();
    expect(h.commands.unlink).toHaveBeenLastCalledWith({
      target: h.cloudLinkState.target,
      clerkToken: null,
    });
  });

  it("reports a missing local environment when toggling T4 Connect too early", async () => {
    stubBrowserWindow();
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "local-only" } },
    };
    h.cloudLinkState = {
      target: null,
      data: null,
      error: "cloud state failed",
      isPending: true,
      refresh: vi.fn(),
    };

    const markup = render();
    expect(markup).toContain("cloud state failed");
    expect(markup).toContain("Make this environment available");

    invoke(control("switch", "Enable T4 Connect"), "onCheckedChange", true);
    await flush();
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not update T4 Connect" }),
    );
    expect(h.commands.link).not.toHaveBeenCalled();
  });

  it("shows sign-in guidance when the clerk session is missing", () => {
    stubBrowserWindow();
    h.clerkAuth.isSignedIn = false;
    h.primarySessionState = {
      data: { authenticated: true, scopes: ADMIN_SCOPES, auth: { policy: "local-only" } },
    };
    h.cloudLinkState.data = { linked: false };

    const markup = render();
    expect(markup).toContain("Sign in to T4 Connect to manage this environment.");
  });

  it("lists connectable T4 Connect environments with availability states", async () => {
    stubBrowserWindow();
    h.primarySessionState = { data: null };
    h.hasCloudConfig = true;
    h.relayDiscovery = {
      refreshing: false,
      environments: new Map([
        [
          "environment-online",
          relayEnvironmentEntry({
            id: "environment-online",
            label: "Online Env",
            availability: "online",
          }),
        ],
        [
          "environment-offline",
          relayEnvironmentEntry({
            id: "environment-offline",
            label: "Offline Env",
            availability: "offline",
          }),
        ],
        [
          "environment-checking",
          relayEnvironmentEntry({
            id: "environment-checking",
            label: "Checking Env",
            availability: "checking",
          }),
        ],
        [
          "environment-error",
          relayEnvironmentEntry({
            id: "environment-error",
            label: "Error Env",
            availability: "error",
            errorMessage: "relay probe failed",
          }),
        ],
        [
          "environment-primary",
          relayEnvironmentEntry({
            id: "environment-primary",
            label: "Primary",
            availability: "online",
          }),
        ],
      ]),
    };

    const markup = render();

    expect(markup).toContain("Online Env");
    expect(markup).toContain("Available · Relay online");
    expect(markup).toContain("Available · Relay offline");
    expect(markup).toContain("Available · Checking relay status…");
    expect(markup).toContain("relay probe failed");
    // The primary environment is filtered out of the connectable list.
    expect(markup).not.toContain(">Primary<");

    // Connect an environment successfully.
    invoke(findControls("button", "Connect")[0]!, "onClick");
    await flush();
    expect(h.commands.register).toHaveBeenCalledTimes(1);
    expect(h.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Environment connected" }),
    );

    // Failure with a trace id.
    h.toastAdd.mockClear();
    h.commands.register.mockResolvedValueOnce(
      failure(Object.assign(new Error("register failed"), { traceId: "trace-7" })),
    );
    invoke(findControls("button", "Connect")[0]!, "onClick");
    await flush();
    const errorToast = h.toastAdd.mock.calls[0]?.[0] as {
      title: string;
      data?: { secondaryActionProps?: { onClick: () => void } };
    };
    expect(errorToast.title).toBe("Could not connect environment");
    errorToast.data?.secondaryActionProps?.onClick();

    // Interrupted registration stays silent.
    h.toastAdd.mockClear();
    h.commands.register.mockResolvedValueOnce(failure(new Error("interrupted"), true));
    invoke(findControls("button", "Connect")[0]!, "onClick");
    await flush();
    expect(h.toastAdd).not.toHaveBeenCalled();
  });

  it("renders saved-backend boundary states and management restrictions", () => {
    stubBrowserWindow();
    h.hasCloudConfig = true;
    h.primarySessionState = {
      data: {
        authenticated: true,
        scopes: [...STANDARD_SCOPES, AuthAccessReadScope, AuthAccessWriteScope],
        auth: { policy: "remote-reachable" },
      },
    };
    h.environments = [
      environment({
        id: "environment-connecting",
        label: "Connecting backend",
        connection: { phase: "connecting" },
      }),
      environment({
        id: "environment-reconnecting",
        label: "Reconnecting backend",
        connection: { phase: "reconnecting" },
      }),
      environment({
        id: "environment-error-no-trace",
        label: "Errored backend",
        connection: { phase: "error", error: new Error("transport failed"), traceId: null },
      }),
      environment({
        id: "environment-ssh-minimal",
        label: "Minimal SSH",
        targetTag: "SshConnectionTarget",
        sshTarget: {
          alias: "build-host",
          hostname: "build-host.internal",
          username: null,
          port: null,
        },
      }),
      environment({
        id: "environment-relay-idle",
        label: "Relay managed",
        relayManaged: true,
      }),
    ];

    const markup = render();

    expect(markup.match(/Connecting…/gu)).toHaveLength(2);
    expect(markup).toContain("status:error");
    expect(markup).not.toContain("Copy trace ID");
    expect(markup).toContain("SSH build-host.internal");
    expect(markup).toContain("T4 Connect");
    expect(control("switch", "Enable T4 Connect").props.disabled).toBe(true);
  });

  it("renders each network reachability fallback and toggles endpoint details", async () => {
    installMountedDesktopWindow();
    const exposureState = {
      mode: "network-accessible",
      endpointUrl: "https://desktop.example.com" as string | null,
      advertisedHost: null as string | null,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    };
    h.networkAccessQuery.data = {
      serverExposureState: exposureState,
      advertisedEndpoints: [],
    };

    let markup = render();
    expect(markup).toContain("Reachable at https://desktop.example.com");

    h.networkAccessQuery.data = {
      serverExposureState: {
        ...exposureState,
        endpointUrl: null,
        advertisedHost: "desktop.lan",
      },
      advertisedEndpoints: [],
    };
    markup = render();
    expect(markup).toContain("Pairing links use desktop.lan");

    h.networkAccessQuery.data = {
      serverExposureState: {
        ...exposureState,
        endpointUrl: null,
        advertisedHost: null,
      },
      advertisedEndpoints: [],
    };
    markup = render();
    expect(markup).toContain("Exposed on all interfaces.");

    h.networkAccessQuery.data = {
      serverExposureState: exposureState,
      advertisedEndpoints: [
        endpoint({
          id: "desktop-lan:primary",
          label: "Primary LAN",
          httpBaseUrl: "http://192.168.1.20:5133",
          isDefault: true,
        }),
        endpoint({
          id: "desktop-lan:secondary",
          label: "Secondary LAN",
          httpBaseUrl: "http://192.168.1.21:5133",
        }),
      ],
    };
    const container = await mountConnections();
    const detailsToggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("+1") === true,
    );
    expect(detailsToggle).toBeDefined();
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("http://192.168.1.20:5133");
    expect(container.textContent).not.toContain("http://192.168.1.21:5133");

    await click(detailsToggle!);
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(detailsToggle?.textContent).toContain("Hide");
    expect(container.textContent).toContain("http://192.168.1.21:5133");

    await click(detailsToggle!);
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(detailsToggle?.textContent).toContain("+1");
    expect(container.textContent).not.toContain("http://192.168.1.21:5133");
  });

  it("shows a skeleton while the first relay refresh is in flight", () => {
    stubBrowserWindow();
    h.primarySessionState = { data: null };
    h.hasCloudConfig = true;
    h.relayDiscovery = { refreshing: true, environments: new Map() };

    const markup = render();
    expect(markup).toContain("data-skeleton");
  });

  it("shows the cloud-enabled empty state when no environments exist anywhere", () => {
    stubBrowserWindow();
    h.primarySessionState = { data: null };
    h.hasCloudConfig = true;
    h.relayDiscovery = { refreshing: false, environments: new Map() };

    const markup = render();
    expect(markup).toContain("No saved remote environments");
    expect(markup).toContain("connect one from T4 Connect");
  });
});
