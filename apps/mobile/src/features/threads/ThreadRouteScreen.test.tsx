import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string | ReadonlyArray<string> | undefined>,
  routerPush: [] as Array<unknown>,
  routerReplace: [] as Array<unknown>,
  workspaceState: { isLoadingConnections: false } as Record<string, unknown>,
  connectionState: "available" as string,
  onReconnectCalls: [] as Array<unknown>,
  selectedThread: null as unknown,
  selectedThreadProject: null as unknown,
  selectedEnvironmentConnection: null as unknown,
  detailState: null as unknown,
  selectedThreadCwd: null as string | null,
  composer: {} as Record<string, unknown>,
  gitState: { gitOperationLabel: null } as Record<string, unknown>,
  gitActions: {} as Record<string, unknown>,
  requests: {} as Record<string, unknown>,
  routeEnvironmentRuntime: null as unknown,
  knownTerminalSessions: [] as Array<unknown>,
  gitActionProgress: null as unknown,
  gitStatusView: { data: null, error: null, isPending: false, refresh: () => {} } as Record<
    string,
    unknown
  >,
  interruptCalls: [] as Array<unknown>,
  stagedLaunches: [] as Array<unknown>,
  detailProps: [] as Array<Record<string, unknown>>,
  gitControlsProps: [] as Array<Record<string, unknown>>,
  drawerProps: [] as Array<Record<string, unknown>>,
  overlayProps: [] as Array<Record<string, unknown>>,
  screenOptions: [] as Array<Record<string, unknown>>,
  pressables: [] as Array<Record<string, unknown>>,
  markers: { interruptTurn: { marker: "interrupt-turn" } },
}));

vi.mock("expo-router", () => {
  const Stack = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  Stack.Screen = (props: { readonly options?: Record<string, unknown> }) => {
    h.screenOptions.push(props.options ?? {});
    return null;
  };
  return {
    Stack,
    useRouter: () => ({
      push: (target: unknown) => {
        h.routerPush.push(target);
      },
      replace: (target: unknown) => {
        h.routerReplace.push(target);
      },
    }),
    useLocalSearchParams: () => h.params,
  };
});

vi.mock("react-native", () => ({
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return <button type="button">{props.children}</button>;
  },
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Text: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#123456",
}));

vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: { readonly title: string; readonly detail?: string }) => (
    <div data-empty-state="true">
      {props.title}::{props.detail ?? ""}
    </div>
  ),
}));

vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: (props: { readonly message: string }) => (
    <div data-loading="true">{props.message}</div>
  ),
}));

vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: h.workspaceState }),
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectionState: h.connectionState }),
  useRemoteConnections: () => ({
    onReconnectEnvironment: (environmentId: unknown) => {
      h.onReconnectCalls.push(environmentId);
    },
  }),
  useRemoteEnvironmentRuntime: () => h.routeEnvironmentRuntime,
}));

vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: h.selectedThread,
    selectedThreadProject: h.selectedThreadProject,
    selectedEnvironmentConnection: h.selectedEnvironmentConnection,
  }),
}));

vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetailState: () => h.detailState,
}));

vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: h.selectedThreadCwd }),
}));

vi.mock("../../state/use-thread-composer-state", () => ({
  useThreadComposerState: () => h.composer,
}));

vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => h.gitState,
}));

vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => h.gitActions,
}));

vi.mock("../../state/use-selected-thread-requests", () => ({
  useSelectedThreadRequests: () => h.requests,
}));

vi.mock("../../state/use-terminal-session", () => ({
  useKnownTerminalSessions: () => h.knownTerminalSessions,
}));

vi.mock("../../state/use-vcs-action-state", () => ({
  dismissGitActionResult: () => {},
  useGitActionProgress: () => h.gitActionProgress,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (value: unknown) => {
    if (command === h.markers.interruptTurn) {
      h.interruptCalls.push(value);
      return Promise.resolve(undefined);
    }
    throw new Error("unexpected atom command");
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => h.gitStatusView,
}));

vi.mock("../../state/vcs", () => ({
  vcsEnvironment: {
    status: (args: unknown) => ({ kind: "vcs-status", args }),
  },
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    interruptTurn: h.markers.interruptTurn,
  },
}));

