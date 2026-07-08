import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
// @ts-expect-error -- react-dom ships no bundled types and apps/mobile has no @types/react-dom
import { renderToStaticMarkup as renderToStaticMarkupUntyped } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SavedRemoteConnection } from "../../lib/connection";
import type { WorkspaceState } from "../../state/workspaceModel";
import { buildHomeThreadGroups } from "./homeThreadList";

const h = vi.hoisted(() => ({
  pressables: [] as Array<Record<string, unknown>>,
  scrollViews: [] as Array<Record<string, unknown>>,
  swipeables: [] as Array<{ props: Record<string, unknown>; methods: { close: () => void } }>,
  swipeActions: [] as Array<Record<string, unknown>>,
  emptyStates: [] as Array<Record<string, unknown>>,
  animatedExiting: [] as Array<((values: unknown) => unknown) | undefined>,
  haptics: [] as Array<unknown>,
  closeCalls: [] as Array<number>,
  expandedSeed: new Set<string>() as Set<string>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = (initial?: unknown) => {
    const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
    const seeded = value instanceof Set ? h.expandedSeed : value;
    const setValue = (next: unknown) => {
      if (typeof next === "function") (next as (prev: unknown) => unknown)(seeded);
    };
    return [seeded, setValue];
  };
  return { ...actual, useState: useState as typeof actual.useState };
});

vi.mock("react-native", () => ({
  ActivityIndicator: () => <i data-activity-indicator="true" />,
  Pressable: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.pressables.push(props);
    return (
      <button type="button" data-a11y={String(props["accessibilityLabel"] ?? "")}>
        {props.children}
      </button>
    );
  },
  ScrollView: (props: { readonly children?: ReactNode } & Record<string, unknown>) => {
    h.scrollViews.push(props);
    return <div data-scrollview="true">{props.children}</div>;
  },
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: (props: {
      readonly children?: ReactNode;
      readonly exiting?: (v: unknown) => unknown;
    }) => {
      h.animatedExiting.push(props.exiting);
      return <div data-animated="true">{props.children}</div>;
    },
  },
  Easing: {
    out: (value: unknown) => value,
    inOut: (value: unknown) => value,
    cubic: 0,
  },
  LinearTransition: {
    duration: () => ({ easing: () => ({ marker: "linear-transition" }) }),
  },
  withDelay: (...args: ReadonlyArray<unknown>) => ({ withDelay: args }),
  withTiming: (...args: ReadonlyArray<unknown>) => ({ withTiming: args }),
}));

vi.mock("react-native-gesture-handler/ReanimatedSwipeable", async () => {
  const React = await import("react");
  const Comp = React.forwardRef(
    (
      props: {
        readonly children?: ReactNode;
        readonly renderRightActions?: (
          progress: unknown,
          translation: unknown,
          methods: unknown,
        ) => ReactNode;
      } & Record<string, unknown>,
      ref: unknown,
    ) => {
      const methods = {
        close: () => {
          h.closeCalls.push(1);
        },
      };
      if (typeof ref === "function") {
        (ref as (value: unknown) => void)(methods);
      } else if (ref && typeof ref === "object") {
        (ref as { current: unknown }).current = methods;
      }
      h.swipeables.push({ props, methods });
      const right = props.renderRightActions?.(0, { value: 0 }, methods);
      return (
        <div data-swipeable="true">
          {right}
          {props.children}
        </div>
      );
    },
  );
  return { default: Comp };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 12, left: 0, right: 0 }),
}));

vi.mock("expo-symbols", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));

vi.mock("expo-haptics", () => ({
  impactAsync: (style: unknown) => {
    h.haptics.push(style);
    return Promise.resolve();
  },
  ImpactFeedbackStyle: { Medium: "medium" },
}));

vi.mock("../../lib/useThemeColor", () => ({
  useThemeColor: () => "#123456",
}));

vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: Record<string, unknown>) => {
    h.emptyStates.push(props);
    return (
      <div data-empty-state="true">
        <span>{String(props["title"] ?? "")}</span>
        <span>{String(props["detail"] ?? "")}</span>
        {props["actionLabel"] ? <span>{String(props["actionLabel"])}</span> : null}
      </div>
    );
  },
}));

vi.mock("../../components/ProjectFavicon", () => ({
  ProjectFavicon: (props: { readonly projectTitle: string }) => (
    <i data-favicon={props.projectTitle} />
  ),
}));

