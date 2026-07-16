/**
 * Unit tests for the Sidebar mega-component.
 *
 * Strategy: the sidebar's leaf UI primitives, router, and environment-bound
 * state hooks are replaced with capture-mocks that record every props object
 * they receive during a `renderToStaticMarkup` pass. Tests then walk the
 * captured React element trees to find host elements/handlers (by
 * data-testid / aria-label) and invoke them directly with fake events, which
 * exercises the component's callback bodies without a DOM.
 */
import * as Cause from "effect/Cause";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t4code/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t4code/contracts/settings";
import { createModelSelection } from "@t4code/shared/model";
import { scopedThreadKey, scopeThreadRef } from "@t4code/client-runtime/environment";
import { derivePhysicalProjectKey } from "../logicalProject";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t4code/client-runtime/state/shell";

const browserRuntime =
  typeof document !== "undefined" && typeof document.createElement === "function";
const staticDescribe = browserRuntime ? describe.skip : describe;

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted harness state shared with every vi.mock factory.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  interface Captured {
    readonly name: string;
    readonly props: Record<string, unknown>;
  }

  const state: any = {
    React: null,
    captures: [] as Captured[],
    // data
    projects: [],
    threads: [],
    environments: [],
    primaryEnvironmentId: null,
    serverConfigs: new Map(),
    clientSettings: null,
    atomValues: {},
    vcsStatusByCwd: {},
    runningTerminalIds: [],
    discoveredPortsByThreadId: {},
    desktopBootstraps: [],
    desktopUpdateState: null,
    updateBtnDisabled: false,
    updateBtnAction: "none",
    showArmWarning: false,
    isMobile: false,
    sidebarCtx: null,
    pathname: "/",
    routeParams: {},
    localApi: null,
    isDesktopHost: true,
    copyShouldFail: false,
    openDiscoveredPortResult: { _tag: "Success", value: undefined },
    commandResults: {},
    commandCalls: [],
    shortcutLabels: {},
    showJumpHintModifiers: false,
    // mock stores
    ui: null,
    selection: null,
    meta: null,
    terminalUi: null,
  };

  const capture = (name: string, props: Record<string, unknown>) => {
    state.captures.push({ name, props });
  };

  const mk = (name: string, tag = "div") => {
    const Comp = (props: Record<string, unknown>) => {
      capture(name, props);
      const R = state.React as typeof import("react");
      const { children, render } = props as { children?: unknown; render?: unknown };
      const passthrough: Record<string, unknown> = {
        "data-mock": name,
      };
      const domProps = new Set([
        "aria-label",
        "autoFocus",
        "className",
        "disabled",
        "id",
        "onBlur",
        "onBlurCapture",
        "onChange",
        "onClick",
        "onContextMenu",
        "onDoubleClick",
        "onFocus",
        "onKeyDown",
        "onMouseLeave",
        "onPointerDown",
        "placeholder",
        "readOnly",
        "role",
        "tabIndex",
        "title",
        "type",
        "value",
      ]);
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith("data-") || domProps.has(key)) {
          passthrough[key] = value;
        }
      }
      if (render !== undefined && R.isValidElement(render)) {
        return children === undefined
          ? R.cloneElement(render as never, passthrough as never)
          : R.cloneElement(render as never, passthrough as never, children as never);
      }
      return R.createElement(tag, passthrough, children as never);
    };
    Comp.displayName = name;
    return Comp;
  };

  const makeStore = <T extends object>(init: () => T) => {
    let current = init();
    const hook = (selector?: (s: T) => unknown) =>
      selector ? selector(current) : (current as unknown);
    hook.getState = () => current;
    hook.setState = (partial: Partial<T>) => {
      current = { ...current, ...partial };
    };
    hook.reset = () => {
      current = init();
    };
    return hook;
  };

  const spies = {
    navigate: vi.fn(),
    routerNavigate: vi.fn(),
    openPrLink: vi.fn(),
    openAddProject: vi.fn(),
    newThreadHandler: vi.fn(),
    updateSettings: vi.fn(),
    archiveThread: vi.fn(),
    deleteThread: vi.fn(),
    contextMenuShow: vi.fn(),
    dialogConfirm: vi.fn(),
    toastAdd: vi.fn(),
    toastClose: vi.fn(),
    stackedThreadToast: vi.fn((toast: unknown) => toast),
    setOpenMobile: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    togglePinned: vi.fn(),
    markThreadUnread: vi.fn(),
    setProjectExpanded: vi.fn(),
    reorderProjects: vi.fn(),
    toggleThread: vi.fn(),
    rangeSelectTo: vi.fn(),
    clearSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    setAnchor: vi.fn(),
    getDraftThreadByProjectRef: vi.fn(),
    clearDraftThread: vi.fn(),
    clearProjectDraftThreadId: vi.fn(),
    openDiscoveredPort: vi.fn(),
    useEnvironmentThread: vi.fn(),
    useProjectBranchPolling: vi.fn(),
    autoAnimate: vi.fn(),
    pointerWithin: vi.fn(),
    closestCorners: vi.fn(),
    copyToClipboard: vi.fn(),
    windowConfirm: vi.fn(),
  };

  const runCommand = (command: { label?: string }, input: unknown) => {
    const label = command?.label ?? "unknown";
    state.commandCalls.push({ label, input });
    const impl = state.commandResults[label] as ((value: unknown) => unknown) | undefined;
    return Promise.resolve(impl ? impl(input) : { _tag: "Success", value: undefined });
  };

  const uiStore = makeStore(() => ({
    projectExpandedById: {} as Record<string, boolean>,
    projectOrder: [] as string[],
    threadLastVisitedAtById: {} as Record<string, string>,
    markThreadVisited: vi.fn(),
    markThreadUnread: spies.markThreadUnread,
    setThreadChangedFilesExpanded: vi.fn(),
    setDefaultAdvertisedEndpointKey: vi.fn(),
    setProjectExpanded: spies.setProjectExpanded,
    reorderProjects: spies.reorderProjects,
  }));

  const selectionStore = makeStore(() => ({
    selectedThreadKeys: new Set<string>(),
    anchorThreadKey: null as string | null,
    toggleThread: spies.toggleThread,
    rangeSelectTo: spies.rangeSelectTo,
    clearSelection: spies.clearSelection,
    removeFromSelection: spies.removeFromSelection,
    setAnchor: spies.setAnchor,
    hasSelection: () =>
      (selectionStore.getState() as { selectedThreadKeys: Set<string> }).selectedThreadKeys.size >
      0,
  }));

  const metaStore = makeStore(() => ({
    pinnedThreadKeys: [] as string[],
    unreadThreadKeys: [] as string[],
    togglePinned: spies.togglePinned,
    markUnread: spies.markUnread,
    markRead: spies.markRead,
  }));

  const terminalUiStore = makeStore(() => ({
    terminalUiStateByThreadKey: {} as Record<string, never>,
  }));

  state.ui = uiStore;
  state.selection = selectionStore;
  state.meta = metaStore;
  state.terminalUi = terminalUiStore;
  return {
    state,
    spies,
    capture,
    mk,
    runCommand,
    uiStore,
    selectionStore,
    metaStore,
    terminalUiStore,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
  Link: h.mk("Link", "a"),
  useNavigate: () => h.spies.navigate,
  useRouter: () => ({ navigate: h.spies.routerNavigate }),
  useLocation: (opts?: { select?: (loc: { pathname: string }) => unknown }) =>
    opts?.select ? opts.select({ pathname: h.state.pathname }) : { pathname: h.state.pathname },
  useParams: (opts?: { select?: (params: Record<string, string>) => unknown }) =>
    opts?.select ? opts.select(h.state.routeParams) : h.state.routeParams,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { id?: string }) => h.state.atomValues[atom?.id ?? ""] ?? null,
  useAtomRefresh: () => () => {},
  RegistryContext: null,
}));

vi.mock("@formkit/auto-animate", () => ({
  autoAnimate: h.spies.autoAnimate,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: h.mk("DndContext"),
  PointerSensor: function PointerSensor() {},
  useSensor: (sensor: unknown, options: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
  pointerWithin: h.spies.pointerWithin,
  closestCorners: h.spies.closestCorners,
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: h.mk("SortableContext"),
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: { "data-sortable": true },
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
  }),
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToFirstScrollableAncestor: () => ({}),
  restrictToVerticalAxis: () => ({}),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Translate: { toString: () => "" } },
}));

vi.mock("../env", () => ({
  get isDesktopHost() {
    return h.state.isDesktopHost as boolean;
  },
}));

vi.mock("../state/entities", () => ({
  useProjects: () => h.state.projects,
  useThreadShells: () => h.state.threads,
  useThreadShellsForProjectRefs: (
    refs: ReadonlyArray<{ environmentId: string; projectId: string }>,
  ) =>
    (h.state.threads as Array<{ environmentId: string; projectId: string }>).filter((thread) =>
      refs.some(
        (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
      ),
    ),
  useProject: (ref: { environmentId: string; projectId: string } | null) =>
    ref
      ? ((h.state.projects as Array<{ environmentId: string; id: string }>).find(
          (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
        ) ?? null)
      : null,
  useServerConfigs: () => h.state.serverConfigs,
  readThreadShell: () => null,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: h.state.environments }),
  usePrimaryEnvironmentId: () => h.state.primaryEnvironmentId,
  useEnvironment: (environmentId: string) =>
    (h.state.environments as Array<{ environmentId: string }>).find(
      (environment) => environment.environmentId === environmentId,
    ) ?? null,
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { args?: { input?: { cwd?: string } } } | null) => ({
    data: atom ? (h.state.vcsStatusByCwd[atom.args?.input?.cwd ?? ""] ?? null) : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

vi.mock("../state/terminalSessions", () => ({
  useThreadRunningTerminalIds: () => h.state.runningTerminalIds,
}));

vi.mock("../portDiscoveryState", () => ({
  useThreadDiscoveredPorts: (ref: { threadId: string }) =>
    h.state.discoveredPortsByThreadId[ref.threadId] ?? [],
}));

vi.mock("./preview/openDiscoveredPort", () => ({
  openDiscoveredPort: h.spies.openDiscoveredPort,
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) => (input: unknown) => h.runCommand(command, input),
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: { label: "preview.open" } },
}));

vi.mock("../state/projects", () => ({
  projectEnvironment: {
    delete: { label: "project.delete" },
    update: { label: "project.update" },
  },
}));

vi.mock("../state/shell", () => ({
  shellEnvironment: { openInEditor: { label: "shell.openInEditor" } },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    updateMetadata: { label: "thread.updateMetadata" },
    create: { label: "thread.create" },
  },
  useEnvironmentThread: h.spies.useEnvironmentThread,
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    status: (args: unknown) => ({ __q: "vcs.status", args }),
    pull: { label: "vcs.pull" },
    refreshStatus: { label: "vcs.refreshStatus" },
  },
}));