vi.mock("../terminal/terminalLaunchContext", () => ({
  resolvePreferredThreadWorktreePath: (input: {
    readonly threadShellWorktreePath: string | null;
    readonly threadDetailWorktreePath: string | null;
  }) => input.threadShellWorktreePath ?? input.threadDetailWorktreePath ?? null,
  stagePendingTerminalLaunch: (payload: unknown) => {
    h.stagedLaunches.push(payload);
  },
}));

vi.mock("../terminal/terminalDebugLog", () => ({
  terminalDebugLog: () => {},
}));

vi.mock("./GitActionProgressOverlay", () => ({
  GitActionProgressOverlay: (props: Record<string, unknown>) => {
    h.overlayProps.push(props);
    return <div data-overlay="true" />;
  },
}));

vi.mock("./ThreadDetailScreen", () => ({
  ThreadDetailScreen: (props: Record<string, unknown>) => {
    h.detailProps.push(props);
    return <div data-thread-detail="true" />;
  },
}));

vi.mock("./ThreadGitControls", () => ({
  ThreadGitControls: (props: Record<string, unknown>) => {
    h.gitControlsProps.push(props);
    return <div data-git-controls="true" />;
  },
}));

vi.mock("./ThreadNavigationDrawer", () => ({
  ThreadNavigationDrawer: (props: Record<string, unknown>) => {
    h.drawerProps.push(props);
    return <div data-drawer="true" />;
  },
}));

import { ThreadRouteScreen } from "./ThreadRouteScreen";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = "env-1";
const THREAD = "thread-1";

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: ENV,
    id: THREAD,
    title: "My Thread",
    branch: "feature/x",
    modelSelection: "sonnet",
    runtimeMode: "cloud",
    interactionMode: "chat",
    session: { status: "idle", activeTurnId: null },
    worktreePath: "/repo/worktree",
    ...overrides,
  };
}

function detailState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: Option.none(),
    error: Option.none(),
    status: "ready",
    ...overrides,
  };
}

function render(element: ReactElement): string {
  h.pressables.length = 0;
  h.screenOptions.length = 0;
  h.detailProps.length = 0;
  h.gitControlsProps.length = 0;
  h.drawerProps.length = 0;
  h.overlayProps.length = 0;
  h.routerPush.length = 0;
  h.routerReplace.length = 0;
  h.interruptCalls.length = 0;
  h.stagedLaunches.length = 0;
  h.onReconnectCalls.length = 0;
  return renderToStaticMarkup(element);
}

function detail(): Record<string, unknown> {
  return h.detailProps[0] ?? {};
}
function gitControls(): Record<string, unknown> {
  return h.gitControlsProps[0] ?? {};
}
function drawer(): Record<string, unknown> {
  return h.drawerProps[0] ?? {};
}

beforeEach(() => {
  h.params = { environmentId: ENV, threadId: THREAD };
  h.workspaceState = { isLoadingConnections: false };
  h.connectionState = "available";
  h.selectedThread = thread();
  h.selectedThreadProject = { title: "Repo", workspaceRoot: "/repo", scripts: [] };
  h.selectedEnvironmentConnection = { environmentLabel: "Local" };
  h.detailState = detailState();
  h.selectedThreadCwd = "/repo/worktree";
  h.composer = {
    modelSelection: null,
    runtimeMode: null,
    interactionMode: null,
    selectedThreadFeed: [],
    activeWorkStartedAt: null,
    draftMessage: "",
    draftAttachments: [],
    activeThreadBusy: false,
    selectedThreadQueueCount: 0,
    onChangeDraftMessage: () => {},
    onPickDraftImages: () => {},
    onNativePasteImages: () => {},
    onRemoveDraftImage: () => {},
    onSendMessage: () => {},
    onUpdateModelSelection: () => {},
    onUpdateRuntimeMode: () => {},
    onUpdateInteractionMode: () => {},
  };
  h.gitState = { gitOperationLabel: null };
  h.gitActions = {
    onPullSelectedThreadBranch: () => {},
    onRunSelectedThreadGitAction: () => {},
  };
  h.requests = {
    activePendingApproval: null,
    respondingApprovalId: null,
    activePendingUserInput: null,
    activePendingUserInputDrafts: {},
    activePendingUserInputAnswers: {},
    respondingUserInputId: null,
    onRespondToApproval: () => {},
    onSelectUserInputOption: () => {},
    onChangeUserInputCustomAnswer: () => {},
    onSubmitUserInput: () => {},
  };
  h.routeEnvironmentRuntime = null;
  h.knownTerminalSessions = [];
  h.gitActionProgress = null;
  h.gitStatusView = { data: null, error: null, isPending: false, refresh: () => {} };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ThreadRouteScreen: hydration guards", () => {
  it("shows the opening loader when the environment param is missing", () => {
    h.params = { threadId: THREAD };
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain("Opening thread");
  });

  it("shows the opening loader when the thread param is missing", () => {
    h.params = { environmentId: ENV };
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain("Opening thread");
  });

  it("shows the opening loader when the thread is still hydrating connections", () => {
    h.selectedThread = null;
    h.workspaceState = { isLoadingConnections: true };
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain("Opening thread");
  });

  it("shows the opening loader when the route connection is reconnecting", () => {
    h.selectedThread = null;
    h.routeEnvironmentRuntime = { connectionState: "reconnecting", connectionError: null };
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain("Opening thread");
  });

  it("shows the unavailable empty state when the thread cannot be found", () => {
    h.selectedThread = null;
    h.workspaceState = { isLoadingConnections: false };
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain("Thread unavailable");
    expect(markup).toContain("not available in the current mobile snapshot");
  });
});

