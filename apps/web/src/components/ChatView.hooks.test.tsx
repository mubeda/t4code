/**
 * Deep behavior tests for ChatView.
 *
 * The sibling ChatView.test.tsx covers plain SSR rendering. This file goes
 * further using the repo's instrumented-hooks pattern (see
 * FilePreviewPanel.test.tsx): a partial `vi.mock("react")` replaces
 * useState/useEffect/useLayoutEffect so state can be seeded per scenario,
 * setter calls execute their functional updaters, and effects are captured
 * and run manually against stubbed window/document globals. Handlers captured
 * from mocked children (see Sidebar.test.tsx) are then invoked directly to
 * exercise the send/terminal/panel/approval command flows.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement, ReactNode, RefObject } from "react";
import {
  ApprovalRequestId,
  type ChatAttachmentId,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  OrchestrationProposedPlanId,
  ProjectId,
  type ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t4code/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t4code/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t4code/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t4code/client-runtime/environment";

const h = vi.hoisted(() => {
  const state = {
    captured: {} as Record<string, Record<string, unknown>>,
    capturedList: [] as Array<{ name: string; props: Record<string, unknown> }>,
    // React's fizz renderer replays a component with empty props while
    // retrying a suspended lazy child — record only real props objects.
    capture(name: string, props: Record<string, unknown>): void {
      if (!props || Object.keys(props).length === 0) return;
      state.captured[name] = props;
      state.capturedList.push({ name, props });
    },
    atomValuesByKey: new Map<string, unknown>(),
    commandCalls: [] as Array<{ key: string; input: unknown }>,
    commandResults: {} as Record<string, (input: unknown) => unknown>,
    defaultCommandResult: (() => undefined) as (input?: unknown) => unknown,
    terminalInputEnqueues: [] as Array<{
      data: string;
      write: (data: string) => Promise<{ _tag: string; cause?: unknown }>;
      onWriteError?: (error: unknown) => void;
    }>,
    environments: [] as unknown[],
    primaryEnvironment: null as unknown,
    threadsByKey: new Map<string, unknown>(),
    projectsByKey: new Map<string, unknown>(),
    allProjects: [] as unknown[],
    threadRefs: [] as unknown[],
    knownSessions: [] as unknown[],
    runningTerminalIds: [] as string[],
    queryDataByKey: new Map<string, unknown>(),
    assetUrls: [] as string[],
    previewSupported: false,
    previewState: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    navigateCalls: [] as unknown[],
    // ── new harness state ────────────────────────────────────────────
    toasts: [] as unknown[],
    shortcutCommandByKey: new Map<string, string>(),
    shortcutLabel: "Mod+K" as string | null,
    terminalFocusOwner: null as "drawer" | "right-panel" | null,
    commandPaletteOpen: false,
    localApi: null as unknown,
    mediaQueryMatches: false,
    turnDiffSummaries: [] as unknown[],
    inferredCheckpointTurnCountByTurnId: {} as Record<string, number>,
    previewActionSubscribers: [] as Array<(action: string) => void>,
    addBrowserSurfaceCalls: [] as unknown[],
    closePreviewSessionCalls: [] as unknown[],
    setActivePreviewTabCalls: [] as unknown[],
    // react hook instrumentation
    stateCalls: [] as Array<{ index: number; initial: unknown }>,
    stateSeeds: new Map<number, { value: unknown; expectInitial: (value: unknown) => boolean }>(),
    setStateCalls: [] as Array<{ index: number; next: unknown; applied: unknown }>,
    effects: [] as Array<() => void | (() => void)>,
  };
  return state;
});

// ── React instrumentation ────────────────────────────────────────────

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();

  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;

  const useState = (initial?: unknown) => {
    const resolved = resolveInitial(initial);
    const index = h.stateCalls.length;
    h.stateCalls.push({ index, initial: resolved });
    const seed = h.stateSeeds.get(index);
    if (seed && !seed.expectInitial(resolved)) {
      throw new Error(
        `useState seed mismatch at index ${index}: initial value ${String(resolved)} did not match the expected shape`,
      );
    }
    const value = seed ? seed.value : resolved;
    const setValue = (next: unknown) => {
      const applied =
        typeof next === "function" ? (next as (value: unknown) => unknown)(value) : next;
      h.setStateCalls.push({ index, next, applied });
    };
    return [value, setValue];
  };

  const useEffect = (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  };

  return {
    ...actual,
    useState: useState as typeof actual.useState,
    useEffect: useEffect as typeof actual.useEffect,
    useLayoutEffect: useEffect as typeof actual.useLayoutEffect,
  };
});

// ── Heavy state/atom modules (same shape as ChatView.test.tsx) ───────

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { key?: string } | null | undefined, _options?: unknown) => {
    const key = command && typeof command.key === "string" ? command.key : "unknown-command";
    return (input: unknown) => {
      h.commandCalls.push({ key, input });
      const respond = h.commandResults[key] ?? h.defaultCommandResult;
      return Promise.resolve(respond(input));
    };
  },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    create: { key: "thread.create" },
    delete: { key: "thread.delete" },
    updateMetadata: { key: "thread.updateMetadata" },
    setRuntimeMode: { key: "thread.setRuntimeMode" },
    setInteractionMode: { key: "thread.setInteractionMode" },
    startTurn: { key: "thread.startTurn" },
    interruptTurn: { key: "thread.interruptTurn" },
    respondToApproval: { key: "thread.respondToApproval" },
    respondToUserInput: { key: "thread.respondToUserInput" },
    revertCheckpoint: { key: "thread.revertCheckpoint" },
  },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    open: { key: "terminal.open" },
    write: { key: "terminal.write" },
    close: { key: "terminal.close" },
  },
}));

vi.mock("../state/projects", () => ({
  projectEnvironment: {
    update: { key: "project.update" },
  },
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: {
    open: { key: "preview.open" },
    close: { key: "preview.close" },
  },
}));

vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    status: (_args: unknown) => ({ key: "vcs.status" }),
  },
}));

vi.mock("../state/shell", () => ({
  environmentShell: {
    stateAtom: (environmentId: string) => ({ key: `shell:${environmentId}` }),
  },
}));

vi.mock("../state/server", () => ({
  serverEnvironment: {
    upsertKeybinding: { key: "server.upsertKeybinding" },
  },
  primaryServerKeybindingsAtom: { key: "atom:keybindings" },
  primaryServerAvailableEditorsAtom: { key: "atom:editors" },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    retryNow: { key: "environment.retryNow" },
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { key?: string } | null) => ({
    data: atom && typeof atom.key === "string" ? (h.queryDataByKey.get(atom.key) ?? null) : null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));

vi.mock("../state/entities", () => ({
  useProject: (ref: { environmentId: string; projectId: string } | null) =>
    ref ? (h.projectsByKey.get(`${ref.environmentId}:${ref.projectId}`) ?? null) : null,
  useProjects: () => h.allProjects,
  useThread: (ref: { environmentId: string; threadId: string } | null) =>
    ref ? (h.threadsByKey.get(`${ref.environmentId}:${ref.threadId}`) ?? null) : null,
  useThreadRefs: () => h.threadRefs,
  useThreadProposedPlans: () => [],
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: h.environments,
  }),
  usePrimaryEnvironment: () => h.primaryEnvironment,
}));

vi.mock("../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => h.knownSessions,
  useThreadRunningTerminalIds: () => h.runningTerminalIds,
}));

vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: string, selector?: (settings: unknown) => unknown) =>
    selector ? selector(h.settings) : h.settings,
}));

vi.mock("../assets/assetUrls", () => ({
  useAssetUrls: () => h.assetUrls,
}));

vi.mock("../previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => h.previewSupported,
  setActivePreviewTab: (threadRef: unknown, tabId: unknown) => {
    h.setActivePreviewTabCalls.push({ threadRef, tabId });
  },
  useThreadPreviewState: () => h.previewState,
}));

vi.mock("./preview/addBrowserSurface", () => ({
  addBrowserSurface: (input: unknown) => {
    h.addBrowserSurfaceCalls.push(input);
    return Promise.resolve();
  },
}));

vi.mock("./preview/closePreviewSession", () => ({
  closePreviewSession: (input: unknown) => {
    h.closePreviewSessionCalls.push(input);
    return Promise.resolve();
  },
}));

vi.mock("./preview/previewActionBus", () => ({
  subscribePreviewAction: (callback: (action: string) => void) => {
    h.previewActionSubscribers.push(callback);
    return () => undefined;
  },
}));

vi.mock("./preview/previewEmptyStateLogic", () => ({
  getConfiguredPreviewUrls: () => [],
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      const key = (atom as { key?: string } | null | undefined)?.key;
      return typeof key === "string" ? h.atomValuesByKey.get(key) : undefined;
    },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => (options: unknown) => {
      h.navigateCalls.push(options);
      return Promise.resolve();
    },
  };
});

// ── Behavior seams introduced for this file ──────────────────────────

vi.mock("../keybindings", () => ({
  resolveShortcutCommand: (event: { key?: string }) =>
    typeof event.key === "string" ? (h.shortcutCommandByKey.get(event.key) ?? null) : null,
  shortcutLabelForCommand: () => h.shortcutLabel,
}));

vi.mock("../commandPaletteContext", () => ({
  isCommandPaletteOpen: () => h.commandPaletteOpen,
  OpenAddProjectCommandPaletteProvider: ({ children }: { children?: ReactNode }) => children,
  useOpenAddProjectCommandPalette: () => () => undefined,
}));

vi.mock("../lib/terminalFocus", () => ({
  getTerminalFocusOwner: () => h.terminalFocusOwner,
  isTerminalFocused: () => h.terminalFocusOwner !== null,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => h.localApi,
  createLocalApi: () => h.localApi,
  ensureLocalApi: () => h.localApi,
  __resetLocalApiForTests: () => Promise.resolve(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (toast: unknown) => {
      h.toasts.push(toast);
      return "toast-id";
    },
    close: () => undefined,
  },
  anchoredToastManager: {
    add: (toast: unknown) => {
      h.toasts.push(toast);
      return "toast-id";
    },
    close: () => undefined,
  },
  stackedThreadToast: (toast: unknown) => toast,
  ToastProvider: ({ children }: { children?: ReactNode }) => children,
  AnchoredToastProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "system" as const,
    resolvedTheme: "dark" as const,
    setTheme: () => undefined,
  }),
}));

vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: () => h.mediaQueryMatches,
}));

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: h.turnDiffSummaries,
    inferredCheckpointTurnCountByTurnId: h.inferredCheckpointTurnCountByTurnId,
  }),
}));

// ── Child components ─────────────────────────────────────────────────

vi.mock("./NoActiveThreadState", () => ({
  NoActiveThreadState: () => <div data-mock="no-active-thread" />,
}));

vi.mock("./DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => (
    <div data-mock="diff-worker-pool">{children}</div>
  ),
}));

vi.mock("./chat/ChatComposer", () => ({
  ChatComposer: (props: Record<string, unknown>) => {
    h.capture("chatComposer", props);
    return <div data-mock="chat-composer" />;
  },
}));

vi.mock("./chat/MessagesTimeline", () => ({
  MessagesTimeline: (props: Record<string, unknown>) => {
    h.capture("messagesTimeline", props);
    return <div data-mock="messages-timeline" />;
  },
}));

vi.mock("./chat/ChatHeader", () => ({
  ChatHeader: (props: Record<string, unknown>) => {
    h.capture("chatHeader", props);
    return <div data-mock="chat-header">{String(props["activeThreadTitle"] ?? "")}</div>;
  },
}));

vi.mock("./chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: (props: Record<string, unknown>) => {
    h.capture("expandedImageDialog", props);
    return <div data-mock="expanded-image-dialog" />;
  },
}));

vi.mock("./chat/PanelLayoutControls", () => ({
  PanelLayoutControls: (props: Record<string, unknown>) => {
    h.capture("panelLayoutControls", props);
    return <div data-mock="panel-layout-controls" />;
  },
  RightPanelMaximizeControl: (props: Record<string, unknown>) => {
    h.capture("rightPanelMaximizeControl", props);
    return <div data-mock="right-panel-maximize" />;
  },
}));

vi.mock("./chat/ProviderStatusBanner", () => ({
  ProviderStatusBanner: (props: Record<string, unknown>) => {
    h.capture("providerStatusBanner", props);
    return <div data-mock="provider-status-banner" />;
  },
}));

vi.mock("./chat/ThreadErrorBanner", () => ({
  ThreadErrorBanner: (props: Record<string, unknown>) => {
    h.capture("threadErrorBanner", props);
    return <div data-mock="thread-error-banner" />;
  },
}));

vi.mock("./chat/ComposerBannerStack", () => ({
  ComposerBannerStack: (props: Record<string, unknown>) => {
    h.capture("composerBannerStack", props);
    return <div data-mock="composer-banner-stack" />;
  },
}));

vi.mock("./PullRequestThreadDialog", () => ({
  PullRequestThreadDialog: (props: Record<string, unknown>) => {
    h.capture("pullRequestThreadDialog", props);
    return <div data-mock="pull-request-thread-dialog" />;
  },
}));

vi.mock("./PlanSidebar", () => ({
  default: (props: Record<string, unknown>) => {
    h.capture("planSidebar", props);
    return <div data-mock="plan-sidebar" />;
  },
}));

vi.mock("./ThreadTerminalDrawer", () => ({
  default: (props: Record<string, unknown>) => {
    h.capture("threadTerminalDrawer", props);
    return <div data-mock="thread-terminal-drawer" data-mode={String(props["mode"] ?? "drawer")} />;
  },
  enqueueTerminalInput: (input: {
    data: string;
    write: (data: string) => Promise<{ _tag: string; cause?: unknown }>;
    onWriteError?: (error: unknown) => void;
  }) => {
    h.terminalInputEnqueues.push(input);
    void input.write(input.data).then((result) => {
      if (result._tag === "Failure") {
        input.onWriteError?.(result.cause);
      }
    });
  },
  releaseTerminalInputScheduler: vi.fn(),
}));

vi.mock("./CenterPanelTabs", () => ({
  CenterPanelTabs: (props: Record<string, unknown>) => {
    h.capture("centerPanelTabs", props);
    return <div data-mock="center-panel-tabs" />;
  },
}));

vi.mock("./CenterTerminalPanel", () => ({
  CenterTerminalPanel: (props: Record<string, unknown>) => {
    h.capture("centerTerminalPanel", props);
    return <div data-mock="center-terminal-panel" />;
  },
}));

vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: (props: Record<string, unknown> & { children?: ReactNode }) => {
    h.capture("rightPanelTabs", props);
    return <div data-mock="right-panel-tabs">{props.children}</div>;
  },
}));

vi.mock("./RightPanelSheet", () => ({
  RightPanelSheet: (props: Record<string, unknown> & { children?: ReactNode }) => {
    h.capture("rightPanelSheet", props);
    return <div data-mock="right-panel-sheet">{props.children}</div>;
  },
}));

vi.mock("./BranchToolbar", () => ({
  BranchToolbar: (props: Record<string, unknown>) => {
    h.capture("branchToolbar", props);
    return <div data-mock="branch-toolbar" />;
  },
}));

vi.mock("./preview/PreviewPanel", () => ({
  PreviewPanel: () => <div data-mock="preview-panel" />,
}));
vi.mock("./DiffPanel", () => ({
  default: () => <div data-mock="diff-panel" />,
}));
vi.mock("./SourceControlPanel", () => ({
  default: () => <div data-mock="source-control-panel" />,
}));
vi.mock("./files/FilePreviewPanel", () => ({
  default: (props: Record<string, unknown>) => {
    h.capture("filePreviewPanel", props);
    return <div data-mock="file-preview-panel" />;
  },
}));

import ChatView, {
  eventPathContainsSelector,
  serverTerminalIdsStrictSubsetOfClient,
  shouldTypeToFocusComposer,
  terminalIdListsEqual,
} from "./ChatView";
import type { ChatMessage, Project, Thread } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { HOST_SURFACE_ID, useCenterPanelStore } from "../centerPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { FileEditingSessionRegistry } from "./files/fileEditingSessionRegistry";
import { newDraftId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import type { ProviderInstanceEntry } from "../providerInstances";
import type { TerminalContextDraft, TerminalContextSelection } from "../lib/terminalContext";
import { getComposerProviderState } from "./chat/composerProviderState";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const later = "2026-03-29T01:00:00.000Z";
const threadRef = scopeThreadRef(environmentId, threadId);
const threadKey = scopedThreadKey(threadRef);
const codexInstanceId = ProviderInstanceId.make("codex");

const codexProvider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  agents: [],
};

// ── Host useState call indexes (ChatViewContent renders first, so its
// unconditional useState calls occupy the first slots in call order; the
// seeding helper verifies the initial value shape and fails loudly if the
// component's hook order changes). ─────────────────────────────────────
const isNull = (value: unknown) => value === null;
const isFalse = (value: unknown) => value === false;
const isEmptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;
const HOST_STATE = {
  showScrollToBottom: { index: 0, expectInitial: isFalse },
  expandedImage: { index: 1, expectInitial: isNull },
  optimisticUserMessages: { index: 2, expectInitial: isEmptyArray },
  maximizedRightPanelThreadKey: { index: 7, expectInitial: isNull },
  pullRequestDialogState: { index: 13, expectInitial: isNull },
  terminalUiLaunchContext: { index: 14, expectInitial: isNull },
  pendingUserInputAnswersByRequestId: {
    index: 10,
    expectInitial: (value: unknown) =>
      typeof value === "object" && value !== null && Object.keys(value).length === 0,
  },
  attachmentPreviewHandoffByMessageId: {
    index: 15,
    expectInitial: (value: unknown) =>
      typeof value === "object" && value !== null && Object.keys(value).length === 0,
  },
  composerOverlayElement: { index: 19, expectInitial: isNull },
  mountedTerminalThreadKeys: { index: 21, expectInitial: isEmptyArray },
} as const;

function seedHostState(name: keyof typeof HOST_STATE, value: unknown): void {
  const { index, expectInitial } = HOST_STATE[name];
  h.stateSeeds.set(index, { value, expectInitial });
}

function setStateCallsFor(
  name: keyof typeof HOST_STATE,
): Array<{ next: unknown; applied: unknown }> {
  const { index } = HOST_STATE[name];
  return h.setStateCalls.filter((call) => call.index === index);
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: projectId,
    environmentId,
    title: "Demo Project",
    workspaceRoot: "X:/demo",
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    scripts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Demo Thread",
    modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<NonNullable<Thread["session"]>> = {}) {
  return {
    threadId,
    status: "ready",
    providerName: "codex",
    providerInstanceId: codexInstanceId,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
    ...overrides,
  } as NonNullable<Thread["session"]>;
}

interface TestConnectionPresentation {
  readonly phase: "available" | "offline" | "connecting" | "reconnecting" | "connected" | "error";
  readonly error: string | null;
  readonly traceId: string | null;
}

interface TestEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  readonly connection: TestConnectionPresentation;
  readonly serverConfig: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly environment: { readonly label: string; readonly serverVersion?: string };
  } | null;
}

function makeEnvironmentPresentation(
  overrides: Partial<TestEnvironmentPresentation> = {},
): TestEnvironmentPresentation {
  return {
    environmentId,
    label: "Local",
    displayUrl: null,
    relayManaged: false,
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: {
      providers: [codexProvider],
      environment: { label: "Local" },
    },
    ...overrides,
  };
}

function seedEnvironment(presentation: TestEnvironmentPresentation): void {
  h.environments = [presentation];
  h.primaryEnvironment = presentation;
}

function seedProject(project: Project): void {
  h.projectsByKey.set(`${project.environmentId}:${project.id}`, project);
  h.allProjects = [project];
}

function seedServerThread(thread: Thread): void {
  h.threadsByKey.set(`${thread.environmentId}:${thread.id}`, thread);
  h.threadRefs = [scopeThreadRef(thread.environmentId, thread.id)];
}

function seedGitStatus(isRepo: boolean): void {
  h.queryDataByKey.set("vcs.status", { isRepo });
}

function seedConnectedServerThread(thread: Thread = makeThread()): void {
  seedEnvironment(makeEnvironmentPresentation());
  seedProject(makeProject());
  seedServerThread(thread);
  seedGitStatus(true);
}

function resetRenderCaptures(): void {
  h.captured = {};
  h.capturedList.length = 0;
  h.stateCalls.length = 0;
  h.effects.length = 0;
  h.previewActionSubscribers.length = 0;
}

function renderServerRoute(): string {
  resetRenderCaptures();
  return renderToStaticMarkup(
    <ChatView
      environmentId={environmentId}
      threadId={threadId}
      routeKind="server"
      reserveTitleBarControlInset
    />,
  );
}

function renderDraftRoute(draftId: ReturnType<typeof newDraftId>): string {
  resetRenderCaptures();
  return renderToStaticMarkup(
    <ChatView
      environmentId={environmentId}
      threadId={threadId}
      routeKind="draft"
      draftId={draftId}
    />,
  );
}

function renderPanelRoute(): string {
  resetRenderCaptures();
  return renderToStaticMarkup(
    <ChatView variant="panel" panelThreadRef={scopeThreadRef(environmentId, threadId)} />,
  );
}

function capturedProps<T = Record<string, unknown>>(name: string): T {
  const entry = [...h.capturedList].toReversed().find((candidate) => candidate.name === name);
  expect(entry, `expected captured props for ${name}`).toBeDefined();
  return entry!.props as T;
}

function runEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const effects = [...h.effects];
  h.effects.length = 0;
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

function commandCallsFor(key: string): Array<{ key: string; input: unknown }> {
  return h.commandCalls.filter((call) => call.key === key);
}

function closedTerminalIds(): string[] {
  return commandCallsFor("terminal.close").map((call) => {
    const command = call.input as {
      environmentId: EnvironmentId;
      input: {
        threadId: ThreadId;
        terminalId: string;
        deleteHistory: boolean;
      };
    };
    expect(command.environmentId).toBe(environmentId);
    expect(command.input.threadId).toBe(threadId);
    expect(command.input.deleteHistory).toBe(true);
    return command.input.terminalId;
  });
}

function composerHandle(overrides: Partial<ChatComposerHandle> = {}): ChatComposerHandle {
  return {
    focusAtEnd: () => undefined,
    focusAt: () => undefined,
    insertTextAtEnd: () => false,
    openModelPicker: () => undefined,
    toggleModelPicker: () => undefined,
    isModelPickerOpen: () => false,
    readSnapshot: () => ({ value: "", cursor: 0, expandedCursor: 0, terminalContextIds: [] }),
    resetCursorState: () => undefined,
    addTerminalContext: () => undefined,
    getSendContext: () => ({
      prompt: "",
      images: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      selectedPromptEffort: null,
      selectedModelOptionsForDispatch: undefined,
      selectedModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: "gpt-5.4",
      selectedProviderModels: codexProvider.models,
    }),
    ...overrides,
  } as ChatComposerHandle;
}

function installComposerHandle(overrides: Partial<ChatComposerHandle> = {}): {
  handle: ChatComposerHandle;
  promptRef: RefObject<string>;
} {
  const composer = capturedProps("chatComposer");
  const composerRef = composer["composerRef"] as RefObject<ChatComposerHandle | null>;
  const handle = composerHandle(overrides);
  composerRef.current = handle;
  return { handle, promptRef: composer["promptRef"] as RefObject<string> };
}

function seedFreshLocalDraft(
  logicalProjectKey: string,
  modelSelection: ModelSelection,
): ReturnType<typeof newDraftId> {
  const draftId = newDraftId();
  seedEnvironment(makeEnvironmentPresentation());
  seedProject(makeProject());
  seedGitStatus(true);
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(environmentId, projectId),
      draftId,
      { threadId, createdAt: now, envMode: "local" },
    );
  useComposerDraftStore.getState().setModelSelection(draftId, modelSelection);
  publishSeededStoreState(useComposerDraftStore);
  return draftId;
}

function draftModelSelection(
  draftId: ReturnType<typeof newDraftId>,
  instanceId: ProviderInstanceId,
): ModelSelection {
  const selection = useComposerDraftStore.getState().getComposerDraft(draftId)
    ?.modelSelectionByProvider[instanceId];
  expect(selection).toBeDefined();
  return selection!;
}

function installComposerModelSelection(
  selection: ModelSelection,
  promptEffort: string,
): RefObject<string> {
  return installComposerHandle({
    getSendContext: () => ({
      ...composerHandle().getSendContext(),
      selectedPromptEffort: promptEffort,
      selectedModelOptionsForDispatch: selection.options,
      selectedModelSelection: selection,
      selectedModel: selection.model,
    }),
  }).promptRef;
}

interface FakeLegendListOptions {
  scroll?: number;
  scrollLength?: number;
  dataLength?: number;
}

function makeLegendList(options: FakeLegendListOptions = {}) {
  const scrollNodeListeners: Array<{ type: string; handler: () => void; options?: unknown }> = [];
  const calls = {
    scrollToEnd: [] as unknown[],
    scrollToOffset: [] as unknown[],
    scrollToIndex: [] as unknown[],
  };
  const scrollNode = {
    listeners: scrollNodeListeners,
    addEventListener: (type: string, handler: () => void, listenerOptions?: unknown) => {
      scrollNodeListeners.push({ type, handler, options: listenerOptions });
    },
    removeEventListener: () => undefined,
    fire(type: string) {
      for (const listener of scrollNodeListeners) {
        if (listener.type === type) listener.handler();
      }
    },
  };
  const list = {
    calls,
    scrollNode,
    getScrollableNode: () => scrollNode,
    getState: () => ({
      scroll: options.scroll ?? 0,
      data: Array.from({ length: options.dataLength ?? 1 }, (_, index) => index),
      positionAtIndex: (_index: number) => 0,
      sizeAtIndex: (_index: number) => 100,
      scrollLength: options.scrollLength ?? 50,
    }),
    scrollToEnd: (input: unknown) => {
      calls.scrollToEnd.push(input);
      return Promise.resolve();
    },
    scrollToOffset: (input: unknown) => {
      calls.scrollToOffset.push(input);
      return Promise.resolve();
    },
    scrollToIndex: (input: unknown) => {
      calls.scrollToIndex.push(input);
      return Promise.resolve();
    },
  };
  return list;
}

function installLegendList(options: FakeLegendListOptions = {}) {
  const timeline = capturedProps("messagesTimeline");
  const listRef = timeline["listRef"] as RefObject<unknown>;
  const list = makeLegendList(options);
  listRef.current = list;
  return list;
}

interface WindowListener {
  type: string;
  handler: (event: unknown) => void;
}

interface WindowStub {
  listeners: WindowListener[];
  timeouts: Array<() => void>;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: () => void;
  setTimeout: (callback: () => void) => number;
  clearTimeout: () => void;
  matchMedia: (query: string) => {
    matches: boolean;
    addEventListener: () => void;
    removeEventListener: () => void;
  };
}

let windowStub: WindowStub;
let documentQuerySelectorResult: unknown = null;

function makeWindowStub(): WindowStub {
  const listeners: WindowListener[] = [];
  const timeouts: Array<() => void> = [];
  return {
    listeners,
    timeouts,
    addEventListener: (type, handler) => {
      listeners.push({ type, handler });
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    requestAnimationFrame: (callback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    setTimeout: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeout: () => undefined,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  };
}

function runWindowTimeouts(): void {
  const pending = [...windowStub.timeouts];
  windowStub.timeouts.length = 0;
  for (const callback of pending) callback();
}

function windowKeydownHandler(): (event: unknown) => void {
  const listener = windowStub.listeners.find((entry) => entry.type === "keydown");
  expect(listener, "expected a window keydown listener").toBeDefined();
  return listener!.handler;
}

class FakeElement {
  closestResult: boolean;
  constructor(closestResult = false) {
    this.closestResult = closestResult;
  }
  closest(_selector: string): unknown {
    return this.closestResult ? this : null;
  }
}

interface FakeKeyEventInit {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  path?: unknown[];
  target?: unknown;
}

function makeKeyEvent(init: FakeKeyEventInit = {}) {
  const event = {
    key: init.key ?? "F13",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: false,
    defaultPrevented: init.defaultPrevented ?? false,
    isComposing: init.isComposing ?? false,
    target: init.target ?? null,
    prevented: false,
    stopped: false,
    composedPath: () => [...(init.path ?? [])],
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

interface ResettableStore {
  getState: () => object;
  getInitialState: () => object;
  setState: (state: object, replace: true) => void;
}

const resettableStores: ReadonlyArray<{ store: ResettableStore; pristine: object }> = [
  useComposerDraftStore,
  useRightPanelStore,
  useCenterPanelStore,
  useTerminalUiStateStore,
  useUiStateStore,
  useDiffPanelStore,
].map((store) => ({
  store: store as unknown as ResettableStore,
  pristine: { ...(store as unknown as ResettableStore).getInitialState() },
}));

/** Copy live zustand state into the server-snapshot object read during SSR. */
function publishSeededStoreState(store: unknown): void {
  const resettable = store as ResettableStore;
  Object.assign(resettable.getInitialState(), resettable.getState());
}