vi.mock("../state/server", () => ({
  primaryServerConfigAtom: { id: "primaryServerConfig" },
  primaryServerKeybindingsAtom: { id: "primaryServerKeybindings" },
}));

vi.mock("../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => h.state.desktopUpdateState,
}));

vi.mock("./desktopUpdate.logic", () => ({
  isDesktopUpdateButtonDisabled: () => h.state.updateBtnDisabled,
  resolveDesktopUpdateButtonAction: () => h.state.updateBtnAction,
  shouldShowArm64IntelBuildWarning: () => h.state.showArmWarning,
  getArm64IntelBuildWarningDescription: () => "Running the Intel build on Apple Silicon.",
  getDesktopUpdateInstallConfirmationMessage: () => "Install the update now?",
  getDesktopUpdateActionError: (result: { error?: string } | null | undefined) =>
    result?.error ?? null,
  shouldToastDesktopUpdateActionResult: (result: { toast?: boolean } | null | undefined) =>
    result?.toast === true,
}));

vi.mock("../hooks/useProjectBranchPolling", () => ({
  useProjectBranchPolling: h.spies.useProjectBranchPolling,
}));

vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    archiveThread: h.spies.archiveThread,
    deleteThread: h.spies.deleteThread,
  }),
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => h.spies.newThreadHandler,
}));

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) => selector(h.state.clientSettings),
  useUpdateClientSettings: () => h.spies.updateSettings,
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (opts?: {
    onCopy?: (ctx: unknown) => void;
    onError?: (error: Error, ctx: unknown) => void;
  }) => ({
    copyToClipboard: vi.fn((value: string, ctx: unknown) => {
      h.spies.copyToClipboard(value, ctx);
      if (h.state.copyShouldFail) {
        opts?.onError?.(new Error("copy failed"), ctx);
      } else {
        opts?.onCopy?.(ctx);
      }
    }),
  }),
}));

vi.mock("~/hooks/useMediaQuery", () => ({
  useIsMobile: () => h.state.isMobile,
}));

vi.mock("../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => h.state.desktopBootstraps,
}));

vi.mock("../lib/openPullRequestLink", () => ({
  useOpenPrLink: () => h.spies.openPrLink,
}));

vi.mock("../commandPaletteContext", () => ({
  useOpenAddProjectCommandPalette: () => h.spies.openAddProject,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => h.state.localApi,
}));

vi.mock("../keybindings", () => ({
  resolveShortcutCommand: () => null,
  shortcutLabelForCommand: (_config: unknown, command: string) => {
    const labels = h.state.shortcutLabels as Record<string, string | null>;
    return command in labels ? labels[command] : "Mod+K";
  },
  shouldShowThreadJumpHintsForModifiers: () => h.state.showJumpHintModifiers,
  threadJumpCommandForIndex: (index: number) =>
    index < 9 ? `chat.jumpToThread${index + 1}` : null,
  threadJumpIndexFromCommand: () => null,
  threadTraversalDirectionFromCommand: () => null,
}));

vi.mock("../uiStateStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useUiStateStore: h.uiStore };
});

vi.mock("../threadSelectionStore", () => ({
  useThreadSelectionStore: h.selectionStore,
}));

vi.mock("../sidebarWorkspaceMetaStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useSidebarWorkspaceMetaStore: h.metaStore };
});

vi.mock("../terminalUiStateStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useTerminalUiStateStore: h.terminalUiStore };
});

vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: h.spies.getDraftThreadByProjectRef,
      clearDraftThread: h.spies.clearDraftThread,
      clearProjectDraftThreadId: h.spies.clearProjectDraftThreadId,
    }),
  },
}));

vi.mock("./ThreadStatusIndicators", () => ({
  ChangeRequestStatusIcon: h.mk("ChangeRequestStatusIcon", "span"),
  ThreadWorktreeIndicator: h.mk("ThreadWorktreeIndicator", "span"),
  ThreadStatusLabel: (props: { status: { label: string }; compact?: boolean }) => {
    h.capture("ThreadStatusLabel", props as unknown as Record<string, unknown>);
    const R = h.state.React as typeof import("react");
    return R.createElement("span", { "data-mock": "ThreadStatusLabel" }, props.status.label);
  },
  resolveThreadPr: (branch: string | null, data: { pr?: unknown } | null) =>
    branch && data?.pr ? data.pr : null,
  prStatusIndicator: (pr: { url: string } | null) =>
    pr ? { url: pr.url, tooltip: "PR open", colorClass: "pr-color" } : null,
  terminalStatusFromRunningIds: (ids: readonly string[]) =>
    ids.length > 0
      ? { label: `${ids.length} terminal running`, colorClass: "term-color", pulse: true }
      : null,
}));

vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: h.mk("ProjectFavicon", "span") }));
vi.mock("./CreateWorktreeDialog", () => ({
  CreateWorktreeDialog: h.mk("CreateWorktreeDialog"),
}));
vi.mock("./settings/SettingsSidebarNav", () => ({
  SettingsSidebarNav: h.mk("SettingsSidebarNav"),
}));
vi.mock("./sidebar/SidebarUpdatePill", () => ({
  SidebarUpdatePill: h.mk("SidebarUpdatePill", "span"),
}));
vi.mock("./sidebar/SidebarProviderUpdatePill", () => ({
  SidebarProviderUpdatePill: h.mk("SidebarProviderUpdatePill", "span"),
}));

vi.mock("./ui/toast", () => ({
  toastManager: {
    add: h.spies.toastAdd,
    close: h.spies.toastClose,
  },
  stackedThreadToast: h.spies.stackedThreadToast,
}));

vi.mock("./ui/alert", () => ({
  Alert: h.mk("Alert"),
  AlertAction: h.mk("AlertAction"),
  AlertDescription: h.mk("AlertDescription"),
  AlertTitle: h.mk("AlertTitle"),
}));

vi.mock("./ui/button", () => ({ Button: h.mk("Button", "button") }));
vi.mock("./ui/input", () => ({ Input: h.mk("Input", "input") }));
vi.mock("./ui/kbd", () => ({ Kbd: h.mk("Kbd", "kbd") }));
vi.mock("./ui/command", () => ({ CommandDialogTrigger: h.mk("CommandDialogTrigger") }));

vi.mock("./ui/dialog", () => ({
  Dialog: h.mk("Dialog"),
  DialogDescription: h.mk("DialogDescription"),
  DialogFooter: h.mk("DialogFooter"),
  DialogHeader: h.mk("DialogHeader"),
  DialogPanel: h.mk("DialogPanel"),
  DialogPopup: h.mk("DialogPopup"),
  DialogTitle: h.mk("DialogTitle"),
}));

vi.mock("./ui/menu", () => ({
  Menu: h.mk("Menu"),
  MenuGroup: h.mk("MenuGroup"),
  MenuPopup: h.mk("MenuPopup"),
  MenuRadioGroup: h.mk("MenuRadioGroup"),
  MenuRadioItem: h.mk("MenuRadioItem"),
  MenuSeparator: h.mk("MenuSeparator"),
  MenuTrigger: h.mk("MenuTrigger", "button"),
}));

vi.mock("./ui/number-field", () => ({
  NumberField: h.mk("NumberField"),
  NumberFieldDecrement: h.mk("NumberFieldDecrement", "button"),
  NumberFieldGroup: h.mk("NumberFieldGroup"),
  NumberFieldIncrement: h.mk("NumberFieldIncrement", "button"),
  NumberFieldInput: h.mk("NumberFieldInput", "input"),
}));

vi.mock("./ui/select", () => ({
  Select: h.mk("Select"),
  SelectItem: h.mk("SelectItem"),
  SelectPopup: h.mk("SelectPopup"),
  SelectTrigger: h.mk("SelectTrigger", "button"),
  SelectValue: h.mk("SelectValue", "span"),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: h.mk("Tooltip", "span"),
  TooltipPopup: h.mk("TooltipPopup", "span"),
  TooltipTrigger: h.mk("TooltipTrigger", "span"),
}));

vi.mock("./ui/sidebar", () => ({
  SidebarContent: h.mk("SidebarContent"),
  SidebarFooter: h.mk("SidebarFooter"),
  SidebarGroup: h.mk("SidebarGroup"),
  SidebarHeader: h.mk("SidebarHeader"),
  SidebarMenu: h.mk("SidebarMenu", "ul"),
  SidebarMenuButton: h.mk("SidebarMenuButton", "button"),
  SidebarMenuItem: h.mk("SidebarMenuItem", "li"),
  SidebarMenuSub: h.mk("SidebarMenuSub", "ul"),
  SidebarMenuSubButton: h.mk("SidebarMenuSubButton", "button"),
  SidebarMenuSubItem: h.mk("SidebarMenuSubItem", "li"),
  SidebarSeparator: h.mk("SidebarSeparator", "hr"),
  SidebarTrigger: h.mk("SidebarTrigger", "button"),
  useSidebar: () => h.state.sidebarCtx,
}));

// The module under test must be imported after all mocks.
import Sidebar, { SidebarBrandContent, SidebarThreadRow } from "./Sidebar";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ENV_MAIN = EnvironmentId.make("env-main");
const ENV_REMOTE = EnvironmentId.make("env-remote");
const ENV_WSL = EnvironmentId.make("env-wsl");

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function makeProject(
  id: string,
  overrides: Partial<Omit<EnvironmentProject, "id">> = {},
): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    title: "Repo A",
    workspaceRoot: "C:/repo-a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: iso(600),
    updatedAt: iso(60),
    environmentId: ENV_MAIN,
    ...overrides,
  };
}

function makeThread(
  id: string,
  overrides: Partial<Omit<EnvironmentThreadShell, "id">> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    title: `Thread ${id}`,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: iso(500),
    updatedAt: iso(50),
    archivedAt: null,
    session: null,
    latestUserMessageAt: iso(40),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    environmentId: ENV_MAIN,
    ...overrides,
  };
}

function environmentFixture(overrides: {
  environmentId: EnvironmentId;
  label?: string | null;
  connectionId?: string;
  displayUrl?: string | null;
  phase?: string;
  error?: string | null;
}) {
  return {
    environmentId: overrides.environmentId,
    label: overrides.label ?? null,
    entry: {
      target: {
        _tag: "BearerConnectionTarget",
        connectionId: overrides.connectionId ?? "plain",
      },
    },
    displayUrl: overrides.displayUrl ?? null,
    connection: { phase: overrides.phase ?? "connected", error: overrides.error ?? null },
  };
}

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