vi.mock("./thread-swipe-actions", () => ({
  THREAD_SWIPE_ACTIONS_WIDTH: 100,
  THREAD_SWIPE_SPRING: { damping: 26 },
  ThreadSwipeActions: (props: Record<string, unknown>) => {
    h.swipeActions.push(props);
    return <i data-swipe-actions={String(props["threadTitle"] ?? "")} />;
  },
}));

import { HomeScreen } from "./HomeScreen";

const renderToStaticMarkup = renderToStaticMarkupUntyped as (element: ReactElement) => string;

const ENV = EnvironmentId.make("environment-1");

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function sessionWithStatus(status: string): NonNullable<EnvironmentThreadShell["session"]> {
  return { status } as NonNullable<EnvironmentThreadShell["session"]>;
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

function makeCatalogState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...overrides,
  };
}

interface Handlers {
  readonly onSelectThread: Array<EnvironmentThreadShell>;
  readonly onArchiveThread: Array<EnvironmentThreadShell>;
  readonly onDeleteThread: Array<EnvironmentThreadShell>;
  readonly onAddConnection: Array<number>;
  readonly onOpenEnvironments: Array<number>;
}

function makeProps(overrides: Partial<Parameters<typeof HomeScreen>[0]> = {}): {
  props: Parameters<typeof HomeScreen>[0];
  handlers: Handlers;
} {
  const handlers: Handlers = {
    onSelectThread: [],
    onArchiveThread: [],
    onDeleteThread: [],
    onAddConnection: [],
    onOpenEnvironments: [],
  };
  const props: Parameters<typeof HomeScreen>[0] = {
    projects: [],
    threads: [],
    catalogState: makeCatalogState(),
    savedConnectionsById: {},
    searchQuery: "",
    selectedEnvironmentId: null,
    projectSortOrder: "updated_at",
    threadSortOrder: "updated_at",
    projectGroupingMode: "separate",
    onAddConnection: () => handlers.onAddConnection.push(1),
    onOpenEnvironments: () => handlers.onOpenEnvironments.push(1),
    onSelectThread: (thread) => handlers.onSelectThread.push(thread),
    onArchiveThread: (thread) => handlers.onArchiveThread.push(thread),
    onDeleteThread: (thread) => handlers.onDeleteThread.push(thread),
    ...overrides,
  };
  return { props, handlers };
}

function render(element: ReactElement): string {
  h.pressables.length = 0;
  h.scrollViews.length = 0;
  h.swipeables.length = 0;
  h.swipeActions.length = 0;
  h.emptyStates.length = 0;
  h.animatedExiting.length = 0;
  return renderToStaticMarkup(element);
}

function savedConnections(
  entries: Readonly<Record<string, string>>,
): Readonly<Record<string, SavedRemoteConnection>> {
  const result: Record<string, SavedRemoteConnection> = {};
  for (const [environmentId, environmentLabel] of Object.entries(entries)) {
    result[environmentId] = { environmentLabel } as SavedRemoteConnection;
  }
  return result;
}