beforeEach(() => {
  h.captured = {};
  h.atomValuesByKey.clear();
  h.atomValuesByKey.set("atom:keybindings", []);
  h.atomValuesByKey.set("atom:editors", []);
  h.commandCalls.length = 0;
  h.commandResults = {};
  h.defaultCommandResult = () => AsyncResult.success(undefined);
  h.terminalInputEnqueues.length = 0;
  h.environments = [];
  h.primaryEnvironment = null;
  h.threadsByKey.clear();
  h.projectsByKey.clear();
  h.allProjects = [];
  h.threadRefs = [];
  h.knownSessions = [];
  h.runningTerminalIds = [];
  h.queryDataByKey.clear();
  h.assetUrls = [];
  h.previewSupported = false;
  h.previewState = {
    snapshot: null,
    sessions: {},
    suppressedTabIds: new Set<string>(),
    activeTabId: null,
    desktopOverlay: null,
    desktopByTabId: {},
    recentlySeenUrls: [],
  };
  h.settings = { ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS };
  h.navigateCalls = [];
  h.toasts.length = 0;
  h.shortcutCommandByKey.clear();
  h.shortcutLabel = "Mod+K";
  h.terminalFocusOwner = null;
  h.commandPaletteOpen = false;
  h.localApi = null;
  h.mediaQueryMatches = false;
  h.turnDiffSummaries = [];
  h.inferredCheckpointTurnCountByTurnId = {};
  h.previewActionSubscribers.length = 0;
  h.addBrowserSurfaceCalls.length = 0;
  h.closePreviewSessionCalls.length = 0;
  h.setActivePreviewTabCalls.length = 0;
  h.stateCalls.length = 0;
  h.stateSeeds.clear();
  h.setStateCalls.length = 0;
  h.effects.length = 0;

  for (const { store, pristine } of resettableStores) {
    store.setState({ ...pristine }, true);
    Object.assign(store.getInitialState(), pristine);
  }

  windowStub = makeWindowStub();
  documentQuerySelectorResult = null;
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", {
    querySelector: () => documentQuerySelectorResult,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("navigator", {
    clipboard: { writeText: () => Promise.resolve() },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatView center panel variant", () => {
  it("renders a server-backed sibling without host-only chrome or effects", () => {
    seedConnectedServerThread();
    renderPanelRoute();

    expect(h.captured["messagesTimeline"]).toBeDefined();
    expect(h.captured["chatComposer"]).toBeDefined();
    expect(h.captured["chatHeader"]).toBeUndefined();
    runEffects();
    expect(windowStub.listeners.some((listener) => listener.type === "keydown")).toBe(false);
  });

  it("mounts an active sibling chat surface from host center-panel state", () => {
    const siblingId = ThreadId.make("thread-sibling");
    seedConnectedServerThread();
    seedServerThread(makeThread({ id: siblingId, title: "Sibling thread" }));
    useCenterPanelStore.getState().openChatPanel(threadRef, siblingId, "Codex");
    publishSeededStoreState(useCenterPanelStore);

    renderServerRoute();

    expect(h.capturedList.filter((entry) => entry.name === "messagesTimeline")).toHaveLength(2);
    expect(h.captured["centerPanelTabs"]).toBeDefined();
  });

  it("renders the empty center-panel state when every surface was closed", () => {
    seedConnectedServerThread();
    useCenterPanelStore.setState({
      byThreadKey: {
        [threadKey]: {
          surfaces: [],
          activeSurfaceId: null,
        },
      },
    });
    publishSeededStoreState(useCenterPanelStore);

    expect(renderServerRoute()).toContain("No chat panels open");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────────────

describe("ChatView effects (captured and run manually)", () => {
  it("runs the mount effects for a connected server thread and cleans up", () => {
    seedConnectedServerThread();
    h.queryDataByKey.set(`shell:${environmentId}`, { snapshot: { _tag: "Some" } });

    renderServerRoute();
    installComposerHandle();
    const list = installLegendList({ scrollLength: 50 });

    const cleanups = runEffects();

    // markThreadVisited effect stamped the visited timestamp.
    expect(useUiStateStore.getState().threadLastVisitedAtById[threadKey]).toBe(now);
    // Keydown keybinding listener was registered on window.
    expect(windowStub.listeners.some((listener) => listener.type === "keydown")).toBe(true);
    // Manual-navigation listeners attached to the legend list scroll node.
    expect(list.scrollNode.listeners.map((listener) => listener.type)).toEqual(
      expect.arrayContaining(["wheel", "touchmove", "pointerdown"]),
    );
    // Live-follow effect scrolled to the end because content overflows.
    expect(list.calls.scrollToEnd.length).toBeGreaterThanOrEqual(1);

    // Wheel gesture cancels live-follow.
    list.scrollNode.fire("wheel");

    for (const cleanup of cleanups) cleanup();
  });

  it("measures the composer overlay height via the layout effect and a ResizeObserver", () => {
    seedConnectedServerThread();
    const observed: unknown[] = [];
    class FakeResizeObserver {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(target: unknown) {
        observed.push(target);
        this.callback();
      }
      disconnect() {
        observed.length = 0;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const overlayElement = {
      getBoundingClientRect: () => ({ height: 41.4 }),
    };
    seedHostState("composerOverlayElement", overlayElement);

    renderServerRoute();
    const cleanups = runEffects();

    const heightCalls = h.setStateCalls.filter((call) => call.applied === 42);
    expect(heightCalls.length).toBeGreaterThanOrEqual(1);
    expect(observed).toContain(overlayElement);
    for (const cleanup of cleanups) cleanup();
  });

  it("does not reserve overlay space for a zero-height composer without ResizeObserver", () => {
    seedConnectedServerThread();
    const overlayElement = {
      getBoundingClientRect: () => ({ height: 0 }),
    };
    seedHostState("composerOverlayElement", overlayElement);
    vi.stubGlobal("ResizeObserver", undefined);

    renderServerRoute();
    const cleanups = runEffects();

    expect(h.setStateCalls.some((call) => call.applied === 0)).toBe(false);
    for (const cleanup of cleanups) cleanup();
  });

  it("keeps an already measured overlay height stable", () => {
    seedConnectedServerThread();
    const overlayElement = {
      getBoundingClientRect: () => ({ height: 42 }),
    };
    seedHostState("composerOverlayElement", overlayElement);
    h.stateSeeds.set(20, { value: 42, expectInitial: (value) => value === 0 });
    vi.stubGlobal("ResizeObserver", undefined);

    renderServerRoute();
    const cleanups = runEffects();

    expect(h.setStateCalls.some((call) => call.index === 20 && call.applied === 42)).toBe(true);
    for (const cleanup of cleanups) cleanup();
  });

  it("reconciles optimistic user messages once the server confirms them", () => {
    const optimisticMessage: ChatMessage = {
      id: MessageId.make("message-1"),
      role: "user",
      text: "hello",
      turnId: null,
      createdAt: now,
      updatedAt: now,
      streaming: false,
      attachments: [
        {
          type: "image",
          id: "attachment-1",
          name: "img.png",
          mimeType: "image/png",
          sizeBytes: 10,
          previewUrl: "blob:preview-1",
        },
      ],
    };
    seedConnectedServerThread(
      makeThread({
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            turnId: null,
            createdAt: now,
            updatedAt: now,
            streaming: false,
          },
        ],
      }),
    );
    seedHostState("optimisticUserMessages", [optimisticMessage]);

    renderServerRoute();
    runEffects();
    runWindowTimeouts();

    // The removal timer executed the functional updater that drops confirmed
    // optimistic messages.
    const optimisticUpdates = setStateCallsFor("optimisticUserMessages");
    expect(
      optimisticUpdates.some(
        (call) => Array.isArray(call.applied) && (call.applied as unknown[]).length === 0,
      ),
    ).toBe(true);
  });

  it("positions and stabilizes a timeline anchor after manual navigation", () => {
    seedConnectedServerThread();
    renderServerRoute();
    const list = installLegendList({ scroll: 24, scrollLength: 200, dataLength: 4 });
    const cleanups = runEffects();
    const timeline = capturedProps("messagesTimeline");
    const messageId = MessageId.make("anchor-message");
    const onAnchorReady = timeline["onAnchorReady"] as (
      messageId: MessageId,
      anchorIndex: number,
    ) => void;
    const onAnchorSizeChanged = timeline["onAnchorSizeChanged"] as (messageId: MessageId) => void;

    onAnchorReady(messageId, 2);
    expect(list.calls.scrollToIndex).toContainEqual({
      index: 2,
      animated: true,
      viewPosition: 0,
      viewOffset: 16,
    });

    list.scrollNode.fire("scrollend");
    expect(list.calls.scrollToOffset).toContainEqual({ offset: 24, animated: false });

    list.scrollNode.fire("wheel");
    onAnchorReady(messageId, 2);
    list.scrollNode.fire("scrollend");
    expect(list.calls.scrollToOffset).toHaveLength(2);

    onAnchorSizeChanged(messageId);
    expect(list.calls.scrollToOffset).toHaveLength(3);

    onAnchorReady(messageId, 2);
    expect(list.calls.scrollToIndex).toHaveLength(2);
    for (const cleanup of cleanups) cleanup();
  });

  it("promotes blob attachment previews to settled server preview urls", async () => {
    const images: Array<{ src: string; fire: (type: string) => void }> = [];
    class FakeImage {
      src = "";
      listeners: Array<{ type: string; handler: () => void }> = [];
      constructor() {
        images.push({
          src: "",
          fire: (type: string) => {
            for (const listener of this.listeners) {
              if (listener.type === type) listener.handler();
            }
          },
        });
        const entry = images[images.length - 1]!;
        Object.defineProperty(this, "src", {
          get: () => entry.src,
          set: (value: string) => {
            entry.src = value;
          },
        });
      }
      addEventListener(type: string, handler: () => void) {
        this.listeners.push({ type, handler });
      }
    }
    vi.stubGlobal("Image", FakeImage);

    h.assetUrls = ["https://server/attachment-1.png"];
    seedConnectedServerThread(
      makeThread({
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "hello",
            turnId: null,
            createdAt: now,
            updatedAt: now,
            streaming: false,
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "img.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          },
        ],
      }),
    );
    seedHostState("attachmentPreviewHandoffByMessageId", {
      "message-1": ["blob:handoff-1"],
    });

    renderServerRoute();
    const cleanups = runEffects();

    expect(images).toHaveLength(1);
    expect(images[0]!.src).toBe("https://server/attachment-1.png");
    images[0]!.fire("load");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const handoffUpdates = setStateCallsFor("attachmentPreviewHandoffByMessageId");
    expect(handoffUpdates.length).toBeGreaterThanOrEqual(1);
    for (const cleanup of cleanups) cleanup();
  });

  it("relays preview bus actions to the preview panel toggle", () => {
    seedConnectedServerThread();
    h.previewSupported = true;

    renderServerRoute();
    runEffects();

    expect(h.previewActionSubscribers.length).toBeGreaterThanOrEqual(1);
    for (const subscriber of h.previewActionSubscribers) subscriber("toggle-panel");

    // No active preview tab: toggling opens a fresh browser surface.
    expect(h.addBrowserSurfaceCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Keydown shortcut dispatch
// ─────────────────────────────────────────────────────────────────────

describe("ChatView keydown shortcuts", () => {
  it("classifies every type-to-focus keyboard guard and event-path fallback", () => {
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "a" }) as never)).toBe(true);
    expect(
      shouldTypeToFocusComposer(makeKeyEvent({ key: "a", defaultPrevented: true }) as never),
    ).toBe(false);
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "a", isComposing: true }) as never)).toBe(
      false,
    );
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "a", metaKey: true }) as never)).toBe(
      false,
    );
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "a", ctrlKey: true }) as never)).toBe(
      false,
    );
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "a", altKey: true }) as never)).toBe(
      false,
    );
    expect(shouldTypeToFocusComposer(makeKeyEvent({ key: "Enter" }) as never)).toBe(false);
    expect(
      shouldTypeToFocusComposer(makeKeyEvent({ key: "a", path: [new FakeElement(true)] }) as never),
    ).toBe(false);
    const interactive = new FakeElement(false);
    interactive.closest = (selector: string) => (selector.includes("button") ? interactive : null);
    expect(
      shouldTypeToFocusComposer(makeKeyEvent({ key: "a", path: [interactive] }) as never),
    ).toBe(false);

    const target = new FakeElement(true);
    const emptyPathEvent = makeKeyEvent({ key: "a", target });
    expect(eventPathContainsSelector(emptyPathEvent as never, "button")).toBe(true);
    expect(
      eventPathContainsSelector(makeKeyEvent({ key: "a", path: [{}] }) as never, "button"),
    ).toBe(false);
  });

  it("compares terminal ids without relying on server ordering", () => {
    expect(terminalIdListsEqual([], [])).toBe(true);
    expect(terminalIdListsEqual(["one"], [])).toBe(false);
    expect(terminalIdListsEqual(["two", "one"], ["one", "two"])).toBe(true);
    expect(terminalIdListsEqual(["one", "three"], ["one", "two"])).toBe(false);

    expect(serverTerminalIdsStrictSubsetOfClient(["one"], ["one", "two"])).toBe(true);
    expect(serverTerminalIdsStrictSubsetOfClient(["missing"], ["one", "two"])).toBe(false);
    expect(serverTerminalIdsStrictSubsetOfClient(["one"], ["one"])).toBe(false);
    expect(serverTerminalIdsStrictSubsetOfClient([], ["one"])).toBe(true);
  });

  function renderWithKeydown(thread: Thread = makeThread()) {
    seedConnectedServerThread(thread);
    renderServerRoute();
    const composer = installComposerHandle();
    runEffects();
    return { handler: windowKeydownHandler(), composer };
  }

  it("routes printable keys into the composer (type-to-focus)", () => {
    const inserted: string[] = [];
    seedConnectedServerThread();
    renderServerRoute();
    installComposerHandle({
      insertTextAtEnd: (text: string) => {
        inserted.push(text);
        return true;
      },
    });
    runEffects();
    const handler = windowKeydownHandler();

    const event = makeKeyEvent({ key: "a" });
    handler(event);
    expect(inserted).toEqual(["a"]);
    expect(event.prevented).toBe(true);

    // Editable targets are excluded from type-to-focus.
    const editable = new FakeElement(true);
    const editableEvent = makeKeyEvent({ key: "b", path: [editable] });
    handler(editableEvent);
    expect(inserted).toEqual(["a"]);

    // An open floating layer suppresses type-to-focus too.
    documentQuerySelectorResult = {};
    const floatingEvent = makeKeyEvent({ key: "c" });
    handler(floatingEvent);
    expect(inserted).toEqual(["a"]);
    documentQuerySelectorResult = null;

    // Modifier chords never type-to-focus.
    handler(makeKeyEvent({ key: "d", ctrlKey: true }));
    expect(inserted).toEqual(["a"]);
  });

  it("terminal.toggle opens a first terminal through the store and server", () => {
    const { handler } = renderWithKeydown();
    h.shortcutCommandByKey.set("F1", "terminal.toggle");

    handler(makeKeyEvent({ key: "F1" }));

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalOpen,
    ).toBe(true);
    expect(commandCallsFor("terminal.open")).toHaveLength(1);
    const openInput = commandCallsFor("terminal.open")[0]!.input as {
      input: { cwd: string; threadId: ThreadId };
    };
    expect(openInput.input.cwd).toBe("X:/demo");
    expect(openInput.input.threadId).toBe(threadId);
  });

  it("terminal.split / splitVertical / new / close and panel toggles dispatch", () => {
    const { handler } = renderWithKeydown();
    h.shortcutCommandByKey.set("F1", "terminal.split");
    h.shortcutCommandByKey.set("F2", "terminal.splitVertical");
    h.shortcutCommandByKey.set("F3", "terminal.new");
    h.shortcutCommandByKey.set("F4", "terminal.close");
    h.shortcutCommandByKey.set("F5", "rightPanel.toggle");
    h.shortcutCommandByKey.set("F6", "diff.toggle");
    h.shortcutCommandByKey.set("F7", "modelPicker.toggle");

    handler(makeKeyEvent({ key: "F1" }));
    handler(makeKeyEvent({ key: "F2" }));
    handler(makeKeyEvent({ key: "F3" }));
    // terminal.close with the drawer closed is a no-op.
    handler(makeKeyEvent({ key: "F4" }));
    handler(makeKeyEvent({ key: "F5" }));
    handler(makeKeyEvent({ key: "F6" }));
    handler(makeKeyEvent({ key: "F7" }));

    // split, splitVertical, and new each opened a terminal.
    expect(commandCallsFor("terminal.open")).toHaveLength(3);
    expect(commandCallsFor("terminal.close")).toHaveLength(0);
    // rightPanel.toggle opened the (empty) right panel.
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.isOpen ?? false).toBe(true);
    // diff.toggle opened the diff surface.
    expect(useDiffPanelStore.getState()).toBeDefined();
  });

  it("routes split/new/close to the right panel when it owns terminal focus", () => {
    seedConnectedServerThread();
    useRightPanelStore.getState().openTerminal(threadRef, "terminal-77");
    publishSeededStoreState(useRightPanelStore);
    h.terminalFocusOwner = "right-panel";

    renderServerRoute();
    installComposerHandle();
    runEffects();
    const handler = windowKeydownHandler();

    h.shortcutCommandByKey.set("F1", "terminal.split");
    h.shortcutCommandByKey.set("F2", "terminal.splitVertical");
    h.shortcutCommandByKey.set("F3", "terminal.new");
    h.shortcutCommandByKey.set("F4", "terminal.close");

    handler(makeKeyEvent({ key: "F1" }));
    handler(makeKeyEvent({ key: "F2" }));
    handler(makeKeyEvent({ key: "F3" }));
    handler(makeKeyEvent({ key: "F4" }));

    // Panel split x2 + panel new terminal each open a server terminal; close
    // closes the focused panel terminal.
    expect(commandCallsFor("terminal.open").length).toBeGreaterThanOrEqual(3);
    expect(commandCallsFor("terminal.close")).toHaveLength(1);
  });

  it("project script shortcuts run the mapped script in a terminal", () => {
    const script: ProjectScript = {
      id: "dev-server",
      name: "Dev server",
      command: "pnpm dev",
      icon: "play",
      runOnWorktreeCreate: false,
    };
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject({ scripts: [script] }));
    seedServerThread(makeThread());
    seedGitStatus(true);
    renderServerRoute();
    installComposerHandle();
    runEffects();
    const handler = windowKeydownHandler();
    h.shortcutCommandByKey.set("F9", "script.dev-server.run");

    handler(makeKeyEvent({ key: "F9" }));

    return Promise.resolve().then(async () => {
      await Promise.resolve();
      await Promise.resolve();
      expect(commandCallsFor("terminal.open")).toHaveLength(1);
      const writes = commandCallsFor("terminal.write");
      expect(writes).toHaveLength(1);
      expect((writes[0]!.input as { input: { data: string } }).input.data).toBe("pnpm dev\r");
    });
  });

  it("ignores shortcuts while the command palette is open", () => {
    const { handler } = renderWithKeydown();
    h.commandPaletteOpen = true;
    h.shortcutCommandByKey.set("F1", "terminal.toggle");

    handler(makeKeyEvent({ key: "F1" }));

    expect(commandCallsFor("terminal.open")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Right panel surface handlers
// ─────────────────────────────────────────────────────────────────────

describe("ChatView right panel handlers", () => {
  function openedPanelProps(open: (ref: typeof threadRef) => void) {
    seedConnectedServerThread();
    open(threadRef);
    publishSeededStoreState(useRightPanelStore);
    renderServerRoute();
    return capturedProps("rightPanelTabs");
  }

  it("passes one project-scoped editing registry into file surfaces", async () => {
    seedConnectedServerThread();
    useRightPanelStore.getState().openFile(threadRef, "src/a.ts");
    useRightPanelStore.getState().openFile(threadRef, "src/b.ts");
    publishSeededStoreState(useRightPanelStore);

    renderServerRoute();
    await vi.dynamicImportSettled();
    renderServerRoute();

    const props = capturedProps("filePreviewPanel");
    expect(props["editingSessions"]).toBeInstanceOf(FileEditingSessionRegistry);
  });

  it("activates plan / terminal / diff surfaces with their side effects", () => {
    const props = openedPanelProps((ref) => {
      useRightPanelStore.getState().open(ref, "plan");
      useRightPanelStore.getState().openTerminal(ref, "terminal-1");
      useRightPanelStore.getState().open(ref, "diff");
    });
    const onActivate = props["onActivate"] as (surface: RightPanelSurface) => void;
    const surfaces = useRightPanelStore.getState().byThreadKey[threadKey]!.surfaces;

    for (const surface of surfaces) {
      onActivate(surface);
    }

    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      surfaces[surfaces.length - 1]!.id,
    );
  });

  it("closes single, other, right-of, and all surfaces including terminal cleanup", () => {
    const props = openedPanelProps((ref) => {
      useRightPanelStore.getState().open(ref, "plan");
      useRightPanelStore.getState().openTerminal(ref, "terminal-1");
      useRightPanelStore.getState().open(ref, "sourceControl");
      useRightPanelStore.getState().open(ref, "files");
    });
    const surfaces = useRightPanelStore.getState().byThreadKey[threadKey]!.surfaces;
    const terminalSurface = surfaces.find((surface) => surface.kind === "terminal")!;
    const planSurface = surfaces.find((surface) => surface.kind === "plan")!;

    const onCloseSurface = props["onCloseSurface"] as (surface: RightPanelSurface) => void;
    const onCloseOtherSurfaces = props["onCloseOtherSurfaces"] as (
      surface: RightPanelSurface,
    ) => void;
    const onCloseSurfacesToRight = props["onCloseSurfacesToRight"] as (
      surface: RightPanelSurface,
    ) => void;
    const onCloseAllSurfaces = props["onCloseAllSurfaces"] as () => void;

    onCloseSurface(terminalSurface);
    expect(commandCallsFor("terminal.close")).toHaveLength(1);

    onCloseSurfacesToRight(planSurface);
    onCloseOtherSurfaces(planSurface);
    onCloseAllSurfaces();

    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toHaveLength(0);
  });

  it("adds browser/terminal/diff/source-control/files surfaces on demand", () => {
    const props = openedPanelProps((ref) => {
      useRightPanelStore.getState().open(ref, "plan");
    });

    (props["onAddBrowser"] as () => void)();
    (props["onAddTerminal"] as () => void)();
    (props["onAddDiff"] as () => void)();
    (props["onAddSourceControl"] as () => void)();
    (props["onAddFiles"] as () => void)();

    expect(h.addBrowserSurfaceCalls).toHaveLength(1);
    expect(commandCallsFor("terminal.open")).toHaveLength(1);
    const kinds = (useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).map(
      (surface) => surface.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(["terminal", "diff", "sourceControl", "files"]));
  });

  it("copies file paths via the clipboard with success and failure toasts", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const props = openedPanelProps((ref) => {
      useRightPanelStore.getState().openFile(ref, "src/index.ts");
    });
    const onCopyFilePath = props["onCopyFilePath"] as (relativePath: string) => void;

    onCopyFilePath("src/index.ts");
    await Promise.resolve();
    expect(written).toEqual(["src/index.ts"]);
    expect(h.toasts.some((toast) => (toast as { title?: string }).title === "Path copied")).toBe(
      true,
    );

    // Clipboard rejection surfaces an error toast.
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: () => Promise.reject(new Error("denied")),
      },
    });
    onCopyFilePath("src/other.ts");
    await Promise.resolve();
    await Promise.resolve();
    expect(
      h.toasts.some((toast) => (toast as { title?: string }).title === "Failed to copy path"),
    ).toBe(true);

    // Missing clipboard API short-circuits with an error toast.
    vi.stubGlobal("navigator", {});
    h.toasts.length = 0;
    onCopyFilePath("src/third.ts");
    expect(
      h.toasts.some((toast) => (toast as { title?: string }).title === "Failed to copy path"),
    ).toBe(true);
  });

  it("closes preview surfaces through closePreviewSession", () => {
    h.previewSupported = true;
    seedConnectedServerThread();
    useRightPanelStore.getState().openBrowser(threadRef, "tab-1");
    publishSeededStoreState(useRightPanelStore);
    renderServerRoute();
    const props = capturedProps("rightPanelTabs");
    const surfaces = useRightPanelStore.getState().byThreadKey[threadKey]!.surfaces;
    const previewSurface = surfaces.find((surface) => surface.kind === "preview")!;

    (props["onCloseSurface"] as (surface: RightPanelSurface) => void)(previewSurface);

    expect(h.closePreviewSessionCalls).toHaveLength(1);
  });

  it("renders the sheet layout on narrow viewports and closes via the sheet", () => {
    h.mediaQueryMatches = true;
    seedConnectedServerThread();
    useRightPanelStore.getState().open(threadRef, "plan");
    publishSeededStoreState(useRightPanelStore);

    const markup = renderServerRoute();

    expect(markup).toContain('data-mock="right-panel-sheet"');
    const sheet = capturedProps("rightPanelSheet");
    (sheet["onClose"] as () => void)();
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.isOpen).toBe(false);
  });

  it("toggles the terminal drawer and right panel from the layout controls", () => {
    seedConnectedServerThread();
    renderServerRoute();
    const controls = capturedProps("panelLayoutControls");

    (controls["onToggleRightPanel"] as () => void)();
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.isOpen).toBe(true);

    (controls["onToggleTerminal"] as () => void)();
    expect(commandCallsFor("terminal.open")).toHaveLength(1);
  });

  it("maximizes the inline right panel via the maximize control", () => {
    seedConnectedServerThread();
    useRightPanelStore.getState().open(threadRef, "plan");
    publishSeededStoreState(useRightPanelStore);
    seedHostState("maximizedRightPanelThreadKey", threadKey);

    const markup = renderServerRoute();

    expect(markup).toContain('data-chat-column-maximized-away="true"');
    const control = capturedProps("rightPanelMaximizeControl");
    expect(control["maximized"]).toBe(true);
    (control["onToggle"] as () => void)();
    const toggles = setStateCallsFor("maximizedRightPanelThreadKey");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.applied).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Persistent terminal drawer
// ─────────────────────────────────────────────────────────────────────

describe("ChatView persistent terminal drawer", () => {
  function seedDrawer(options: { knownIds?: string[]; storeIds?: string[] } = {}) {
    seedConnectedServerThread();
    const storeIds = options.storeIds ?? ["terminal-1"];
    const store = useTerminalUiStateStore.getState();
    for (const [index, id] of storeIds.entries()) {
      store.ensureTerminal(threadRef, id, { open: index === 0 });
    }
    publishSeededStoreState(useTerminalUiStateStore);
    h.knownSessions = (options.knownIds ?? storeIds).map((terminalId) => ({
      target: { environmentId, threadId, terminalId },
      state: {
        summary: {
          label: `Shell ${terminalId}`,
          cwd: "X:/demo",
          worktreePath: null,
        },
      },
    }));
    seedHostState("mountedTerminalThreadKeys", [threadKey]);
  }

  it("renders the drawer and exercises split/new/activate/close callbacks", async () => {
    seedDrawer();

    const markup = renderServerRoute();
    expect(markup).toContain('data-mock="thread-terminal-drawer"');

    const drawer = capturedProps("threadTerminalDrawer");
    expect(drawer["mode"]).toBeUndefined();
    expect(drawer["cwd"]).toBe("X:/demo");

    (drawer["onSplitTerminal"] as () => void)();
    (drawer["onSplitTerminalVertical"] as () => void)();
    (drawer["onNewTerminal"] as () => void)();
    (drawer["onActiveTerminalChange"] as (terminalId: string) => void)("terminal-1");
    (drawer["onHeightChange"] as (height: number) => void)(333);

    expect(commandCallsFor("terminal.open")).toHaveLength(3);
    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalHeight,
    ).toBe(333);

    // Successful close deletes the terminal server-side without a fallback write.
    (drawer["onCloseTerminal"] as (terminalId: string) => void)("terminal-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(commandCallsFor("terminal.close")).toHaveLength(1);
    expect(commandCallsFor("terminal.write")).toHaveLength(0);

    // Failed close falls back to writing an exit into the terminal.
    h.commandResults["terminal.close"] = () =>
      AsyncResult.failure(Cause.fail(new Error("close failed")));
    (drawer["onCloseTerminal"] as (terminalId: string) => void)("terminal-2");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandCallsFor("terminal.write")).toHaveLength(1);
    expect(h.terminalInputEnqueues.at(-1)?.data).toBe("exit\n");

    // Terminal context selections forward to the composer only while visible.
    const selections: TerminalContextSelection[] = [];
    installComposerHandle({
      addTerminalContext: (selection: TerminalContextSelection) => {
        selections.push(selection);
      },
    });
    const selection: TerminalContextSelection = {
      terminalId: "terminal-1",
      terminalLabel: "Shell terminal-1",
      lineStart: 1,
      lineEnd: 2,
      text: "output",
    };
    (drawer["onAddTerminalContext"] as (selection: TerminalContextSelection) => void)(selection);
    expect(selections).toEqual([selection]);
  });

  it("reconciles when server terminal ids diverge but not for strict subsets", () => {
    // Case 1: identical ids (order ignored) — no reconcile.
    seedDrawer({ storeIds: ["terminal-1"], knownIds: ["terminal-1"] });
    renderServerRoute();
    runEffects();
    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalIds,
    ).toEqual(["terminal-1"]);

    // Case 2: server ids are a strict subset of local ids — reconcile skipped.
    h.knownSessions = [
      {
        target: { environmentId, threadId, terminalId: "terminal-1" },
        state: { summary: { label: "Shell", cwd: "X:/demo", worktreePath: null } },
      },
    ];
    useTerminalUiStateStore.getState().splitTerminal(threadRef, "terminal-2");
    publishSeededStoreState(useTerminalUiStateStore);
    seedHostState("mountedTerminalThreadKeys", [threadKey]);
    renderServerRoute();
    runEffects();
    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalIds,
    ).toEqual(["terminal-1", "terminal-2"]);

    // Case 3: server knows about a different set — reconcile applies it.
    h.knownSessions = ["terminal-8", "terminal-9"].map((terminalId) => ({
      target: { environmentId, threadId, terminalId },
      state: { summary: { label: terminalId, cwd: "X:/demo", worktreePath: null } },
    }));
    seedHostState("mountedTerminalThreadKeys", [threadKey]);
    renderServerRoute();
    runEffects();
    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey]?.terminalIds,
    ).toEqual(["terminal-8", "terminal-9"]);
  });

  it("uses the script launch context for the drawer cwd when one is active", () => {
    seedDrawer();
    seedHostState("terminalUiLaunchContext", {
      threadId,
      cwd: "X:/demo/worktrees/wt-1",
      worktreePath: "X:/demo/worktrees/wt-1",
    });

    renderServerRoute();

    const drawer = capturedProps("threadTerminalDrawer");
    expect(drawer["cwd"]).toBe("X:/demo/worktrees/wt-1");
    expect(drawer["worktreePath"]).toBe("X:/demo/worktrees/wt-1");
    const locations = drawer["terminalLaunchLocationsById"] as ReadonlyMap<
      string,
      { cwd: string; worktreePath: string | null }
    >;
    expect(locations.get("terminal-1")?.cwd).toBe("X:/demo/worktrees/wt-1");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Project scripts (header handlers)
// ─────────────────────────────────────────────────────────────────────

describe("ChatView project script handlers", () => {
  const script: ProjectScript = {
    id: "dev-server",
    name: "Dev server",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
  };

  function renderWithScripts(scripts = [script]) {
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject({ scripts }));
    seedServerThread(makeThread());
    seedGitStatus(true);
    renderServerRoute();
    return capturedProps("chatHeader");
  }

  it("creates a chat panel from configured defaults instead of stale project options", async () => {
    const reasoningEffort: ProviderOptionDescriptor = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    };
    const configuredModel = {
      slug: "gpt-configured",
      name: "Configured",
      isCustom: false,
      capabilities: { optionDescriptors: [reasoningEffort] },
    };
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(
      makeProject({
        defaultModelSelection: {
          instanceId: codexInstanceId,
          model: "gpt-stale",
          options: [
            { id: "reasoningEffort", value: "medium" },
            { id: "serviceTier", value: "default" },
          ],
        },
        scripts: [script],
      }),
    );
    seedServerThread(
      makeThread({
        branch: "feature/panels",
        worktreePath: "X:/demo/worktrees/panels",
      }),
    );
    seedGitStatus(true);
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        [ProviderDriverKind.make("codex")]: {
          model: "gpt-configured",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    };
    renderServerRoute();
    const header = capturedProps("chatHeader");
    const entry = {
      instanceId: codexInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: [
        {
          slug: "gpt-stale",
          name: "Stale",
          isCustom: false,
          capabilities: { optionDescriptors: [reasoningEffort] },
        },
        configuredModel,
      ],
    } as unknown as ProviderInstanceEntry;

    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.create")).toHaveLength(1);
    expect(commandCallsFor("thread.create")[0]?.input).toMatchObject({
      environmentId,
      input: {
        projectId,
        branch: "feature/panels",
        worktreePath: "X:/demo/worktrees/panels",
        modelSelection: {
          instanceId: codexInstanceId,
          model: "gpt-configured",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    });
  });

  it("creates a Claude chat panel with a configured prompt-injected effort", async () => {
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const configuredModel = {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
        ],
      },
    };
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject({ defaultModelSelection: null }));
    seedServerThread(makeThread());
    seedGitStatus(true);
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        [claudeDriver]: {
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "ultrathink" }],
        },
      },
    };
    renderServerRoute();
    const header = capturedProps("chatHeader");
    const entry = {
      instanceId: claudeInstanceId,
      driverKind: claudeDriver,
      displayName: "Claude",
      models: [configuredModel],
    } as unknown as ProviderInstanceEntry;

    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.create")[0]?.input).toMatchObject({
      input: {
        modelSelection: {
          instanceId: claudeInstanceId,
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "ultrathink" }],
        },
      },
    });
  });

  it("creates a Codex chat panel with saved effort and fast mode during empty discovery", async () => {
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject({ defaultModelSelection: null }));
    seedServerThread(makeThread());
    seedGitStatus(true);
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        [ProviderDriverKind.make("codex")]: {
          model: "gpt-offline",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    };
    renderServerRoute();
    const header = capturedProps("chatHeader");
    const entry = {
      instanceId: codexInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: [],
    } as unknown as ProviderInstanceEntry;

    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.create")[0]?.input).toMatchObject({
      input: {
        modelSelection: {
          instanceId: codexInstanceId,
          model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("codex")],
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    });
  });

  it("runs a script in the active terminal and remembers it per project", async () => {
    const header = renderWithScripts();
    const onRunProjectScript = header["onRunProjectScript"] as (
      target: ProjectScript,
      options?: Record<string, unknown>,
    ) => Promise<void>;

    await onRunProjectScript(script);

    expect(commandCallsFor("terminal.open")).toHaveLength(1);
    const writes = commandCallsFor("terminal.write");
    expect(writes).toHaveLength(1);
    expect((writes[0]!.input as { input: { data: string } }).input.data).toBe("pnpm dev\r");
    expect(h.terminalInputEnqueues.at(-1)?.data).toBe("pnpm dev\r");
  });

  it("prefers a fresh terminal when the base terminal is busy", async () => {
    h.runningTerminalIds = ["terminal-1"];
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject({ scripts: [script] }));
    seedServerThread(makeThread());
    seedGitStatus(true);
    const store = useTerminalUiStateStore.getState();
    store.ensureTerminal(threadRef, "terminal-1", { open: true });
    publishSeededStoreState(useTerminalUiStateStore);
    h.knownSessions = [
      {
        target: { environmentId, threadId, terminalId: "terminal-1" },
        state: { summary: { label: "Shell", cwd: "X:/demo", worktreePath: null } },
      },
    ];
    renderServerRoute();
    const header = capturedProps("chatHeader");

    await (header["onRunProjectScript"] as (input: typeof script) => Promise<void>)(script);

    const openCalls = commandCallsFor("terminal.open");
    expect(openCalls).toHaveLength(1);
    const openInput = openCalls[0]!.input as { input: { terminalId: string; cols?: number } };
    expect(openInput.input.terminalId).not.toBe("terminal-1");
    expect(openInput.input.cols).toBe(120);
  });

  it("reports script terminal failures as thread errors", async () => {
    h.commandResults["terminal.open"] = () =>
      AsyncResult.failure(Cause.fail(new Error("terminal exploded")));
    const header = renderWithScripts();

    await (header["onRunProjectScript"] as (input: typeof script) => Promise<void>)(script);

    expect(commandCallsFor("terminal.write")).toHaveLength(0);
    // The failure was routed into local server error state.
    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "terminal exploded",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("saves, updates, and deletes project scripts through project.update", async () => {
    const header = renderWithScripts();

    const onAdd = header["onAddProjectScript"] as (
      input: Record<string, unknown>,
    ) => Promise<{ _tag: string }>;
    const addResult = await onAdd({
      name: "Build",
      command: "pnpm build",
      icon: null,
      runOnWorktreeCreate: true,
      keybinding: null,
    });
    expect(addResult._tag).toBe("Success");
    expect(commandCallsFor("project.update")).toHaveLength(1);

    const onUpdate = header["onUpdateProjectScript"] as (
      scriptId: string,
      input: Record<string, unknown>,
    ) => Promise<{ _tag: string }>;
    const updateResult = await onUpdate("dev-server", {
      name: "Dev server 2",
      command: "pnpm dev --host",
      icon: null,
      runOnWorktreeCreate: true,
      keybinding: null,
    });
    expect(updateResult._tag).toBe("Success");

    const missingResult = await onUpdate("missing-script", {
      name: "Nope",
      command: "true",
      icon: null,
      runOnWorktreeCreate: false,
      keybinding: null,
    });
    expect(missingResult._tag).toBe("Failure");

    const onDelete = header["onDeleteProjectScript"] as (
      scriptId: string,
    ) => Promise<{ _tag: string }>;
    const deleteResult = await onDelete("dev-server");
    expect(deleteResult._tag).toBe("Success");
    expect(
      h.toasts.some((toast) => (toast as { title?: string }).title?.startsWith("Deleted action")),
    ).toBe(true);

    h.commandResults["project.update"] = () =>
      AsyncResult.failure(Cause.fail(new Error("persist failed")));
    const failedDelete = await onDelete("dev-server");
    expect(failedDelete._tag).toBe("Failure");
    expect(
      h.toasts.some((toast) => (toast as { title?: string }).title === "Could not delete action"),
    ).toBe(true);
  });

  it("creates chat panels and center terminal panels from the header", () => {
    const header = renderWithScripts();

    const entry = {
      instanceId: codexInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      models: codexProvider.models,
    } as unknown as ProviderInstanceEntry;
    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    expect(commandCallsFor("thread.create").length).toBeGreaterThanOrEqual(0);

    (header["onOpenTerminalPanel"] as () => void)();
    const centerState = useCenterPanelStore.getState().byThreadKey[threadKey];
    expect(centerState?.surfaces.some((surface) => surface.kind === "terminal")).toBe(true);

    const providerTerminalAction = {
      entry,
      label: "Codex Terminal",
      command: {
        executable: "/opt/codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        label: "Codex Terminal",
      },
    };
    (header["onOpenProviderTerminalPanel"] as (action: typeof providerTerminalAction) => void)(
      providerTerminalAction,
    );
    const providerSurface = useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.find(
        (surface) => surface.kind === "terminal" && surface.label === "Codex Terminal",
      );
    expect(providerSurface).toMatchObject({
      kind: "terminal",
      label: "Codex Terminal",
      command: providerTerminalAction.command,
    });
    expect(
      useCenterPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "terminal"),
    ).toHaveLength(2);
  });

  it("falls back to a built-in model discovered for the target provider instance", async () => {
    const targetInstanceId = ProviderInstanceId.make("codex_work");
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(
      makeProject({
        defaultModelSelection: {
          instanceId: codexInstanceId,
          model: "gpt-custom-first",
        },
        scripts: [script],
      }),
    );
    seedServerThread(makeThread());
    seedGitStatus(true);
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        [ProviderDriverKind.make("codex")]: { model: "gpt-other-instance" },
      },
    };
    renderServerRoute();
    const header = capturedProps("chatHeader");
    const entry = {
      instanceId: targetInstanceId,
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      models: [
        { slug: "gpt-custom-first", name: "Custom", isCustom: true, capabilities: null },
        { slug: "gpt-built-in", name: "Built in", isCustom: false, capabilities: null },
      ],
    } as unknown as ProviderInstanceEntry;

    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.create")).toHaveLength(1);
    expect(commandCallsFor("thread.create")[0]?.input).toMatchObject({
      input: {
        modelSelection: {
          instanceId: targetInstanceId,
          model: "gpt-built-in",
        },
      },
    });
  });

  it("creates a provider chat panel even when model discovery is temporarily empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const header = renderWithScripts();
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const entry = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driverKind: claudeDriver,
      displayName: "Claude",
      models: [],
    } as unknown as ProviderInstanceEntry;

    (header["onCreateChatPanel"] as (entry: ProviderInstanceEntry) => void)(entry);
    await Promise.resolve();
    await Promise.resolve();

    const createCalls = commandCallsFor("thread.create");
    expect(createCalls).toHaveLength(1);
    const createInput = createCalls[0]?.input as {
      environmentId: EnvironmentId;
      input: {
        threadId: ThreadId;
        title: string;
        modelSelection: { instanceId: ProviderInstanceId; model: string };
        kind: string;
      };
    };
    expect(createInput).toMatchObject({
      environmentId,
      input: {
        title: "Panel — Claude",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: DEFAULT_MODEL_BY_PROVIDER[claudeDriver],
        },
        kind: "panel",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "Provider session default fallback",
      expect.objectContaining({
        driver: claudeDriver,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        resolvedModel: DEFAULT_MODEL_BY_PROVIDER[claudeDriver],
        reason: "models-unavailable",
      }),
    );

    const centerState = useCenterPanelStore.getState().byThreadKey[threadKey];
    const claudeSurface = centerState?.surfaces.find((surface) => surface.kind === "chat");
    expect(claudeSurface).toEqual({
      id: `chat:${createInput.input.threadId}`,
      kind: "chat",
      threadId: createInput.input.threadId,
      providerLabel: "Claude",
    });
    expect(centerState?.activeSurfaceId).toBe(claudeSurface?.id);
  });

  it("covers explicit script launch options and opaque terminal failures", async () => {
    const header = renderWithScripts();
    const onRun = header["onRunProjectScript"] as (
      target: ProjectScript,
      options?: Record<string, unknown>,
    ) => Promise<void>;

    await onRun(script, {
      cwd: "X:/custom",
      env: { FEATURE: "1" },
      worktreePath: null,
      preferNewTerminal: true,
      rememberAsLastInvoked: false,
    });
    expect(commandCallsFor("terminal.open")[0]?.input).toMatchObject({
      input: { cwd: "X:/custom", env: expect.objectContaining({ FEATURE: "1" }) },
    });

    h.commandCalls.length = 0;
    h.commandResults["terminal.open"] = () => AsyncResult.failure(Cause.fail("opaque open"));
    await onRun(script);
    expect(commandCallsFor("terminal.write")).toHaveLength(0);

    h.commandCalls.length = 0;
    h.commandResults["terminal.open"] = () => AsyncResult.success(undefined);
    h.commandResults["terminal.write"] = () => AsyncResult.failure(Cause.fail("opaque write"));
    await onRun(script);
    expect(
      h.setStateCalls.some(
        (call) =>
          typeof call.applied === "object" &&
          call.applied !== null &&
          Object.values(call.applied as Record<string, unknown>).includes(
            'Failed to run script "Dev server".',
          ),
      ),
    ).toBe(true);
  });

  it("covers script persistence alternatives and unknown deletions", async () => {
    const autoScript = { ...script, runOnWorktreeCreate: true };
    const secondScript: ProjectScript = {
      id: "test",
      name: "Test",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
    };
    const header = renderWithScripts([autoScript, secondScript]);
    const input = {
      name: "Build",
      command: "pnpm build",
      icon: null,
      runOnWorktreeCreate: false,
      keybinding: null,
    };

    await (header["onAddProjectScript"] as (value: Record<string, unknown>) => Promise<unknown>)(
      input,
    );
    await (
      header["onUpdateProjectScript"] as (
        id: string,
        value: Record<string, unknown>,
      ) => Promise<unknown>
    )("dev-server", { ...input, runOnWorktreeCreate: true });
    await (header["onDeleteProjectScript"] as (id: string) => Promise<unknown>)("missing");

    expect(
      h.toasts.some((toast) => (toast as { title?: string }).title === 'Deleted action "Unknown"'),
    ).toBe(true);
  });

  it("returns successful no-ops for script mutations without an active project", async () => {
    seedEnvironment(makeEnvironmentPresentation());
    seedServerThread(makeThread());
    seedGitStatus(true);
    renderServerRoute();
    const header = capturedProps("chatHeader");
    const input = {
      name: "No project",
      command: "true",
      icon: null,
      runOnWorktreeCreate: false,
      keybinding: null,
    };

    expect(
      await (
        header["onAddProjectScript"] as (value: Record<string, unknown>) => Promise<{
          _tag: string;
        }>
      )(input),
    ).toMatchObject({ _tag: "Success" });
    expect(
      await (
        header["onUpdateProjectScript"] as (
          id: string,
          value: Record<string, unknown>,
        ) => Promise<{ _tag: string }>
      )("missing", input),
    ).toMatchObject({ _tag: "Success" });
    expect(
      await (header["onDeleteProjectScript"] as (id: string) => Promise<{ _tag: string }>)(
        "missing",
      ),
    ).toMatchObject({ _tag: "Success" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Send flows
// ─────────────────────────────────────────────────────────────────────

describe("ChatView send flows", () => {
  it("uses shared defaults for a legacy draft that has no stored model selection", () => {
    const draftId = newDraftId();
    const capabilityRichProvider: ServerProvider = {
      ...codexProvider,
      models: [
        {
          ...codexProvider.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
                currentValue: "medium",
              },
              {
                id: "serviceTier",
                label: "Service tier",
                type: "select",
                options: [
                  { id: "default", label: "Default", isDefault: true },
                  { id: "fast", label: "Fast" },
                ],
                currentValue: "default",
              },
            ],
          },
        },
      ],
    };
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [capabilityRichProvider],
          environment: { label: "Local" },
        },
      }),
    );
    seedProject(makeProject({ defaultModelSelection: null }));
    seedGitStatus(true);
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        codex: {
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    };
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "legacy-draft",
        scopeProjectRef(environmentId, projectId),
        draftId,
        { threadId, createdAt: now, envMode: "local" },
      );
    publishSeededStoreState(useComposerDraftStore);

    renderDraftRoute(draftId);

    expect(capturedProps("chatComposer")["activeThreadModelSelection"]).toEqual({
      instanceId: codexInstanceId,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
  });

  it.each(["draft", "server-style"] as const)(
    "warns once at legacy draft promotion through the %s route when a configured model falls back",
    async (route) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const draftId = newDraftId();
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject({ defaultModelSelection: null }));
      seedGitStatus(true);
      h.settings = {
        ...h.settings,
        providerSessionDefaults: {
          codex: {
            model: "retired-codex-model",
            options: [],
          },
        },
      };
      useComposerDraftStore
        .getState()
        .setLogicalProjectDraftThreadId(
          "legacy-draft-fallback",
          scopeProjectRef(environmentId, projectId),
          draftId,
          { threadId, createdAt: now, envMode: "local" },
        );
      publishSeededStoreState(useComposerDraftStore);

      if (route === "draft") {
        renderDraftRoute(draftId);
      } else {
        renderServerRoute();
      }

      expect(warn).not.toHaveBeenCalled();
      const resolvedSelection = capturedProps("chatComposer")[
        "activeThreadModelSelection"
      ] as ModelSelection;
      expect(resolvedSelection).toEqual({
        instanceId: codexInstanceId,
        model: "gpt-5.4",
        options: [{ id: "serviceTier", value: "default" }],
      });
      const promptRef = installComposerModelSelection(resolvedSelection, "medium");
      const onSend = capturedProps("chatComposer")["onSend"] as () => Promise<void>;

      promptRef.current = "promote the legacy draft";
      await onSend();
      promptRef.current = "retry the same legacy promotion boundary";
      await onSend();

      expect(warn.mock.calls).toEqual([
        [
          "Provider session default fallback",
          {
            driver: ProviderDriverKind.make("codex"),
            instanceId: codexInstanceId,
            configuredModel: "retired-codex-model",
            resolvedModel: "gpt-5.4",
            reason: "configured-model-unavailable",
          },
        ],
      ]);
    },
  );

  it("promotes a freshly seeded draft with its unchanged full model selection", async () => {
    const seededSelection: ModelSelection = {
      instanceId: codexInstanceId,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const draftId = seedFreshLocalDraft("logical-project-first-turn", seededSelection);
    const storedSelection = draftModelSelection(draftId, codexInstanceId);
    expect(storedSelection).toEqual(seededSelection);

    renderDraftRoute(draftId);
    const promptRef = installComposerModelSelection(storedSelection, "high");
    promptRef.current = "use the seeded defaults";

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    const input = startCalls[0]!.input as {
      input: {
        modelSelection: ModelSelection;
        bootstrap?: { createThread?: { modelSelection: ModelSelection } };
      };
    };
    expect(input.input.modelSelection).toBe(storedSelection);
    expect(input.input.bootstrap?.createThread?.modelSelection).toBe(storedSelection);
  });

  it("prefixes the first prompt from a prompt-injected Claude session default", async () => {
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const claudeModel: ServerProvider["models"][number] = {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
        ],
      },
    };
    const seededSelection: ModelSelection = {
      instanceId: claudeInstanceId,
      model: claudeModel.slug,
      options: [{ id: "effort", value: "ultrathink" }],
    };
    const draftId = seedFreshLocalDraft("claude-ultrathink-first-turn", seededSelection);
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [
            {
              ...codexProvider,
              instanceId: claudeInstanceId,
              driver: claudeDriver,
              models: [claudeModel],
            },
          ],
          environment: { label: "Local" },
        },
      }),
    );

    renderDraftRoute(draftId);
    const storedSelection = draftModelSelection(draftId, claudeInstanceId);
    const composerState = getComposerProviderState({
      provider: claudeDriver,
      model: claudeModel.slug,
      models: [claudeModel],
      modelOptions: storedSelection.options,
    });
    const dispatchSelection: ModelSelection = {
      instanceId: claudeInstanceId,
      model: claudeModel.slug,
      ...(composerState.modelOptionsForDispatch
        ? { options: composerState.modelOptionsForDispatch }
        : {}),
    };
    const { promptRef } = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        selectedPromptEffort: composerState.promptEffort,
        selectedModelOptionsForDispatch: composerState.modelOptionsForDispatch,
        selectedModelSelection: dispatchSelection,
        selectedProvider: claudeDriver,
        selectedModel: claudeModel.slug,
        selectedProviderModels: [claudeModel],
      }),
    });
    promptRef.current = "Investigate the flaky test";

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(1);
    expect(commandCallsFor("thread.startTurn")[0]?.input).toMatchObject({
      input: {
        message: { text: "Ultrathink:\nInvestigate the flaky test" },
        modelSelection: {
          instanceId: claudeInstanceId,
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "high" }],
        },
        bootstrap: {
          createThread: {
            modelSelection: {
              instanceId: claudeInstanceId,
              model: "claude-sonnet-5",
              options: [{ id: "effort", value: "high" }],
            },
          },
        },
      },
    });
  });

  it("uses explicit draft model, effort, and fast changes for the first turn", async () => {
    const seededSelection: ModelSelection = {
      instanceId: codexInstanceId,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    };
    const userSelection: ModelSelection = {
      instanceId: codexInstanceId,
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    };
    const draftId = seedFreshLocalDraft("logical-project-first-turn-edited", seededSelection);
    useComposerDraftStore.getState().setModelSelection(draftId, userSelection);
    publishSeededStoreState(useComposerDraftStore);

    const storedSelection = draftModelSelection(draftId, codexInstanceId);
    expect(storedSelection).toEqual(userSelection);

    renderDraftRoute(draftId);
    const promptRef = installComposerModelSelection(storedSelection, "high");
    promptRef.current = "use my explicit choices";

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    const input = startCalls[0]!.input as {
      input: {
        modelSelection: ModelSelection;
        bootstrap?: { createThread?: { modelSelection: ModelSelection } };
      };
    };
    expect(input.input.modelSelection).toBe(storedSelection);
    expect(input.input.bootstrap?.createThread?.modelSelection).toBe(storedSelection);
  });

  it("keeps an existing thread selection after provider session defaults change", async () => {
    const persistedSelection: ModelSelection = {
      instanceId: codexInstanceId,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: false },
      ],
    };
    seedConnectedServerThread(makeThread({ modelSelection: persistedSelection }));
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        [ProviderDriverKind.make("codex")]: {
          model: "gpt-5.4-mini",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
    };

    renderServerRoute();
    const promptRef = installComposerModelSelection(persistedSelection, "low");
    promptRef.current = "continue with the persisted selection";

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.create")).toHaveLength(0);
    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    const input = startCalls[0]!.input as {
      input: {
        modelSelection: ModelSelection;
        bootstrap?: unknown;
      };
    };
    expect(input.input.modelSelection).toBe(persistedSelection);
    expect(input.input.bootstrap).toBeUndefined();
    expect(
      commandCallsFor("thread.updateMetadata").filter(
        (call) =>
          (
            call.input as {
              input?: { modelSelection?: ModelSelection };
            }
          ).input?.modelSelection !== undefined,
      ),
    ).toHaveLength(0);
  });

  it("returns without dispatch when the composer handle has no send context", async () => {
    seedConnectedServerThread();
    renderServerRoute();

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
  });

  it("treats a standalone /plan message as an interaction mode switch", async () => {
    seedConnectedServerThread();
    renderServerRoute();
    const { promptRef } = installComposerHandle();
    promptRef.current = "/plan";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode).toBe(
      "plan",
    );
  });

  it("warns when only expired terminal contexts remain", async () => {
    seedConnectedServerThread();
    renderServerRoute();
    const expiredContext: TerminalContextDraft = {
      id: "ctx-1",
      threadId,
      createdAt: now,
      terminalId: "terminal-1",
      terminalLabel: "Shell",
      lineStart: 1,
      lineEnd: 3,
      text: "",
    };
    const { promptRef } = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        terminalContexts: [expiredContext],
      }),
    });
    promptRef.current = "";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
    expect(h.toasts.length).toBeGreaterThanOrEqual(1);
  });

  it("requires a base branch before sending in new-worktree mode", async () => {
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject());
    seedGitStatus(true);
    const draftId = newDraftId();
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "logical-project-1",
        scopeProjectRef(environmentId, projectId),
        draftId,
        { threadId, createdAt: now, envMode: "worktree" },
      );
    publishSeededStoreState(useComposerDraftStore);

    renderDraftRoute(draftId);
    const { promptRef } = installComposerHandle();
    promptRef.current = "start in worktree";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        Object.values(call.applied as Record<string, unknown>).includes(
          "Select a base branch before sending in New worktree mode.",
        ),
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("restores the composer draft when the turn start fails", async () => {
    seedConnectedServerThread();
    h.commandResults["thread.startTurn"] = () =>
      AsyncResult.failure(Cause.fail(new Error("turn rejected")));
    renderServerRoute();
    const resetCalls: unknown[] = [];
    const { promptRef } = installComposerHandle({
      resetCursorState: (options?: unknown) => {
        resetCalls.push(options ?? null);
      },
    });
    promptRef.current = "please fail";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    // Restore pass: prompt written back to the ref and the draft store.
    expect(promptRef.current).toBe("please fail");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "please fail",
    );
    // The cursor reset ran once on clear and once on restore.
    expect(resetCalls.length).toBe(2);
    // Optimistic message add + removal updaters both executed.
    const optimisticUpdates = setStateCallsFor("optimisticUserMessages");
    expect(optimisticUpdates.length).toBeGreaterThanOrEqual(2);
  });

  it("sends image attachments through FileReader data urls", async () => {
    class FakeFileReader {
      result: string | null = null;
      private listeners: Array<{ type: string; handler: () => void }> = [];
      addEventListener(type: string, handler: () => void) {
        this.listeners.push({ type, handler });
      }
      readAsDataURL(_file: unknown) {
        this.result = "data:image/png;base64,ZmFrZQ==";
        for (const listener of this.listeners) {
          if (listener.type === "load") listener.handler();
        }
      }
    }
    vi.stubGlobal("FileReader", FakeFileReader);

    seedConnectedServerThread();
    renderServerRoute();
    const image = {
      type: "image" as const,
      id: "image-1" as ChatAttachmentId,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "blob:preview-9",
      file: new File(["fake"], "shot.png", { type: "image/png" }),
    };
    const { promptRef } = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        images: [image],
      }),
    });
    promptRef.current = "";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    const input = startCalls[0]!.input as {
      input: {
        titleSeed: string;
        message: { attachments: Array<{ dataUrl: string }> };
      };
    };
    expect(input.input.titleSeed).toBe("Image: shot.png");
    expect(input.input.message.attachments[0]!.dataUrl).toBe("data:image/png;base64,ZmFrZQ==");
  });

  it("uses terminal and element context labels as attachment-only title seeds", async () => {
    const terminalContext: TerminalContextDraft = {
      id: "ctx-title",
      threadId,
      createdAt: now,
      terminalId: "terminal-1",
      terminalLabel: "Build shell",
      lineStart: 3,
      lineEnd: 4,
      text: "build output",
    };
    seedConnectedServerThread();
    renderServerRoute();
    let installed = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        terminalContexts: [terminalContext],
      }),
    });
    installed.promptRef.current = "";
    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();
    expect(commandCallsFor("thread.startTurn")[0]?.input).toMatchObject({
      input: { titleSeed: expect.stringContaining("Build shell") },
    });

    h.commandCalls.length = 0;
    seedConnectedServerThread(makeThread({ messages: [] }));
    renderServerRoute();
    const elementContext = {
      id: "element-title",
      threadId,
      pageUrl: "http://localhost:3000",
      pageTitle: "Demo",
      tagName: "button",
      selector: ".save",
      htmlPreview: "<button>Save</button>",
      componentName: "SaveButton",
      source: null,
      styles: "",
      pickedAt: now,
    };
    installed = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        elementContexts: [elementContext],
      }),
    });
    installed.promptRef.current = "";
    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();
    expect(commandCallsFor("thread.startTurn")[0]?.input).toMatchObject({
      input: { titleSeed: "<SaveButton>" },
    });
  });

  it("omits expired contexts while sending valid prompt content", async () => {
    const expiredContext: TerminalContextDraft = {
      id: "ctx-expired-with-prompt",
      threadId,
      createdAt: now,
      terminalId: "terminal-1",
      terminalLabel: "Expired shell",
      lineStart: 1,
      lineEnd: 2,
      text: "",
    };
    seedConnectedServerThread();
    renderServerRoute();
    const { promptRef } = installComposerHandle({
      getSendContext: () => ({
        ...composerHandle().getSendContext(),
        terminalContexts: [expiredContext],
      }),
    });
    promptRef.current = "send the valid text";

    await (capturedProps("chatComposer")["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(1);
    expect(
      h.toasts.some((toast) =>
        (toast as { title?: string }).title?.includes("Expired terminal context"),
      ),
    ).toBe(true);
  });

  it("uses generic send and interrupt messages for opaque command failures", async () => {
    seedConnectedServerThread(
      makeThread({
        session: makeSession({ status: "running", activeTurnId: TurnId.make("turn-opaque") }),
      }),
    );
    h.commandResults["thread.updateMetadata"] = () =>
      AsyncResult.failure(Cause.fail("opaque title failure"));
    h.commandResults["thread.interruptTurn"] = () =>
      AsyncResult.failure(Cause.fail("opaque interrupt failure"));
    renderServerRoute();
    const { promptRef } = installComposerHandle();
    promptRef.current = "fail opaquely";
    const composer = capturedProps("chatComposer");

    await (composer["onSend"] as () => Promise<void>)();
    await (composer["onInterrupt"] as () => Promise<void>)();

    const messages = h.setStateCalls.flatMap((call) =>
      typeof call.applied === "object" && call.applied !== null
        ? Object.values(call.applied as Record<string, unknown>)
        : [],
    );
    expect(messages).toEqual(
      expect.arrayContaining(["Failed to send message.", "Failed to interrupt the current turn."]),
    );
  });

  it("submits a plan follow-up instead of a regular turn when a plan is actionable", async () => {
    const turnId = TurnId.make("turn-1");
    seedConnectedServerThread(
      makeThread({
        interactionMode: "plan",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: later,
          assistantMessageId: null,
        },
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.make("plan-1"),
            turnId,
            planMarkdown: "# Plan\n\n1. do the thing",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    renderServerRoute();
    const { promptRef } = installComposerHandle();
    promptRef.current = "ship it";

    const composer = capturedProps("chatComposer");
    expect(composer["showPlanFollowUpPrompt"]).toBe(true);
    await (composer["onSend"] as () => Promise<void>)();

    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    const input = startCalls[0]!.input as {
      input: { interactionMode: string; sourceProposedPlan?: { planId: string } };
    };
    // A follow-up with custom text refines the plan in plan mode.
    expect(input.input.interactionMode).toBe("plan");
  });

  it("reports plan follow-up failures and drops the optimistic message", async () => {
    const turnId = TurnId.make("turn-1");
    seedConnectedServerThread(
      makeThread({
        interactionMode: "plan",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: later,
          assistantMessageId: null,
        },
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.make("plan-1"),
            turnId,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    h.commandResults["thread.startTurn"] = () =>
      AsyncResult.failure(Cause.fail(new Error("follow-up rejected")));
    renderServerRoute();
    const { promptRef } = installComposerHandle();
    promptRef.current = "";

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(1);
    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "follow-up rejected",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("implements the plan in a new thread and cleans up when the start fails", async () => {
    const turnId = TurnId.make("turn-1");
    seedConnectedServerThread(
      makeThread({
        interactionMode: "plan",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: later,
          assistantMessageId: null,
        },
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.make("plan-1"),
            turnId,
            planMarkdown: "# Great Plan\n\ndo it",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );
    h.commandResults["thread.startTurn"] = () =>
      AsyncResult.failure(Cause.fail(new Error("no capacity")));
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    await (composer["onImplementPlanInNewThread"] as () => Promise<void>)();

    expect(commandCallsFor("thread.create")).toHaveLength(1);
    expect(commandCallsFor("thread.startTurn")).toHaveLength(1);
    // Failure path deletes the freshly created thread and toasts.
    expect(commandCallsFor("thread.delete")).toHaveLength(1);
    expect(
      h.toasts.some(
        (toast) => (toast as { title?: string }).title === "Could not start implementation thread",
      ),
    ).toBe(true);
    expect(h.navigateCalls).toHaveLength(0);
  });

  it("interrupt failures surface a thread error", async () => {
    seedConnectedServerThread(
      makeThread({
        session: makeSession({ status: "running", activeTurnId: TurnId.make("turn-9") }),
      }),
    );
    h.commandResults["thread.interruptTurn"] = () =>
      AsyncResult.failure(Cause.fail(new Error("cannot interrupt")));
    renderServerRoute();

    const composer = capturedProps("chatComposer");
    await (composer["onInterrupt"] as () => Promise<void>)();

    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "cannot interrupt",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pending approvals and user input
// ─────────────────────────────────────────────────────────────────────

describe("ChatView pending user input", () => {
  const requestId = ApprovalRequestId.make("request-1");

  function threadWithQuestions(questionCount: number): Thread {
    const questions = Array.from({ length: questionCount }, (_, index) => ({
      id: `question-${index + 1}`,
      header: `Header ${index + 1}`,
      question: `Question ${index + 1}?`,
      options: [
        { label: "Yes", description: "Do it" },
        { label: "No", description: "Skip it" },
      ],
      multiSelect: false,
    }));
    return makeThread({
      activities: [
        {
          id: EventId.make("event-1"),
          tone: "approval",
          kind: "user-input.requested",
          summary: "Needs your input",
          payload: { requestId: "request-1", questions },
          turnId: null,
          createdAt: now,
        },
      ],
    });
  }

  it("toggles option selections and custom answers for the active question", () => {
    seedConnectedServerThread(threadWithQuestions(2));
    renderServerRoute();
    const focusAtCalls: number[] = [];
    installComposerHandle({
      focusAt: (cursor: number) => {
        focusAtCalls.push(cursor);
      },
    });

    const composer = capturedProps("chatComposer");
    expect(composer["pendingUserInputs"]).toHaveLength(1);

    (
      composer["onSelectActivePendingUserInputOption"] as (
        questionId: string,
        optionLabel: string,
      ) => void
    )("question-1", "Yes");
    (
      composer["onChangeActivePendingUserInputCustomAnswer"] as (
        questionId: string,
        value: string,
        nextCursor: number,
        expandedCursor: number,
        cursorAdjacentToMention: boolean,
      ) => void
    )("question-1", "custom answer", 13, 13, false);

    // Both handlers wrote draft answers for the request.
    const answerWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        "request-1" in (call.applied as Record<string, unknown>),
    );
    expect(answerWrites.length).toBeGreaterThanOrEqual(2);
    expect(focusAtCalls).toEqual([13]);
  });

  it("advances through questions and submits answers on the last one", async () => {
    seedConnectedServerThread(threadWithQuestions(1));
    seedHostState("pendingUserInputAnswersByRequestId", {
      "request-1": { "question-1": { customAnswer: "", selectedOptionLabels: ["Yes"] } },
    });
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["onAdvanceActivePendingUserInput"] as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    // Single question: advancing submits immediately.
    expect(commandCallsFor("thread.respondToUserInput")).toHaveLength(1);

    (composer["onPreviousActivePendingUserInputQuestion"] as () => void)();
  });

  it("onSend advances the pending user input instead of sending", async () => {
    seedConnectedServerThread(threadWithQuestions(1));
    seedHostState("pendingUserInputAnswersByRequestId", {
      "request-1": { "question-1": { customAnswer: "", selectedOptionLabels: ["Yes"] } },
    });
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    await (composer["onSend"] as () => Promise<void>)();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
    expect(commandCallsFor("thread.respondToUserInput")).toHaveLength(1);
  });

  it("reports user-input submission failures as thread errors", async () => {
    seedConnectedServerThread(threadWithQuestions(1));
    seedHostState("pendingUserInputAnswersByRequestId", {
      "request-1": { "question-1": { customAnswer: "", selectedOptionLabels: ["Yes"] } },
    });
    h.commandResults["thread.respondToUserInput"] = () =>
      AsyncResult.failure(Cause.fail(new Error("input rejected")));
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["onAdvanceActivePendingUserInput"] as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "input rejected",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("reports approval submission failures as thread errors", async () => {
    seedConnectedServerThread();
    h.commandResults["thread.respondToApproval"] = () =>
      AsyncResult.failure(Cause.fail(new Error("approval rejected")));
    renderServerRoute();

    const composer = capturedProps("chatComposer");
    await (
      composer["onRespondToApproval"] as (
        requestId: ApprovalRequestId,
        decision: string,
      ) => Promise<unknown>
    )(requestId, "approve");

    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "approval rejected",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps pending-input callbacks inert when no request is active", () => {
    seedConnectedServerThread();
    renderServerRoute();
    const composer = capturedProps("chatComposer");

    (composer["onSelectActivePendingUserInputOption"] as (id: string, label: string) => void)(
      "missing",
      "Yes",
    );
    (
      composer["onChangeActivePendingUserInputCustomAnswer"] as (
        id: string,
        value: string,
        cursor: number,
        expandedCursor: number,
        adjacent: boolean,
      ) => void
    )("missing", "answer", 6, 6, false);
    (composer["onAdvanceActivePendingUserInput"] as () => void)();
    (composer["onPreviousActivePendingUserInputQuestion"] as () => void)();

    expect(commandCallsFor("thread.respondToUserInput")).toHaveLength(0);
  });

  it("ignores unknown questions, advances multi-question requests, and avoids redundant focus", () => {
    seedConnectedServerThread(threadWithQuestions(2));
    renderServerRoute();
    const focusAt = vi.fn();
    installComposerHandle({
      focusAt,
      readSnapshot: () => ({
        value: "answer",
        cursor: 6,
        expandedCursor: 6,
        terminalContextIds: [],
      }),
    });
    const composer = capturedProps("chatComposer");

    (composer["onSelectActivePendingUserInputOption"] as (id: string, label: string) => void)(
      "unknown-question",
      "Yes",
    );
    (
      composer["onChangeActivePendingUserInputCustomAnswer"] as (
        id: string,
        value: string,
        cursor: number,
        expandedCursor: number,
        adjacent: boolean,
      ) => void
    )("question-1", "answer", 6, 6, true);
    (composer["onAdvanceActivePendingUserInput"] as () => void)();

    expect(focusAt).not.toHaveBeenCalled();
    expect(commandCallsFor("thread.respondToUserInput")).toHaveLength(0);
  });

  it("uses generic messages for opaque approval and user-input failures", async () => {
    seedConnectedServerThread(threadWithQuestions(1));
    seedHostState("pendingUserInputAnswersByRequestId", {
      "request-1": { "question-1": { customAnswer: "", selectedOptionLabels: ["Yes"] } },
    });
    h.commandResults["thread.interruptTurn"] = () =>
      AsyncResult.failure(Cause.fail("opaque cancel"));
    h.commandResults["thread.respondToApproval"] = () =>
      AsyncResult.failure(Cause.fail("opaque approval"));
    h.commandResults["thread.respondToUserInput"] = () =>
      AsyncResult.failure(Cause.fail("opaque input"));
    renderServerRoute();
    const composer = capturedProps("chatComposer");

    await (
      composer["onRespondToApproval"] as (
        id: ApprovalRequestId,
        decision: "cancel" | "deny",
      ) => Promise<unknown>
    )(requestId, "cancel");
    await (
      composer["onRespondToApproval"] as (
        id: ApprovalRequestId,
        decision: "cancel" | "deny",
      ) => Promise<unknown>
    )(requestId, "deny");
    (composer["onAdvanceActivePendingUserInput"] as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const messages = h.setStateCalls.flatMap((call) =>
      typeof call.applied === "object" && call.applied !== null
        ? Object.values(call.applied as Record<string, unknown>)
        : [],
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        "Failed to cancel the current turn.",
        "Failed to submit approval decision.",
        "Failed to submit user input.",
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Checkpoint revert
// ─────────────────────────────────────────────────────────────────────

describe("ChatView checkpoint revert", () => {
  const userMessageId = MessageId.make("message-user-1");
  const assistantMessageId = MessageId.make("message-assistant-1");
  const turnId = TurnId.make("turn-1");

  function threadWithTurn(): Thread {
    return makeThread({
      messages: [
        {
          id: userMessageId,
          role: "user",
          text: "do something",
          turnId,
          createdAt: now,
          updatedAt: now,
          streaming: false,
        },
        {
          id: assistantMessageId,
          role: "assistant",
          text: "done",
          turnId,
          createdAt: later,
          updatedAt: later,
          streaming: false,
        },
      ],
    });
  }

  function seedRevertContext() {
    h.turnDiffSummaries = [
      {
        turnId,
        assistantMessageId,
        checkpointTurnCount: 3,
        files: [],
      },
    ];
    seedConnectedServerThread(threadWithTurn());
  }

  it("confirms and reverts to the checkpoint for a user message", async () => {
    seedRevertContext();
    const confirms: string[] = [];
    h.localApi = {
      dialogs: {
        confirm: (message: string) => {
          confirms.push(message);
          return Promise.resolve(true);
        },
      },
    };
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    const revertCounts = timeline["revertTurnCountByUserMessageId"] as ReadonlyMap<
      MessageId,
      number
    >;
    expect(revertCounts.get(userMessageId)).toBe(2);

    (timeline["onRevertUserMessage"] as (messageId: MessageId) => void)(userMessageId);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirms).toHaveLength(1);
    const revertCalls = commandCallsFor("thread.revertCheckpoint");
    expect(revertCalls).toHaveLength(1);
    expect((revertCalls[0]!.input as { input: { turnCount: number } }).input.turnCount).toBe(2);
  });

  it("does not revert when the confirmation is declined", async () => {
    seedRevertContext();
    h.localApi = {
      dialogs: { confirm: () => Promise.resolve(false) },
    };
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    (timeline["onRevertUserMessage"] as (messageId: MessageId) => void)(userMessageId);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.revertCheckpoint")).toHaveLength(0);
  });

  it("blocks reverting while the environment is unavailable", async () => {
    h.turnDiffSummaries = [{ turnId, assistantMessageId, checkpointTurnCount: 3, files: [] }];
    seedEnvironment(
      makeEnvironmentPresentation({
        connection: { phase: "error", error: "socket closed", traceId: null },
      }),
    );
    seedProject(makeProject());
    seedServerThread(threadWithTurn());
    seedGitStatus(true);
    h.localApi = { dialogs: { confirm: () => Promise.resolve(true) } };
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    (timeline["onRevertUserMessage"] as (messageId: MessageId) => void)(userMessageId);
    await Promise.resolve();
    await Promise.resolve();

    expect(commandCallsFor("thread.revertCheckpoint")).toHaveLength(0);
    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] ===
          "Reconnect Local before reverting checkpoints.",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces revert failures on the thread", async () => {
    seedRevertContext();
    h.localApi = { dialogs: { confirm: () => Promise.resolve(true) } };
    h.commandResults["thread.revertCheckpoint"] = () =>
      AsyncResult.failure(Cause.fail(new Error("revert refused")));
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    (timeline["onRevertUserMessage"] as (messageId: MessageId) => void)(userMessageId);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorWrites = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        (call.applied as Record<string, unknown>)[threadKey] === "revert refused",
    );
    expect(errorWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("opens the diff panel for a turn from the timeline", () => {
    seedRevertContext();
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    (timeline["onOpenTurnDiff"] as (turnId: TurnId, filePath?: string) => void)(
      turnId,
      "src/index.ts",
    );

    expect(
      useRightPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.some((surface) => surface.kind === "diff"),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Model / env-mode selection
// ─────────────────────────────────────────────────────────────────────

describe("ChatView model and environment selection", () => {
  it("selects a provider model and stores it as the sticky selection", () => {
    seedConnectedServerThread();
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["onProviderModelSelect"] as (instanceId: ProviderInstanceId, model: string) => void)(
      codexInstanceId,
      "gpt-5.4",
    );

    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.modelSelectionByProvider[codexInstanceId]).toMatchObject({
      instanceId: codexInstanceId,
      model: "gpt-5.4",
    });
  });

  it("blocks model changes on a started restricted session with a toast", () => {
    const restrictedCodex: ServerProvider = {
      ...codexProvider,
      requiresNewThreadForModelChange: true,
      models: [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
        { slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null },
      ],
    };
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [restrictedCodex],
          environment: { label: "Local" },
        },
      }),
    );
    seedProject(makeProject());
    seedServerThread(makeThread({ session: makeSession() }));
    seedGitStatus(true);
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["onProviderModelSelect"] as (instanceId: ProviderInstanceId, model: string) => void)(
      codexInstanceId,
      "gpt-6",
    );

    expect(h.toasts.length).toBeGreaterThanOrEqual(1);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionByProvider ?? {},
    ).toEqual({});

    // getModelDisabledReason mirrors the same restriction for the picker UI.
    const getModelDisabledReason = composer["getModelDisabledReason"] as (
      instanceId: ProviderInstanceId,
      model: string,
    ) => string | null;
    expect(getModelDisabledReason(codexInstanceId, "gpt-6")).toContain("Start a new thread");
  });

  it("silently ignores selecting a different locked provider", () => {
    const grokInstanceId = ProviderInstanceId.make("grok");
    const grokProvider: ServerProvider = {
      ...codexProvider,
      instanceId: grokInstanceId,
      driver: ProviderDriverKind.make("grok"),
      models: [{ slug: "grok-build", name: "Grok Build", isCustom: false, capabilities: null }],
    };
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [codexProvider, grokProvider],
          environment: { label: "Local" },
        },
      }),
    );
    seedProject(makeProject());
    seedServerThread(makeThread({ session: makeSession() }));
    seedGitStatus(true);
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["onProviderModelSelect"] as (instanceId: ProviderInstanceId, model: string) => void)(
      grokInstanceId,
      "grok-build",
    );

    expect(h.toasts).toHaveLength(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionByProvider ?? {},
    ).toEqual({});
  });

  it("does not render the removed branch toolbar below the composer", () => {
    seedConnectedServerThread();
    renderServerRoute();

    expect(h.capturedList.some((entry) => entry.name === "branchToolbar")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Banners, dialogs, and misc chrome
// ─────────────────────────────────────────────────────────────────────

describe("ChatView banners and dialogs", () => {
  function findButtons(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
    if (!node || typeof node !== "object") return found;
    if (Array.isArray(node)) {
      for (const child of node) findButtons(child, found);
      return found;
    }
    const element = node as ReactElement<Record<string, unknown>>;
    if (element.props && typeof element.props["onClick"] === "function") {
      found.push(element);
    }
    if (element.props && element.props["children"] !== undefined) {
      findButtons(element.props["children"] as ReactNode, found);
    }
    return found;
  }

  it("reconnects the environment from the unavailable banner and toasts failures", async () => {
    seedEnvironment(
      makeEnvironmentPresentation({
        connection: { phase: "error", error: "socket closed", traceId: null },
      }),
    );
    seedProject(makeProject());
    seedServerThread(makeThread());
    seedGitStatus(true);
    h.commandResults["environment.retryNow"] = () =>
      AsyncResult.failure(Cause.fail(new Error("still down")));
    renderServerRoute();

    const bannerStack = capturedProps<{ items: ComposerBannerStackItem[] }>("composerBannerStack");
    expect(bannerStack.items).toHaveLength(1);
    const buttons = findButtons(bannerStack.items[0]!.actions as ReactNode);
    expect(buttons.length).toBe(2);

    (buttons[0]!.props as { onClick: () => void }).onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(commandCallsFor("environment.retryNow")).toHaveLength(1);
    expect(
      h.toasts.some(
        (toast) => (toast as { title?: string }).title === "Could not reconnect environment",
      ),
    ).toBe(true);

    (buttons[1]!.props as { onClick: () => void }).onClick();
    expect(h.navigateCalls).toContainEqual({ to: "/settings/connections" });
  });

  it("dismisses the version mismatch banner persistently", () => {
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [codexProvider],
          environment: { label: "Local", serverVersion: "0.0.0-mismatch" },
        },
      }),
    );
    seedProject(makeProject());
    seedServerThread(makeThread());
    seedGitStatus(true);
    renderServerRoute();

    const bannerStack = capturedProps<{ items: ComposerBannerStackItem[] }>("composerBannerStack");
    expect(bannerStack.items).toHaveLength(1);
    const item = bannerStack.items[0]!;
    expect(item.title).toBe("Client and server versions differ");
    item.onDismiss?.();

    // Dismissal is persisted, so a fresh render no longer shows the banner.
    renderServerRoute();
    const nextStack = capturedProps<{ items: ComposerBannerStackItem[] }>("composerBannerStack");
    expect(nextStack.items).toHaveLength(0);
  });

  it("shows the scroll-to-end pill and scrolls on click", () => {
    seedConnectedServerThread();
    seedHostState("showScrollToBottom", true);

    const markup = renderServerRoute();
    expect(markup).toContain("Scroll to end");

    const list = installLegendList();
    // The pill's onClick is on a real <button>; drive scrollToEnd through the
    // captured timeline live-follow instead.
    const timeline = capturedProps("messagesTimeline");
    (timeline["onIsAtEndChange"] as (isAtEnd: boolean) => void)(false);
    (timeline["onIsAtEndChange"] as (isAtEnd: boolean) => void)(true);
    expect(list).toBeDefined();
  });

  it("renders the expanded image dialog from seeded state and closes it", () => {
    seedConnectedServerThread();
    seedHostState("expandedImage", {
      images: [{ src: "blob:image-1", alt: "img" }],
      index: 0,
    });

    const markup = renderServerRoute();
    expect(markup).toContain('data-mock="expanded-image-dialog"');

    const dialog = capturedProps("expandedImageDialog");
    (dialog["onClose"] as () => void)();
    const closes = setStateCallsFor("expandedImage");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.applied).toBeNull();
  });

  it("expands timeline images through the timeline callback", () => {
    seedConnectedServerThread();
    renderServerRoute();

    const timeline = capturedProps("messagesTimeline");
    (timeline["onImageExpand"] as (preview: unknown) => void)({
      images: [{ src: "blob:image-2" }],
      index: 0,
    });

    const expands = setStateCallsFor("expandedImage");
    expect(expands).toHaveLength(1);
  });

  it("opens the pull request dialog flow and prepares a draft thread", async () => {
    seedConnectedServerThread();
    seedProject(makeProject({ defaultModelSelection: null }));
    const capabilityRichCodexProvider: ServerProvider = {
      ...codexProvider,
      models: [
        {
          ...codexProvider.models[0]!,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "medium", label: "Medium", isDefault: true },
                  { id: "high", label: "High" },
                ],
                currentValue: "medium",
              },
              {
                id: "serviceTier",
                label: "Service tier",
                type: "select",
                options: [
                  { id: "default", label: "Default", isDefault: true },
                  { id: "fast", label: "Fast" },
                ],
                currentValue: "default",
              },
            ],
          },
        },
      ],
    };
    seedEnvironment(
      makeEnvironmentPresentation({
        serverConfig: {
          providers: [capabilityRichCodexProvider],
          environment: { label: "Local" },
        },
      }),
    );
    h.settings = {
      ...h.settings,
      providerSessionDefaults: {
        codex: {
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
    };
    seedHostState("pullRequestDialogState", { initialReference: "octo/repo#42", key: 7 });

    const markup = renderServerRoute();
    expect(markup).toContain('data-mock="pull-request-thread-dialog"');

    const dialog = capturedProps("pullRequestThreadDialog");
    expect(dialog["initialReference"]).toBe("octo/repo#42");

    // Closing resets the dialog state.
    (dialog["onOpenChange"] as (open: boolean) => void)(false);
    const dialogWrites = setStateCallsFor("pullRequestDialogState");
    expect(dialogWrites.some((call) => call.applied === null)).toBe(true);

    // Preparing hands off to a fresh draft thread and navigates to it.
    await (
      dialog["onPrepared"] as (input: {
        branch: string;
        worktreePath: string | null;
      }) => Promise<void>
    )({ branch: "pr-branch", worktreePath: null });

    expect(h.navigateCalls.length).toBeGreaterThanOrEqual(1);
    const navigateCall = h.navigateCalls[0] as {
      to: string;
      params: { draftId: ReturnType<typeof newDraftId> };
    };
    expect(navigateCall.to).toBe("/draft/$draftId");
    expect(draftModelSelection(navigateCall.params.draftId, codexInstanceId)).toEqual({
      instanceId: codexInstanceId,
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
  });

  it("reuses a stored draft session for pull request checkout when one exists", async () => {
    seedConnectedServerThread();
    const project = makeProject();
    const logicalKey = deriveLogicalProjectKeyFromSettings(
      project,
      selectProjectGroupingSettings(h.settings as never),
    );
    const draftId = newDraftId();
    const draftThreadId = ThreadId.make("thread-draft-9");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        logicalKey,
        scopeProjectRef(environmentId, projectId),
        draftId,
        { threadId: draftThreadId, createdAt: now, envMode: "local" },
      );
    publishSeededStoreState(useComposerDraftStore);
    seedHostState("pullRequestDialogState", { initialReference: null, key: 3 });

    renderServerRoute();
    const dialog = capturedProps("pullRequestThreadDialog");
    await (
      dialog["onPrepared"] as (input: {
        branch: string;
        worktreePath: string | null;
      }) => Promise<void>
    )({ branch: "pr-branch", worktreePath: "X:/wt" });

    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    expect(session?.worktreePath).toBe("X:/wt");
    expect(session?.envMode).toBe("worktree");
    expect(h.navigateCalls).toContainEqual({
      to: "/draft/$draftId",
      params: { draftId },
    });
  });

  it("dismisses the thread error banner", () => {
    seedConnectedServerThread(
      makeThread({ session: makeSession({ lastError: "provider exploded" }) }),
    );
    renderServerRoute();

    const banner = capturedProps("threadErrorBanner");
    expect(banner["error"]).toBe("provider exploded");

    // Raise a local error first so both updater branches run.
    const composer = capturedProps("chatComposer");
    (composer["setThreadError"] as (targetThreadId: ThreadId, error: string | null) => void)(
      threadId,
      "local boom",
    );
    const writesBeforeDismiss = h.setStateCalls.length;
    (banner["onDismiss"] as () => void)();

    const writes = h.setStateCalls.filter(
      (call) =>
        typeof call.applied === "object" &&
        call.applied !== null &&
        threadKey in (call.applied as Record<string, unknown>),
    );
    expect(
      writes.some((call) => (call.applied as Record<string, unknown>)[threadKey] === "local boom"),
    ).toBe(true);
    // Dismissing with no rendered local error takes the identity early-return
    // inside the updater (the render-time snapshot has no entry to clear).
    expect(h.setStateCalls.length).toBe(writesBeforeDismiss + 1);
  });

  it("toggles the plan sidebar from the composer controls", () => {
    seedConnectedServerThread();
    renderServerRoute();

    const composer = capturedProps("chatComposer");
    (composer["togglePlanSidebar"] as () => void)();
    expect(
      useRightPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.some((surface) => surface.kind === "plan"),
    ).toBe(true);

    (composer["togglePlanSidebar"] as () => void)();
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.isOpen).toBe(false);
  });

  it("runtime and interaction mode changes persist into the draft store", () => {
    seedConnectedServerThread();
    renderServerRoute();
    installComposerHandle();

    const composer = capturedProps("chatComposer");
    (composer["handleRuntimeModeChange"] as (mode: string) => void)("approval-required");
    (composer["toggleInteractionMode"] as () => void)();

    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.runtimeMode).toBe("approval-required");
    expect(draft?.interactionMode).toBe("plan");
  });

  it("closes a center terminal session when its tab is closed", () => {
    seedConnectedServerThread();
    useCenterPanelStore.getState().openTerminalPanel(threadRef, "terminal-42");
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const tabs = capturedProps("centerPanelTabs");
    const surfaces = useCenterPanelStore.getState().byThreadKey[threadKey]!.surfaces;
    const terminalSurface = surfaces.find((surface) => surface.kind === "terminal")!;

    (tabs["onActivate"] as (surface: unknown) => void)(terminalSurface);
    (tabs["onCloseSurface"] as (surface: unknown) => void)(terminalSurface);
    expect(
      useCenterPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.some((surface) => surface.kind === "terminal") ?? false,
    ).toBe(false);
    expect(closedTerminalIds()).toEqual(["terminal-42"]);
  });

  it("closes a center terminal session from the panel close control", () => {
    seedConnectedServerThread();
    useCenterPanelStore.getState().openTerminalPanel(threadRef, "terminal-panel");
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const panel = capturedProps("centerTerminalPanel");
    (panel["onClose"] as () => void)();

    expect(closedTerminalIds()).toEqual(["terminal-panel"]);
    expect(
      useCenterPanelStore
        .getState()
        .byThreadKey[threadKey]?.surfaces.some(
          (surface) => surface.id === "terminal:terminal-panel",
        ) ?? false,
    ).toBe(false);
  });

  it("closes only removed center terminals when closing other surfaces", () => {
    seedConnectedServerThread();
    for (const terminalId of ["terminal-left", "terminal-kept", "terminal-right"]) {
      useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
    }
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const tabs = capturedProps("centerPanelTabs");
    const kept = useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]!.surfaces.find((surface) => surface.id === "terminal:terminal-kept")!;
    (tabs["onCloseOtherSurfaces"] as (surface: typeof kept) => void)(kept);

    expect(closedTerminalIds()).toEqual(["terminal-left", "terminal-right"]);
    expect(
      useCenterPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((surface) => surface.id),
    ).toEqual([HOST_SURFACE_ID, "terminal:terminal-kept"]);
  });

  it("closes only center terminals to the right of the selected surface", () => {
    seedConnectedServerThread();
    for (const terminalId of ["terminal-left", "terminal-middle", "terminal-right"]) {
      useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
    }
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const tabs = capturedProps("centerPanelTabs");
    const selected = useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]!.surfaces.find((surface) => surface.id === "terminal:terminal-left")!;
    (tabs["onCloseSurfacesToRight"] as (surface: typeof selected) => void)(selected);

    expect(closedTerminalIds()).toEqual(["terminal-middle", "terminal-right"]);
    expect(
      useCenterPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((surface) => surface.id),
    ).toEqual([HOST_SURFACE_ID, "terminal:terminal-left"]);
  });

  it("closes every center terminal when closing all surfaces", () => {
    seedConnectedServerThread();
    for (const terminalId of ["terminal-one", "terminal-two"]) {
      useCenterPanelStore.getState().openTerminalPanel(threadRef, terminalId);
    }
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const tabs = capturedProps("centerPanelTabs");
    (tabs["onCloseAllSurfaces"] as () => void)();

    expect(closedTerminalIds()).toEqual(["terminal-one", "terminal-two"]);
    expect(useCenterPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toEqual([]);
  });

  it("does not close a terminal when dismissing a center chat surface", () => {
    seedConnectedServerThread();
    const siblingThreadId = ThreadId.make("center-chat-only");
    useCenterPanelStore.getState().openChatPanel(threadRef, siblingThreadId, "Codex");
    publishSeededStoreState(useCenterPanelStore);
    renderServerRoute();

    const tabs = capturedProps("centerPanelTabs");
    const chatSurface = useCenterPanelStore
      .getState()
      .byThreadKey[threadKey]!.surfaces.find((surface) => surface.kind === "chat")!;
    (tabs["onCloseSurface"] as (surface: typeof chatSurface) => void)(chatSurface);

    expect(commandCallsFor("terminal.close")).toHaveLength(0);
    expect(commandCallsFor("thread.delete")).toHaveLength(1);
  });
});