// ─────────────────────────────────────────────────────────────────────────────
// Render + capture helpers
// ─────────────────────────────────────────────────────────────────────────────

function render(element: React.ReactElement): string {
  h.state.captures.length = 0;
  return renderToStaticMarkup(element);
}

interface Captured {
  readonly name: string;
  readonly props: Record<string, unknown>;
}

function captured(name: string): Captured[] {
  return (h.state.captures as Captured[]).filter((entry) => entry.name === name);
}

function collectElements(node: unknown, out: React.ReactElement[]): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return;
  }
  if (React.isValidElement(node)) {
    out.push(node);
    const props = node.props as Record<string, unknown>;
    collectElements(props["children"], out);
    collectElements(props["render"], out);
  }
}

type PropsPredicate = (props: Record<string, unknown>) => boolean;

function findProps(predicate: PropsPredicate): Record<string, unknown> | null {
  for (const entry of h.state.captures as Captured[]) {
    if (predicate(entry.props)) return entry.props;
    const elements: React.ReactElement[] = [];
    collectElements(entry.props["children"], elements);
    collectElements(entry.props["render"], elements);
    for (const element of elements) {
      const props = element.props as Record<string, unknown>;
      if (predicate(props)) return props;
    }
  }
  return null;
}

function mustFindProps(predicate: PropsPredicate, label: string): Record<string, unknown> {
  const props = findProps(predicate);
  if (!props) throw new Error(`Could not find captured element: ${label}`);
  return props;
}

const byTestId =
  (id: string): PropsPredicate =>
  (props) =>
    props["data-testid"] === id;
const byAriaLabel =
  (label: string): PropsPredicate =>
  (props) =>
    props["aria-label"] === label;

function invoke<TEvent>(props: Record<string, unknown>, handler: string, event: TEvent): void {
  const fn = props[handler];
  if (typeof fn !== "function") {
    throw new Error(`Captured element has no ${handler} handler`);
  }
  fn(event);
}

function mouseEvent(overrides: Record<string, unknown> = {}): React.MouseEvent<HTMLButtonElement> {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    detail: 1,
    button: 0,
    clientX: 11,
    clientY: 22,
    target: { closest: () => null },
    currentTarget: { contains: () => false },
    ...overrides,
  } as unknown as React.MouseEvent<HTMLButtonElement>;
}

function keyboardEvent(
  key: string,
  overrides: Record<string, unknown> = {},
): React.KeyboardEvent<HTMLButtonElement> {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as React.KeyboardEvent<HTMLButtonElement>;
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

function failureResult(message: string) {
  return { _tag: "Failure", cause: Cause.fail(new Error(message)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario setup
// ─────────────────────────────────────────────────────────────────────────────

const projectA = makeProject("project-a");

const threadDefault = makeThread("thread-default", {
  kind: "default",
  title: "Repo A",
});
const threadActive = makeThread("thread-active", {
  title: "Active worktree",
  branch: "feat/x",
  worktreePath: "C:/wt/x",
  session: {
    threadId: ThreadId.make("thread-active"),
    status: "running",
    providerName: "Claude Code",
    activeTurnId: null,
    lastError: null,
    updatedAt: iso(90),
    runtimeMode: "full-access",
  },
  latestUserMessageAt: iso(5),
});
const threadIdle = makeThread("thread-idle", { title: "Idle thread" });
const threadPanel = makeThread("thread-panel", { kind: "panel", title: "Panel thread" });
const threadArchived = makeThread("thread-archived", {
  archivedAt: iso(10),
  title: "Archived thread",
});

function baseScenario() {
  h.state.projects = [projectA];
  h.state.threads = [threadDefault, threadActive, threadIdle, threadPanel, threadArchived];
  h.state.environments = [
    environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
  ];
  h.state.primaryEnvironmentId = ENV_MAIN;
  h.state.routeParams = { environmentId: ENV_MAIN, threadId: "thread-active" };
  h.state.vcsStatusByCwd = {
    "C:/repo-a": { refName: "main" },
    "C:/wt/x": { refName: "feat/x", pr: { url: "https://example.com/pr/1" } },
  };
}

function fakeLocalApi() {
  const api = {
    contextMenu: { show: h.spies.contextMenuShow },
    dialogs: { confirm: h.spies.dialogConfirm },
  };
  h.state.localApi = api;
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.React = React;
  h.uiStore.reset();
  h.selectionStore.reset();
  h.metaStore.reset();
  h.terminalUiStore.reset();
  h.state.captures.length = 0;
  h.state.projects = [];
  h.state.threads = [];
  h.state.environments = [];
  h.state.primaryEnvironmentId = ENV_MAIN;
  h.state.serverConfigs = new Map();
  h.state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  h.state.atomValues = {
    primaryServerConfig: {
      availableEditors: ["vscode"],
      environment: { serverVersion: "0.1.0" },
    },
    primaryServerKeybindings: {},
  };
  h.state.vcsStatusByCwd = {};
  h.state.runningTerminalIds = [];
  h.state.discoveredPortsByThreadId = {};
  h.state.desktopBootstraps = [];
  h.state.desktopUpdateState = null;
  h.state.updateBtnDisabled = false;
  h.state.updateBtnAction = "none";
  h.state.showArmWarning = false;
  h.state.isMobile = false;
  h.state.sidebarCtx = { isMobile: false, setOpenMobile: h.spies.setOpenMobile };
  h.state.pathname = "/";
  h.state.routeParams = {};
  h.state.localApi = null;
  h.state.isDesktopHost = true;
  h.state.copyShouldFail = false;
  h.state.openDiscoveredPortResult = { _tag: "Success", value: undefined };
  h.state.commandResults = {};
  h.state.commandCalls = [];
  h.state.shortcutLabels = {};
  h.state.showJumpHintModifiers = false;
  h.spies.contextMenuShow.mockResolvedValue(null);
  h.spies.dialogConfirm.mockResolvedValue(true);
  h.spies.toastAdd.mockReturnValue("toast-1");
  h.spies.archiveThread.mockResolvedValue({ _tag: "Success", value: undefined });
  h.spies.deleteThread.mockResolvedValue({ _tag: "Success", value: undefined });
  h.spies.getDraftThreadByProjectRef.mockReturnValue(null);
  h.spies.openDiscoveredPort.mockImplementation(async () => h.state.openDiscoveredPortResult);
  h.spies.pointerWithin.mockReturnValue([]);
  h.spies.closestCorners.mockReturnValue([]);
  h.spies.windowConfirm.mockReturnValue(true);

  if (!browserRuntime) {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("document", { activeElement: null, querySelector: () => null });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      clearTimeout: () => {},
      confirm: h.spies.windowConfirm,
      desktopBridge: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

staticDescribe("SidebarBrandContent", () => {
  it("renders base name and stage label", () => {
    const markup = render(<SidebarBrandContent appBaseName="T4Code" stageLabel="Dev" />);
    expect(markup).toContain("T4Code");
    expect(markup).toContain("Dev");
  });
});

staticDescribe("Sidebar full render", () => {
  it("renders the project header, primary row, and workspace thread rows", () => {
    baseScenario();
    const markup = render(<Sidebar />);

    expect(markup).toContain("Repo A");
    expect(markup).toContain(">primary<");
    expect(markup).toContain("thread-row-thread-active");
    expect(markup).toContain("thread-row-thread-idle");
    // Panel and archived threads never render as workspace rows.
    expect(markup).not.toContain("thread-row-thread-panel");
    expect(markup).not.toContain("thread-row-thread-archived");
    // Running session renders the nested agent sub-row.
    expect(markup).toContain("thread-agent-row-thread-active");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Running");
    // The live branch from vcs.status becomes the primary row title.
    expect(markup).toContain("main");
    // Search entry + shortcut label.
    expect(markup).toContain("Search");
    expect(markup).toContain("Mod+K");
  });

  it("renders the settings navigation when routed to /settings", () => {
    baseScenario();
    h.state.pathname = "/settings/appearance";
    render(<Sidebar />);

    const nav = captured("SettingsSidebarNav");
    expect(nav).toHaveLength(1);
    expect(nav[0]!.props["pathname"]).toBe("/settings/appearance");
  });

  it("renders the empty projects state", () => {
    const markup = render(<Sidebar />);
    expect(markup).toContain("No projects yet");
  });

  it("shows the empty-thread state for an expanded project without workspace threads", () => {
    h.state.projects = [projectA];
    h.state.threads = [threadDefault];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    const markup = render(<Sidebar />);
    expect(markup).toContain("No threads yet");
  });

  it("collapses a project but keeps the active thread row visible", () => {
    baseScenario();
    h.uiStore.setState({
      projectExpandedById: { [derivePhysicalProjectKey(projectA)]: false },
    });
    const markup = render(<Sidebar />);
    // Active thread peeks through even while collapsed.
    expect(markup).toContain("thread-row-thread-active");
    expect(markup).not.toContain("thread-row-thread-idle");
  });

  it("shows the overflow 'Show more' affordance and expands on click", () => {
    baseScenario();
    h.state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, sidebarThreadPreviewCount: 1 };
    const markup = render(<Sidebar />);
    expect(markup).toContain("Show more");

    const showMore = mustFindProps(
      (props) =>
        typeof props["onClick"] === "function" &&
        props["data-thread-selection-safe"] !== undefined &&
        props["size"] === "sm" &&
        props["className"] !== undefined &&
        String(props["className"]).includes("text-[10px]"),
      "show more button",
    );
    invoke(showMore, "onClick", mouseEvent());
  });

  it("renders the arm64 warning with a download action and runs the download flow", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "idle" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "download";
    const downloadUpdate = vi.fn(async () => ({ completed: true, toast: false }));
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate,
      installUpdate: vi.fn(),
    };

    const markup = render(<Sidebar />);
    expect(markup).toContain("Intel build on Apple Silicon");
    expect(markup).toContain("Download ARM build");

    const button = captured("Button").find(
      (entry) => entry.props["children"] === "Download ARM build",
    );
    expect(button).toBeDefined();
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(downloadUpdate).toHaveBeenCalled();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Update downloaded" }),
    );
  });

  it("toasts when the update download reports an actionable error", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "idle" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "download";
    const downloadUpdate = vi.fn(async () => ({ completed: false, toast: true, error: "no disk" }));
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate,
      installUpdate: vi.fn(),
    };

    render(<Sidebar />);
    const button = captured("Button").find(
      (entry) => entry.props["children"] === "Download ARM build",
    );
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not download update", description: "no disk" }),
    );
  });

  it("toasts when the update download rejects", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "idle" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "download";
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate: vi.fn(async () => {
        throw new Error("network down");
      }),
      installUpdate: vi.fn(),
    };

    render(<Sidebar />);
    const button = captured("Button").find(
      (entry) => entry.props["children"] === "Download ARM build",
    );
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not start update download",
        description: "network down",
      }),
    );
  });

  it("runs the install flow behind a confirmation and toasts errors", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "downloaded" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "install";
    const installUpdate = vi.fn(async () => ({ toast: true, error: "install failed" }));
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate: vi.fn(),
      installUpdate,
    };

    render(<Sidebar />);
    const button = captured("Button").find(
      (entry) => entry.props["children"] === "Install ARM build",
    );
    expect(button).toBeDefined();

    // First: user declines the confirm.
    h.spies.windowConfirm.mockReturnValueOnce(false);
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(installUpdate).not.toHaveBeenCalled();

    // Then: user accepts, install reports an error.
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(installUpdate).toHaveBeenCalled();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not install update", description: "install failed" }),
    );

    // And: install rejects entirely.
    installUpdate.mockRejectedValueOnce(new Error("io error"));
    invoke(button!.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not install update", description: "io error" }),
    );
  });

  it("keeps update actions quiet when the bridge or actionable result is absent", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "idle" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "download";
    render(<Sidebar />);
    const button = captured("Button").find(
      (entry) => entry.props["children"] === "Download ARM build",
    )!;
    invoke(button.props, "onClick", mouseEvent());
    expect(h.spies.toastAdd).not.toHaveBeenCalled();

    const downloadUpdate = vi.fn(async () => ({ completed: false, toast: false }));
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate,
      installUpdate: vi.fn(),
    };
    invoke(button.props, "onClick", mouseEvent());
    await flush();
    expect(downloadUpdate).toHaveBeenCalled();
    expect(h.spies.toastAdd).not.toHaveBeenCalled();
  });

  it("uses generic messages for opaque update failures", async () => {
    baseScenario();
    h.state.desktopUpdateState = { phase: "idle" };
    h.state.showArmWarning = true;
    h.state.updateBtnAction = "download";
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate: vi.fn(async () => Promise.reject("opaque download failure")),
      installUpdate: vi.fn(),
    };
    render(<Sidebar />);
    const download = captured("Button").find(
      (entry) => entry.props["children"] === "Download ARM build",
    )!;
    invoke(download.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An unexpected error occurred." }),
    );

    h.spies.toastAdd.mockClear();
    h.state.desktopUpdateState = { phase: "downloaded" };
    h.state.updateBtnAction = "install";
    (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(async () => Promise.reject("opaque install failure")),
    };
    h.state.captures.length = 0;
    render(<Sidebar />);
    const install = captured("Button").find(
      (entry) => entry.props["children"] === "Install ARM build",
    )!;
    invoke(install.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An unexpected error occurred." }),
    );
  });

  it("renders local secondary backend connection status", () => {
    baseScenario();
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({
        environmentId: ENV_WSL,
        label: "WSL",
        connectionId: "local:wsl",
        displayUrl: "http://localhost:9001",
        phase: "error",
        error: "boot failed",
      }),
    ];
    h.state.desktopBootstraps = [
      { label: "WSL", httpBaseUrl: "http://localhost:9001" },
      { label: "Podman", httpBaseUrl: null },
    ];
    const markup = render(<Sidebar />);
    expect(markup).toContain("Connecting Podman");
    expect(markup).toContain("Couldn&#x27;t connect WSL");
    expect(markup).toContain("boot failed");
  });

  it("falls back to a generic error when a failed backend reports no error text", () => {
    baseScenario();
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({
        environmentId: ENV_WSL,
        label: "WSL",
        connectionId: "local:wsl",
        displayUrl: "http://localhost:9001",
        phase: "error",
        error: null,
      }),
    ];
    h.state.desktopBootstraps = [{ label: "WSL", httpBaseUrl: "http://localhost:9001" }];
    const markup = render(<Sidebar />);
    expect(markup).toContain("The backend didn&#x27;t respond.");
  });

  it("attaches auto-animate to project and thread lists once per node", () => {
    baseScenario();
    render(<Sidebar />);
    const menus = captured("SidebarMenu").filter(
      (entry) => typeof entry.props["ref"] === "function",
    );
    expect(menus.length).toBeGreaterThan(0);
    const attach = menus[0]!.props["ref"] as (node: unknown) => void;
    const node = {};
    attach(node);
    attach(node);
    attach(null);
    expect(h.spies.autoAnimate).toHaveBeenCalledTimes(1);

    const subMenus = captured("SidebarMenuSub").filter(
      (entry) => typeof entry.props["ref"] === "function",
    );
    expect(subMenus.length).toBeGreaterThan(0);
    const attachThreads = subMenus[0]!.props["ref"] as (node: unknown) => void;
    const threadNode = {};
    attachThreads(threadNode);
    attachThreads(threadNode);
    expect(h.spies.autoAnimate).toHaveBeenCalledTimes(2);
  });

  it("opens the create-worktree dialog from the header button and resets on close", () => {
    baseScenario();
    render(<Sidebar />);

    const newWorktree = mustFindProps(byTestId("sidebar-new-worktree-trigger"), "new worktree");
    invoke(newWorktree, "onClick", mouseEvent());

    const addProject = mustFindProps(byTestId("sidebar-add-project-trigger"), "add project");
    invoke(addProject, "onClick", mouseEvent());
    expect(h.spies.openAddProject).toHaveBeenCalled();

    const dialog = captured("CreateWorktreeDialog")[0]!;
    const onOpenChange = dialog.props["onOpenChange"] as (open: boolean) => void;
    onOpenChange(true);
    onOpenChange(false);
  });

  it("navigates to settings from the footer, closing the mobile sheet when needed", () => {
    baseScenario();
    h.state.sidebarCtx = { isMobile: true, setOpenMobile: h.spies.setOpenMobile };
    render(<Sidebar />);

    const footerButton = captured("SidebarMenuButton").find((entry) => {
      const elements: React.ReactElement[] = [];
      collectElements(entry.props["children"], elements);
      return elements.some(
        (element) => (element.props as { children?: unknown }).children === "Settings",
      );
    });
    expect(footerButton).toBeDefined();
    invoke(footerButton!.props, "onClick", mouseEvent());
    expect(h.spies.setOpenMobile).toHaveBeenCalledWith(false);
    expect(h.spies.navigate).toHaveBeenCalledWith({ to: "/settings" });
  });
});

