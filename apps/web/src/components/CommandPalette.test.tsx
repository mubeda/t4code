/**
 * Unit tests for the CommandPalette mega-component.
 *
 * Strategy (same harness as GitActionsControl.test.tsx): React hooks are
 * partially mocked with a slot-based store so component state survives
 * repeated `renderToStaticMarkup` passes, while leaf UI primitives are
 * replaced by capture-mocks that record every props object. Tests drive the
 * palette by invoking the captured handlers (onExecuteItem, onValueChange,
 * onKeyDown, button onClick) directly and re-rendering.
 */
import type {
  SourceControlDiscoveryResult,
  SourceControlProviderDiscoveryItem,
  SourceControlRepositoryInfo,
} from "@t4code/contracts";
import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t4code/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t4code/contracts/settings";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t4code/client-runtime/state/shell";
import { createModelSelection } from "@t4code/shared/model";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CommandPaletteActionItem,
  CommandPaletteGroup,
  CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

type EffectCallback = () => void | (() => void);

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let stateSlots = new Map<number, unknown>();
  let refSlots = new Map<number, { current: unknown }>();
  let cacheSlots = new Map<number, unknown[]>();

  return {
    effects: [] as EffectCallback[],
    beginRender() {
      cursor = 0;
      this.effects = [];
    },
    reset() {
      cursor = 0;
      stateSlots = new Map();
      refSlots = new Map();
      cacheSlots = new Map();
      this.effects = [];
    },
    runEffects(): Array<() => void> {
      const cleanups: Array<() => void> = [];
      for (const effect of this.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") {
          cleanups.push(cleanup);
        }
      }
      return cleanups;
    },
    useCallback<T>(callback: T): T {
      cursor += 1;
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      cursor += 1;
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = cursor;
      cursor += 1;
      const existing = cacheSlots.get(index);
      if (existing) {
        return existing;
      }
      const slots = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      cacheSlots.set(index, slots);
      return slots;
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor;
      cursor += 1;
      const existing = refSlots.get(index);
      if (existing) {
        return existing as { current: T };
      }
      const ref = { current: initialValue };
      refSlots.set(index, ref);
      return ref;
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = cursor;
      cursor += 1;
      if (!stateSlots.has(index)) {
        stateSlots.set(
          index,
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        );
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = stateSlots.get(index) as T;
        stateSlots.set(
          index,
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue,
        );
      };
      return [stateSlots.get(index) as T, setValue];
    },
    useReducer<S, A>(
      reducer: (state: S, action: A) => S,
      initialState: S,
    ): [S, (action: A) => void] {
      const index = cursor;
      cursor += 1;
      if (!stateSlots.has(index)) {
        stateSlots.set(index, initialState);
      }
      const dispatch = (action: A) => {
        stateSlots.set(index, reducer(stateSlots.get(index) as S, action));
      };
      return [stateSlots.get(index) as S, dispatch];
    },
    useEffect(effect: EffectCallback): void {
      cursor += 1;
      this.effects.push(effect);
    },
    useLayoutEffect(effect: EffectCallback): void {
      cursor += 1;
      this.effects.push(effect);
    },
    useDeferredValue<T>(value: T): T {
      cursor += 1;
      return value;
    },
  };
});

const captured = vi.hoisted(() => ({
  providers: [] as unknown[],
  commandDialogs: [] as unknown[],
  commandPopups: [] as unknown[],
  commands: [] as unknown[],
  commandInputs: [] as unknown[],
  results: [] as unknown[],
  addProjectDialogs: [] as unknown[],
  buttons: [] as unknown[],
  clear() {
    this.providers = [];
    this.commandDialogs = [];
    this.commandPopups = [];
    this.commands = [];
    this.commandInputs = [];
    this.results = [];
    this.addProjectDialogs = [];
    this.buttons = [];
  },
}));

interface TestEnvironment {
  environmentId: EnvironmentId;
  label: string | null;
  entry: { target: { _tag: string; connectionId?: string } };
  displayUrl: string | null;
  serverConfig: {
    settings: { addProjectBaseDirectory?: string } | null;
    environment: { platform: { os: string } };
  } | null;
}

interface TestBrowseResult {
  parentPath: string;
  entries: ReadonlyArray<{ name: string; fullPath: string }>;
}

const testState = vi.hoisted(() => ({
  navigate: vi.fn(),
  keybindings: { kind: "keybindings" } as unknown,
  shortcutCommand: null as string | null,
  shortcutCalls: [] as unknown[][],
  routeParams: {} as Record<string, string>,
  terminalOpen: false,
  environments: [] as TestEnvironment[],
  primaryEnvironment: null as TestEnvironment | null,
  projects: [] as unknown[],
  threads: [] as unknown[],
  activeThread: null as unknown,
  activeDraftThread: null as unknown,
  defaultProjectRef: null as unknown,
  handleNewThread: vi.fn(),
  startNewThread: vi.fn(),
  startNewThreadInProject: vi.fn(),
  clientSettings: null as unknown,
  discovery: null as SourceControlDiscoveryResult | null,
  browseResult: null as TestBrowseResult | null,
  browseIsPending: false,
  browseCalls: [] as unknown[],
  createProject: vi.fn(),
  cloneRepository: vi.fn(),
  lookupRepository: vi.fn(),
  localApi: undefined as { dialogs: { pickFolder: ReturnType<typeof vi.fn> } } | undefined,
  desktopLocalBootstraps: [] as Array<{
    id: string;
    httpBaseUrl: string;
    runningDistro: string | null;
  }>,
  navigatorPlatform: "Win32",
  composerHandleRef: { current: null as { focusAtEnd: () => void } | null },
  toast: {
    add: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
    useReducer: hooks.useReducer.bind(hooks),
    useEffect: hooks.useEffect.bind(hooks),
    useLayoutEffect: hooks.useLayoutEffect.bind(hooks),
    useDeferredValue: hooks.useDeferredValue,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.keybindings,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useParams: (opts?: { select?: (params: Record<string, string>) => unknown }) =>
    opts?.select ? opts.select(testState.routeParams) : testState.routeParams,
}));

vi.mock("../commandPaletteContext", () => ({
  OpenAddProjectCommandPaletteProvider: (props: {
    openAddProject: () => void;
    children?: ReactNode;
  }) => {
    captured.providers.push(props);
    return <>{props.children}</>;
  },
}));

vi.mock("../composerHandleContext", () => ({
  ComposerHandleContext: (props: { children?: ReactNode }) => <>{props.children}</>,
  useComposerHandleContext: () => testState.composerHandleRef,
}));

vi.mock("../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => testState.desktopLocalBootstraps,
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: testState.activeDraftThread,
    activeThread: testState.activeThread,
    defaultProjectRef: testState.defaultProjectRef,
    handleNewThread: testState.handleNewThread,
  }),
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => testState.clientSettings,
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => testState.localApi,
}));