describe("ThreadRouteScreen: full render", () => {
  it("renders the thread detail, git controls, overlay, and drawer", () => {
    const markup = render(<ThreadRouteScreen />);
    expect(markup).toContain('data-thread-detail="true"');
    expect(markup).toContain('data-git-controls="true"');
    expect(markup).toContain('data-overlay="true"');
    expect(markup).toContain('data-drawer="true"');

    // git action handlers are wired straight through
    expect(gitControls().onPull).toBe(h.gitActions.onPullSelectedThreadBranch);
    expect(gitControls().onRunAction).toBe(h.gitActions.onRunSelectedThreadGitAction);
  });

  it("renders the header title with the thread title and subtitle", () => {
    render(<ThreadRouteScreen />);
    const options = h.screenOptions.find((entry) => entry.headerTitle);
    const headerTitle = options?.headerTitle as () => ReactElement;
    const titleMarkup = renderToStaticMarkup(headerTitle());
    expect(titleMarkup).toContain("My Thread");
    expect(titleMarkup).toContain("Repo");
    expect(titleMarkup).toContain("Local");

    // the header title press target carries an onLongPress rename hook
    const longPress = h.pressables.find((entry) => typeof entry.onLongPress === "function");
    (longPress!.onLongPress as () => void)();
  });

  it("uses the route runtime connection state and server config when present", () => {
    h.routeEnvironmentRuntime = {
      connectionState: "connected",
      connectionError: "prior error",
      serverConfig: { id: "server-1" },
    };
    render(<ThreadRouteScreen />);
    expect(detail().serverConfig).toEqual({ id: "server-1" });
    expect(detail().connectionError).toBe("prior error");
  });

  it("merges composer draft settings over the selected thread", () => {
    h.composer = {
      ...h.composer,
      modelSelection: "opus",
      runtimeMode: "local",
      interactionMode: "plan",
    };
    render(<ThreadRouteScreen />);
    const passedThread = detail().selectedThread as Record<string, unknown>;
    expect(passedThread.modelSelection).toBe("opus");
    expect(passedThread.runtimeMode).toBe("local");
    expect(passedThread.interactionMode).toBe("plan");
  });
});

describe("ThreadRouteScreen: navigation handlers", () => {
  it("opens the connection editor and the drawer", () => {
    render(<ThreadRouteScreen />);
    (detail().onOpenConnectionEditor as () => void)();
    expect(h.routerPush).toContainEqual("/connections");

    // opening the drawer runs its state setter without throwing
    (detail().onOpenDrawer as () => void)();
  });

  it("reconnects the environment", () => {
    render(<ThreadRouteScreen />);
    (detail().onReconnectEnvironment as () => void)();
    expect(h.onReconnectCalls).toEqual([ENV]);
  });

  it("navigates the drawer selection, close, and new task actions", () => {
    render(<ThreadRouteScreen />);
    (drawer().onStartNewTask as () => void)();
    expect(h.routerPush).toContainEqual("/new");

    (drawer().onClose as () => void)();

    (drawer().onSelectThread as (input: unknown) => void)({
      environmentId: ENV,
      id: "thread-2",
    });
    expect(h.routerReplace[0]).toBe(`/threads/${ENV}/thread-2`);
  });
});