staticDescribe("Sidebar sort menu", () => {
  it("updates settings from the sort menus and clamps the preview count", () => {
    baseScenario();
    render(<Sidebar />);

    const radioGroups = captured("MenuRadioGroup");
    expect(radioGroups.length).toBe(3);

    (radioGroups[0]!.props["onValueChange"] as (value: string) => void)("created_at");
    expect(h.spies.updateSettings).toHaveBeenCalledWith({ sidebarProjectSortOrder: "created_at" });

    (radioGroups[1]!.props["onValueChange"] as (value: string) => void)("created_at");
    expect(h.spies.updateSettings).toHaveBeenCalledWith({ sidebarThreadSortOrder: "created_at" });

    (radioGroups[2]!.props["onValueChange"] as (value: string) => void)("separate");
    expect(h.spies.updateSettings).toHaveBeenCalledWith({ sidebarProjectGroupingMode: "separate" });
    (radioGroups[2]!.props["onValueChange"] as (value: string) => void)("bogus");

    const numberField = captured("NumberField")[0]!;
    const onValueChange = numberField.props["onValueChange"] as (value: number | null) => void;
    onValueChange(null);
    onValueChange(100);
    expect(h.spies.updateSettings).toHaveBeenCalledWith({ sidebarThreadPreviewCount: 15 });
    h.spies.updateSettings.mockClear();
    onValueChange(DEFAULT_CLIENT_SETTINGS.sidebarThreadPreviewCount);
    expect(h.spies.updateSettings).not.toHaveBeenCalled();

    const numberInput = captured("NumberFieldInput")[0]!;
    const keydown = keyboardEvent("a");
    invoke(numberInput.props, "onKeyDownCapture", keydown);
    expect(keydown.stopPropagation).toHaveBeenCalled();
  });
});