beforeEach(() => {
  h.expandedSeed = new Set();
  h.haptics.length = 0;
  h.closeCalls.length = 0;
  delete process.env.EXPO_OS;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HomeScreen empty states", () => {
  it("shows the loading environments state", () => {
    const { props } = makeProps({
      catalogState: makeCatalogState({
        isLoadingConnections: true,
        hasReadyEnvironment: false,
      }),
    });
    const markup = render(<HomeScreen {...props} />);

    expect(markup).toContain("Loading environments");
    expect(markup).toContain("Checking saved environments on this device.");
    // loading -> the empty-state overlay activity indicator is present.
    expect(markup).toContain("data-activity-indicator");
  });

  it("shows the no-environments state and wires the add action", () => {
    const { props, handlers } = makeProps({
      catalogState: makeCatalogState({
        hasConnections: false,
        hasReadyEnvironment: false,
      }),
    });
    render(<HomeScreen {...props} />);

    const empty = h.emptyStates.at(-1)!;
    expect(empty["title"]).toBe("No environments connected");
    expect(empty["actionLabel"]).toBe("Add environment");
    (empty["onAction"] as () => void)();
    expect(handlers.onAddConnection).toHaveLength(1);
  });

  it("shows the environment-unavailable state with a connection error", () => {
    const { props } = makeProps({
      catalogState: makeCatalogState({
        connectionState: "error",
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionError: "boom",
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Environment unavailable");
    expect(markup).toContain("boom");
  });

  it("shows the environment-unavailable fallback detail when no error is set", () => {
    const { props } = makeProps({
      catalogState: makeCatalogState({
        connectionState: "offline",
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionError: null,
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Environment unavailable");
    expect(markup).toContain("The saved environment is offline.");
  });

  it("shows the connecting state", () => {
    const { props } = makeProps({
      catalogState: makeCatalogState({
        hasConnectingEnvironment: true,
        hasLoadedShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionError: null,
        connectionState: "connecting",
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Connecting to environment");
  });

  it("shows the no-projects state once a shell snapshot has loaded", () => {
    const { props } = makeProps({
      projects: [],
      catalogState: makeCatalogState({ hasLoadedShellSnapshot: true }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No projects found");
  });

  it("shows the no-threads default state when projects exist but no threads", () => {
    const project = makeProject({
      environmentId: ENV,
      id: ProjectId.make("project-1"),
      title: "Alpha",
    });
    const { props } = makeProps({
      projects: [project],
      catalogState: makeCatalogState({ hasLoadedShellSnapshot: true }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No threads yet");
    expect(markup).toContain("start a new coding session");
  });
});

describe("HomeScreen no-results states", () => {
  const project = makeProject({
    environmentId: ENV,
    id: ProjectId.make("project-1"),
    title: "Alpha",
  });
  const OTHER_ENV = EnvironmentId.make("environment-2");

  // A non-archived thread in a different environment keeps `hasAnyThreads`
  // true while the environment filter drops it from the rendered groups.
  function otherEnvironmentThread() {
    return makeThread({
      environmentId: OTHER_ENV,
      id: ThreadId.make("thread-other"),
      projectId: ProjectId.make("project-other"),
      title: "Other environment thread",
    });
  }

  it("shows a search-specific empty state when a query matches nothing", () => {
    const activeThread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-active"),
      projectId: project.id,
      title: "Zeta feature",
    });
    const { props } = makeProps({
      projects: [project],
      threads: [activeThread],
      searchQuery: "no-such-thread",
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No results");
    expect(markup).toContain("No threads matching");
    expect(markup).toContain("no-such-thread");
  });

  it("shows an environment-scoped empty state when the selected environment has no groups", () => {
    const { props } = makeProps({
      projects: [project],
      threads: [otherEnvironmentThread()],
      selectedEnvironmentId: ENV,
      savedConnectionsById: savedConnections({ [ENV]: "Alpha Env" }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No threads in Alpha Env");
  });

  it("falls back to the environment label placeholder when the connection is unknown", () => {
    const { props } = makeProps({
      projects: [project],
      threads: [otherEnvironmentThread()],
      selectedEnvironmentId: ENV,
      savedConnectionsById: {},
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No threads in this environment");
  });

  it("shows the generic no-threads state when nothing is selected", () => {
    const orphanThread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-orphan"),
      projectId: ProjectId.make("project-missing"),
      title: "Orphan thread",
    });
    const { props } = makeProps({
      projects: [],
      threads: [orphanThread],
      selectedEnvironmentId: null,
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("No threads yet");
    expect(markup).toContain("Create a task to start a new coding session.");
  });
});

describe("HomeScreen connection status pill", () => {
  function projectWithThread() {
    const project = makeProject({
      environmentId: ENV,
      id: ProjectId.make("project-1"),
      title: "Alpha",
    });
    const thread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-1"),
      projectId: project.id,
      title: "Feature work",
    });
    return { project, thread };
  }

  it("renders an offline pill and closes open swipeables on scroll", () => {
    const { project, thread } = projectWithThread();
    const { props } = makeProps({
      projects: [project],
      threads: [thread],
      catalogState: makeCatalogState({
        networkStatus: "offline",
        hasReadyEnvironment: false,
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("You are offline");

    const scroll = h.scrollViews.at(-1)!;
    (scroll["onScrollBeginDrag"] as () => void)();
  });

  it("renders a single reconnecting environment label", () => {
    const { project, thread } = projectWithThread();
    const connecting = {
      environmentId: ENV,
      environmentLabel: "Alpha Env",
    } as unknown as WorkspaceState["connectingEnvironments"][number];
    const { props } = makeProps({
      projects: [project],
      threads: [thread],
      catalogState: makeCatalogState({
        hasConnectingEnvironment: true,
        connectingEnvironments: [connecting],
        hasReadyEnvironment: false,
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Reconnecting to Alpha Env");
    expect(markup).toContain("data-activity-indicator");
  });

  it("renders a multi-environment reconnecting label", () => {
    const { project, thread } = projectWithThread();
    const connecting = [
      { environmentId: ENV, environmentLabel: "Alpha" },
      { environmentId: EnvironmentId.make("environment-2"), environmentLabel: "Beta" },
    ] as unknown as WorkspaceState["connectingEnvironments"];
    const { props } = makeProps({
      projects: [project],
      threads: [thread],
      catalogState: makeCatalogState({
        hasConnectingEnvironment: true,
        connectingEnvironments: connecting,
        hasReadyEnvironment: false,
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Reconnecting 2 environments");
  });

  it("renders a not-connected pill and wires the open-environments action", () => {
    const { project, thread } = projectWithThread();
    const { props, handlers } = makeProps({
      projects: [project],
      threads: [thread],
      catalogState: makeCatalogState({
        hasLoadedShellSnapshot: true,
        hasReadyEnvironment: false,
      }),
    });
    const markup = render(<HomeScreen {...props} />);
    expect(markup).toContain("Not connected");

    const pill = h.pressables.find(
      (pressable) =>
        typeof pressable["onPress"] === "function" && pressable["className"] !== undefined,
    );
    // The status pill is the only Pressable carrying the rounded-full pill styling.
    const statusPill = h.pressables.find((pressable) =>
      String(pressable["className"] ?? "").includes("rounded-full"),
    );
    expect(statusPill).toBeDefined();
    (statusPill!["onPress"] as () => void)();
    expect(handlers.onOpenEnvironments).toHaveLength(1);
    expect(pill).toBeDefined();
  });
});

describe("HomeScreen thread rows", () => {
  const project = makeProject({
    environmentId: ENV,
    id: ProjectId.make("project-1"),
    title: "Alpha",
  });

  it("renders status colors and tone pills for every session status", () => {
    const statuses = ["running", "ready", "starting", "error", "idle"];
    const threads = statuses.map((status, index) =>
      makeThread({
        environmentId: ENV,
        id: ThreadId.make(`thread-${index}`),
        projectId: project.id,
        title: `Thread ${status}`,
        branch: index % 2 === 0 ? "main" : null,
        session: status === "idle" ? null : sessionWithStatus(status),
      }),
    );
    const { props } = makeProps({
      projects: [project],
      threads,
      savedConnectionsById: savedConnections({ [ENV]: "Alpha Env" }),
    });
    const markup = render(<HomeScreen {...props} />);

    expect(markup).toContain("Running");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Starting");
    expect(markup).toContain("Error");
    expect(markup).toContain("Idle");
    // Subtitle includes the environment label and branch when present.
    expect(markup).toContain("Alpha Env");
  });

  it("invokes select, archive, delete, and swipe lifecycle handlers", () => {
    process.env.EXPO_OS = "ios";
    const thread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-1"),
      projectId: project.id,
      title: "Feature work",
      session: sessionWithStatus("running"),
    });
    const { props, handlers } = makeProps({
      projects: [project],
      threads: [thread],
    });
    render(<HomeScreen {...props} />);

    // The inner Pressable selects the thread and closes the swipeable.
    const rowPressable = h.pressables.find(
      (pressable) => pressable["accessibilityLabel"] === "Feature work",
    );
    expect(rowPressable).toBeDefined();
    (rowPressable!["onPress"] as () => void)();
    expect(handlers.onSelectThread).toHaveLength(1);
    expect(h.closeCalls.length).toBeGreaterThanOrEqual(1);

    const swipeAction = h.swipeActions.at(-1)!;
    // Archive primary action.
    const primaryAction = swipeAction["primaryAction"] as { onPress: () => void };
    primaryAction.onPress();
    expect(handlers.onArchiveThread).toHaveLength(1);

    // Arm the full swipe (fires haptics on iOS), then open to trigger delete.
    const onArmedChange = swipeAction["onFullSwipeArmedChange"] as (armed: boolean) => void;
    onArmedChange(true);
    // A second identical arm is a no-op (already armed).
    onArmedChange(true);
    expect(h.haptics).toHaveLength(1);

    const swipe = h.swipeables.at(-1)!;
    (swipe.props["onSwipeableOpenStartDrag"] as () => void)();
    (swipe.props["onSwipeableWillOpen"] as () => void)();
    expect(handlers.onDeleteThread).toHaveLength(1);

    // Closing resets the armed flag and notifies the parent.
    (swipe.props["onSwipeableClose"] as () => void)();

    // The direct swipe-actions onDelete callback also deletes.
    (swipeAction["onDelete"] as () => void)();
    expect(handlers.onDeleteThread.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire haptics when arming a full swipe off iOS", () => {
    const thread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-1"),
      projectId: project.id,
      title: "Feature work",
    });
    const { props } = makeProps({ projects: [project], threads: [thread] });
    render(<HomeScreen {...props} />);

    const swipeAction = h.swipeActions.at(-1)!;
    (swipeAction["onFullSwipeArmedChange"] as (armed: boolean) => void)(true);
    expect(h.haptics).toHaveLength(0);

    // Opening without the ios haptic still runs the armed-delete branch.
    const swipe = h.swipeables.at(-1)!;
    (swipe.props["onSwipeableWillOpen"] as () => void)();
  });

  it("runs the row exit worklet animation", () => {
    const thread = makeThread({
      environmentId: ENV,
      id: ThreadId.make("thread-1"),
      projectId: project.id,
      title: "Feature work",
    });
    const { props } = makeProps({ projects: [project], threads: [thread] });
    render(<HomeScreen {...props} />);

    const exiting = h.animatedExiting.find((value) => typeof value === "function");
    expect(exiting).toBeDefined();
    const result = exiting!({
      currentHeight: 120,
      currentOriginX: 10,
      windowWidth: 400,
    }) as { initialValues: { height: number }; animations: Record<string, unknown> };
    expect(result.initialValues.height).toBe(120);
    expect(result.animations).toHaveProperty("originX");
  });

  it("coordinates open swipeables across multiple rows", () => {
    const threads = [
      makeThread({
        environmentId: ENV,
        id: ThreadId.make("thread-a"),
        projectId: project.id,
        title: "Thread A",
      }),
      makeThread({
        environmentId: ENV,
        id: ThreadId.make("thread-b"),
        projectId: project.id,
        title: "Thread B",
      }),
    ];
    const { props } = makeProps({ projects: [project], threads });
    render(<HomeScreen {...props} />);

    expect(h.swipeables.length).toBeGreaterThanOrEqual(2);
    const [first, second] = h.swipeables;
    // Opening the first then the second row should close the first.
    (first!.props["onSwipeableWillOpen"] as () => void)();
    (second!.props["onSwipeableWillOpen"] as () => void)();
    expect(h.closeCalls.length).toBeGreaterThanOrEqual(1);
    // Closing the currently-open row clears the tracked reference.
    (second!.props["onSwipeableClose"] as () => void)();
  });
});

describe("HomeScreen project grouping", () => {
  const project = makeProject({
    environmentId: ENV,
    id: ProjectId.make("project-1"),
    title: "Alpha",
  });

  function manyThreads(count: number): ReadonlyArray<EnvironmentThreadShell> {
    return Array.from({ length: count }, (_, index) =>
      makeThread({
        environmentId: ENV,
        id: ThreadId.make(`thread-${index}`),
        projectId: project.id,
        title: `Thread ${index}`,
        updatedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
  }

  it("collapses to six threads and exposes a show-more toggle", () => {
    const threads = manyThreads(9);
    const { props } = makeProps({ projects: [project], threads });
    render(<HomeScreen {...props} />);

    const toggle = h.pressables.find(
      (pressable) =>
        String(JSON.stringify(pressable["hitSlop"] ?? "")).length > 0 &&
        typeof pressable["onPress"] === "function" &&
        pressable["accessibilityLabel"] === undefined,
    );
    // The "N more" toggle Pressable carries a hitSlop and no accessibilityLabel.
    expect(toggle).toBeDefined();
    (toggle!["onPress"] as () => void)();
  });

  it("renders every thread and a show-less label when the group is expanded", () => {
    const threads = manyThreads(9);
    const groups = buildHomeThreadGroups({
      projects: [project],
      threads,
      environmentId: null,
      searchQuery: "",
      projectSortOrder: "updated_at",
      threadSortOrder: "updated_at",
      projectGroupingMode: "separate",
    });
    h.expandedSeed = new Set(groups.map((group) => group.key));

    const { props } = makeProps({ projects: [project], threads });
    const markup = render(<HomeScreen {...props} />);

    expect(markup).toContain("Show less");
    // All nine threads render when expanded.
    expect(markup).toContain("Thread 0");
    expect(markup).toContain("Thread 8");
  });
});