vi.mock("../state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (args: unknown) => ({ kind: "browse", args }),
  },
}));

vi.mock("../state/projects", () => ({
  projectEnvironment: { create: "cmd:createProject" },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom !== null && typeof atom === "object") {
      const kind = (atom as { kind?: string }).kind;
      if (kind === "browse") {
        testState.browseCalls.push((atom as { args: unknown }).args);
        return {
          data: testState.browseResult,
          error: null,
          isPending: testState.browseIsPending,
          refresh: () => {},
        };
      }
      if (kind === "discovery") {
        return { data: testState.discovery, error: null, isPending: false, refresh: () => {} };
      }
    }
    return { data: null, error: null, isPending: false, refresh: () => {} };
  },
}));

vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: {
    discovery: (args: unknown) => ({ kind: "discovery", args }),
    repository: "query:repository",
    cloneRepository: "cmd:cloneRepository",
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "cmd:createProject" ? testState.createProject : testState.cloneRepository,
}));

vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => testState.lookupRepository,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironment: () => testState.primaryEnvironment,
}));

vi.mock("../state/entities", () => ({
  useProjects: () => testState.projects,
  useThreadShells: () => testState.threads,
}));

vi.mock("../lib/chatThreadActions", () => ({
  startNewThreadFromContext: (...args: unknown[]) => testState.startNewThread(...args),
  startNewThreadInProjectFromContext: (...args: unknown[]) =>
    testState.startNewThreadInProject(...args),
}));

vi.mock("../lib/terminalFocus", () => ({
  isTerminalFocused: () => false,
}));

vi.mock("../terminalUiStateStore", () => ({
  selectThreadTerminalUiState: () => ({ terminalOpen: testState.terminalOpen }),
  useTerminalUiStateStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ terminalUiStateByThreadKey: {} }),
}));

vi.mock("../state/server", () => ({
  primaryServerKeybindingsAtom: "atom:keybindings",
}));

vi.mock("../keybindings", () => ({
  resolveShortcutCommand: (...args: unknown[]) => {
    testState.shortcutCalls.push(args);
    return testState.shortcutCommand;
  },
}));

vi.mock("./AddProjectDialog", () => ({
  AddProjectDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    captured.addProjectDialogs.push(props);
    return <div data-testid="add-project-dialog" data-open={props.open ? "true" : "false"} />;
  },
}));

vi.mock("./CommandPaletteResults", () => ({
  CommandPaletteResults: (props: Record<string, unknown>) => {
    captured.results.push(props);
    const groups = props["groups"] as ReadonlyArray<{ value: string }>;
    return (
      <div data-testid="palette-results">
        {groups.map((group) => group.value).join("|")}
        {(props["emptyStateMessage"] as string | undefined) ?? null}
      </div>
    );
  },
}));

vi.mock("./ProjectFavicon", () => ({
  ProjectFavicon: () => <span data-testid="project-favicon" />,
}));

vi.mock("./ThreadStatusIndicators", () => ({
  ThreadRowLeadingStatus: () => <span data-testid="leading-status" />,
  ThreadRowTrailingStatus: () => <span data-testid="trailing-status" />,
}));

vi.mock("./ui/command", () => ({
  Command: (props: Record<string, unknown>) => {
    captured.commands.push(props);
    return <div data-testid="command">{props["children"] as ReactNode}</div>;
  },
  CommandDialog: (props: Record<string, unknown>) => {
    captured.commandDialogs.push(props);
    return <div data-testid="command-dialog">{props["children"] as ReactNode}</div>;
  },
  CommandDialogPopup: (props: Record<string, unknown>) => {
    captured.commandPopups.push(props);
    return <div data-testid="command-popup">{props["children"] as ReactNode}</div>;
  },
  CommandFooter: (props: { children?: ReactNode }) => (
    <div data-testid="command-footer">{props.children}</div>
  ),
  CommandInput: (props: Record<string, unknown>) => {
    captured.commandInputs.push(props);
    return (
      <div data-testid="command-input">
        {props["startAddon"] as ReactNode}
        <span>{props["placeholder"] as string | undefined}</span>
      </div>
    );
  },
  CommandPanel: (props: { children?: ReactNode }) => (
    <div data-testid="command-panel">{props.children}</div>
  ),
}));

interface CapturedButtonProps {
  disabled?: boolean;
  onClick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  children?: ReactNode;
  "aria-label"?: string;
}

vi.mock("./ui/button", () => ({
  Button: (props: CapturedButtonProps) => {
    captured.buttons.push(props);
    return (
      <button
        type="button"
        data-slot="button"
        data-disabled={props.disabled ? "true" : undefined}
        aria-label={props["aria-label"]}
      >
        {props.children}
      </button>
    );
  },
}));