describe("ThreadRouteScreen: stop thread", () => {
  it("interrupts a running turn including the active turn id", () => {
    h.selectedThread = thread({
      session: { status: "running", activeTurnId: "turn-9" },
    });
    render(<ThreadRouteScreen />);
    (detail().onStopThread as () => void)();
    expect(h.interruptCalls).toEqual([
      { environmentId: ENV, input: { threadId: THREAD, turnId: "turn-9" } },
    ]);
  });

  it("interrupts a starting turn without an active turn id", () => {
    h.selectedThread = thread({
      session: { status: "starting", activeTurnId: null },
    });
    render(<ThreadRouteScreen />);
    (detail().onStopThread as () => void)();
    expect(h.interruptCalls).toEqual([{ environmentId: ENV, input: { threadId: THREAD } }]);
  });

  it("does nothing when the session is idle", () => {
    h.selectedThread = thread({ session: { status: "idle", activeTurnId: null } });
    render(<ThreadRouteScreen />);
    (detail().onStopThread as () => void)();
    expect(h.interruptCalls).toEqual([]);
  });
});

describe("ThreadRouteScreen: terminal handlers", () => {
  it("opens an existing terminal for the thread", () => {
    render(<ThreadRouteScreen />);
    (gitControls().onOpenTerminal as (id?: string | null) => void)("term-5");
    const pushed = h.routerPush[0] as { pathname: string; params: Record<string, unknown> };
    expect(pushed.pathname).toBe("/threads/[environmentId]/[threadId]/terminal");
    expect(pushed.params).toMatchObject({
      environmentId: ENV,
      threadId: THREAD,
      terminalId: "term-5",
    });
  });

  it("opens a new terminal for the thread", () => {
    render(<ThreadRouteScreen />);
    (gitControls().onOpenNewTerminal as () => void)();
    const pushed = h.routerPush[0] as { pathname: string };
    expect(pushed.pathname).toBe("/threads/[environmentId]/[threadId]/terminal");
  });

  it("stages and launches a project script terminal", async () => {
    render(<ThreadRouteScreen />);
    await (gitControls().onRunProjectScript as (script: unknown) => Promise<void>)({
      id: "script-1",
      command: "pnpm dev",
    });
    expect(h.stagedLaunches).toHaveLength(1);
    const launch = h.stagedLaunches[0] as { launch: { initialInput: string } };
    expect(launch.launch.initialInput).toBe("pnpm dev\r");
    const pushed = h.routerPush.at(-1) as { pathname: string };
    expect(pushed.pathname).toBe("/threads/[environmentId]/[threadId]/terminal");
  });

  it("aborts terminal handlers when the project has no workspace root", async () => {
    h.selectedThreadProject = { title: "Repo", workspaceRoot: null, scripts: [] };
    render(<ThreadRouteScreen />);

    (gitControls().onOpenTerminal as () => void)();
    (gitControls().onOpenNewTerminal as () => void)();
    await (gitControls().onRunProjectScript as (script: unknown) => Promise<void>)({
      id: "script-1",
      command: "pnpm dev",
    });

    expect(h.routerPush).toEqual([]);
    expect(h.stagedLaunches).toEqual([]);
  });
});

describe("ThreadRouteScreen: detail presentation", () => {
  it("passes a resolved detail when present", () => {
    h.detailState = detailState({
      data: Option.some({ worktreePath: "/repo/detail-worktree" }),
      status: "ready",
    });
    render(<ThreadRouteScreen />);
    expect(detail().selectedThread).toBeDefined();
    expect(detail().environmentId).toBe(ENV);
  });

  it("reflects a deleted detail status in the content presentation", () => {
    h.detailState = detailState({
      data: Option.none(),
      error: Option.some("gone"),
      status: "deleted",
    });
    render(<ThreadRouteScreen />);
    expect(detail().contentPresentation).toBeDefined();
  });
});