staticDescribe("Sidebar manual project sorting", () => {
  function manualScenario() {
    const projectB = makeProject("project-b", { title: "Repo B", workspaceRoot: "C:/repo-b" });
    h.state.projects = [projectA, projectB];
    h.state.threads = [threadDefault, threadIdle];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    h.state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, sidebarProjectSortOrder: "manual" };
    return { projectB };
  }

  it("renders inside a DndContext and reorders on drag end", () => {
    const { projectB } = manualScenario();
    const keyA = derivePhysicalProjectKey(projectA);
    const keyB = derivePhysicalProjectKey(projectB);
    render(<Sidebar />);

    const dnd = captured("DndContext")[0]!;
    expect(dnd).toBeDefined();

    const onDragStart = dnd.props["onDragStart"] as (event: unknown) => void;
    const onDragEnd = dnd.props["onDragEnd"] as (event: unknown) => void;
    const onDragCancel = dnd.props["onDragCancel"] as (event: unknown) => void;

    onDragStart({ active: { id: keyA } });
    onDragCancel({});

    // no target
    onDragEnd({ active: { id: keyA }, over: null });
    // same target
    onDragEnd({ active: { id: keyA }, over: { id: keyA } });
    // unknown project
    onDragEnd({ active: { id: "nope" }, over: { id: keyA } });
    expect(h.spies.reorderProjects).not.toHaveBeenCalled();

    // valid reorder
    onDragEnd({ active: { id: keyA }, over: { id: keyB } });
    expect(h.spies.reorderProjects).toHaveBeenCalledTimes(1);

    // collision detection prefers pointer hits, falls back to corners
    const collisionDetection = dnd.props["collisionDetection"] as (args: unknown) => unknown;
    h.spies.pointerWithin.mockReturnValueOnce([{ id: "x" }]);
    expect(collisionDetection({})).toEqual([{ id: "x" }]);
    h.spies.pointerWithin.mockReturnValueOnce([]);
    collisionDetection({});
    expect(h.spies.closestCorners).toHaveBeenCalled();
  });

  it("suppresses project header clicks around drags and context menus", () => {
    manualScenario();
    const keyA = derivePhysicalProjectKey(projectA);
    render(<Sidebar />);

    const dnd = captured("DndContext")[0]!;
    const onDragStart = dnd.props["onDragStart"] as (event: unknown) => void;
    const onDragEnd = dnd.props["onDragEnd"] as (event: unknown) => void;

    const header = captured("SidebarMenuButton").find(
      (entry) => typeof entry.props["onPointerDownCapture"] === "function",
    )!;
    expect(header).toBeDefined();

    // Drag in progress: click swallowed.
    onDragStart({ active: { id: keyA } });
    const duringDrag = mouseEvent();
    invoke(header.props, "onClick", duringDrag);
    expect(duringDrag.preventDefault).toHaveBeenCalled();
    expect(h.spies.setProjectExpanded).not.toHaveBeenCalled();

    // Drag finished: the trailing click is swallowed once.
    onDragEnd({ active: { id: keyA }, over: null });
    const afterDrag = mouseEvent();
    invoke(header.props, "onClick", afterDrag);
    expect(afterDrag.preventDefault).toHaveBeenCalled();

    // Subsequent click toggles expansion.
    invoke(header.props, "onClick", mouseEvent());
    expect(h.spies.setProjectExpanded).toHaveBeenCalledTimes(1);

    // Keyboard toggle.
    invoke(header.props, "onKeyDown", keyboardEvent("Enter"));
    expect(h.spies.setProjectExpanded).toHaveBeenCalledTimes(2);
    invoke(header.props, "onKeyDown", keyboardEvent("x"));
    expect(h.spies.setProjectExpanded).toHaveBeenCalledTimes(2);

    // Keyboard toggle suppressed during drag.
    onDragStart({ active: { id: keyA } });
    invoke(header.props, "onKeyDown", keyboardEvent(" "));
    expect(h.spies.setProjectExpanded).toHaveBeenCalledTimes(2);
    onDragEnd({ active: { id: keyA }, over: null });
    // Consume the post-drag click suppression left behind by drag start.
    invoke(header.props, "onClick", mouseEvent());

    // Pointer-down capture: context-menu-ish press stops propagation.
    const rightClick = mouseEvent({ button: 2 });
    invoke(header.props, "onPointerDownCapture", rightClick);
    expect(rightClick.stopPropagation).toHaveBeenCalled();
    const plainDown = mouseEvent({ button: 0 });
    invoke(header.props, "onPointerDownCapture", plainDown);
    expect(plainDown.stopPropagation).not.toHaveBeenCalled();

    // With a selection active, a plain click clears it before toggling.
    h.selectionStore.setState({ selectedThreadKeys: new Set(["some-key"]) });
    invoke(header.props, "onClick", mouseEvent());
    expect(h.spies.clearSelection).toHaveBeenCalled();
  });
});

staticDescribe("project header context menu", () => {
  function projectHeaderProps() {
    baseScenario();
    render(<Sidebar />);
    return captured("SidebarMenuButton").find(
      (entry) => typeof entry.props["onContextMenu"] === "function",
    )!.props;
  }

  it("does nothing when the local API is unavailable", async () => {
    const header = projectHeaderProps();
    h.state.localApi = null;
    invoke(header, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).not.toHaveBeenCalled();
  });

  it("copies the project path", async () => {
    const header = projectHeaderProps();
    fakeLocalApi();
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      const copy = items.find((item) => item.id.startsWith("copy-path:"));
      return copy!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("C:/repo-a", { path: "C:/repo-a" });
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Path copied" }),
    );
  });

  it("opens the rename and grouping dialogs from the menu", async () => {
    const header = projectHeaderProps();
    fakeLocalApi();
    h.spies.contextMenuShow.mockImplementationOnce(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("rename:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();

    h.spies.contextMenuShow.mockImplementationOnce(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("grouping:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalledTimes(2);
  });

  it("removes an empty project after confirmation", async () => {
    h.state.projects = [projectA];
    h.state.threads = [];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    render(<Sidebar />);
    const header = captured("SidebarMenuButton").find(
      (entry) => typeof entry.props["onContextMenu"] === "function",
    )!.props;

    fakeLocalApi();
    h.spies.getDraftThreadByProjectRef.mockReturnValue({ draftId: "draft-1" });
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("delete:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();

    expect(h.spies.dialogConfirm).toHaveBeenCalled();
    expect(h.state.commandCalls.map((call: { label: string }) => call.label)).toContain(
      "project.delete",
    );
    expect(h.spies.clearDraftThread).toHaveBeenCalledWith("draft-1");
    expect(h.spies.clearProjectDraftThreadId).toHaveBeenCalled();
  });

  it("aborts project removal when the confirmation is declined", async () => {
    h.state.projects = [projectA];
    h.state.threads = [];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    render(<Sidebar />);
    const header = captured("SidebarMenuButton").find(
      (entry) => typeof entry.props["onContextMenu"] === "function",
    )!.props;

    fakeLocalApi();
    h.spies.dialogConfirm.mockResolvedValue(false);
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("delete:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();
    expect(h.state.commandCalls.map((call: { label: string }) => call.label)).not.toContain(
      "project.delete",
    );
  });

  it("toasts when project removal fails", async () => {
    h.state.projects = [projectA];
    h.state.threads = [];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    render(<Sidebar />);
    const header = captured("SidebarMenuButton").find(
      (entry) => typeof entry.props["onContextMenu"] === "function",
    )!.props;

    fakeLocalApi();
    h.state.commandResults["project.delete"] = () => failureResult("delete blew up");
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("delete:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Failed to remove "Repo A"',
        description: "delete blew up",
      }),
    );
  });

  it("warns before force-removing a project with threads and honors 'Delete anyway'", async () => {
    const header = projectHeaderProps();
    fakeLocalApi();
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      return items.find((item) => item.id.startsWith("delete:"))!.id;
    });
    invoke(header, "onContextMenu", mouseEvent());
    await flush();

    const warningToast = h.spies.toastAdd.mock.calls
      .map((call) => call[0] as { title?: string; actionProps?: { onClick?: () => void } })
      .find((toast) => toast.title === "Project is not empty");
    expect(warningToast).toBeDefined();
    warningToast!.actionProps!.onClick!();
    await flush();

    expect(h.spies.toastClose).toHaveBeenCalledWith("toast-1");
    expect(h.spies.dialogConfirm).toHaveBeenCalledWith(expect.stringContaining("Remove project"));
    expect(h.state.commandCalls.map((call: { label: string }) => call.label)).toContain(
      "project.delete",
    );
  });
});

staticDescribe("thread rows in the full sidebar", () => {
  function renderedRow(threadId: string) {
    return mustFindProps(byTestId(`thread-row-${threadId}`), `row ${threadId}`);
  }

  it("navigates on plain click and clears an existing selection", () => {
    baseScenario();
    render(<Sidebar />);
    const row = renderedRow("thread-idle");

    h.selectionStore.setState({ selectedThreadKeys: new Set(["other"]) });
    invoke(row, "onClick", mouseEvent());
    expect(h.spies.clearSelection).toHaveBeenCalled();
    expect(h.spies.setAnchor).toHaveBeenCalledWith(threadKeyOf(threadIdle));
    expect(h.spies.routerNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/$environmentId/$threadId" }),
    );
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(threadIdle));
  });

  it("toggles selection on modifier-click and range-selects on shift-click", () => {
    baseScenario();
    render(<Sidebar />);
    const row = renderedRow("thread-idle");

    invoke(row, "onClick", mouseEvent({ metaKey: true, ctrlKey: true }));
    expect(h.spies.toggleThread).toHaveBeenCalledWith(threadKeyOf(threadIdle));

    invoke(row, "onClick", mouseEvent({ shiftKey: true }));
    expect(h.spies.rangeSelectTo).toHaveBeenCalled();

    // Trailing double click does not navigate.
    h.spies.routerNavigate.mockClear();
    invoke(row, "onClick", mouseEvent({ detail: 2 }));
    expect(h.spies.routerNavigate).not.toHaveBeenCalled();
  });

  it("navigates via keyboard activation", () => {
    baseScenario();
    render(<Sidebar />);
    const row = renderedRow("thread-idle");

    invoke(row, "onKeyDown", keyboardEvent("Enter"));
    expect(h.spies.routerNavigate).toHaveBeenCalled();
    h.spies.routerNavigate.mockClear();
    invoke(row, "onKeyDown", keyboardEvent("x"));
    expect(h.spies.routerNavigate).not.toHaveBeenCalled();

    invoke(row, "onKeyDown", keyboardEvent(" "));
    expect(h.spies.routerNavigate).toHaveBeenCalled();
  });

  it("archives immediately when confirmation is disabled", async () => {
    baseScenario();
    render(<Sidebar />);
    const archive = mustFindProps(byTestId("thread-archive-thread-idle"), "archive button");
    const pointer = mouseEvent();
    invoke(archive, "onPointerDown", pointer);
    expect(pointer.stopPropagation).toHaveBeenCalled();
    invoke(archive, "onClick", mouseEvent());
    await flush();
    expect(h.spies.archiveThread).toHaveBeenCalled();
  });

  it("toasts when archiving fails", async () => {
    baseScenario();
    h.spies.archiveThread.mockResolvedValue(failureResult("archive nope"));
    render(<Sidebar />);
    const archive = mustFindProps(byTestId("thread-archive-thread-idle"), "archive button");
    invoke(archive, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to archive thread", description: "archive nope" }),
    );
  });

  it("enters archive-confirmation mode when the setting is enabled", () => {
    baseScenario();
    h.state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, confirmThreadArchive: true };
    render(<Sidebar />);
    const archive = mustFindProps(byTestId("thread-archive-thread-idle"), "archive button");
    invoke(archive, "onClick", mouseEvent());
    expect(h.spies.archiveThread).not.toHaveBeenCalled();
  });

  it("opens the PR link from the status indicator", () => {
    baseScenario();
    render(<Sidebar />);
    const prButton = mustFindProps(byAriaLabel("PR open"), "pr button");
    invoke(prButton, "onClick", mouseEvent());
    expect(h.spies.openPrLink).toHaveBeenCalledWith(expect.anything(), "https://example.com/pr/1");
  });

  it("opens a discovered port preview and toasts failures", async () => {
    baseScenario();
    h.state.discoveredPortsByThreadId = {
      "thread-idle": [{ port: 3000 }, { port: 4000 }],
    };
    const markup = render(<Sidebar />);
    expect(markup).toContain("Open localhost:3000");
    expect(markup).toContain("(+1)");

    const portButton = mustFindProps(byAriaLabel("Open localhost:3000"), "port button");
    invoke(portButton, "onClick", mouseEvent());
    await flush();
    expect(h.spies.openDiscoveredPort).toHaveBeenCalled();
    expect(h.spies.routerNavigate).toHaveBeenCalled();

    h.state.openDiscoveredPortResult = failureResult("preview broke");
    invoke(portButton, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to open preview", description: "preview broke" }),
    );
  });

  it("uses a generic message for opaque preview failures", async () => {
    baseScenario();
    h.state.discoveredPortsByThreadId = {
      [threadIdle.id]: [{ port: 5733, protocol: "http", label: "Preview" }],
    };
    h.state.openDiscoveredPortResult = {
      _tag: "Failure",
      cause: Cause.fail("opaque preview failure"),
    };
    render(<Sidebar />);
    const preview = mustFindProps(byAriaLabel("Open localhost:5733"), "preview button");
    invoke(preview, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "The preview could not be opened." }),
    );
  });
});