vi.mock("./ui/kbd", () => ({
  Kbd: (props: { children?: ReactNode }) => <kbd>{props.children}</kbd>,
  KbdGroup: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

vi.mock("./ui/toast", () => ({
  toastManager: testState.toast,
  stackedThreadToast: (toast: Record<string, unknown>) => ({ ...toast, stacked: true }),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { render?: ReactNode; children?: ReactNode }) => (
    <div data-testid="tooltip-trigger">
      {props.render ?? null}
      {props.children ?? null}
    </div>
  ),
  TooltipPopup: (props: { children?: ReactNode }) => (
    <div data-testid="tooltip-popup">{props.children}</div>
  ),
}));

import {
  CommandPalette,
  buildAddProjectRemoteSourceReadiness,
  errorMessage,
  reduceCommandPaletteUiState,
  remoteProjectSourcePathHint,
  sortAddProjectProviderSources,
} from "./CommandPalette";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ENV_PRIMARY = EnvironmentId.make("env-primary");
const ENV_WSL = EnvironmentId.make("env-wsl");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function primaryEnvironment(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
  return {
    environmentId: ENV_PRIMARY,
    label: "This device",
    entry: { target: { _tag: "PrimaryConnectionTarget" } },
    displayUrl: null,
    serverConfig: {
      settings: null,
      environment: { platform: { os: "windows" } },
    },
    ...overrides,
  };
}

function wslEnvironment(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
  return {
    environmentId: ENV_WSL,
    label: "WSL Ubuntu",
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl:Ubuntu" } },
    displayUrl: "http://127.0.0.1:8899",
    serverConfig: {
      settings: { addProjectBaseDirectory: "~/dev" },
      environment: { platform: { os: "linux" } },
    },
    ...overrides,
  };
}

function makeProject(
  id: string,
  overrides: Partial<Omit<EnvironmentProject, "id">> = {},
): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    title: "Repo A",
    workspaceRoot: "~/dev/repo-a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: iso(600),
    updatedAt: iso(60),
    environmentId: ENV_PRIMARY,
    ...overrides,
  };
}

function makeThread(
  id: string,
  overrides: Partial<Omit<EnvironmentThreadShell, "id">> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_A,
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
    environmentId: ENV_PRIMARY,
    ...overrides,
  };
}

function discoveryProvider(
  overrides: Partial<SourceControlProviderDiscoveryItem> & {
    kind: SourceControlProviderDiscoveryItem["kind"];
  },
): SourceControlProviderDiscoveryItem {
  return {
    label: overrides.kind,
    status: "available",
    version: Option.some("1.0.0"),
    installHint: `Install ${overrides.kind}`,
    detail: Option.none(),
    auth: {
      status: "authenticated",
      account: Option.some("octo"),
      host: Option.none(),
      detail: Option.none(),
    },
    ...overrides,
  };
}

function discovery(
  providers: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): SourceControlDiscoveryResult {
  return { versionControlSystems: [], sourceControlProviders: providers };
}

function readyDiscovery(): SourceControlDiscoveryResult {
  return discovery([
    discoveryProvider({ kind: "github", label: "GitHub" }),
    discoveryProvider({
      kind: "gitlab",
      label: "GitLab",
      auth: {
        status: "unauthenticated",
        account: Option.none(),
        host: Option.none(),
        detail: Option.some("Run glab auth login."),
      },
    }),
    discoveryProvider({
      kind: "bitbucket",
      label: "Bitbucket",
      status: "missing",
      installHint: "Install the Bitbucket CLI first.",
    }),
  ]);
}

function repositoryInfo(
  overrides: Partial<SourceControlRepositoryInfo> = {},
): SourceControlRepositoryInfo {
  return {
    provider: "github",
    nameWithOwner: "octo/repo",
    url: "https://github.com/octo/repo",
    sshUrl: "git@github.com:octo/repo.git",
    ...overrides,
  };
}

describe("command palette helpers", () => {
  it("builds and sorts remote provider readiness states", () => {
    const unavailable = buildAddProjectRemoteSourceReadiness(null);
    expect(unavailable.github.ready).toBe(false);
    expect(remoteProjectSourcePathHint("url")).toBe("URL");

    const readiness = buildAddProjectRemoteSourceReadiness(
      discovery([
        discoveryProvider({ kind: "github", label: "GitHub" }),
        discoveryProvider({
          kind: "gitlab",
          label: "GitLab",
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.none(),
          },
        }),
      ]),
    );

    expect(readiness.gitlab.hint).toContain("not authenticated");
    expect(sortAddProjectProviderSources(readiness)[0]).toBe("github");

    const lastProviderReady = buildAddProjectRemoteSourceReadiness(
      discovery([discoveryProvider({ kind: "azure-devops", label: "Azure DevOps" })]),
    );
    expect(sortAddProjectProviderSources(lastProviderReady)[0]).toBe("azure-devops");
  });

  it("formats opaque errors and reduces no-op palette intent changes", () => {
    expect(errorMessage(new Error("   "))).toBe("An error occurred.");
    expect(errorMessage({ message: "hidden" })).toBe("An error occurred.");

    const closed = { open: false, openIntent: null } as const;
    expect(reduceCommandPaletteUiState(closed, { _tag: "ClearOpenIntent" })).toBe(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      openIntent: null,
    });
    expect(
      reduceCommandPaletteUiState(
        { open: true, openIntent: { kind: "add-project" } },
        { _tag: "SetOpen", open: false },
      ),
    ).toEqual({ open: false, openIntent: null });
  });
});

function success<A>(value: A) {
  return AsyncResult.success<A, never>(value);
}

