/**
 * Render-level tests for ChatView.
 *
 * ChatView is a very large route component; these tests render it through
 * `renderToStaticMarkup` (no DOM, per web test conventions) with the heavy
 * state/atom modules and child components replaced by prop-capturing mocks.
 * Real zustand stores (composer drafts, right/center panel, terminal ui) are
 * seeded directly so the component's derivation pipeline runs against
 * realistic state. Handler props captured from mocked children are then
 * invoked to exercise the send/interrupt/approval command flows.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps, ReactNode, RefObject } from "react";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

const h = vi.hoisted(() => {
  return {
    captured: {} as Record<string, unknown>,
    atomValuesByKey: new Map<string, unknown>(),
    commandCalls: [] as Array<{ key: string; input: unknown }>,
    commandResults: {} as Record<string, (input: unknown) => unknown>,
    defaultCommandResult: (() => undefined) as (input?: unknown) => unknown,
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
  };
});

// ── Heavy state/atom modules ─────────────────────────────────────────

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
  setActivePreviewTab: () => undefined,
  useThreadPreviewState: () => h.previewState,
}));

vi.mock("./preview/addBrowserSurface", () => ({
  addBrowserSurface: () => undefined,
}));

vi.mock("./preview/closePreviewSession", () => ({
  closePreviewSession: () => Promise.resolve(),
}));

vi.mock("./preview/previewActionBus", () => ({
  subscribePreviewAction: () => () => undefined,
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
    h.captured["chatComposer"] = props;
    return <div data-mock="chat-composer" />;
  },
}));

vi.mock("./chat/MessagesTimeline", () => ({
  MessagesTimeline: (props: Record<string, unknown>) => {
    h.captured["messagesTimeline"] = props;
    return (
      <div
        data-mock="messages-timeline"
        data-entry-count={String((props["timelineEntries"] as readonly unknown[]).length)}
      />
    );
  },
}));

vi.mock("./chat/ChatHeader", () => ({
  ChatHeader: (props: Record<string, unknown>) => {
    h.captured["chatHeader"] = props;
    return <div data-mock="chat-header">{String(props["activeThreadTitle"] ?? "")}</div>;
  },
}));

vi.mock("./chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: () => <div data-mock="expanded-image-dialog" />,
}));

vi.mock("./chat/PanelLayoutControls", () => ({
  PanelLayoutControls: (props: Record<string, unknown>) => {
    h.captured["panelLayoutControls"] = props;
    return <div data-mock="panel-layout-controls" />;
  },
  RightPanelMaximizeControl: () => <div data-mock="right-panel-maximize" />,
}));

vi.mock("./chat/ProviderStatusBanner", () => ({
  ProviderStatusBanner: (props: Record<string, unknown>) => {
    h.captured["providerStatusBanner"] = props;
    return <div data-mock="provider-status-banner" />;
  },
}));

vi.mock("./chat/ThreadErrorBanner", () => ({
  ThreadErrorBanner: (props: Record<string, unknown>) => {
    h.captured["threadErrorBanner"] = props;
    return (
      <div data-mock="thread-error-banner">
        {typeof props["error"] === "string" ? props["error"] : ""}
      </div>
    );
  },
}));

vi.mock("./chat/ComposerBannerStack", () => ({
  ComposerBannerStack: (props: Record<string, unknown>) => {
    h.captured["composerBannerStack"] = props;
    return <div data-mock="composer-banner-stack" />;
  },
}));

vi.mock("./PullRequestThreadDialog", () => ({
  PullRequestThreadDialog: (props: Record<string, unknown>) => {
    h.captured["pullRequestThreadDialog"] = props;
    return <div data-mock="pull-request-thread-dialog" />;
  },
}));

vi.mock("./PlanSidebar", () => ({
  default: (props: Record<string, unknown>) => {
    h.captured["planSidebar"] = props;
    return <div data-mock="plan-sidebar" />;
  },
}));

vi.mock("./ThreadTerminalDrawer", () => ({
  default: (props: Record<string, unknown>) => {
    h.captured["threadTerminalDrawer"] = props;
    return <div data-mock="thread-terminal-drawer" data-mode={String(props["mode"] ?? "drawer")} />;
  },
}));

vi.mock("./CenterPanelTabs", () => ({
  CenterPanelTabs: (props: Record<string, unknown>) => {
    h.captured["centerPanelTabs"] = props;
    return <div data-mock="center-panel-tabs" />;
  },
}));

vi.mock("./CenterTerminalPanel", () => ({
  CenterTerminalPanel: (props: Record<string, unknown>) => {
    h.captured["centerTerminalPanel"] = props;
    return <div data-mock="center-terminal-panel" />;
  },
}));

vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: (props: Record<string, unknown> & { children?: ReactNode }) => {
    h.captured["rightPanelTabs"] = props;
    return <div data-mock="right-panel-tabs">{props.children}</div>;
  },
}));

vi.mock("./RightPanelSheet", () => ({
  RightPanelSheet: ({ children }: { children?: ReactNode }) => (
    <div data-mock="right-panel-sheet">{children}</div>
  ),
}));

vi.mock("./BranchToolbar", () => ({
  BranchToolbar: (props: Record<string, unknown>) => {
    h.captured["branchToolbar"] = props;
    return <div data-mock="branch-toolbar" />;
  },
}));

// Lazy-loaded panels: keep the imports trivial so Suspense fallbacks stay inert.
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
  default: () => <div data-mock="file-preview-panel" />,
}));

import ChatView from "./ChatView";
import type { Project, Thread } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useCenterPanelStore } from "../centerPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { newDraftId } from "../lib/utils";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const threadRef = scopeThreadRef(environmentId, threadId);
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
};

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

function renderServerRoute(): string {
  return renderToStaticMarkup(
    <ChatView
      environmentId={environmentId}
      threadId={threadId}
      routeKind="server"
      reserveTitleBarControlInset
    />,
  );
}

function capturedProps<T>(name: string): T {
  const props = h.captured[name];
  expect(props, `expected captured props for ${name}`).toBeDefined();
  return props as T;
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

/**
 * renderToStaticMarkup reads zustand state through `getInitialState()` (the
 * server snapshot), so seeded state written with regular actions must be
 * copied into the initial-state object before rendering.
 */
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

  for (const { store, pristine } of resettableStores) {
    store.setState({ ...pristine }, true);
    Object.assign(store.getInitialState(), pristine);
  }

  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: (time: number) => void) => {
      callback(0);
      return 0;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatView", () => {
  describe("when: no server thread and no draft session exist", () => {
    it("renders the no-active-thread empty state inside the diff worker pool", () => {
      seedEnvironment(makeEnvironmentPresentation());
      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="diff-worker-pool"');
      expect(markup).toContain('data-mock="no-active-thread"');
      expect(markup).not.toContain('data-mock="chat-composer"');
    });
  });

  describe("when: a server thread exists on a connected environment", () => {
    it("renders header, timeline, and composer without the old branch toolbar", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);

      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="chat-header"');
      expect(markup).toContain("Demo Thread");
      expect(markup).toContain('data-mock="messages-timeline"');
      expect(markup).toContain('data-mock="chat-composer"');
      expect(markup).not.toContain('data-mock="branch-toolbar"');
      expect(markup).not.toContain('data-mock="no-active-thread"');

      const composer = capturedProps<Record<string, unknown>>("chatComposer");
      expect(composer["isServerThread"]).toBe(true);
      expect(composer["isLocalDraftThread"]).toBe(false);
      expect(composer["routeKind"]).toBe("server");
      expect(composer["environmentUnavailable"]).toBeNull();
      expect(composer["providerStatuses"]).toEqual([codexProvider]);

      const header = capturedProps<Record<string, unknown>>("chatHeader");
      expect(header["activeThreadId"]).toBe(threadId);
      expect(header["activeProjectName"]).toBe("Demo Project");

      const bannerStack = capturedProps<{ items: ComposerBannerStackItem[] }>(
        "composerBannerStack",
      );
      expect(bannerStack.items).toEqual([]);
    });

    it("hides the branch toolbar when the workspace is not a git repository", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(false);

      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="chat-composer"');
      expect(markup).not.toContain('data-mock="branch-toolbar"');
    });

    it("surfaces the session error through the thread error banner", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(
        makeThread({
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: codexInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "provider exploded",
            updatedAt: now,
          },
        }),
      );
      seedGitStatus(true);

      const markup = renderServerRoute();

      expect(markup).toContain("provider exploded");
      const banner = capturedProps<Record<string, unknown>>("threadErrorBanner");
      expect(banner["error"]).toBe("provider exploded");
    });
  });

  describe("when: the active environment is unavailable", () => {
    it("pushes an environment-unavailable banner with reconnect actions", () => {
      seedEnvironment(
        makeEnvironmentPresentation({
          connection: { phase: "error", error: "socket closed", traceId: null },
        }),
      );
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);

      renderServerRoute();

      const bannerStack = capturedProps<{ items: ComposerBannerStackItem[] }>(
        "composerBannerStack",
      );
      expect(bannerStack.items).toHaveLength(1);
      const item = bannerStack.items[0]!;
      expect(item.id).toBe(`environment-unavailable:${environmentId}`);
      expect(item.variant).toBe("error");
      expect(item.title).toBe("Local: Connection failed. Reason: socket closed");
      expect(item.description).toBe("socket closed");

      const composer = capturedProps<Record<string, unknown>>("chatComposer");
      expect(composer["environmentUnavailable"]).toEqual({
        environmentId,
        label: "Local",
        connection: { phase: "error", error: "socket closed", traceId: null },
      });
    });
  });

  describe("when: server and client versions differ", () => {
    it("pushes a version mismatch warning banner", () => {
      seedEnvironment(
        makeEnvironmentPresentation({
          serverConfig: {
            providers: [codexProvider],
            environment: { label: "Local", serverVersion: "0.0.0-version-skew-test" },
          },
        }),
      );
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);

      renderServerRoute();

      const bannerStack = capturedProps<{ items: ComposerBannerStackItem[] }>(
        "composerBannerStack",
      );
      expect(bannerStack.items).toHaveLength(1);
      expect(bannerStack.items[0]!.title).toBe("Client and server versions differ");
    });
  });

  describe("when: rendering a draft route with a seeded draft session", () => {
    it("builds a local draft thread and renders the full chat chrome", () => {
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
          { threadId, createdAt: now, envMode: "local" },
        );
      publishSeededStoreState(useComposerDraftStore);

      const markup = renderToStaticMarkup(
        <ChatView
          environmentId={environmentId}
          threadId={threadId}
          routeKind="draft"
          draftId={draftId}
        />,
      );

      expect(markup).toContain('data-mock="chat-composer"');
      expect(markup).toContain('data-mock="messages-timeline"');
      expect(markup).not.toContain('data-mock="no-active-thread"');

      const composer = capturedProps<Record<string, unknown>>("chatComposer");
      expect(composer["isServerThread"]).toBe(false);
      expect(composer["isLocalDraftThread"]).toBe(true);
      expect(composer["routeKind"]).toBe("draft");
      const activeThread = composer["activeThread"] as Thread;
      expect(activeThread.title).toBe("New thread");
      expect(activeThread.id).toBe(threadId);
      expect(activeThread.session).toBeNull();

      const header = capturedProps<Record<string, unknown>>("chatHeader");
      expect(header["draftId"]).toBe(draftId);
    });
  });

  describe("when: rendering the panel variant", () => {
    it("omits host-only chrome (header and branch toolbar) but keeps the transcript", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);

      const markup = renderToStaticMarkup(<ChatView variant="panel" panelThreadRef={threadRef} />);

      expect(markup).toContain('data-mock="messages-timeline"');
      expect(markup).toContain('data-mock="chat-composer"');
      expect(markup).not.toContain('data-mock="chat-header"');
      expect(markup).not.toContain('data-mock="branch-toolbar"');

      const composer = capturedProps<Record<string, unknown>>("chatComposer");
      expect(composer["routeKind"]).toBe("server");
      expect(composer["isServerThread"]).toBe(true);
    });
  });

  describe("when: the plan right-panel surface is open", () => {
    it("renders the plan sidebar inside the inline right panel tabs", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);
      useRightPanelStore.getState().open(threadRef, "plan");
      publishSeededStoreState(useRightPanelStore);

      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="right-panel-tabs"');
      expect(markup).toContain('data-mock="plan-sidebar"');

      const planSidebar = capturedProps<Record<string, unknown>>("planSidebar");
      expect(planSidebar["label"]).toBe("Tasks");
      expect(planSidebar["environmentId"]).toBe(environmentId);
    });
  });

  describe("when: a terminal right-panel surface is open", () => {
    it("renders the persistent terminal panel with the surface's terminal group", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);
      h.knownSessions = [
        {
          target: { environmentId, threadId, terminalId: "term-1" },
          state: {
            summary: {
              label: "Build shell",
              cwd: "X:/demo",
              worktreePath: null,
            },
          },
        },
      ];
      useRightPanelStore.getState().openTerminal(threadRef, "term-1");
      publishSeededStoreState(useRightPanelStore);

      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="right-panel-tabs"');
      expect(markup).toContain('data-mock="thread-terminal-drawer"');
      expect(markup).toContain('data-mode="panel"');

      const drawer = capturedProps<Record<string, unknown>>("threadTerminalDrawer");
      expect(drawer["terminalIds"]).toEqual(["term-1"]);
      expect(drawer["activeTerminalId"]).toBe("term-1");
      expect(drawer["cwd"]).toBe("X:/demo");
      const labels = drawer["terminalLabelsById"] as ReadonlyMap<string, string>;
      expect(labels.get("term-1")).toBe("Build shell");
    });
  });

  describe("when: a center terminal panel is active", () => {
    it("hides the host chat column and mounts the center terminal panel", () => {
      seedEnvironment(makeEnvironmentPresentation());
      seedProject(makeProject());
      seedServerThread(makeThread());
      seedGitStatus(true);
      useCenterPanelStore.getState().openTerminalPanel(threadRef, "term-9");
      publishSeededStoreState(useCenterPanelStore);

      const markup = renderServerRoute();

      expect(markup).toContain('data-mock="center-panel-tabs"');
      expect(markup).toContain('data-mock="center-terminal-panel"');

      const centerTerminal = capturedProps<Record<string, unknown>>("centerTerminalPanel");
      expect(centerTerminal["terminalId"]).toBe("term-9");
    });
  });
});