staticDescribe("thread context menu", () => {
  function setupMenu(clickedId: string | null) {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    if (clickedId !== null) {
      h.spies.contextMenuShow.mockResolvedValue(clickedId);
    }
    return mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
  }

  it("skips entirely without a local API", async () => {
    baseScenario();
    render(<Sidebar />);
    h.state.localApi = null;
    const row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).not.toHaveBeenCalled();
  });

  it("runs vcs pull for 'Update' and refreshes the status", async () => {
    const row = setupMenu("update");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    const labels = h.state.commandCalls.map((call: { label: string }) => call.label);
    expect(labels).toContain("vcs.pull");
    expect(labels).toContain("vcs.refreshStatus");
  });

  it("toasts when 'Update' fails", async () => {
    const row = setupMenu("update");
    h.state.commandResults["vcs.pull"] = () => failureResult("pull failed");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to update", description: "pull failed" }),
    );
  });

  it("opens the workspace in an available editor", async () => {
    const row = setupMenu("open-in:vscode");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    const openCall = h.state.commandCalls.find(
      (call: { label: string }) => call.label === "shell.openInEditor",
    );
    expect(openCall).toBeDefined();
    expect(openCall.input.input.editor).toBe("vscode");
  });

  it("toasts when opening an editor fails", async () => {
    const row = setupMenu("open-in:vscode");
    h.state.commandResults["shell.openInEditor"] = () => failureResult("no editor");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to open editor", description: "no editor" }),
    );
  });

  it("starts a rename from the menu", async () => {
    const row = setupMenu("rename");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalled();
  });

  it("marks threads unread/read and toggles pins", async () => {
    const row = setupMenu("mark-unread");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.markUnread).toHaveBeenCalledWith(threadKeyOf(threadIdle));

    h.metaStore.setState({ unreadThreadKeys: [threadKeyOf(threadIdle)] });
    h.spies.contextMenuShow.mockResolvedValue("mark-read");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(threadIdle));

    h.spies.contextMenuShow.mockResolvedValue("toggle-pin");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.togglePinned).toHaveBeenCalledWith(threadKeyOf(threadIdle));
  });

  it("copies the workspace path and thread id", async () => {
    const row = setupMenu("copy-path");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("C:/repo-a", { path: "C:/repo-a" });

    h.spies.contextMenuShow.mockResolvedValue("copy-thread-id");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("thread-idle", {
      threadId: "thread-idle",
    });
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread ID copied" }),
    );
  });

  it("toasts when copying the thread id fails", async () => {
    const row = setupMenu("copy-thread-id");
    h.state.copyShouldFail = true;
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to copy thread ID" }),
    );
  });

  it("deletes the thread after confirmation and toasts failures", async () => {
    const row = setupMenu("delete");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.dialogConfirm).toHaveBeenCalledWith(expect.stringContaining("Delete thread"));
    expect(h.spies.deleteThread).toHaveBeenCalled();

    h.spies.deleteThread.mockResolvedValue(failureResult("delete failed"));
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to delete thread", description: "delete failed" }),
    );

    h.spies.deleteThread.mockClear();
    h.spies.dialogConfirm.mockResolvedValue(false);
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.deleteThread).not.toHaveBeenCalled();
  });

  it("shows the multi-select menu when the row is part of a selection", async () => {
    baseScenario();
    // The row's isSelected flag is read at render time, so select first.
    h.selectionStore.setState({
      selectedThreadKeys: new Set([threadKeyOf(threadIdle), threadKeyOf(threadActive)]),
    });
    render(<Sidebar />);
    fakeLocalApi();
    const row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");

    // Mark unread across the selection.
    h.spies.contextMenuShow.mockResolvedValue("mark-unread");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.markThreadUnread).toHaveBeenCalledTimes(2);
    expect(h.spies.clearSelection).toHaveBeenCalled();

    // Delete across the selection.
    h.spies.contextMenuShow.mockResolvedValue("delete");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.deleteThread).toHaveBeenCalledTimes(2);
    expect(h.spies.removeFromSelection).toHaveBeenCalled();
  });

  it("toasts when the multi-select menu itself fails", async () => {
    baseScenario();
    h.selectionStore.setState({ selectedThreadKeys: new Set([threadKeyOf(threadIdle)]) });
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockRejectedValue(new Error("menu exploded"));
    const row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread action failed" }),
    );
  });

  it("uses generic messages for opaque row and multi-select menu failures", async () => {
    baseScenario();
    h.selectionStore.setState({ selectedThreadKeys: new Set([threadKeyOf(threadIdle)]) });
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockRejectedValue("opaque menu failure");
    let row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );

    h.spies.toastAdd.mockClear();
    h.selectionStore.setState({ selectedThreadKeys: new Set() });
    h.state.captures.length = 0;
    render(<Sidebar />);
    row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );
  });

  it("clears a selection that does not include the row before showing the row menu", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    h.selectionStore.setState({ selectedThreadKeys: new Set(["someone-else"]) });
    const row = mustFindProps(byTestId("thread-row-thread-idle"), "idle row");
    invoke(row, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.clearSelection).toHaveBeenCalled();
    expect(h.spies.contextMenuShow).toHaveBeenCalled();
  });
});

staticDescribe("primary row", () => {
  it("navigates to the default thread on click", () => {
    baseScenario();
    render(<Sidebar />);
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
    expect(primaryRow).toBeDefined();
    invoke(primaryRow.props, "onClick", mouseEvent());
    expect(h.spies.routerNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ threadId: "thread-default" }),
      }),
    );
  });

  it("creates a default thread on demand when the server has not backfilled one", async () => {
    h.state.projects = [projectA];
    h.state.threads = [threadIdle];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    h.state.serverConfigs = new Map([
      [
        ENV_MAIN,
        {
          providers: [
            {
              enabled: true,
              instanceId: ProviderInstanceId.make("claude"),
              models: [{ slug: "claude-fable-5" }],
            },
          ],
        },
      ],
    ]);
    render(<Sidebar />);
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
    invoke(primaryRow.props, "onClick", mouseEvent());
    await flush();

    const createCall = h.state.commandCalls.find(
      (call: { label: string }) => call.label === "thread.create",
    );
    expect(createCall).toBeDefined();
    expect(createCall.input.input.kind).toBe("default");
    expect(createCall.input.input.modelSelection.model).toBe("claude-fable-5");
    expect(h.spies.routerNavigate).toHaveBeenCalled();
  });

  it("falls back to the codex provider when no server config exists", async () => {
    h.state.projects = [projectA];
    h.state.threads = [];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    render(<Sidebar />);
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
    invoke(primaryRow.props, "onClick", mouseEvent());
    await flush();
    const createCall = h.state.commandCalls.find(
      (call: { label: string }) => call.label === "thread.create",
    );
    expect(createCall.input.input.modelSelection.instanceId).toBe("codex");
  });

  it("stops after a failed default-thread creation", async () => {
    h.state.projects = [projectA];
    h.state.threads = [];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    h.state.commandResults["thread.create"] = () => failureResult("create failed");
    render(<Sidebar />);
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;
    invoke(primaryRow.props, "onClick", mouseEvent());
    await flush();
    expect(h.spies.routerNavigate).not.toHaveBeenCalled();
  });

  it("shows the primary-row context menu and handles update / copy / pin actions", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;

    h.spies.contextMenuShow.mockResolvedValue("update");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.state.commandCalls.map((call: { label: string }) => call.label)).toContain("vcs.pull");

    h.spies.contextMenuShow.mockResolvedValue("copy-path");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.copyToClipboard).toHaveBeenCalledWith("C:/repo-a", { path: "C:/repo-a" });

    h.spies.contextMenuShow.mockResolvedValue("mark-unread");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.markUnread).toHaveBeenCalledWith(threadKeyOf(threadDefault));

    h.metaStore.setState({ unreadThreadKeys: [threadKeyOf(threadDefault)] });
    h.spies.contextMenuShow.mockResolvedValue("mark-read");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(threadDefault));

    h.spies.contextMenuShow.mockResolvedValue("toggle-pin");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.togglePinned).toHaveBeenCalledWith(threadKeyOf(threadDefault));

    h.spies.contextMenuShow.mockResolvedValue("open-in:vscode");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.state.commandCalls.map((call: { label: string }) => call.label)).toContain(
      "shell.openInEditor",
    );
  });

  it("keeps the primary-row menu inert without a local API or a matching editor", async () => {
    baseScenario();
    render(<Sidebar />);
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;

    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).not.toHaveBeenCalled();

    fakeLocalApi();
    h.spies.contextMenuShow.mockResolvedValue("open-in:unknown");
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.state.commandCalls).toEqual([]);
  });

  it("suppresses interrupted primary-row actions and reports opaque failures", async () => {
    baseScenario();
    render(<Sidebar />);
    fakeLocalApi();
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;

    h.spies.contextMenuShow.mockResolvedValue("update");
    h.state.commandResults["vcs.pull"] = () => ({
      _tag: "Failure",
      cause: Cause.interrupt(1),
    });
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).not.toHaveBeenCalled();

    h.spies.contextMenuShow.mockResolvedValue("open-in:vscode");
    h.state.commandResults["shell.openInEditor"] = () => ({
      _tag: "Failure",
      cause: Cause.fail("opaque editor failure"),
    });
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to open editor",
        description: "An error occurred.",
      }),
    );
  });

  it("does not expose project removal from the primary branch row", async () => {
    h.state.projects = [projectA];
    h.state.threads = [threadDefault];
    h.state.environments = [environmentFixture({ environmentId: ENV_MAIN, label: "Main" })];
    render(<Sidebar />);
    fakeLocalApi();
    const primaryRow = captured("SidebarMenuSubButton").find(
      (entry) =>
        entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
    )!;

    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ id: string }>) => {
      expect(items.some((item) => item.id.startsWith("remove-project"))).toBe(false);
      return null;
    });
    invoke(primaryRow.props, "onContextMenu", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalled();
    expect(h.spies.toastAdd).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project is not empty" }),
    );
  });
});