function failure(message: string) {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

function interrupted() {
  return AsyncResult.failure(Cause.interrupt(1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Render + capture helpers
// ─────────────────────────────────────────────────────────────────────────────

function render(): string {
  hooks.beginRender();
  captured.clear();
  return renderToStaticMarkup(
    <CommandPalette>
      <div data-testid="app-child" />
    </CommandPalette>,
  );
}

const rerender = render;

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface CapturedCommandDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface CapturedCommandProps {
  value?: string;
  autoHighlight?: boolean | "always";
  onValueChange?: (value: string) => void;
  onItemHighlighted?: (value: unknown) => void;
}

interface FakeInputKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault: () => void;
}

interface CapturedCommandInputProps {
  placeholder?: string;
  className?: string;
  startAddon?: ReactNode;
  onKeyDown?: (event: FakeInputKeyEvent) => void;
}

interface CapturedResultsProps {
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue: string | null;
  isActionsOnly: boolean;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
  emptyStateMessage?: string;
}

function lastCommandDialog(): CapturedCommandDialogProps {
  const props = captured.commandDialogs.at(-1);
  if (!props) throw new Error("CommandDialog was not rendered");
  return props as CapturedCommandDialogProps;
}

function lastCommand(): CapturedCommandProps {
  const props = captured.commands.at(-1);
  if (!props) throw new Error("Command was not rendered");
  return props as CapturedCommandProps;
}

function lastCommandInput(): CapturedCommandInputProps {
  const props = captured.commandInputs.at(-1);
  if (!props) throw new Error("CommandInput was not rendered");
  return props as CapturedCommandInputProps;
}

function resultsProps(): CapturedResultsProps {
  const props = captured.results.at(-1);
  if (!props) throw new Error("CommandPaletteResults was not rendered");
  return props as unknown as CapturedResultsProps;
}

function allItems(): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  return resultsProps().groups.flatMap((group) => [...group.items]);
}

function itemByValue(
  value: string,
): CommandPaletteActionItem | CommandPaletteSubmenuItem | undefined {
  return allItems().find((item) => item.value === value);
}

function executeValue(value: string): void {
  const item = itemByValue(value);
  if (!item) {
    throw new Error(
      `Palette item "${value}" not found; available: ${allItems()
        .map((item) => item.value)
        .join(", ")}`,
    );
  }
  resultsProps().onExecuteItem(item);
}

function openPalette(): string {
  render();
  lastCommandDialog().onOpenChange?.(true);
  return rerender();
}

function enterKey(overrides: Partial<FakeInputKeyEvent> = {}): FakeInputKeyEvent {
  return { key: "Enter", metaKey: false, ctrlKey: false, preventDefault: vi.fn(), ...overrides };
}

function buttonContaining(text: string): CapturedButtonProps | undefined {
  return (captured.buttons as CapturedButtonProps[]).find((button) =>
    collectText(button.children).includes(text),
  );
}

function buttonByAriaLabel(label: string): CapturedButtonProps | undefined {
  return (captured.buttons as CapturedButtonProps[]).find(
    (button) => button["aria-label"] === label,
  );
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    const props = (node as { props: Record<string, unknown> }).props;
    return collectText(props["children"]) + collectText(props["render"]);
  }
  return "";
}

/** Depth-first search of a React element tree for the first onClick handler. */
function findFirstOnClick(node: unknown): (() => void) | null {
  if (node === null || node === undefined || typeof node !== "object") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const handler = findFirstOnClick(child);
      if (handler) return handler;
    }
    return null;
  }
  const element = node as { props?: Record<string, unknown> };
  if (!element.props) {
    return null;
  }
  if (typeof element.props["onClick"] === "function") {
    return element.props["onClick"] as () => void;
  }
  for (const value of Object.values(element.props)) {
    const handler = findFirstOnClick(value);
    if (handler) return handler;
  }
  return null;
}

const clickEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

interface WindowStub {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  desktopBridge?: {
    getWslState: ReturnType<typeof vi.fn>;
    getLocalEnvironmentBootstraps: ReturnType<typeof vi.fn>;
  };
}

let windowStub: WindowStub;