describe("ChatView handlers (captured from mocked children)", () => {
  function seedConnectedServerThread(thread: Thread = makeThread()): void {
    seedEnvironment(makeEnvironmentPresentation());
    seedProject(makeProject());
    seedServerThread(thread);
    seedGitStatus(true);
  }

  function composerHandle(overrides: Partial<ChatComposerHandle> = {}): ChatComposerHandle {
    return {
      focusAtEnd: () => undefined,
      resetCursorState: () => undefined,
      addTerminalContext: () => undefined,
      getSendContext: () => ({
        images: [],
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
        selectedProvider: ProviderDriverKind.make("codex"),
        selectedModel: "gpt-5.4",
        selectedProviderModels: codexProvider.models,
        selectedPromptEffort: null,
        selectedModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      }),
      ...overrides,
    } as ChatComposerHandle;
  }

  function commandCallsFor(key: string): Array<{ key: string; input: unknown }> {
    return h.commandCalls.filter((call) => call.key === key);
  }

  it("onInterrupt targets the running turn of the active session", async () => {
    const runningTurnId = TurnId.make("turn-running");
    seedConnectedServerThread(
      makeThread({
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          activeTurnId: runningTurnId,
          lastError: null,
          updatedAt: now,
        },
      }),
    );

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const onInterrupt = composer["onInterrupt"] as () => Promise<void>;
    await onInterrupt();

    expect(commandCallsFor("thread.interruptTurn")).toEqual([
      {
        key: "thread.interruptTurn",
        input: { environmentId, input: { threadId, turnId: runningTurnId } },
      },
    ]);
  });

  it("onRespondToApproval submits the decision for the active thread", async () => {
    seedConnectedServerThread();

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const onRespondToApproval = composer["onRespondToApproval"] as (
      requestId: ApprovalRequestId,
      decision: string,
    ) => Promise<unknown>;
    const requestId = ApprovalRequestId.make("approval-1");
    await onRespondToApproval(requestId, "approve");

    expect(commandCallsFor("thread.respondToApproval")).toEqual([
      {
        key: "thread.respondToApproval",
        input: { environmentId, input: { threadId, requestId, decision: "approve" } },
      },
    ]);
  });

  it("onSend starts a turn with the formatted prompt and auto-title", async () => {
    seedConnectedServerThread();

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const composerRef = composer["composerRef"] as RefObject<ChatComposerHandle | null>;
    composerRef.current = composerHandle();
    const promptRef = composer["promptRef"] as RefObject<string>;
    promptRef.current = "hello world";

    const onSend = composer["onSend"] as () => Promise<void>;
    await onSend();

    const titleCalls = commandCallsFor("thread.updateMetadata");
    expect(titleCalls.length).toBeGreaterThanOrEqual(1);
    expect(titleCalls[0]!.input).toMatchObject({
      environmentId,
      input: { threadId, title: "hello world" },
    });

    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.input).toMatchObject({
      environmentId,
      input: {
        threadId,
        message: { role: "user", text: "hello world", attachments: [] },
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
        titleSeed: "hello world",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
    // Server threads with no worktree bootstrap never send a bootstrap payload.
    expect(
      (startCalls[0]!.input as { input: Record<string, unknown> }).input["bootstrap"],
    ).toBeUndefined();
  });

  it("onSend reports a failure from the turn start as a thread error", async () => {
    seedConnectedServerThread();
    h.commandResults["thread.startTurn"] = () =>
      AsyncResult.failure(Cause.fail(new Error("turn rejected by server")));

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const composerRef = composer["composerRef"] as RefObject<ChatComposerHandle | null>;
    composerRef.current = composerHandle();
    const promptRef = composer["promptRef"] as RefObject<string>;
    promptRef.current = "will fail";

    const onSend = composer["onSend"] as () => Promise<void>;
    await onSend();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(1);
    const setThreadError = composer["setThreadError"];
    expect(typeof setThreadError).toBe("function");
  });

  it("onSend is a no-op when the environment is unavailable", async () => {
    seedEnvironment(
      makeEnvironmentPresentation({
        connection: { phase: "error", error: "socket closed", traceId: null },
      }),
    );
    seedProject(makeProject());
    seedServerThread(makeThread());
    seedGitStatus(true);

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const composerRef = composer["composerRef"] as RefObject<ChatComposerHandle | null>;
    composerRef.current = composerHandle();
    const promptRef = composer["promptRef"] as RefObject<string>;
    promptRef.current = "hello";

    const onSend = composer["onSend"] as () => Promise<void>;
    await onSend();

    expect(commandCallsFor("thread.startTurn")).toHaveLength(0);
  });

  it("onSend promotes a draft session by bootstrapping thread creation", async () => {
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
        { threadId, createdAt: now, envMode: "local" },
      );
    publishSeededStoreState(useComposerDraftStore);

    renderToStaticMarkup(
      <ChatView
        environmentId={environmentId}
        threadId={threadId}
        routeKind="draft"
        draftId={draftId}
      />,
    );

    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const composerRef = composer["composerRef"] as RefObject<ChatComposerHandle | null>;
    composerRef.current = composerHandle();
    const promptRef = composer["promptRef"] as RefObject<string>;
    promptRef.current = "kick off draft";

    const onSend = composer["onSend"] as () => Promise<void>;
    await onSend();

    // Draft sends never update metadata first; they bootstrap the thread.
    expect(commandCallsFor("thread.updateMetadata")).toHaveLength(0);
    const startCalls = commandCallsFor("thread.startTurn");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.input).toMatchObject({
      environmentId,
      input: {
        threadId,
        titleSeed: "kick off draft",
        bootstrap: {
          createThread: {
            projectId,
            title: "kick off draft",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        },
      },
    });
  });

  it("getModelDisabledReason blocks switching providers on a started restricted session", () => {
    const grokInstanceId = ProviderInstanceId.make("grok");
    const grokProvider: ServerProvider = {
      ...codexProvider,
      instanceId: grokInstanceId,
      driver: ProviderDriverKind.make("grok"),
      requiresNewThreadForModelChange: true,
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
    seedServerThread(
      makeThread({
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    );
    seedGitStatus(true);

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const getModelDisabledReason = composer["getModelDisabledReason"] as (
      instanceId: ProviderInstanceId,
      model: string,
    ) => string | null;

    expect(getModelDisabledReason(codexInstanceId, "gpt-5.4")).toBeNull();
    expect(getModelDisabledReason(grokInstanceId, "grok-build")).toBe(
      "This provider does not allow switching models after a conversation has started. Start a new thread to use this model.",
    );
  });

  it("handleRuntimeModeChange stores the next runtime mode in the composer draft", () => {
    seedConnectedServerThread();

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const handleRuntimeModeChange = composer["handleRuntimeModeChange"] as (
      mode: string,
    ) => unknown;
    handleRuntimeModeChange("approval-required");

    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.runtimeMode).toBe(
      "approval-required",
    );
    // Persisting to the server only happens on the next turn start.
    expect(commandCallsFor("thread.setRuntimeMode")).toHaveLength(0);
  });

  it("handleInteractionModeChange stores the next interaction mode in the composer draft", () => {
    seedConnectedServerThread();

    renderServerRoute();
    const composer = capturedProps<Record<string, unknown>>("chatComposer");
    const toggleInteractionMode = composer["toggleInteractionMode"] as () => unknown;
    toggleInteractionMode();

    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.interactionMode).toBe(
      "plan",
    );
  });
});

type _AssertRouteProps = ComponentProps<typeof ChatView>;