staticDescribe("new thread entry points", () => {
  it("creates a main-branch chat for a single-member project", () => {
    baseScenario();
    render(<Sidebar />);
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    expect(h.spies.newThreadHandler).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_MAIN, projectId: projectA.id }),
      { branch: null, worktreePath: null, envMode: "local" },
    );
  });

  it("closes the mobile sheet before creating a main-branch chat", () => {
    baseScenario();
    h.state.sidebarCtx = { isMobile: true, setOpenMobile: h.spies.setOpenMobile };
    render(<Sidebar />);
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    expect(h.spies.setOpenMobile).toHaveBeenCalledWith(false);
  });

  it("exposes separate main-chat and worktree actions in the projects toolbar", () => {
    baseScenario();
    render(<Sidebar />);

    const newMainChat = mustFindProps(byTestId("sidebar-new-main-chat-trigger"), "new main chat");
    invoke(newMainChat, "onClick", mouseEvent());
    expect(h.spies.newThreadHandler).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_MAIN, projectId: projectA.id }),
      { branch: null, worktreePath: null, envMode: "local" },
    );

    const newWorktree = mustFindProps(byTestId("sidebar-new-worktree-trigger"), "new worktree");
    invoke(newWorktree, "onClick", mouseEvent());
  });
});

staticDescribe("grouped and remote projects", () => {
  const repoIdentity = {
    canonicalKey: "github.com/acme/repo-a",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/repo-a.git",
    },
    rootPath: "C:/repo-a",
    displayName: "Repo A",
    name: "repo-a",
  };

  function groupedScenario() {
    const localMember = makeProject("project-a", {
      repositoryIdentity: repoIdentity,
    });
    const remoteMember = makeProject("project-a-remote", {
      workspaceRoot: "C:/remote/repo-a",
      repositoryIdentity: { ...repoIdentity, rootPath: "C:/remote/repo-a" },
      environmentId: ENV_REMOTE,
    });
    const remoteThread = makeThread("thread-remote", {
      projectId: ProjectId.make("project-a-remote"),
      environmentId: ENV_REMOTE,
      title: "Remote thread",
    });
    h.state.projects = [localMember, remoteMember];
    h.state.threads = [threadDefault, threadIdle, remoteThread];
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({
        environmentId: ENV_REMOTE,
        label: "Remote Box",
        connectionId: "remote",
      }),
    ];
    return { remoteThread };
  }

  it("groups projects by repository and renders remote thread markers", () => {
    groupedScenario();
    const markup = render(<Sidebar />);
    expect(markup).toContain("2 projects");
    expect(markup).toContain("thread-row-thread-remote");
    expect(markup).toContain("Remote Box");
  });

  it("uses a member picker when creating a main-branch chat in a grouped project", async () => {
    groupedScenario();
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockImplementation(
      async (items: Array<{ id: string }>) => items[1]!.id,
    );
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalled();
    expect(h.spies.newThreadHandler).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV_REMOTE }),
      { branch: null, worktreePath: null, envMode: "local" },
    );
  });

  it("does not create a grouped-project chat when its picker is unavailable or cancelled", async () => {
    groupedScenario();
    render(<Sidebar />);
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.newThreadHandler).not.toHaveBeenCalled();

    fakeLocalApi();
    h.spies.contextMenuShow.mockResolvedValue(null);
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    h.spies.contextMenuShow.mockResolvedValue("missing-member");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.newThreadHandler).not.toHaveBeenCalled();
  });

  it("uses workspace paths when grouped members have no environment label", async () => {
    groupedScenario();
    h.state.environments = [];
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockImplementation(async (items: Array<{ label: string }>) => {
      expect(items.every((item) => item.label.includes("C:/"))).toBe(true);
      return null;
    });
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.contextMenuShow).toHaveBeenCalled();
  });

  it("uses a generic message for opaque member-picker failures", async () => {
    groupedScenario();
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockRejectedValue("opaque picker failure");
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "An error occurred." }),
    );
  });

  it("toasts when the environment picker fails", async () => {
    groupedScenario();
    render(<Sidebar />);
    fakeLocalApi();
    h.spies.contextMenuShow.mockRejectedValue(new Error("picker broke"));
    const newThread = mustFindProps(byTestId("new-thread-button"), "new thread button");
    invoke(newThread, "onClick", mouseEvent());
    await flush();
    expect(h.spies.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not choose environment" }),
    );
  });

  it("renders a container icon for desktop-local sandbox projects", () => {
    const wslProject = makeProject("project-wsl", {
      workspaceRoot: "/home/user/repo",
      environmentId: ENV_WSL,
    });
    h.state.projects = [wslProject];
    h.state.threads = [];
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({ environmentId: ENV_WSL, label: "WSL", connectionId: "local:wsl" }),
    ];
    const markup = render(<Sidebar />);
    expect(markup).toContain("Local sandbox project");
  });
});

staticDescribe("SidebarThreadRow direct rendering", () => {
  type ThreadRowProps = React.ComponentProps<typeof SidebarThreadRow>;

  function rowProps(
    thread: EnvironmentThreadShell,
    overrides: Partial<ThreadRowProps> = {},
  ): ThreadRowProps {
    return {
      thread,
      projectCwd: "C:/repo-a",
      orderedProjectThreadKeys: [threadKeyOf(thread)],
      isActive: false,
      jumpLabel: null,
      appSettingsConfirmThreadArchive: false,
      renamingThreadKey: null,
      renamingTitle: "",
      setRenamingTitle: vi.fn(),
      startThreadRename: vi.fn(),
      renamingInputRef: { current: null },
      renamingCommittedRef: { current: false },
      confirmingArchiveThreadKey: null,
      setConfirmingArchiveThreadKey: vi.fn(),
      confirmArchiveButtonRefs: { current: new Map<string, HTMLButtonElement>() },
      handleThreadClick: vi.fn(),
      navigateToThread: vi.fn(),
      handleMultiSelectContextMenu: vi.fn(async () => {}),
      handleThreadContextMenu: vi.fn(async () => {}),
      clearSelection: vi.fn(),
      commitRename: vi.fn(async () => {}),
      cancelRename: vi.fn(),
      attemptArchiveThread: vi.fn(async () => {}),
      openPrLink: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({ environmentId: ENV_REMOTE, label: null, connectionId: "remote" }),
      environmentFixture({ environmentId: ENV_WSL, label: "WSL", connectionId: "local:wsl" }),
    ];
    h.state.primaryEnvironmentId = ENV_MAIN;
    h.state.projects = [projectA];
  });

  it("renders unread and pinned markers with a jump label", () => {
    const thread = makeThread("thread-a");
    h.metaStore.setState({
      pinnedThreadKeys: [threadKeyOf(thread)],
      unreadThreadKeys: [threadKeyOf(thread)],
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread, { jumpLabel: "⌘1" })} />);
    expect(markup).toContain("thread-unread-thread-a");
    expect(markup).toContain("thread-pinned-thread-a");
    expect(markup).toContain("⌘1");
  });

  it("labels a remote thread with the cloud icon and falls back to 'Remote'", () => {
    const thread = makeThread("thread-remote-b", { environmentId: ENV_REMOTE });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).toContain('aria-label="Remote"');
  });

  it("labels a desktop-local thread as 'Local' without the cloud icon", () => {
    const thread = makeThread("thread-wsl", { environmentId: ENV_WSL });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).not.toContain('aria-label="WSL"');
  });

  it("shows a running terminal indicator", () => {
    h.state.runningTerminalIds = ["term-1", "term-2"];
    const thread = makeThread("thread-a");
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).toContain("2 terminal running");
  });

  it("renders the agent sub-row for a starting session without a parsable timestamp", () => {
    const thread = makeThread("thread-a", {
      session: {
        threadId: ThreadId.make("thread-a"),
        status: "starting",
        providerName: null,
        activeTurnId: null,
        lastError: null,
        updatedAt: "not-a-date",
        runtimeMode: "full-access",
      },
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).toContain("Agent");
    expect(markup).toContain("Connecting");
  });

  it("hides the archive button while a turn is actively running", () => {
    const thread = makeThread("thread-a", {
      session: {
        threadId: ThreadId.make("thread-a"),
        status: "running",
        providerName: "Claude Code",
        activeTurnId: "turn-1",
        lastError: null,
        updatedAt: iso(1),
        runtimeMode: "full-access",
      } as EnvironmentThreadShell["session"],
    });
    const markup = render(<SidebarThreadRow {...rowProps(thread)} />);
    expect(markup).not.toContain("thread-archive-thread-a");
    expect(markup).toContain("thread-agent-row-thread-a");
  });

  it("renders the confirm-archive button and archives on confirm", async () => {
    const thread = makeThread("thread-a");
    const attemptArchiveThread = vi.fn(async () => {});
    const setConfirming = vi.fn();
    const props = rowProps(thread, {
      confirmingArchiveThreadKey: threadKeyOf(thread),
      setConfirmingArchiveThreadKey: setConfirming,
      attemptArchiveThread,
    });
    const markup = render(<SidebarThreadRow {...props} />);
    expect(markup).toContain("thread-archive-confirm-thread-a");

    const confirm = mustFindProps(byTestId("thread-archive-confirm-thread-a"), "confirm");
    const refCallback = confirm["ref"] as (element: unknown) => void;
    refCallback({ focus: vi.fn() });
    refCallback(null);
    invoke(confirm, "onClick", mouseEvent());
    await flush();
    expect(attemptArchiveThread).toHaveBeenCalled();
    expect(setConfirming).toHaveBeenCalled();

    // Row-level mouse leave clears the pending confirmation.
    const rowItem = captured("SidebarMenuSubItem")[0]!;
    invoke(rowItem.props, "onMouseLeave", mouseEvent());
    const blurEvent = {
      currentTarget: { contains: () => false },
    } as unknown as React.FocusEvent<HTMLLIElement>;
    invoke(rowItem.props, "onBlurCapture", blurEvent);
    const blurInside = {
      currentTarget: { contains: () => true },
    } as unknown as React.FocusEvent<HTMLLIElement>;
    invoke(rowItem.props, "onBlurCapture", blurInside);
  });

  it("starts the archive confirmation flow when confirmation is required", () => {
    const thread = makeThread("thread-a");
    const setConfirming = vi.fn();
    const props = rowProps(thread, {
      appSettingsConfirmThreadArchive: true,
      setConfirmingArchiveThreadKey: setConfirming,
    });
    render(<SidebarThreadRow {...props} />);
    const archive = mustFindProps(byTestId("thread-archive-thread-a"), "archive");
    invoke(archive, "onClick", mouseEvent());
    expect(setConfirming).toHaveBeenCalledWith(threadKeyOf(thread));
  });

  it("renders the inline rename input and wires its handlers", () => {
    const thread = makeThread("thread-a", { title: "Original title" });
    const setRenamingTitle = vi.fn();
    const commitRename = vi.fn(async () => {});
    const cancelRename = vi.fn();
    const renamingCommittedRef = { current: false };
    const props = rowProps(thread, {
      renamingThreadKey: threadKeyOf(thread),
      renamingTitle: "Edited title",
      setRenamingTitle,
      commitRename,
      cancelRename,
      renamingCommittedRef,
    });
    render(<SidebarThreadRow {...props} />);

    const input = mustFindProps(
      (candidate) =>
        typeof candidate["onBlur"] === "function" && candidate["value"] === "Edited title",
      "rename input",
    );

    const focus = vi.fn();
    const select = vi.fn();
    (input["ref"] as (element: unknown) => void)({ focus, select });
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalled();

    invoke(input, "onChange", { target: { value: "New" } });
    expect(setRenamingTitle).toHaveBeenCalledWith("New");

    invoke(input, "onKeyDown", keyboardEvent("Enter"));
    expect(commitRename).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: thread.id }),
      "Edited title",
      "Original title",
    );

    renamingCommittedRef.current = false;
    invoke(input, "onKeyDown", keyboardEvent("Escape"));
    expect(cancelRename).toHaveBeenCalled();

    renamingCommittedRef.current = false;
    commitRename.mockClear();
    invoke(input, "onBlur", {});
    expect(commitRename).toHaveBeenCalled();

    renamingCommittedRef.current = true;
    commitRename.mockClear();
    invoke(input, "onBlur", {});
    expect(commitRename).not.toHaveBeenCalled();

    const click = mouseEvent();
    invoke(input, "onClick", click);
    expect(click.stopPropagation).toHaveBeenCalled();
  });

  it("ignores a double-click while already renaming and on mobile", () => {
    const thread = makeThread("thread-a");
    const startThreadRename = vi.fn();
    const props = rowProps(thread, {
      renamingThreadKey: threadKeyOf(thread),
      renamingTitle: thread.title,
      startThreadRename,
    });
    render(<SidebarThreadRow {...props} />);
    const row = mustFindProps(byTestId("thread-row-thread-a"), "row");
    invoke(row, "onDoubleClick", mouseEvent());
    expect(startThreadRename).not.toHaveBeenCalled();

    h.state.isMobile = true;
    render(<SidebarThreadRow {...rowProps(thread, { startThreadRename })} />);
    const mobileRow = mustFindProps(byTestId("thread-row-thread-a"), "row");
    invoke(mobileRow, "onDoubleClick", mouseEvent());
    expect(startThreadRename).not.toHaveBeenCalled();
  });
});