function keydownHandler(): (event: {
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void {
  const handler = windowStub.addEventListener.mock.calls.find(
    ([event]) => event === "keydown",
  )?.[1] as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error("keydown handler not registered");
  return handler;
}

beforeEach(() => {
  hooks.reset();
  captured.clear();
  vi.clearAllMocks();
  testState.shortcutCommand = null;
  testState.shortcutCalls = [];
  testState.routeParams = {};
  testState.terminalOpen = false;
  testState.environments = [primaryEnvironment(), wslEnvironment()];
  testState.primaryEnvironment = testState.environments[0] ?? null;
  testState.projects = [
    makeProject("project-a"),
    makeProject("project-b", {
      title: "Repo B",
      workspaceRoot: "~/dev/repo-b",
    }),
  ];
  testState.threads = [makeThread("thread-1")];
  testState.activeThread = makeThread("thread-1");
  testState.activeDraftThread = null;
  testState.defaultProjectRef = null;
  testState.clientSettings = DEFAULT_CLIENT_SETTINGS;
  testState.discovery = readyDiscovery();
  testState.browseResult = {
    parentPath: "~/dev",
    entries: [
      { name: "app", fullPath: "~/dev/app" },
      { name: ".git", fullPath: "~/dev/.git" },
    ],
  };
  testState.browseIsPending = false;
  testState.browseCalls = [];
  testState.localApi = undefined;
  testState.desktopLocalBootstraps = [];
  testState.navigatorPlatform = "Win32";
  testState.composerHandleRef = { current: { focusAtEnd: vi.fn() } };
  testState.navigate.mockResolvedValue(undefined);
  testState.handleNewThread.mockResolvedValue(undefined);
  testState.startNewThread.mockResolvedValue(undefined);
  testState.startNewThreadInProject.mockResolvedValue(undefined);
  testState.createProject.mockResolvedValue(success({}));
  testState.cloneRepository.mockResolvedValue(success({ cwd: "~/dev/cloned" }));
  testState.lookupRepository.mockResolvedValue(success(repositoryInfo()));

  windowStub = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("navigator", {
    get platform() {
      return testState.navigatorPlatform;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("palette shell", () => {
  it("renders only its children while closed", () => {
    const markup = render();
    expect(markup).toContain('data-testid="app-child"');
    expect(markup).not.toContain('data-testid="command-popup"');
  });

  it("opens and closes through the keyboard shortcut", () => {
    render();
    hooks.runEffects();
    const handler = keydownHandler();

    // Non-matching command: stays closed.
    testState.shortcutCommand = null;
    handler({ defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(rerender()).not.toContain('data-testid="command-popup"');

    // defaultPrevented events are ignored entirely.
    testState.shortcutCommand = "commandPalette.toggle";
    handler({ defaultPrevented: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(rerender()).not.toContain('data-testid="command-popup"');

    // Matching command toggles open.
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(rerender()).toContain('data-testid="command-popup"');

    // And toggles closed again.
    handler({ defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(rerender()).not.toContain('data-testid="command-popup"');
  });

  it("opens via the dialog onOpenChange and shows the root placeholder", () => {
    const markup = openPalette();
    expect(markup).toContain('data-testid="command-popup"');
    expect(lastCommandInput().placeholder).toBe("Search commands, projects, and threads...");
    expect(lastCommand().autoHighlight).toBe("always");
  });

  it("closes when the backdrop is pressed", () => {
    openPalette();
    const popup = captured.commandPopups.at(-1) as {
      onBackdropPointerDown?: () => void;
    };
    popup.onBackdropPointerDown?.();
    expect(rerender()).not.toContain('data-testid="command-popup"');
  });

  it("returns focus to the composer when the dialog closes", () => {
    openPalette();
    const popup = captured.commandPopups.at(-1) as {
      finalFocus?: () => boolean;
    };
    expect(popup.finalFocus?.()).toBe(false);
    expect(testState.composerHandleRef.current?.focusAtEnd).toHaveBeenCalledTimes(1);
  });

  it("opens the add-project dialog when an open intent is queued", () => {
    render();
    const provider = captured.providers.at(-1) as { openAddProject: () => void };
    provider.openAddProject();
    rerender();
    // The layout effect consumes the intent and opens the dedicated dialog.
    hooks.runEffects();
    const markup = rerender();
    expect(markup).toContain('data-open="true"');
    expect(markup).not.toContain('data-testid="command-popup"');
  });

  it("closes the add-project dialog through its onOpenChange", () => {
    openPalette();
    executeValue("action:add-project");
    rerender();
    const dialog = captured.addProjectDialogs.at(-1) as {
      open: boolean;
      onOpenChange: (open: boolean) => void;
    };
    expect(dialog.open).toBe(true);
    dialog.onOpenChange(false);
    expect(rerender()).toContain('data-open="false"');
  });

  it("selects terminal ui state for the active server thread route", () => {
    testState.routeParams = { environmentId: "env-primary", threadId: "thread-1" };
    testState.terminalOpen = true;
    const markup = render();
    expect(markup).toContain('data-testid="app-child"');
  });
});

describe("root actions", () => {
  it("builds the root actions and recent threads", () => {
    openPalette();
    const groups = resultsProps().groups;
    expect(groups.map((group) => group.value)).toEqual(["actions", "recent-threads"]);
    const values = allItems().map((item) => item.value);
    expect(values).toContain("action:new-thread");
    expect(values).toContain("action:new-thread-in");
    expect(values).toContain("action:add-project");
    expect(values).toContain("action:add-project:wsl-folder");
    expect(values).toContain("action:settings");
    expect(values).toContain("thread:thread-1");
  });

  it("omits the active-project new-thread action without projects", () => {
    testState.projects = [];
    testState.threads = [];
    testState.activeThread = null;
    openPalette();
    const values = allItems().map((item) => item.value);
    expect(values).not.toContain("action:new-thread");
    expect(values).not.toContain("action:new-thread-in");
    expect(values).toContain("action:add-project");
  });

  it("navigates to settings and closes the palette", async () => {
    openPalette();
    executeValue("action:settings");
    await flushPromises();
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/settings" });
    expect(rerender()).not.toContain('data-testid="command-popup"');
  });

  it("starts a new thread in the active project", async () => {
    openPalette();
    executeValue("action:new-thread");
    await flushPromises();
    expect(testState.startNewThread).toHaveBeenCalledTimes(1);
  });

  it("drills into the new-thread-in submenu and starts a thread in a project", async () => {
    openPalette();
    executeValue("action:new-thread-in");
    rerender();
    expect(lastCommandInput().placeholder).toBe("Search...");
    executeValue(`new-thread-in:${ENV_PRIMARY}:${PROJECT_B}`);
    await flushPromises();
    expect(testState.startNewThreadInProject).toHaveBeenCalledTimes(1);
    const scopedRef = testState.startNewThreadInProject.mock.calls[0]?.[1] as {
      environmentId: string;
      projectId: string;
    };
    expect(scopedRef.projectId).toBe(PROJECT_B);
  });

  it("pops the submenu through the back addon and Backspace", () => {
    openPalette();
    executeValue("action:new-thread-in");
    rerender();
    const backAddon = findFirstOnClick(lastCommandInput().startAddon);
    expect(backAddon).not.toBeNull();
    backAddon?.();
    rerender();
    expect(resultsProps().groups.map((group) => group.value)).toContain("actions");

    // Re-enter and pop with Backspace on an empty query.
    executeValue("action:new-thread-in");
    rerender();
    lastCommandInput().onKeyDown?.({
      key: "Backspace",
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    });
    rerender();
    expect(resultsProps().groups.map((group) => group.value)).toContain("actions");
  });

  it("reports failing command runs as a toast", async () => {
    openPalette();
    resultsProps().onExecuteItem({
      kind: "action",
      value: "test:boom",
      searchTerms: [],
      title: "Boom",
      icon: null,
      run: () => Promise.reject(new Error("boom")),
    });
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Unable to run command",
        description: "boom",
      }),
    );
  });

  it("ignores disabled items", async () => {
    openPalette();
    const run = vi.fn(() => Promise.resolve());
    resultsProps().onExecuteItem({
      kind: "action",
      value: "test:disabled",
      searchTerms: [],
      title: "Disabled",
      icon: null,
      disabled: true,
      run,
    });
    await flushPromises();
    expect(run).not.toHaveBeenCalled();
    expect(rerender()).toContain('data-testid="command-popup"');
  });

  it("filters to actions when the query starts with >", () => {
    openPalette();
    lastCommand().onValueChange?.(">");
    rerender();
    expect(resultsProps().isActionsOnly).toBe(true);
    expect(resultsProps().groups.map((group) => group.value)).toEqual(["actions"]);
  });

  it("opens a searched project at its latest thread", async () => {
    openPalette();
    lastCommand().onValueChange?.("Repo A");
    rerender();
    executeValue(`project:${ENV_PRIMARY}:${PROJECT_A}`);
    await flushPromises();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_PRIMARY, threadId: ThreadId.make("thread-1") },
    });
  });

  it("starts a new thread for a searched project without threads", async () => {
    openPalette();
    lastCommand().onValueChange?.("Repo B");
    rerender();
    executeValue(`project:${ENV_PRIMARY}:${PROJECT_B}`);
    await flushPromises();
    expect(testState.handleNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_B }),
    );
  });

  it("navigates to a searched thread", async () => {
    openPalette();
    lastCommand().onValueChange?.("Thread thread-1");
    rerender();
    executeValue("thread:thread-1");
    await flushPromises();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_PRIMARY, threadId: ThreadId.make("thread-1") },
    });
  });
});

describe("filesystem browse", () => {
  function openWslBrowse(): string {
    openPalette();
    executeValue("action:add-project:wsl-folder");
    return rerender();
  }

  it("starts browsing the WSL environment at its configured base directory", () => {
    openWslBrowse();
    expect(lastCommand().value).toBe("~/dev/");
    expect(lastCommand().autoHighlight).toBe(false);
    expect(lastCommandInput().placeholder).toBe("Enter path (e.g. ~/projects/my-app)");
    const browseArgs = testState.browseCalls.at(-1) as {
      environmentId: string;
      input: { partialPath: string };
    };
    expect(browseArgs.environmentId).toBe(ENV_WSL);
    expect(browseArgs.input.partialPath).toBe("~/dev/");
  });

  it("lists directories, hides dotfiles, and navigates into and up", () => {
    openWslBrowse();
    const values = allItems().map((item) => item.value);
    expect(values).toContain("browse:up");
    expect(values).toContain("browse:~/dev/app");
    expect(values).not.toContain("browse:~/dev/.git");

    executeValue("browse:~/dev/app");
    rerender();
    expect(lastCommand().value).toBe("~/dev/app/");

    executeValue("browse:up");
    rerender();
    expect(lastCommand().value).toBe("~/dev/");
  });

  it("pops back to the root when the browse query is cleared", () => {
    openWslBrowse();
    lastCommand().onValueChange?.("");
    rerender();
    expect(resultsProps().groups.map((group) => group.value)).toContain("actions");
  });

  it("creates a project for the browsed directory on Enter", async () => {
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.createProject).toHaveBeenCalledWith({
      environmentId: ENV_WSL,
      input: expect.objectContaining({
        title: "app",
        workspaceRoot: "~/dev/app",
        createWorkspaceRootIfMissing: true,
      }),
    });
    expect(testState.handleNewThread).toHaveBeenCalledTimes(1);
    expect(rerender()).not.toContain('data-testid="command-popup"');
  });

  it("shows the create-and-add affordance for unknown leaf names", async () => {
    openWslBrowse();
    lastCommand().onValueChange?.("~/dev/newproj");
    rerender();
    expect(resultsProps().emptyStateMessage).toBe(
      "Press Enter to create this folder and add it as a project.",
    );
    const submit = (captured.buttons as CapturedButtonProps[]).find((button) =>
      button["aria-label"]?.startsWith("Create & Add"),
    );
    expect(submit).toBeDefined();
    submit?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ workspaceRoot: "~/dev/newproj" }),
      }),
    );
  });

  it("requires the primary modifier when a browse item is highlighted", async () => {
    openWslBrowse();
    lastCommand().onItemHighlighted?.("browse:~/dev/app");
    rerender();

    // Plain Enter defers to the highlighted item.
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.createProject).not.toHaveBeenCalled();

    // Ctrl+Enter (non-mac) submits the typed path.
    testState.browseResult = { parentPath: "~/dev", entries: [] };
    lastCommandInput().onKeyDown?.(enterKey({ ctrlKey: true }));
    await flushPromises();
    expect(testState.createProject).toHaveBeenCalledTimes(1);
  });

  it("clears the highlight when a non-string value is highlighted", () => {
    openWslBrowse();
    lastCommand().onItemHighlighted?.(undefined);
    rerender();
    expect(resultsProps().highlightedItemValue).toBeNull();
  });

  it("navigates to an existing project instead of re-adding it", async () => {
    testState.projects = [
      makeProject("project-wsl", {
        title: "WSL Repo",
        workspaceRoot: "~/dev/app",
        environmentId: ENV_WSL,
      }),
    ];
    testState.threads = [
      makeThread("thread-wsl", {
        projectId: ProjectId.make("project-wsl"),
        environmentId: ENV_WSL,
      }),
    ];
    testState.activeThread = null;
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.createProject).not.toHaveBeenCalled();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_WSL, threadId: ThreadId.make("thread-wsl") },
    });
  });

  it("starts a thread for an existing project without threads and reports failures", async () => {
    testState.projects = [
      makeProject("project-wsl", {
        title: "WSL Repo",
        workspaceRoot: "~/dev/app",
        environmentId: ENV_WSL,
      }),
    ];
    testState.threads = [];
    testState.activeThread = null;
    testState.handleNewThread.mockRejectedValue(new Error("nav exploded"));
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to open project",
        description: "nav exploded",
      }),
    );
  });

  it("reports project creation failures", async () => {
    testState.createProject.mockResolvedValue(failure("disk full"));
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to add project",
        description: "disk full",
      }),
    );
  });

  it("stays quiet when project creation is interrupted", async () => {
    testState.createProject.mockResolvedValue(interrupted());
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).not.toHaveBeenCalled();
  });

  it("reports navigation failures after creating the project", async () => {
    testState.handleNewThread.mockRejectedValue(new Error("router broke"));
    openWslBrowse();
    testState.browseResult = { parentPath: "~/dev/app", entries: [] };
    lastCommand().onValueChange?.("~/dev/app/");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to add project",
        description: "router broke",
      }),
    );
  });

  it("blocks relative paths without an active project", () => {
    testState.activeThread = null;
    openPalette();
    lastCommand().onValueChange?.("./sub");
    rerender();
    expect(resultsProps().emptyStateMessage).toBe("Relative paths require an active project.");
    expect(resultsProps().groups).toEqual([]);
    lastCommandInput().onKeyDown?.(enterKey());
    expect(testState.createProject).not.toHaveBeenCalled();
  });

  it("resolves relative paths against the active project", async () => {
    // Active thread's project lives on the primary environment.
    testState.projects = [
      makeProject("project-a", { workspaceRoot: "/home/dev/repo-a" }),
      makeProject("project-b", {
        title: "Repo B",
        workspaceRoot: "~/dev/repo-b",
      }),
    ];
    openPalette();
    lastCommand().onValueChange?.("./sub");
    rerender();
    const browseArgs = testState.browseCalls.at(-1) as {
      input: { partialPath: string; cwd?: string };
    };
    expect(browseArgs.input.cwd).toBe("/home/dev/repo-a");
    testState.browseResult = { parentPath: "/home/dev/repo-a", entries: [] };
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_PRIMARY,
        input: expect.objectContaining({ workspaceRoot: "/home/dev/repo-a/sub" }),
      }),
    );
  });
});

describe("add project sources and clone flow", () => {
  function openSourcesView(): string {
    openPalette();
    executeValue("action:add-project:wsl-folder");
    rerender();
    // The legacy multi-environment source picker is currently dead UI code
    // (see TODO(orca-port) in the component); reach it by pushing a submenu
    // whose first group value matches the sources view for the selected env.
    resultsProps().onExecuteItem({
      kind: "submenu",
      value: "test:sources",
      searchTerms: [],
      title: "Sources",
      icon: null,
      addonIcon: null,
      groups: [{ value: `sources:${ENV_WSL}`, label: "Sources", items: [] }],
    });
    return rerender();
  }

  it("lists local, url, and provider sources with readiness", () => {
    openSourcesView();
    const values = allItems().map((item) => item.value);
    expect(values).toContain(`action:add-project:${ENV_WSL}:local`);
    expect(values).toContain(`action:add-project:${ENV_WSL}:url`);
    expect(values).toContain(`action:add-project:${ENV_WSL}:github`);
    expect(values).toContain(`action:add-project:${ENV_WSL}:gitlab:not-ready`);
    expect(values).toContain(`action:add-project:${ENV_WSL}:bitbucket:not-ready`);
    expect(values).toContain(`action:add-project:${ENV_WSL}:azure-devops:not-ready`);
    const gitlab = itemByValue(`action:add-project:${ENV_WSL}:gitlab:not-ready`);
    expect(gitlab?.disabled).toBe(true);
    expect(collectText(gitlab?.titleTrailingContent)).toContain("Setup Required");
  });

  it("opens source control settings from a not-ready source", async () => {
    openSourcesView();
    const gitlab = itemByValue(`action:add-project:${ENV_WSL}:gitlab:not-ready`);
    const setup = findFirstOnClick(gitlab?.titleTrailingContent);
    expect(setup).not.toBeNull();
    setup?.();
    await flushPromises();
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/settings/source-control" });
    expect(rerender()).not.toContain('data-testid="command-popup"');

    // The disabled item's run is a no-op.
    const runResult = (gitlab as CommandPaletteActionItem | undefined)?.run();
    await runResult;
  });

  it("starts a local browse from the sources view", () => {
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:local`);
    rerender();
    expect(lastCommand().value).toBe("~/dev/");
  });

  it("looks up a provider repository and clones it to the chosen destination", async () => {
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:github`);
    rerender();
    expect(lastCommandInput().placeholder).toBe("Enter GitHub repository (owner/repo)");
    expect(lastCommandInput().className).toBe("pe-32");
    expect(resultsProps().groups).toEqual([]);
    expect(resultsProps().emptyStateMessage).toBe(
      "Enter a repository path and press Enter to look it up.",
    );
    expect(buttonByAriaLabel("Lookup (Enter)")).toBeDefined();

    // Enter with an empty query does nothing.
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.lookupRepository).not.toHaveBeenCalled();

    lastCommand().onValueChange?.("octo/repo");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.lookupRepository).toHaveBeenCalledWith({
      environmentId: ENV_WSL,
      input: { provider: "github", repository: "octo/repo" },
    });

    // Confirm step: destination browse seeded with the env base directory.
    let markup = rerender();
    expect(lastCommand().value).toBe("~/dev/");
    expect(markup).toContain("octo/repo");
    expect(resultsProps().emptyStateMessage).toBe(
      "Choose a destination path and press Enter to clone.",
    );
    expect(resultsProps().groups.some((group) => group.label === "Select where to clone")).toBe(
      true,
    );

    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.cloneRepository).toHaveBeenCalledWith({
      environmentId: ENV_WSL,
      input: {
        remoteUrl: "git@github.com:octo/repo.git",
        destinationPath: "~/dev",
      },
    });
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_WSL,
        input: expect.objectContaining({ workspaceRoot: "~/dev/cloned", title: "cloned" }),
      }),
    );
    markup = rerender();
    expect(markup).not.toContain('data-testid="command-popup"');
  });

  it("reports repository lookup failures", async () => {
    testState.lookupRepository.mockResolvedValue(failure("repo not found"));
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:github`);
    rerender();
    lastCommand().onValueChange?.("octo/missing");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Repository lookup failed",
        description: "repo not found",
      }),
    );
    expect(testState.cloneRepository).not.toHaveBeenCalled();
  });

  it("stays quiet when the lookup is interrupted", async () => {
    testState.lookupRepository.mockResolvedValue(interrupted());
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:github`);
    rerender();
    lastCommand().onValueChange?.("octo/missing");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).not.toHaveBeenCalled();
  });

  it("clones straight from a git URL without a lookup", async () => {
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:url`);
    rerender();
    expect(lastCommandInput().placeholder).toBe("Enter Git clone URL");
    expect(resultsProps().emptyStateMessage).toBe(
      "Enter a Git clone URL and press Enter to continue.",
    );
    expect(buttonByAriaLabel("Continue (Enter)")).toBeDefined();

    lastCommand().onValueChange?.("https://example.com/repo.git");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.lookupRepository).not.toHaveBeenCalled();

    const markup = rerender();
    expect(markup).toContain("https://example.com/repo.git");
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.cloneRepository).toHaveBeenCalledWith({
      environmentId: ENV_WSL,
      input: {
        remoteUrl: "https://example.com/repo.git",
        destinationPath: "~/dev",
      },
    });
  });

  it("reports clone failures", async () => {
    testState.cloneRepository.mockResolvedValue(failure("clone denied"));
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:url`);
    rerender();
    lastCommand().onValueChange?.("https://example.com/repo.git");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Clone failed",
        description: "clone denied",
      }),
    );
    expect(testState.createProject).not.toHaveBeenCalled();
  });

  it("rejects windows-style clone destinations on non-windows environments", async () => {
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:url`);
    rerender();
    lastCommand().onValueChange?.("https://example.com/repo.git");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    // The browse data resolves the trailing-separator query to a Windows path.
    testState.browseResult = { parentPath: "C:\\dest", entries: [] };
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Clone failed",
        description: "Windows-style paths are only supported on Windows.",
      }),
    );
    expect(testState.cloneRepository).not.toHaveBeenCalled();
  });

  it("rejects relative clone destinations without an active project", async () => {
    testState.activeThread = null;
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:url`);
    rerender();
    lastCommand().onValueChange?.("https://example.com/repo.git");
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    testState.browseResult = { parentPath: "./relative", entries: [] };
    rerender();
    lastCommandInput().onKeyDown?.(enterKey());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Clone failed",
        description: "Relative paths require an active project.",
      }),
    );
  });

  it("abandons the clone flow through the back addon", () => {
    openSourcesView();
    executeValue(`action:add-project:${ENV_WSL}:github`);
    rerender();
    const backAddon = findFirstOnClick(lastCommandInput().startAddon);
    backAddon?.();
    rerender();
    // Popped back to the fabricated sources view; no clone flow placeholder.
    expect(lastCommandInput().placeholder).toBe("Search...");
  });
});