staticDescribe("project rename and grouping dialogs", () => {
  it("wires the rename dialog inputs and guards empty submits", async () => {
    baseScenario();
    render(<Sidebar />);

    const dialogs = captured("Dialog");
    expect(dialogs.length).toBeGreaterThanOrEqual(2);
    for (const dialog of dialogs) {
      const onOpenChange = dialog.props["onOpenChange"] as (open: boolean) => void;
      onOpenChange(false);
      onOpenChange(true);
    }

    const titleInput = mustFindProps(byAriaLabel("Project title"), "project title input");
    invoke(titleInput, "onChange", { target: { value: "Renamed" } });
    const enter = keyboardEvent("Enter");
    invoke(titleInput, "onKeyDown", enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    await flush();

    // Rename target is null in a fresh render → submit early-returns.
    const saveButtons = captured("Button").filter((entry) => entry.props["children"] === "Save");
    for (const save of saveButtons) {
      invoke(save.props, "onClick", mouseEvent());
    }
    const cancelButtons = captured("Button").filter(
      (entry) => entry.props["children"] === "Cancel",
    );
    for (const cancel of cancelButtons) {
      invoke(cancel.props, "onClick", mouseEvent());
    }
    await flush();
  });

  it("validates the grouping selection values", () => {
    baseScenario();
    render(<Sidebar />);
    const select = captured("Select")[0]!;
    const onValueChange = select.props["onValueChange"] as (value: string) => void;
    onValueChange("repository");
    onValueChange("repository_path");
    onValueChange("separate");
    onValueChange("inherit");
    onValueChange("bogus");
  });

  it("describes each grouping mode", () => {
    baseScenario();
    h.state.clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarProjectGroupingMode: "repository_path",
    };
    let markup = render(<Sidebar />);
    expect(markup).toContain("repo-relative path");

    h.state.clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarProjectGroupingMode: "separate",
    };
    markup = render(<Sidebar />);
    expect(markup).toContain("own sidebar row");
  });
});

if (browserRuntime) {
  describe("SidebarThreadRow browser interactions", () => {
    type ThreadRowProps = React.ComponentProps<typeof SidebarThreadRow>;

    beforeEach(() => {
      h.state.environments = [
        environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      ];
      h.state.primaryEnvironmentId = ENV_MAIN;
      h.state.projects = [projectA];
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
      const element = container.querySelector<T>(selector);
      if (!element) throw new Error(`Missing DOM element: ${selector}`);
      return element;
    }

    function rowProps(
      thread: EnvironmentThreadShell,
      overrides: Partial<ThreadRowProps> = {},
    ): ThreadRowProps {
      return {
        thread,
        projectCwd: "C:/repo-a",
        orderedProjectThreadKeys: [threadKeyOf(thread)],
        isActive: false,
        jumpLabel: null,
        appSettingsConfirmThreadArchive: false,
        renamingThreadKey: null,
        renamingTitle: "",
        setRenamingTitle: vi.fn(),
        startThreadRename: vi.fn(),
        renamingInputRef: { current: null },
        renamingCommittedRef: { current: false },
        confirmingArchiveThreadKey: null,
        setConfirmingArchiveThreadKey: vi.fn(),
        confirmArchiveButtonRefs: { current: new Map<string, HTMLButtonElement>() },
        handleThreadClick: vi.fn(),
        navigateToThread: vi.fn(),
        handleMultiSelectContextMenu: vi.fn(async () => {}),
        handleThreadContextMenu: vi.fn(async () => {}),
        clearSelection: vi.fn(),
        commitRename: vi.fn(async () => {}),
        cancelRename: vi.fn(),
        attemptArchiveThread: vi.fn(async () => {}),
        openPrLink: vi.fn(),
        ...overrides,
      };
    }

    async function mount(element: React.ReactElement): Promise<{
      container: HTMLDivElement;
      root: Root;
    }> {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await React.act(async () => {
        root.render(element);
      });
      return { container, root };
    }

    async function dispatch(element: Element, event: Event): Promise<void> {
      await React.act(async () => {
        element.dispatchEvent(event);
      });
    }

    async function nextFrame(): Promise<void> {
      await React.act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
    }

    async function unmount(root: Root, container: HTMLElement): Promise<void> {
      await React.act(async () => root.unmount());
      container.remove();
    }

    it("starts inline rename only for an unmodified row-body double-click", async () => {
      const thread = makeThread("thread-browser-rename", { title: "Rename me" });
      const startThreadRename = vi.fn();

      function Harness() {
        const [renamingThreadKey, setRenamingThreadKey] = React.useState<string | null>(null);
        const [renamingTitle, setRenamingTitle] = React.useState("");
        const renamingInputRef = React.useRef<HTMLInputElement | null>(null);
        const renamingCommittedRef = React.useRef(false);
        const beginRename = React.useCallback((threadKey: string, title: string) => {
          startThreadRename(threadKey, title);
          setRenamingThreadKey(threadKey);
          setRenamingTitle(title);
        }, []);
        return (
          <SidebarThreadRow
            {...rowProps(thread, {
              renamingThreadKey,
              renamingTitle,
              setRenamingTitle,
              startThreadRename: beginRename,
              renamingInputRef,
              renamingCommittedRef,
            })}
          />
        );
      }

      const { container, root } = await mount(<Harness />);
      const row = requiredElement<HTMLElement>(
        container,
        "[data-testid='thread-row-thread-browser-rename']",
      );
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
        await dispatch(
          row,
          new MouseEvent("dblclick", { bubbles: true, cancelable: true, [modifier]: true }),
        );
        expect(startThreadRename, `${modifier} must not start rename`).not.toHaveBeenCalled();
        expect(container.querySelector("input")).toBeNull();
      }

      const archive = requiredElement<HTMLButtonElement>(
        container,
        "[data-testid='thread-archive-thread-browser-rename']",
      );
      await dispatch(archive, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      expect(startThreadRename, "nested controls must not start rename").not.toHaveBeenCalled();
      expect(container.querySelector("input")).toBeNull();

      await dispatch(row, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      expect(startThreadRename).toHaveBeenCalledOnce();
      expect(startThreadRename).toHaveBeenCalledWith(threadKeyOf(thread), "Rename me");
      const input = requiredElement<HTMLInputElement>(container, "input");
      expect(input.value).toBe("Rename me");
      expect(document.activeElement).toBe(input);
      await unmount(root, container);
    });

    it("retains archive confirmation for focus inside the row and clears it after focus leaves", async () => {
      const thread = makeThread("thread-browser-archive", { title: "Archive me" });

      function Harness() {
        const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = React.useState<
          string | null
        >(null);
        const confirmArchiveButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
        return (
          <SidebarThreadRow
            {...rowProps(thread, {
              appSettingsConfirmThreadArchive: true,
              confirmingArchiveThreadKey,
              setConfirmingArchiveThreadKey,
              confirmArchiveButtonRefs,
            })}
          />
        );
      }

      const outside = document.createElement("button");
      outside.textContent = "Outside";
      document.body.append(outside);
      const { container, root } = await mount(<Harness />);
      const archive = requiredElement<HTMLButtonElement>(
        container,
        "[data-testid='thread-archive-thread-browser-archive']",
      );
      await dispatch(archive, new MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextFrame();

      const confirmSelector = "[data-testid='thread-archive-confirm-thread-browser-archive']";
      const confirm = requiredElement<HTMLButtonElement>(container, confirmSelector);
      expect(confirm.textContent).toBe("Confirm");
      expect(document.activeElement).toBe(confirm);

      const row = requiredElement<HTMLElement>(
        container,
        "[data-testid='thread-row-thread-browser-archive']",
      );
      await React.act(async () => row.focus());
      await nextFrame();
      expect(requiredElement<HTMLButtonElement>(container, confirmSelector).textContent).toBe(
        "Confirm",
      );

      await React.act(async () => outside.focus());
      await nextFrame();
      expect(container.querySelector(confirmSelector)).toBeNull();

      await unmount(root, container);
      outside.remove();
    });
  });
}