describe("open in file manager", () => {
  function desktopBridgeStub(overrides: Partial<NonNullable<WindowStub["desktopBridge"]>> = {}) {
    const bridge = {
      getWslState: vi.fn(async () => null as unknown),
      getLocalEnvironmentBootstraps: vi.fn(() => [] as unknown[]),
      ...overrides,
    };
    windowStub.desktopBridge = bridge;
    return bridge;
  }

  function openPrimaryBrowse(): void {
    openPalette();
    lastCommand().onValueChange?.("~/");
    testState.browseResult = { parentPath: "~", entries: [] };
    rerender();
  }

  it("hides the picker without a desktop bridge", () => {
    openPrimaryBrowse();
    expect(buttonContaining("Open in Explorer")).toBeUndefined();
  });

  it("picks a folder on the primary environment and adds it", async () => {
    const pickFolder = vi.fn(async () => "D:/picked");
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    openPrimaryBrowse();
    const button = buttonContaining("Open in Explorer");
    expect(button).toBeDefined();
    button?.onClick?.(clickEvent());
    await flushPromises();
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~" });
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_PRIMARY,
        input: expect.objectContaining({ workspaceRoot: "D:/picked" }),
      }),
    );
  });

  it("does nothing when the picker is cancelled or fails", async () => {
    const pickFolder = vi.fn(async () => null);
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    openPrimaryBrowse();
    buttonContaining("Open in Explorer")?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.createProject).not.toHaveBeenCalled();

    pickFolder.mockRejectedValue(new Error("picker crashed"));
    buttonContaining("Open in Explorer")?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.createProject).not.toHaveBeenCalled();
    expect(testState.toast.add).not.toHaveBeenCalled();
  });

  it("routes a WSL UNC selection to the matching WSL environment", async () => {
    const pickFolder = vi.fn(async () => "\\\\wsl$\\Ubuntu\\home\\dev\\proj");
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    testState.desktopLocalBootstraps = [
      { id: "wsl:Ubuntu", httpBaseUrl: "http://127.0.0.1:8899", runningDistro: "Ubuntu" },
    ];
    openPrimaryBrowse();
    buttonContaining("Open in Explorer")?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_WSL,
        input: expect.objectContaining({ workspaceRoot: "/home/dev/proj" }),
      }),
    );
  });

  it("warns when a WSL UNC selection has no matching backend", async () => {
    const pickFolder = vi.fn(async () => "\\\\wsl$\\Fedora\\srv\\code");
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    openPrimaryBrowse();
    buttonContaining("Open in Explorer")?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not add WSL project",
      }),
    );
    expect(testState.createProject).not.toHaveBeenCalled();
  });

  it("routes the picker into a desktop-local WSL environment", async () => {
    const pickFolder = vi.fn(async () => "C:\\oops");
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    testState.desktopLocalBootstraps = [
      { id: "wsl:Ubuntu", httpBaseUrl: "http://127.0.0.1:8899", runningDistro: "Ubuntu" },
    ];
    testState.navigatorPlatform = "Linux x86_64";
    openPalette();
    executeValue("action:add-project:wsl-folder");
    rerender();
    const button = buttonContaining("Open in Files");
    expect(button).toBeDefined();
    button?.onClick?.(clickEvent());
    await flushPromises();
    expect(pickFolder).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnvironmentId: "wsl:Ubuntu" }),
    );
    // A Windows-style path against the Linux environment is rejected.
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to add project",
        description: "Windows-style paths are only supported on Windows.",
      }),
    );
  });

  it("rejects relative picker results without an active project", async () => {
    const pickFolder = vi.fn(async () => "./rel");
    testState.localApi = { dialogs: { pickFolder } };
    desktopBridgeStub();
    testState.activeThread = null;
    openPrimaryBrowse();
    buttonContaining("Open in Explorer")?.onClick?.(clickEvent());
    await flushPromises();
    expect(testState.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to add project",
        description: "Relative paths require an active project.",
      }),
    );
  });

  it("resolves the picker target for a WSL-only primary environment", async () => {
    testState.environments = [
      primaryEnvironment({
        serverConfig: { settings: null, environment: { platform: { os: "linux" } } },
      }),
    ];
    testState.primaryEnvironment = testState.environments[0] ?? null;
    const pickFolder = vi.fn(async () => "\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj");
    testState.localApi = { dialogs: { pickFolder } };
    const bridge = desktopBridgeStub({
      getWslState: vi.fn(async () => ({
        enabled: true,
        wslOnly: true,
        distro: "Ubuntu",
        distros: [{ name: "Ubuntu", isDefault: true }],
      })),
      getLocalEnvironmentBootstraps: vi.fn(() => [
        { id: PRIMARY_LOCAL_ENVIRONMENT_ID, runningDistro: "Ubuntu" },
      ]),
    });
    testState.navigatorPlatform = "Linux x86_64";
    openPrimaryBrowse();
    const button = buttonContaining("Open in Files");
    expect(button).toBeDefined();
    button?.onClick?.(clickEvent());
    await flushPromises();
    expect(bridge.getWslState).toHaveBeenCalled();
    expect(pickFolder).toHaveBeenCalledWith(
      expect.objectContaining({ targetEnvironmentId: "wsl:Ubuntu" }),
    );
    expect(testState.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENV_PRIMARY,
        input: expect.objectContaining({ workspaceRoot: "/home/dev/proj" }),
      }),
    );
  });

  it("labels the file manager for macOS", () => {
    testState.navigatorPlatform = "MacIntel";
    testState.environments = [
      primaryEnvironment({
        serverConfig: { settings: null, environment: { platform: { os: "darwin" } } },
      }),
    ];
    testState.primaryEnvironment = testState.environments[0] ?? null;
    testState.localApi = { dialogs: { pickFolder: vi.fn() } };
    desktopBridgeStub();
    openPrimaryBrowse();
    expect(buttonContaining("Open in Finder")).toBeDefined();
  });
});
